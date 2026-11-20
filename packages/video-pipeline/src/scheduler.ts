import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { computeProgramOccurrences } from './schedule.js';
import { registryOf, type RequestDeps } from './deps.js';
import { requestVideo } from './request.js';

export type SchedulerConfig = {
    graceMinutes: number;
    maxPendingJobs: number;
    /** Restreint le tick à certains projets (tests, relance manuelle). */
    projectIds?: string[];
};

export type SlotOutcome = {
    programId: string; projectId: string; videoType: string;
    scheduledDate: string; slotTime: string; language: string;
    status: 'DISPATCHED' | 'SKIPPED' | 'FAILED' | 'ALREADY_CLAIMED'; reason?: string; videoId?: string;
};

function isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// Seul point de rencontre entre planification et génération : pour chaque programme actif, chaque
// créneau à traiter est réservé une seule fois (l'index unique de ScheduledSlot sert de verrou entre
// instances), puis requestVideo prépare la vidéo. Le rendu reste l'affaire du worker.
export async function runProgramsTick(prisma: PrismaClient, deps: RequestDeps, config: SchedulerConfig, now: Date = new Date()): Promise<SlotOutcome[]> {
    const registry = registryOf(deps);
    const programs = await prisma.program.findMany({ where: { enabled: true, ...(config.projectIds ? { projectId: { in: config.projectIds } } : {}) }, include: { project: true }, orderBy: { createdAt: 'asc' } });
    const outcomes: SlotOutcome[] = [];

    for (const program of programs) {
        const { project } = program;
        const language = project.language ?? project.languages[0];
        const base = { programId: program.id, projectId: project.id, videoType: program.videoType, language: language ?? '' };
        if (!language || !registry.has(program.videoType)) {
            // Configuration invalide : signalée à chaque tick, sans réserver de créneau.
            outcomes.push({ ...base, scheduledDate: '', slotTime: '', status: 'FAILED',
                reason: !language ? 'No language configured for this project' : `Unknown video type "${program.videoType}"` });
            continue;
        }

        for (const slot of computeProgramOccurrences(now, program, project.timezone, config.graceMinutes)) {
            const where = { ...base, scheduledDate: slot.scheduledDate, slotTime: slot.slotTime };
            let claimed;
            try {
                claimed = await prisma.scheduledSlot.create({ data: {
                    projectId: project.id, programId: program.id, language,
                    scheduledDate: new Date(`${slot.scheduledDate}T00:00:00.000Z`), slotTime: slot.slotTime, scheduledAt: slot.scheduledAt,
                    status: slot.missed ? 'SKIPPED' : 'PENDING',
                    reason: slot.missed ? 'Missed: scheduler was not running (or backlogged) when this slot became due' : null
                } });
            } catch (error) {
                if (isUniqueConstraintViolation(error)) { outcomes.push({ ...where, status: 'ALREADY_CLAIMED' }); continue; }
                throw error;
            }
            if (slot.missed) { outcomes.push({ ...where, status: 'SKIPPED', reason: claimed.reason! }); continue; }

            try {
                const pendingCount = await prisma.video.count({ where: { projectId: project.id, status: { in: ['PENDING', 'QUEUED', 'PROCESSING'] } } });
                if (pendingCount >= config.maxPendingJobs) {
                    const reason = `Too many videos already pending (${pendingCount} >= ${config.maxPendingJobs}); slot skipped`;
                    await prisma.scheduledSlot.update({ where: { id: claimed.id }, data: { status: 'SKIPPED', reason } });
                    outcomes.push({ ...where, status: 'SKIPPED', reason });
                    continue;
                }
                const { video } = await requestVideo(prisma, deps, { projectId: project.id, programId: program.id, requestId: randomUUID(), language });
                await prisma.scheduledSlot.update({ where: { id: claimed.id }, data: { status: 'DISPATCHED', videoId: video.id, dispatchedAt: new Date() } });
                outcomes.push({ ...where, status: 'DISPATCHED', videoId: video.id });
            } catch (error) {
                const reason = (error instanceof Error ? error.message : 'SCHEDULER_UNKNOWN_ERROR').slice(0, 500);
                await prisma.scheduledSlot.update({ where: { id: claimed.id }, data: { status: 'FAILED', reason } });
                outcomes.push({ ...where, status: 'FAILED', reason });
            }
        }
    }
    return outcomes;
}
