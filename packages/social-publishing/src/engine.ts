import { UnrecoverableError } from '@fako/jobs';
import type { PrismaClient, SocialPublication, SocialPublicationAttemptOutcome } from '@prisma/client';
import type { PublishVideoResult } from '@fako/publishing';
import { verifyBeforeSend } from './verify.js';
import { createPublicVideoLink, revokePublicVideoLinksForQuizVideo } from './public-link.js';
import type { PublicationEngineDeps } from './types.js';

async function finishAttempt(prisma: PrismaClient, publicationId: string, attemptNumber: number, outcome: SocialPublicationAttemptOutcome, errorMessage?: string, remoteStatus?: string) {
    await prisma.socialPublicationAttempt.updateMany({
        where: { publicationId, attemptNumber, finishedAt: null },
        data: { outcome, errorMessage: errorMessage?.slice(0, 2000), remoteStatus, finishedAt: new Date() }
    });
}

// The claim step mirrors generateQuizVideo's (mission 10) PROCESSING-crash detection exactly, with
// one refinement: a row found already PUBLISHING is only treated as a genuine crash when no
// remotePostId was ever recorded. If one was, the platform already acknowledged the request and
// processing is legitimately asynchronous (TikTok/Instagram/Facebook's own PENDING states) — that
// case belongs to reconcile.ts, never to a blind retry here.
async function claim(prisma: PrismaClient, id: string): Promise<SocialPublication | null> {
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "SocialPublication" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const publication = await tx.socialPublication.findUnique({ where: { id } });
        if (!publication || !['READY', 'PUBLISHING'].includes(publication.status)) return null;

        if (publication.status === 'PUBLISHING') {
            if (publication.remotePostId) return null;
            await tx.socialPublication.update({ where: { id }, data: { status: 'OUTCOME_UNKNOWN', lastError: 'SOCIAL_PUBLICATION_OUTCOME_UNKNOWN_AFTER_RESTART' } });
            await tx.socialPublicationAttempt.create({ data: {
                publicationId: id, attemptNumber: publication.attempts, outcome: 'TIMEOUT', finishedAt: new Date(),
                errorMessage: 'Reprise après redémarrage : une tentative précédente a été interrompue avant toute confirmation de la plateforme — issue réellement inconnue, aucune republication automatique.'
            } });
            return null;
        }

        const attemptNumber = publication.attempts + 1;
        const updated = await tx.socialPublication.update({ where: { id }, data: { status: 'PUBLISHING', attempts: attemptNumber, lastAttemptAt: new Date(), lastError: null } });
        await tx.socialPublicationAttempt.create({ data: { publicationId: id, attemptNumber } });
        return updated;
    });
}

// Mirrors generateQuizVideo(prisma, id, deps, {attempt, maxAttempts}) exactly: a normal thrown Error
// lets BullMQ retry with its own exponential backoff (mission 14 section 7's "retry limité avec
// backoff"); UnrecoverableError stops it dead, used whenever the DB has already recorded a terminal
// outcome (BLOCKED, confirmed FAILED, OUTCOME_UNKNOWN) that must never be auto-retried.
export async function runPublicationAttempt(prisma: PrismaClient, id: string, deps: PublicationEngineDeps, options: { attempt: number; maxAttempts: number }) {
    const claimed = await claim(prisma, id);
    if (!claimed) return;
    const attemptNumber = claimed.attempts;

    let verification;
    try {
        verification = await verifyBeforeSend(prisma, claimed, deps);
    } catch (error) {
        // Verification itself failing (e.g. the live RijPermis check erroring) is ambiguous for the
        // RijPermis side-effect it already wrote, but not for the publish itself: nothing was ever
        // sent to the platform, so this is safely retryable, never OUTCOME_UNKNOWN.
        await finishAttempt(prisma, id, attemptNumber, 'FAILED', error instanceof Error ? error.message : 'VERIFICATION_ERROR');
        await prisma.socialPublication.update({ where: { id }, data: { status: 'READY' } });
        throw error instanceof Error ? error : new Error('VERIFICATION_ERROR');
    }

    if (!verification.ok) {
        const reason = verification.reasons.join(' ; ').slice(0, 2000);
        await prisma.socialPublication.update({ where: { id }, data: { status: 'BLOCKED', lastError: reason } });
        await finishAttempt(prisma, id, attemptNumber, 'BLOCKED', reason);
        throw new UnrecoverableError('SOCIAL_PUBLICATION_BLOCKED');
    }

    const connector = deps.connectors[claimed.platform];

    let publicVideoUrl: string | undefined;
    if (claimed.platform === 'INSTAGRAM') {
        if (!deps.publicLinkBaseUrl) {
            // Caught here, before any network call, with a clear reason — rather than letting the
            // connector's own PUBLIC_URL_REQUIRED surface as a less specific per-attempt failure.
            const message = 'URL publique non configurée (publicLinkBaseUrl / PUBLIC_VIDEO_BASE_URL) ; requise pour publier sur Instagram.';
            await prisma.socialPublication.update({ where: { id }, data: { status: 'BLOCKED', lastError: message } });
            await finishAttempt(prisma, id, attemptNumber, 'BLOCKED', message);
            throw new UnrecoverableError('INSTAGRAM_PUBLIC_URL_NOT_CONFIGURED');
        }
        // Media requirements (size/format/duration) were already confirmed by verifyBeforeSend's
        // connector.validateMediaRequirements call above — minting a link only ever happens for
        // media Instagram has already been confirmed able to accept.
        publicVideoUrl = await createPublicVideoLink(prisma, claimed.videoId, deps.publicLinkBaseUrl, deps.publicVideoLinkTtlMs);
    }

    let result: PublishVideoResult;
    try {
        result = await connector.publishVideo({
            accessToken: verification.accessToken, videoBytes: verification.videoBytes, media: verification.media,
            caption: claimed.caption, hashtags: claimed.hashtags, accountMetadata: verification.accountMetadata, publicVideoUrl
        });
    } catch (error) {
        // The impérative rule (section 7): an exception here means we genuinely do not know whether
        // the platform received the request. Never resolve this to FAILED and never let BullMQ
        // retry it automatically — only reconciliation or an explicit human decision may act next.
        const message = error instanceof Error ? error.message : 'SOCIAL_PUBLISH_UNKNOWN_ERROR';
        await prisma.socialPublication.update({ where: { id }, data: { status: 'OUTCOME_UNKNOWN', lastError: message.slice(0, 2000) } });
        await finishAttempt(prisma, id, attemptNumber, 'TIMEOUT', message);
        throw new UnrecoverableError('SOCIAL_PUBLICATION_OUTCOME_UNKNOWN');
    }

    if (result.outcome === 'PUBLISHED') {
        // Terminal, and (unlike PENDING) Meta cannot still be mid-fetch — safe to revoke now.
        await revokePublicVideoLinksForQuizVideo(prisma, claimed.videoId);
        await prisma.socialPublication.update({ where: { id }, data: {
            status: 'PUBLISHED', remotePostId: result.remotePostId, remoteUrl: result.remoteUrl ?? null, publishedAt: new Date(), lastError: null
        } });
        await finishAttempt(prisma, id, attemptNumber, 'SUCCESS', undefined, 'PUBLISHED');
        return;
    }

    if (result.outcome === 'PENDING') {
        // The platform acknowledged the request and is processing it asynchronously (TikTok's
        // publish_id, Instagram's container, Facebook's video_reels id). Stays PUBLISHING, but now
        // WITH a remotePostId — reconcile.ts's periodic sweep owns this row from here, polling
        // getPublicationStatus until it resolves or the reconciliation grace period elapses. The
        // public link (if any) is deliberately left alone here: Meta may not have fetched it yet.
        await prisma.socialPublication.update({ where: { id }, data: { status: 'PUBLISHING', remotePostId: result.remoteRef, lastAttemptAt: new Date() } });
        await finishAttempt(prisma, id, attemptNumber, 'SUCCESS', undefined, 'PENDING');
        return;
    }

    // result.outcome === 'FAILED': a confirmed, non-ambiguous rejection from the platform, returned
    // synchronously — Meta never registered the video_url for an asynchronous fetch, so any link
    // minted for this attempt is safe to revoke immediately (a retry mints its own fresh one).
    await revokePublicVideoLinksForQuizVideo(prisma, claimed.videoId);
    const canRetry = result.retryable && options.attempt < options.maxAttempts;
    await finishAttempt(prisma, id, attemptNumber, 'FAILED', result.message, result.code);
    if (canRetry) {
        await prisma.socialPublication.update({ where: { id }, data: { status: 'READY', lastError: result.message.slice(0, 2000) } });
        throw new Error(result.code);
    }
    await prisma.socialPublication.update({ where: { id }, data: { status: 'FAILED', lastError: result.message.slice(0, 2000) } });
    throw new UnrecoverableError(result.code);
}
