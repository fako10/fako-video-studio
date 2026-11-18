import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { Worker } from '@fako/jobs';
import { ElevenLabsProvider, CachingTTSProvider, LocalAudioCacheStore, MockTTSProvider, type TTSProvider } from '@fako/ai-providers';
import { createQuizVideoQueue, dispatchQuizVideos, generateQuizVideo, quizVideoQueueName, type QuizVideoDeps } from '@fako/quiz-pipeline';
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

export function startQuizVideoWorker(prisma: PrismaClient) {
    if ((process.env.QUIZ_VIDEO_ENABLED ?? 'false') !== 'true') return { close: async () => {} };

    const inner = resolveTtsProvider();
    const cache = new LocalAudioCacheStore(process.env.QUIZ_VIDEO_AUDIO_CACHE_ROOT || resolve(import.meta.dirname, '../../../storage/audio-cache'));
    const ttsProvider = new CachingTTSProvider(inner, cache);
    const videoStorage = new LocalVideoStorage(process.env.QUIZ_VIDEO_STORAGE_ROOT || resolve(import.meta.dirname, '../../../storage/quiz-videos'));
    const mediaRoot = process.env.RIJPERMIS_MEDIA_ROOT || resolve(import.meta.dirname, '../../../storage/rijpermis-images');
    const publicDir = process.env.QUIZ_VIDEO_PUBLIC_DIR || defaultPublicDir;
    const deps: QuizVideoDeps = { ttsProvider, videoStorage, publicDir, mediaRoot };

    const concurrency = Number(process.env.QUIZ_VIDEO_WORKER_CONCURRENCY ?? 1);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid QUIZ_VIDEO_WORKER_CONCURRENCY');

    const queue = createQuizVideoQueue();
    const worker = new Worker<{ quizVideoId: string }>(quizVideoQueueName, job => generateQuizVideo(prisma, job.data.quizVideoId, deps, {
        attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 3
    }), { concurrency });

    worker.on('error', error => logger.error({ queue: quizVideoQueueName, err: error.message }, 'Quiz video worker connection error'));
    queue.on('error', error => logger.error({ queue: quizVideoQueueName, err: error.message }, 'Quiz video queue connection error'));
    worker.on('failed', (job, error) => logger.warn({ queue: quizVideoQueueName, jobId: job?.id, quizVideoId: job?.data.quizVideoId, attemptsMade: job?.attemptsMade, err: error?.message }, 'Quiz video render attempt failed'));

    let stopping = false; let pending: Promise<void> | undefined;
    function dispatch() {
        if (stopping || pending) return;
        pending = dispatchQuizVideos(prisma, queue).catch(() => logger.error({ queue: quizVideoQueueName }, 'Quiz video dispatch unavailable; rows retained')).finally(() => { pending = undefined; });
    }
    const timer = setInterval(dispatch, 2000);
    dispatch();
    return { close: async () => { stopping = true; clearInterval(timer); await pending; await worker.close(); await queue.close(); } };
}
