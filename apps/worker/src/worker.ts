import { startAudioWorker } from './audio-worker.js';
import { PrismaClient } from '@prisma/client';
import { Worker } from 'bullmq';
import { createVideoQueue, dispatchPending, queueName, redisConnection, simulateVideoJob } from '@fako/video-jobs';
import { logger } from './logger.js';
import { startScriptWorker } from './script-worker.js';
import { startQuizVideoWorker } from './quiz-video-worker.js';
import { startSocialPublicationWorker } from './social-publication-worker.js';

function positiveInteger(name: string, fallback: number) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    return value;
}

const prisma = new PrismaClient();
const scriptWorker = startScriptWorker(prisma);
const audioWorker = startAudioWorker(prisma);
const quizVideoWorker = startQuizVideoWorker(prisma);
const socialPublicationWorker = startSocialPublicationWorker(prisma);
const queue = createVideoQueue();
const worker = new Worker<{ videoJobId: string }>(queueName, async job => {
    await simulateVideoJob(prisma, job.data.videoJobId, {
        attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 3,
        stepDelayMs: positiveInteger('SIMULATION_STEP_MS', 300)
    });
}, { connection: redisConnection(), concurrency: positiveInteger('WORKER_CONCURRENCY', 2) });

// Do not log connection objects or job payloads, which may contain private data.
worker.on('error', error => logger.error({ queue: queueName, err: error.message }, 'Worker connection or processing error'));
queue.on('error', error => logger.error({ queue: queueName, err: error.message }, 'Queue connection error'));
worker.on('failed', async (job, error) => {
    // Also covers exhausted stalled-job recovery, where the processor cannot catch the failure.
    logger.warn({ queue: queueName, jobId: job?.id, videoJobId: job?.data.videoJobId, attemptsMade: job?.attemptsMade, err: error?.message }, 'Video job attempt failed');
    if (!job) return;
    try {
        if (await job.getState() === 'failed') {
            await prisma.videoJob.updateMany({ where: { id: job.data.videoJobId, status: { in: ['PROCESSING', 'QUEUED'] }, scriptGenerationRequested: false },
                data: { status: 'FAILED', errorMessage: 'Queue attempts or stalled recovery exhausted', finishedAt: new Date() } });
            logger.error({ queue: queueName, videoJobId: job.data.videoJobId }, 'Video job exhausted retries or stalled recovery; marked FAILED');
        }
    } catch { logger.error({ queue: queueName, jobId: job.id }, 'Could not persist queue failure; reconciliation will retry'); }
});

let stopping = false;
let dispatching: Promise<void> | undefined;
async function dispatch() {
    if (stopping || dispatching) return;
    dispatching = dispatchPending(prisma, queue).catch(() => logger.error({ queue: queueName }, 'Dispatch unavailable; database jobs retained'));
    await dispatching;
    dispatching = undefined;
}
const timer = setInterval(() => void dispatch(), positiveInteger('DISPATCH_INTERVAL_MS', 2000));
void dispatch();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
        stopping = true;
        clearInterval(timer);
        await worker.close();
        await dispatching;
        await queue.close();
        await scriptWorker.close();
        await audioWorker.close();
        await quizVideoWorker.close();
        await socialPublicationWorker.close();
        await prisma.$disconnect();
    });
}
