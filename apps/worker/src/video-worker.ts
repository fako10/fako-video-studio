import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { Worker } from '@fako/jobs';
import { ElevenLabsProvider, CachingTTSProvider, LocalAudioCacheStore, MockTTSProvider, type TTSProvider } from '@fako/ai-providers';
import { createVideoRenderQueue, dispatchVideos, generateVideo, videoRenderQueueName, type RenderPipelineDeps } from '@fako/video-pipeline';
import { LocalVideoStorage, defaultPublicDir } from '@fako/media-engine';
import { logger } from './logger.js';

function resolveTtsProvider(): TTSProvider {
    const name = process.env.QUIZ_VIDEO_TTS_PROVIDER ?? 'disabled';
    if (name === 'mock') {
        // Explicitly sanctioned for local development only (mission 10); refused in production unless
        // FAKO_ALLOW_MOCK_IN_PRODUCTION=true is ALSO set (mission 16's staging deployment) — unlike the
        // shared TTS_PROVIDER used by the AudioAsset pipeline (mission 5), which never accepts "mock" at all.
        if (process.env.NODE_ENV === 'production' && process.env.FAKO_ALLOW_MOCK_IN_PRODUCTION !== 'true') {
            throw new Error('QUIZ_VIDEO_TTS_PROVIDER=mock is forbidden when NODE_ENV=production');
        }
        return new MockTTSProvider();
    }
    if (name === 'elevenlabs') return new ElevenLabsProvider(process.env.ELEVENLABS_API_KEY ?? '');
    throw new Error('Unsupported QUIZ_VIDEO_TTS_PROVIDER');
}

export function startVideoWorker(prisma: PrismaClient) {
    if ((process.env.QUIZ_VIDEO_ENABLED ?? 'false') !== 'true') return { close: async () => {} };

    const inner = resolveTtsProvider();
    const cache = new LocalAudioCacheStore(process.env.QUIZ_VIDEO_AUDIO_CACHE_ROOT || resolve(import.meta.dirname, '../../../storage/audio-cache'));
    const ttsProvider = new CachingTTSProvider(inner, cache);
    const videoStorage = new LocalVideoStorage(process.env.QUIZ_VIDEO_STORAGE_ROOT || resolve(import.meta.dirname, '../../../storage/quiz-videos'));
    const mediaRoot = process.env.RIJPERMIS_MEDIA_ROOT || resolve(import.meta.dirname, '../../../storage/rijpermis-images');
    const publicDir = process.env.QUIZ_VIDEO_PUBLIC_DIR || defaultPublicDir;
    const brandAssetsRoot = process.env.BRAND_ASSETS_ROOT || resolve(import.meta.dirname, '../../../assets/brands');
    const deps: RenderPipelineDeps = { ttsProvider, videoStorage, publicDir, mediaRoot, brandAssetsRoot };

    const concurrency = Number(process.env.QUIZ_VIDEO_WORKER_CONCURRENCY ?? 1);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid QUIZ_VIDEO_WORKER_CONCURRENCY');

    const queue = createVideoRenderQueue();
    const worker = new Worker<{ videoId: string }>(videoRenderQueueName, job => generateVideo(prisma, job.data.videoId, deps, {
        attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 3
    }), { concurrency });

    worker.on('error', error => logger.error({ queue: videoRenderQueueName, err: error.message }, 'Video worker connection error'));
    queue.on('error', error => logger.error({ queue: videoRenderQueueName, err: error.message }, 'Video queue connection error'));
    worker.on('failed', (job, error) => logger.warn({ queue: videoRenderQueueName, jobId: job?.id, videoId: job?.data.videoId, attemptsMade: job?.attemptsMade, err: error?.message }, 'Video render attempt failed'));

    let stopping = false; let pending: Promise<void> | undefined;
    function dispatch() {
        if (stopping || pending) return;
        pending = dispatchVideos(prisma, queue).catch(() => logger.error({ queue: videoRenderQueueName }, 'Video dispatch unavailable; rows retained')).finally(() => { pending = undefined; });
    }
    const timer = setInterval(dispatch, 2000);
    dispatch();
    return { close: async () => { stopping = true; clearInterval(timer); await pending; await worker.close(); await queue.close(); } };
}
