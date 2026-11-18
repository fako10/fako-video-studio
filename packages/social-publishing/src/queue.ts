import { Queue } from '@fako/jobs';
import type { PrismaClient } from '@prisma/client';

export const socialPublicationQueueName = 'social-publications';

export function createSocialPublicationQueue() {
    return new Queue<{ publicationId: string }>(socialPublicationQueueName, {
        defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
    });
}

// Outbox dispatch, mirroring dispatchQuizVideos (mission 10) exactly: the database row is the
// source of truth, jobId = row id makes re-dispatch idempotent (the queue simply refuses a duplicate
// jobId), and a job the queue itself gave up on (stalled-recovery/attempts exhausted) is reconciled
// back into a terminal DB status rather than left to silently disappear.
export async function dispatchSocialPublications(prisma: PrismaClient, queue: Pick<ReturnType<typeof createSocialPublicationQueue>, 'add' | 'getJob'>) {
    let cursor: string | undefined;
    for (;;) {
        const rows = await prisma.socialPublication.findMany({
            where: { status: 'READY' }, orderBy: { id: 'asc' }, take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true }
        });
        for (const row of rows) {
            const existing = await queue.getJob(row.id);
            if (existing && await existing.getState() === 'failed') {
                await prisma.socialPublication.updateMany({ where: { id: row.id, status: 'READY' },
                    data: { status: 'FAILED', lastError: 'Queue attempts or stalled recovery exhausted' } });
                continue;
            }
            if (!existing) await queue.add('publish', { publicationId: row.id }, { jobId: row.id });
        }
        if (rows.length < 100) return;
        cursor = rows.at(-1)!.id;
    }
}
