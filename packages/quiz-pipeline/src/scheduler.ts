import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ContentSourceProvider, MediaStorage } from '@fako/content-sources';
import { computeDueSlots, type SlotConfig } from './schedule.js';
import { requestQuizVideo } from './request.js';

export type SchedulerConfig = { slots: SlotConfig[]; timeZone: string; graceMinutes: number; maxPendingJobs: number };

export type SlotOutcome = { scheduledDate: string; slotTime: string; language: string; status: 'DISPATCHED' | 'SKIPPED' | 'FAILED' | 'ALREADY_CLAIMED'; reason?: string; quizVideoId?: string };

function isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// The only place scheduling meets generation: for each slot due "now" (see computeDueSlots), claim
// it exactly once (the unique index on ScheduledQuizSlot is the cross-instance lock) and call
// requestQuizVideo — never generateQuizVideo/renderQuizVideo. Planning and rendering stay separate;
// the existing mission 10 worker and its outbox dispatcher do the rest, on their own schedule.
export async function runSchedulerTick(
    prisma: PrismaClient, provider: ContentSourceProvider, mediaStorage: MediaStorage, projectId: string,
    config: SchedulerConfig, now: Date = new Date()
): Promise<SlotOutcome[]> {
    const due = computeDueSlots(now, config.slots, config.timeZone, config.graceMinutes);
    const outcomes: SlotOutcome[] = [];

    for (const slot of due) {
        const scheduledDate = new Date(`${slot.scheduledDate}T00:00:00.000Z`);
        let claimed;
        try {
            claimed = await prisma.scheduledQuizSlot.create({ data: {
                projectId, scheduledDate, slotTime: slot.slotTime, language: slot.language, scheduledAt: slot.scheduledAt,
                status: slot.missed ? 'SKIPPED' : 'PENDING',
                reason: slot.missed ? 'Missed: scheduler was not running (or backlogged) when this slot became due' : null
            } });
        } catch (error) {
            if (isUniqueConstraintViolation(error)) {
                outcomes.push({ scheduledDate: slot.scheduledDate, slotTime: slot.slotTime, language: slot.language, status: 'ALREADY_CLAIMED' });
                continue;
            }
            throw error;
        }

        if (slot.missed) {
            outcomes.push({ scheduledDate: slot.scheduledDate, slotTime: slot.slotTime, language: slot.language, status: 'SKIPPED', reason: claimed.reason! });
            continue;
        }

        try {
            const pendingCount = await prisma.quizVideo.count({ where: { projectId, status: { in: ['PENDING', 'QUEUED', 'PROCESSING'] } } });
            if (pendingCount >= config.maxPendingJobs) {
                const reason = `Too many quiz videos already pending (${pendingCount} >= ${config.maxPendingJobs}); will retry on a later tick`;
                await prisma.scheduledQuizSlot.update({ where: { id: claimed.id }, data: { status: 'SKIPPED', reason } });
                outcomes.push({ scheduledDate: slot.scheduledDate, slotTime: slot.slotTime, language: slot.language, status: 'SKIPPED', reason });
                continue;
            }

            const { quizVideo } = await requestQuizVideo(prisma, provider, mediaStorage, projectId, slot.language, randomUUID());
            await prisma.scheduledQuizSlot.update({ where: { id: claimed.id }, data: { status: 'DISPATCHED', quizVideoId: quizVideo.id, dispatchedAt: new Date() } });
            outcomes.push({ scheduledDate: slot.scheduledDate, slotTime: slot.slotTime, language: slot.language, status: 'DISPATCHED', quizVideoId: quizVideo.id });
        } catch (error) {
            const reason = (error instanceof Error ? error.message : 'SCHEDULER_UNKNOWN_ERROR').slice(0, 500);
            await prisma.scheduledQuizSlot.update({ where: { id: claimed.id }, data: { status: 'FAILED', reason } });
            outcomes.push({ scheduledDate: slot.scheduledDate, slotTime: slot.slotTime, language: slot.language, status: 'FAILED', reason });
        }
    }

    return outcomes;
}
