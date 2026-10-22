import type { PrismaClient } from '@prisma/client';

export type SocialPublicationSchedulerOutcome = { promoted: number; skippedCapacity: boolean };

// Distinct from the generation scheduler (mission 11's runSchedulerTick/ScheduledQuizSlot) as
// mission 14 section 6 requires: no fixed daily slots here, just "is this specific publication's
// own scheduledAt now due". Capacity-bounded (maxInFlight) so a burst of due publications can never
// flood the queue unbounded (section 6's "éviter l'accumulation incontrôlée de jobs") — the same
// safeguard runSchedulerTick applies via maxPendingJobs.
export async function runSocialPublicationSchedulerTick(prisma: PrismaClient, options: { maxInFlight: number }, now: Date = new Date()): Promise<SocialPublicationSchedulerOutcome> {
    const inFlight = await prisma.socialPublication.count({ where: { status: { in: ['READY', 'PUBLISHING'] } } });
    if (inFlight >= options.maxInFlight) return { promoted: 0, skippedCapacity: true };

    const capacity = options.maxInFlight - inFlight;
    const due = await prisma.socialPublication.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { lte: now } }, orderBy: { scheduledAt: 'asc' }, take: capacity, select: { id: true }
    });
    if (!due.length) return { promoted: 0, skippedCapacity: false };

    const result = await prisma.socialPublication.updateMany({ where: { id: { in: due.map(row => row.id) }, status: 'SCHEDULED' }, data: { status: 'READY' } });
    return { promoted: result.count, skippedCapacity: false };
}
