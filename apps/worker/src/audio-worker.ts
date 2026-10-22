import type { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { resolve } from 'node:path';
import { redisConnection } from '@fako/video-jobs';
import { audioQueueName, dispatchAudio, ElevenLabsProvider, LocalAudioStorage, processAudio } from '@fako/ai-providers';
import { logger } from './logger.js';
export function startAudioWorker(prisma: PrismaClient) {
    if ((process.env.TTS_PROVIDER ?? 'disabled') === 'disabled') return { close: async () => {} };
    if (process.env.TTS_PROVIDER !== 'elevenlabs') throw new Error('Unsupported TTS_PROVIDER');
    const provider = new ElevenLabsProvider(process.env.ELEVENLABS_API_KEY ?? '');
    const storage = new LocalAudioStorage(process.env.AUDIO_STORAGE_ROOT || resolve(import.meta.dirname, '../../../storage/audio'));
    const queue = new Queue<{ audioAssetId: string }>(audioQueueName, { connection: redisConnection(), defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } } });
    const worker = new Worker<{ audioAssetId: string }>(audioQueueName, job => processAudio(prisma, job.data.audioAssetId, provider, storage, 3), { connection: redisConnection(), concurrency: 1 });
    worker.on('error', error => logger.error({ queue: audioQueueName, err: error.message }, 'Audio worker unavailable'));
    queue.on('error', error => logger.error({ queue: audioQueueName, err: error.message }, 'Audio queue unavailable'));
    worker.on('completed', job => logger.info({ queue: audioQueueName, jobId: job.id }, 'Audio processing finished'));
    worker.on('failed', (job, error) => logger.warn({ queue: audioQueueName, jobId: job?.id, attemptsMade: job?.attemptsMade, err: error?.message }, 'Audio attempt failed'));
    let stopped = false; let pending: Promise<void> | undefined;
    function dispatch() {
        if (stopped || pending) return;
        pending = dispatchAudio(prisma, queue).catch(() => logger.error({ queue: audioQueueName }, 'Audio dispatch unavailable; requests retained')).finally(() => { pending = undefined; });
    }
    const timer = setInterval(dispatch, 2000); dispatch();
    return { close: async () => { stopped = true; clearInterval(timer); await pending; await worker.close(); await queue.close(); } };
}
