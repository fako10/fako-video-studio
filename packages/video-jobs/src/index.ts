import { Queue } from 'bullmq';
import type { PrismaClient, VideoJobStatus } from '@prisma/client';
export * from './ai.js';
export * from './editorial.js';
export * from './rijpermis.js';
export * from './scripts.js';

export const queueName = 'video-production';
export const activeStatuses: VideoJobStatus[] = ['PENDING', 'QUEUED', 'PROCESSING'];
export const cancellableStatuses: VideoJobStatus[] = [...activeStatuses, 'WAITING_APPROVAL'];

export function redisConnection(value = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379') {
    const url = new URL(value);
    if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Invalid Redis URL protocol');
    return {
        host: url.hostname, port: Number(url.port || 6379),
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        db: Number(url.pathname.slice(1) || 0),
        ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
        maxRetriesPerRequest: null
    };
}

export function createVideoQueue() {
    return new Queue<{ videoJobId: string }>(queueName, {
        connection: redisConnection(),
        defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }
    });
}

// Database rows act as a durable outbox. Redis can be offline when the API creates a job.
export async function dispatchPending(prisma: PrismaClient, queue: Pick<ReturnType<typeof createVideoQueue>, 'add' | 'getJob'>) {
    let cursor: string | undefined;
    for (;;) {
        const rows = await prisma.videoJob.findMany({
            where: { status: { in: activeStatuses }, scriptGenerationRequested: false }, orderBy: { id: 'asc' }, take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true }
        });
        for (const row of rows) {
            const existing = await queue.getJob(row.id);
            if (existing && await existing.getState() === 'failed') {
                await prisma.videoJob.updateMany({ where: { id: row.id, status: { in: activeStatuses }, scriptGenerationRequested: false },
                    data: { status: 'FAILED', errorMessage: 'Queue attempts or stalled recovery exhausted', finishedAt: new Date() } });
                continue;
            }
            await prisma.videoJob.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'QUEUED' } });
            await queue.add('simulate', { videoJobId: row.id }, { jobId: row.id });
        }
        if (rows.length < 100) return;
        cursor = rows.at(-1)!.id;
    }
}

export type SimulationOptions = {
    attempt: number; maxAttempts: number; stepDelayMs?: number;
    step?: (progress: number) => Promise<void>;
};

export async function simulateVideoJob(prisma: PrismaClient, id: string, options: SimulationOptions) {
    const claimed = await prisma.videoJob.updateMany({
        where: { id, status: { in: activeStatuses }, scriptGenerationRequested: false },
        data: { status: 'PROCESSING', startedAt: new Date(), progress: 0, errorMessage: null, attempts: { increment: 1 } }
    });
    if (!claimed.count) return;
    try {
        for (const progress of [20, 50, 80, 100]) {
            await new Promise(resolve => setTimeout(resolve, options.stepDelayMs ?? 300));
            const current = await prisma.videoJob.findUnique({ where: { id }, select: { status: true, scriptGenerationRequested: true } });
            if (current?.status !== 'PROCESSING' || current.scriptGenerationRequested) return;
            await options.step?.(progress);
            await prisma.videoJob.updateMany({ where: { id, status: 'PROCESSING', scriptGenerationRequested: false }, data: { progress } });
        }
        await prisma.videoJob.updateMany({
            where: { id, status: 'PROCESSING', scriptGenerationRequested: false },
            data: { status: 'WAITING_APPROVAL', progress: 100, errorMessage: null }
        });
    } catch (error) {
        const terminal = options.attempt >= options.maxAttempts;
        await prisma.videoJob.updateMany({
            where: { id, status: 'PROCESSING', scriptGenerationRequested: false },
            data: { status: terminal ? 'FAILED' : 'QUEUED', errorMessage: 'Simulated processing failed', finishedAt: terminal ? new Date() : null }
        });
        throw error;
    }
}
