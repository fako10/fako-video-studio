import type { PrismaClient } from '@prisma/client';
import { decryptSecret } from '@fako/publishing';
import { revokePublicVideoLinksForQuizVideo } from './public-link.js';
import type { PublicationEngineDeps } from './types.js';

export type ReconcileResult = 'PUBLISHED' | 'FAILED' | 'STILL_PENDING' | 'OUTCOME_UNKNOWN' | 'SKIPPED_ERROR';
export type ReconcileOutcome = { publicationId: string; result: ReconcileResult };

const DEFAULT_RECONCILE_GRACE_MS = 15 * 60 * 1000;

// Every row this sweep touches is already PUBLISHING — the main engine (engine.ts) only ever moves
// a row here once the platform has genuinely acknowledged the request (remotePostId set) or the
// claim step detected a crash with no acknowledgment at all. This function is the *only* place that
// resolves either case: a legitimate async platform result (poll until PUBLISHED/FAILED/still
// processing), or a stale crash (past `reconcileGraceMs` with no sign of life) that graduates to
// OUTCOME_UNKNOWN rather than being silently retried — mission 14 section 7's impérative rule.
export async function reconcileInFlightPublications(prisma: PrismaClient, deps: PublicationEngineDeps, now: Date = new Date()): Promise<ReconcileOutcome[]> {
    const graceMs = deps.reconcileGraceMs ?? DEFAULT_RECONCILE_GRACE_MS;
    const rows = await prisma.socialPublication.findMany({ where: { status: 'PUBLISHING' } });
    const outcomes: ReconcileOutcome[] = [];

    for (const row of rows) {
        const stale = !row.lastAttemptAt || (now.getTime() - row.lastAttemptAt.getTime()) > graceMs;

        if (!row.remotePostId) {
            // Crashed before any platform acknowledgment, and no retried job has reclaimed it yet.
            // Give it a grace period first — a row can briefly sit here between being claimed and its
            // first update landing — before concluding the outcome is genuinely unknown.
            if (!stale) { outcomes.push({ publicationId: row.id, result: 'SKIPPED_ERROR' }); continue; }
            await prisma.socialPublication.update({ where: { id: row.id }, data: { status: 'OUTCOME_UNKNOWN', lastError: 'SOCIAL_PUBLICATION_OUTCOME_UNKNOWN_STALE_NO_ACK' } });
            outcomes.push({ publicationId: row.id, result: 'OUTCOME_UNKNOWN' });
            continue;
        }

        try {
            const account = await prisma.socialAccount.findUnique({ where: { id: row.socialAccountId } });
            if (!account?.accessTokenCiphertext) { outcomes.push({ publicationId: row.id, result: 'SKIPPED_ERROR' }); continue; }
            const accessToken = decryptSecret(account.accessTokenCiphertext, deps.encryptionKey, deps.previousEncryptionKey);
            const status = await deps.connectors[row.platform].getPublicationStatus(row.remotePostId, accessToken);

            if (status.outcome === 'PUBLISHED') {
                // Terminal: the platform (Instagram's FINISHED+media_publish, in practice) confirms
                // it already fetched the video — any public link for it is safe to revoke now.
                await revokePublicVideoLinksForQuizVideo(prisma, row.videoId);
                await prisma.socialPublication.update({ where: { id: row.id }, data: {
                    status: 'PUBLISHED', remotePostId: status.remotePostId, remoteUrl: status.remoteUrl ?? null, publishedAt: now, lastError: null
                } });
                outcomes.push({ publicationId: row.id, result: 'PUBLISHED' });
            } else if (status.outcome === 'FAILED') {
                // Now safely terminal: the platform itself confirmed it, so a human can retry it
                // afterwards (retryPublication only ever accepts a confirmed FAILED, never OUTCOME_UNKNOWN).
                // A confirmed failure (incl. the container's own 24h EXPIRED) means Meta will never
                // fetch this link again either way.
                await revokePublicVideoLinksForQuizVideo(prisma, row.videoId);
                await prisma.socialPublication.update({ where: { id: row.id }, data: { status: 'FAILED', lastError: status.message.slice(0, 2000) } });
                outcomes.push({ publicationId: row.id, result: 'FAILED' });
            } else if (stale) {
                // Past grace with no resolution: ambiguous, not confirmed either way — the link is
                // deliberately left alone (not revoked) in case Meta is still genuinely mid-fetch;
                // it will expire on its own TTL regardless.
                await prisma.socialPublication.update({ where: { id: row.id }, data: { status: 'OUTCOME_UNKNOWN', lastError: 'SOCIAL_PUBLICATION_OUTCOME_UNKNOWN_PROCESSING_PAST_GRACE' } });
                outcomes.push({ publicationId: row.id, result: 'OUTCOME_UNKNOWN' });
            } else {
                await prisma.socialPublication.update({ where: { id: row.id }, data: { lastAttemptAt: now } });
                outcomes.push({ publicationId: row.id, result: 'STILL_PENDING' });
            }
        } catch {
            // A single transient polling failure is not itself a crash signal — retried next sweep.
            outcomes.push({ publicationId: row.id, result: 'SKIPPED_ERROR' });
        }
    }
    return outcomes;
}
