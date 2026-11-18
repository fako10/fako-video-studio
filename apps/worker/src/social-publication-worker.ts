import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { Worker } from '@fako/jobs';
import { contentSourceFromEnv } from '@fako/content-sources';
import { LocalVideoStorage } from '@fako/media-engine';
import { loadEncryptionKeyFromEnv, loadPreviousEncryptionKeyFromEnv, socialConnectorsFromEnv, type SocialPlatform } from '@fako/publishing';
import {
    createSocialPublicationQueue, dispatchSocialPublications, reconcileInFlightPublications, runPublicationAttempt,
    socialPublicationQueueName, type PublicationEngineDeps
} from '@fako/social-publishing';
import { logger } from './logger.js';

function positiveInteger(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    return value;
}

function appAuditedByPlatform(): Partial<Record<SocialPlatform, boolean>> {
    // Absent/anything but "true" always means "not audited" (the safe default) — this must be set
    // explicitly, per platform, only once that platform's own App Review has actually passed.
    return {
        TIKTOK: process.env.TIKTOK_APP_AUDITED === 'true',
        INSTAGRAM: process.env.INSTAGRAM_APP_AUDITED === 'true',
        FACEBOOK: process.env.FACEBOOK_APP_AUDITED === 'true'
    };
}

// Mission 14. Reuses the mission 10 quiz-video storage root (same files, never copied) and the
// mission 13 RijPermis content source (for the live re-verification every send requires) — nothing
// here is a second copy of either. SOCIAL_PUBLISHING_ENABLED is the server-side switch mission 14
// section 9 requires: false by default, never readable/settable from a browser, and distinct from
// SOCIAL_MOCK_MODE (which only decides whether the connectors themselves are real or simulated).
export function startSocialPublicationWorker(prisma: PrismaClient) {
    if ((process.env.SOCIAL_PUBLISHING_ENABLED ?? 'false') !== 'true') return { close: async () => {} };

    const provider = contentSourceFromEnv(process.env);
    if (!provider) throw new Error('SOCIAL_PUBLISHING_ENABLED is true but no RijPermis content source is configured (RIJPERMIS_API_ENABLED / RIJPERMIS_MOCK_MODE)');

    const deps: PublicationEngineDeps = {
        connectors: socialConnectorsFromEnv(process.env),
        provider,
        encryptionKey: loadEncryptionKeyFromEnv(process.env),
        previousEncryptionKey: loadPreviousEncryptionKeyFromEnv(process.env),
        videoStorage: new LocalVideoStorage(process.env.QUIZ_VIDEO_STORAGE_ROOT || resolve(import.meta.dirname, '../../../storage/quiz-videos')),
        appAuditedByPlatform: appAuditedByPlatform(),
        reconcileGraceMs: positiveInteger('SOCIAL_PUBLISHING_RECONCILE_GRACE_MS', 15 * 60 * 1000),
        // Instagram-only (mission 15 section 4): absent by default, so an Instagram publication
        // attempt blocks with a clear BLOCKED reason rather than silently failing deep inside the
        // connector. Must be the same public HTTPS origin apps/api's public-quiz-videos route is
        // actually reachable on — never guessed from API_PORT/HOST, which are bind addresses, not
        // the externally reachable URL behind a reverse proxy.
        publicLinkBaseUrl: process.env.PUBLIC_VIDEO_BASE_URL || undefined,
        publicVideoLinkTtlMs: positiveInteger('PUBLIC_VIDEO_LINK_TTL_MS', 2 * 60 * 60 * 1000)
    };

    const concurrency = positiveInteger('SOCIAL_PUBLISHING_WORKER_CONCURRENCY', 1);
    const queue = createSocialPublicationQueue();
    const worker = new Worker<{ publicationId: string }>(socialPublicationQueueName, job => runPublicationAttempt(prisma, job.data.publicationId, deps, {
        attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 5
    }), { concurrency });

    worker.on('error', error => logger.error({ queue: socialPublicationQueueName, err: error.message }, 'Social publication worker connection error'));
    queue.on('error', error => logger.error({ queue: socialPublicationQueueName, err: error.message }, 'Social publication queue connection error'));
    worker.on('failed', async (job, error) => {
        logger.warn({ queue: socialPublicationQueueName, jobId: job?.id, publicationId: job?.data.publicationId, attemptsMade: job?.attemptsMade, err: error?.message }, 'Social publication attempt failed');
        if (!job) return;
        try {
            if (await job.getState() === 'failed') {
                await prisma.socialPublication.updateMany({ where: { id: job.data.publicationId, status: { in: ['READY', 'PUBLISHING'] } },
                    data: { status: 'FAILED', lastError: 'Queue attempts or stalled recovery exhausted' } });
                logger.error({ queue: socialPublicationQueueName, publicationId: job.data.publicationId }, 'Social publication exhausted retries or stalled recovery; marked FAILED');
            }
        } catch { logger.error({ queue: socialPublicationQueueName, publicationId: job.data.publicationId }, 'Could not persist social publication queue failure; reconciliation will retry'); }
    });

    let stopping = false; let pending: Promise<void> | undefined;
    function dispatch() {
        if (stopping || pending) return;
        pending = dispatchSocialPublications(prisma, queue).catch(() => logger.error({ queue: socialPublicationQueueName }, 'Social publication dispatch unavailable; rows retained')).finally(() => { pending = undefined; });
    }
    const dispatchTimer = setInterval(dispatch, 2000);
    dispatch();

    // Mission 15 section 7: OUTCOME_UNKNOWN is the one result here that genuinely needs a human —
    // the platform's true state is unconfirmed and nothing here will retry it automatically (section
    // 7's impérative rule, enforced in reconcile.ts itself). Logged at `error` level specifically so a
    // log-based alert (e.g. "alert on any 'OUTCOME_UNKNOWN requires review' error line") catches it,
    // distinct from FAILED (confirmed, retryable by a human) and STILL_PENDING/SKIPPED_ERROR (routine).
    let reconciling: Promise<void> | undefined;
    function reconcile() {
        if (stopping || reconciling) return;
        reconciling = reconcileInFlightPublications(prisma, deps).then(outcomes => {
            for (const outcome of outcomes) {
                if (outcome.result === 'OUTCOME_UNKNOWN') logger.error({ publicationId: outcome.publicationId }, 'Social publication OUTCOME_UNKNOWN requires review');
                else if (outcome.result === 'FAILED') logger.warn({ publicationId: outcome.publicationId }, 'Social publication confirmed FAILED by reconciliation');
                else logger.debug({ publicationId: outcome.publicationId, result: outcome.result }, 'Social publication reconciliation outcome');
            }
        }).catch(() => logger.error('Social publication reconciliation sweep failed; will retry')).finally(() => { reconciling = undefined; });
    }
    const reconcileTimer = setInterval(reconcile, positiveInteger('SOCIAL_PUBLISHING_RECONCILE_INTERVAL_MS', 60_000));
    reconcile();

    return { close: async () => {
        stopping = true; clearInterval(dispatchTimer); clearInterval(reconcileTimer);
        await pending; await reconciling; await worker.close(); await queue.close();
    } };
}
