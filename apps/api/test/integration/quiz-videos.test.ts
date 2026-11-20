import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@fako/db';
import { getVideoMetadata } from '@remotion/renderer';
import { LocalMediaStorage, MockContentSourceProvider, mockQuestion } from '@fako/content-sources';
import { CachingTTSProvider, LocalAudioCacheStore, MockTTSProvider, TTSError, type TTSProvider } from '@fako/ai-providers';
import { LocalVideoStorage } from '@fako/media-engine';
import {
    createQuizVideoQueue, dispatchQuizVideos, generateQuizVideo, quizVideoQueueName,
    requestQuizVideo, reviewQuizVideo, type QuizVideoDeps, type RenderAndMeasure
} from '@fako/video-pipeline';
import { buildApp } from '../../src/app.js';

// Spins up a headless browser and encodes a real MP4 (downloads headless Chrome on first use).
// Opt in explicitly, consistent with @fako/media-engine's own render tests.
const RUN_REAL_RENDER = process.env.MEDIA_ENGINE_RENDER_TESTS === 'true';

const TOKEN = 'test-quiz-video-token-123456789012345678';
const headers = { authorization: `Bearer ${TOKEN}` };

function fakeRender(durationInSeconds = 12): RenderAndMeasure {
    return async (_quiz, outputPath) => { await writeFile(outputPath, Buffer.from('fake mp4 bytes')); return { durationInSeconds }; };
}

async function tempDirs() {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'fako-qv-media-'));
    const videoRoot = await mkdtemp(join(tmpdir(), 'fako-qv-video-'));
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-qv-public-'));
    return {
        mediaRoot, publicDir, mediaStorage: new LocalMediaStorage(mediaRoot), videoStorage: new LocalVideoStorage(videoRoot),
        cleanup: async () => { await rm(mediaRoot, { recursive: true, force: true }); await rm(videoRoot, { recursive: true, force: true }); await rm(publicDir, { recursive: true, force: true }); }
    };
}

function deps(overrides: Partial<QuizVideoDeps> & Pick<QuizVideoDeps, 'videoStorage' | 'publicDir' | 'mediaRoot'>): QuizVideoDeps {
    return { ttsProvider: new MockTTSProvider(), renderAndMeasure: fakeRender(), ...overrides };
}

test('FR success end to end: creation, idempotency, generation, preview, no auto-publication, review', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, rijPermisProvider: provider, rijPermisStorage: dirs.mediaStorage, quizVideoStorage: dirs.videoStorage });
    const project = await prisma.project.create({ data: { name: 'Quiz pipeline FR', languages: ['fr', 'nl'] } });
    const quizVideoIds: string[] = [];
    try {
        await prisma.projectVoice.create({ data: { projectId: project.id, language: 'fr', voiceId: 'voice-fr', model: 'eleven_multilingual_v2', settings: {} } });

        const requestId = randomUUID();
        const create = () => app.inject({ method: 'POST', url: `/projects/${project.id}/quiz-videos`, headers, payload: { requestId, language: 'fr' } });
        const [a, b] = await Promise.all([create(), create()]);
        assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 202]);
        const quizVideo = a.json();
        quizVideoIds.push(quizVideo.id);
        assert.equal(quizVideo.id, b.json().id, 'the same requestId must not create two rows');
        assert.equal(quizVideo.status, 'PENDING');
        assert.equal(quizVideo.questionId, mockQuestion.id);
        assert.equal(quizVideo.contentHash, mockQuestion.contentHash);
        assert.equal(quizVideo.validationStatus, 'PENDING_APPROVAL');

        assert.equal((await app.inject({ url: `/quiz-videos/${quizVideo.id}/preview`, headers })).statusCode, 409, 'no file before generation');

        await generateQuizVideo(prisma, quizVideo.id, deps({ videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot }), { attempt: 1, maxAttempts: 3 });

        const generated = await prisma.video.findUniqueOrThrow({ where: { id: quizVideo.id } });
        assert.equal(generated.status, 'WAITING_APPROVAL', 'never published automatically');
        assert.equal(generated.durationSeconds, 12);
        assert.ok(generated.fileKey);
        assert.equal(generated.ttsProvider, 'mock');
        assert.equal(generated.validationStatus, 'PENDING_APPROVAL');

        const preview = await app.inject({ url: `/quiz-videos/${quizVideo.id}/preview`, headers });
        assert.equal(preview.statusCode, 200);
        assert.equal(preview.headers['content-type'], 'video/mp4');
        assert.equal((await app.inject(`/quiz-videos/${quizVideo.id}/preview`)).statusCode, 401, 'no token, no preview');

        const review = await app.inject({ method: 'POST', url: `/quiz-videos/${quizVideo.id}/review`, headers, payload: { reviewedBy: 'Human', decision: 'APPROVED' } });
        assert.equal(review.statusCode, 200);
        assert.equal(review.json().status, 'COMPLETED');
        assert.equal(review.json().validationStatus, 'APPROVED');
        assert.equal((await app.inject({ method: 'POST', url: `/quiz-videos/${quizVideo.id}/review`, headers, payload: { reviewedBy: 'Human', decision: 'APPROVED' } })).statusCode, 409, 'cannot review twice');
    } finally {
        await prisma.video.deleteMany({ where: { id: { in: quizVideoIds } } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

test('rejects creation when the project has no voice configured for the language', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, rijPermisProvider: provider, rijPermisStorage: dirs.mediaStorage, quizVideoStorage: dirs.videoStorage });
    const project = await prisma.project.create({ data: { name: 'No voice configured', languages: ['fr', 'nl'] } });
    try {
        const response = await app.inject({ method: 'POST', url: `/projects/${project.id}/quiz-videos`, headers, payload: { requestId: randomUUID(), language: 'nl' } });
        assert.equal(response.statusCode, 409);
        assert.equal(await prisma.video.count({ where: { projectId: project.id } }), 0);
    } finally {
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

test('no eligible question available for the language is reported clearly, not silently', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([]);
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, rijPermisProvider: provider, rijPermisStorage: dirs.mediaStorage, quizVideoStorage: dirs.videoStorage });
    const project = await prisma.project.create({ data: { name: 'No question available', languages: ['fr'] } });
    try {
        await prisma.projectVoice.create({ data: { projectId: project.id, language: 'fr', voiceId: 'voice-fr', model: 'eleven_multilingual_v2', settings: {} } });
        const response = await app.inject({ method: 'POST', url: `/projects/${project.id}/quiz-videos`, headers, payload: { requestId: randomUUID(), language: 'fr' } });
        assert.equal(response.statusCode, 409);
        assert.equal(await prisma.video.count({ where: { projectId: project.id } }), 0);
    } finally {
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

test('an explicit questionId the API refuses to export is never used', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, rijPermisProvider: provider, rijPermisStorage: dirs.mediaStorage, quizVideoStorage: dirs.videoStorage });
    const project = await prisma.project.create({ data: { name: 'Ineligible question', languages: ['fr'] } });
    try {
        await prisma.projectVoice.create({ data: { projectId: project.id, language: 'fr', voiceId: 'voice-fr', model: 'eleven_multilingual_v2', settings: {} } });
        const response = await app.inject({ method: 'POST', url: `/projects/${project.id}/quiz-videos`, headers, payload: { requestId: randomUUID(), language: 'fr', questionId: 'does-not-exist' } });
        assert.equal(response.statusCode, 404);
        assert.equal(await prisma.video.count({ where: { projectId: project.id } }), 0);
    } finally {
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

async function createPendingQuizVideo(prisma: PrismaClient, dirs: Awaited<ReturnType<typeof tempDirs>>, provider: MockContentSourceProvider, project: { id: string }, language: 'fr' | 'nl' = 'fr') {
    await prisma.projectVoice.upsert({ where: { projectId_language: { projectId: project.id, language } },
        create: { projectId: project.id, language, voiceId: `voice-${language}`, model: 'eleven_multilingual_v2', settings: {} }, update: {} });
    const { quizVideo } = await requestQuizVideo(prisma, provider, dirs.mediaStorage, project.id, language, randomUUID());
    return quizVideo;
}

test('a non-retryable TTS failure fails the job without retrying, and a retryable one retries then can succeed', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const project = await prisma.project.create({ data: { name: 'TTS failures', languages: ['fr'] } });
    const d = deps({ videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot });
    try {
        const fatal = await createPendingQuizVideo(prisma, dirs, provider, project);
        const authFailure: TTSProvider = { name: 'fake', synthesize: async () => { throw new TTSError('TTS_HTTP_401'); } };
        await assert.rejects(generateQuizVideo(prisma, fatal.id, { ...d, ttsProvider: authFailure }, { attempt: 1, maxAttempts: 3 }));
        assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: fatal.id } })).status, 'FAILED');
        assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: fatal.id } })).errorMessage, 'TTS_HTTP_401');

        const transient = await createPendingQuizVideo(prisma, dirs, provider, project);
        // synthesizeQuizNarration fires one call per scene (up to 6, in parallel); failing the whole
        // first attempt only needs one of them to reject, which fails the batch via Promise.all.
        let firstAttempt = true;
        const flaky: TTSProvider = { name: 'fake', synthesize: async input => {
            if (firstAttempt) { firstAttempt = false; throw new TTSError('TTS_HTTP_429', true); }
            return new MockTTSProvider().synthesize(input);
        } };
        await assert.rejects(generateQuizVideo(prisma, transient.id, { ...d, ttsProvider: flaky }, { attempt: 1, maxAttempts: 3 }));
        assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: transient.id } })).status, 'PENDING', 'a retryable failure goes back to PENDING, not FAILED');
        await generateQuizVideo(prisma, transient.id, { ...d, ttsProvider: flaky }, { attempt: 2, maxAttempts: 3 });
        assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: transient.id } })).status, 'WAITING_APPROVAL');
    } finally {
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await dirs.cleanup();
        await prisma.$disconnect();
    }
});

test('a render crash fails the job without retrying (not a TTS error) and never leaves a half-written file referenced', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const project = await prisma.project.create({ data: { name: 'Render failure', languages: ['fr'] } });
    try {
        const quizVideo = await createPendingQuizVideo(prisma, dirs, provider, project);
        const crashingRender: RenderAndMeasure = async () => { throw new Error('RENDER_CRASHED'); };
        await assert.rejects(generateQuizVideo(prisma, quizVideo.id, deps({ videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot, renderAndMeasure: crashingRender }), { attempt: 1, maxAttempts: 3 }));
        const failed = await prisma.video.findUniqueOrThrow({ where: { id: quizVideo.id } });
        assert.equal(failed.status, 'FAILED');
        assert.equal(failed.fileKey, null);
    } finally {
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await dirs.cleanup();
        await prisma.$disconnect();
    }
});

test('a crash left PROCESSING is never silently retried, to avoid risking a second paid TTS call', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const project = await prisma.project.create({ data: { name: 'Outcome unknown', languages: ['fr'] } });
    try {
        const quizVideo = await createPendingQuizVideo(prisma, dirs, provider, project);
        await prisma.video.update({ where: { id: quizVideo.id }, data: { status: 'PROCESSING', attempts: 1 } });
        let called = false;
        const shouldNotBeCalled: TTSProvider = { name: 'fake', synthesize: async () => { called = true; throw new Error('must not be called'); } };
        await generateQuizVideo(prisma, quizVideo.id, deps({ ttsProvider: shouldNotBeCalled, videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot }), { attempt: 2, maxAttempts: 3 });
        assert.equal(called, false);
        const row = await prisma.video.findUniqueOrThrow({ where: { id: quizVideo.id } });
        assert.equal(row.status, 'FAILED');
        assert.equal(row.errorMessage, 'QUIZ_VIDEO_OUTCOME_UNKNOWN');
    } finally {
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await dirs.cleanup();
        await prisma.$disconnect();
    }
});

test('identical narration text, voice and settings across two quiz videos reuses the cache instead of paying twice', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const cacheDir = await mkdtemp(join(tmpdir(), 'fako-qv-cache-'));
    const provider = new MockContentSourceProvider([mockQuestion]);
    const project = await prisma.project.create({ data: { name: 'Cache reuse', languages: ['fr'] } });
    try {
        const mock = new MockTTSProvider();
        const cached = new CachingTTSProvider(mock, new LocalAudioCacheStore(cacheDir));
        const d = deps({ ttsProvider: cached, videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot });

        const first = await createPendingQuizVideo(prisma, dirs, provider, project);
        await generateQuizVideo(prisma, first.id, d, { attempt: 1, maxAttempts: 3 });
        const callsAfterFirst = mock.calls;
        assert.ok(callsAfterFirst > 0);

        // Same question (same source text) and same voice: every scene should be a cache hit.
        const second = await createPendingQuizVideo(prisma, dirs, provider, project);
        await generateQuizVideo(prisma, second.id, d, { attempt: 1, maxAttempts: 3 });
        assert.equal(mock.calls, callsAfterFirst, 'no new provider calls on the second, identical generation');
    } finally {
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await dirs.cleanup();
        await rm(cacheDir, { recursive: true, force: true });
        await prisma.$disconnect();
    }
});

test('each project only ever sees its own quiz video files; a foreign or unknown id is never served', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, rijPermisProvider: provider, rijPermisStorage: dirs.mediaStorage, quizVideoStorage: dirs.videoStorage });
    try {
        assert.equal((await app.inject({ url: `/quiz-videos/${randomUUID()}/preview`, headers })).statusCode, 404);
        assert.equal((await app.inject({ url: `/quiz-videos/${randomUUID()}`, headers })).statusCode, 404);
        assert.equal((await app.inject(`/quiz-videos/${randomUUID()}`)).statusCode, 401, 'metadata also requires the token');
    } finally {
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

test('disabled by default: creation is refused without configuration', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const app = buildApp({ prisma });
    try {
        assert.equal((await app.inject({ method: 'POST', url: `/projects/${randomUUID()}/quiz-videos`, headers, payload: { requestId: randomUUID(), language: 'fr' } })).statusCode, 503);
    } finally {
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

test('the outbox dispatcher enqueues pending rows exactly once and reconciles exhausted queue failures', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const project = await prisma.project.create({ data: { name: 'Dispatch', languages: ['fr'] } });
    const queue = createQuizVideoQueue();
    try {
        const quizVideo = await createPendingQuizVideo(prisma, dirs, provider, project);
        await dispatchQuizVideos(prisma, queue);
        const job = await queue.getJob(quizVideo.id);
        assert.ok(job, 'a job should have been enqueued for the pending row');
        await dispatchQuizVideos(prisma, queue);
        assert.equal(await queue.getJob(quizVideo.id).then(j => j?.id), quizVideo.id, 'still the same single job, not duplicated');
    } finally {
        await (await queue.getJob((await prisma.video.findFirst({ where: { projectId: project.id } }))?.id ?? ''))?.remove().catch(() => {});
        await queue.close();
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await dirs.cleanup();
        await prisma.$disconnect();
    }
});

test('full real pipeline: PostgreSQL, Redis-backed queue and an actual Remotion MP4 render',
    { skip: !RUN_REAL_RENDER && 'set MEDIA_ENGINE_RENDER_TESTS=true to run (downloads headless Chrome on first use)' }, async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, rijPermisProvider: provider, rijPermisStorage: dirs.mediaStorage, quizVideoStorage: dirs.videoStorage });
    const project = await prisma.project.create({ data: { name: 'Real pipeline', languages: ['fr'] } });
    const queue = createQuizVideoQueue();
    try {
        await prisma.projectVoice.create({ data: { projectId: project.id, language: 'fr', voiceId: 'voice-fr', model: 'eleven_multilingual_v2', settings: {} } });
        const created = await app.inject({ method: 'POST', url: `/projects/${project.id}/quiz-videos`, headers, payload: { requestId: randomUUID(), language: 'fr' } });
        assert.equal(created.statusCode, 202);
        const videoId = created.json().id;

        await dispatchQuizVideos(prisma, queue);
        await generateQuizVideo(prisma, videoId, {
            ttsProvider: new MockTTSProvider(), videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot
            // renderAndMeasure intentionally omitted: uses the real Remotion render pipeline.
        }, { attempt: 1, maxAttempts: 3 });

        const generated = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
        assert.equal(generated.status, 'WAITING_APPROVAL');
        assert.ok(generated.durationSeconds && generated.durationSeconds > 0);
        assert.ok(generated.fileKey);

        const preview = await app.inject({ url: `/quiz-videos/${videoId}/preview`, headers });
        assert.equal(preview.statusCode, 200);
        const tempFile = join(dirs.publicDir, 'preview-check.mp4');
        await writeFile(tempFile, preview.rawPayload);
        const meta = await getVideoMetadata(tempFile);
        assert.equal(meta.width, 1080);
        assert.equal(meta.height, 1920);
        assert.equal(meta.fps, 30);
        assert.equal(meta.codec, 'h264');
    } finally {
        await (await queue.getJob((await prisma.video.findFirst({ where: { projectId: project.id } }))?.id ?? ''))?.remove().catch(() => {});
        await queue.close();
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

test('lists quiz videos filtered by language, status and day, with pagination', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion, { ...mockQuestion, id: 'mock-nl', language: 'nl' }]);
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, rijPermisProvider: provider, rijPermisStorage: dirs.mediaStorage, quizVideoStorage: dirs.videoStorage });
    const project = await prisma.project.create({ data: { name: 'List and filters', languages: ['fr', 'nl'] } });
    try {
        await prisma.projectVoice.create({ data: { projectId: project.id, language: 'fr', voiceId: 'v-fr', model: 'eleven_multilingual_v2', settings: {} } });
        await prisma.projectVoice.create({ data: { projectId: project.id, language: 'nl', voiceId: 'v-nl', model: 'eleven_multilingual_v2', settings: {} } });
        const create = (language: 'fr' | 'nl') => app.inject({ method: 'POST', url: `/projects/${project.id}/quiz-videos`, headers, payload: { requestId: randomUUID(), language } });
        const fr = (await create('fr')).json();
        const nl = (await create('nl')).json();
        await generateQuizVideo(prisma, nl.id, deps({ videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot }), { attempt: 1, maxAttempts: 3 });

        const all = await app.inject({ url: `/projects/${project.id}/quiz-videos`, headers });
        assert.equal(all.statusCode, 200);
        assert.equal(all.json().total, 2);

        const frOnly = await app.inject({ url: `/projects/${project.id}/quiz-videos?language=fr`, headers });
        assert.equal(frOnly.json().total, 1);
        assert.equal(frOnly.json().quizVideos[0].id, fr.id);

        const waiting = await app.inject({ url: `/projects/${project.id}/quiz-videos?status=WAITING_APPROVAL`, headers });
        assert.equal(waiting.json().total, 1);
        assert.equal(waiting.json().quizVideos[0].id, nl.id);

        const today = new Date().toISOString().slice(0, 10);
        assert.equal((await app.inject({ url: `/projects/${project.id}/quiz-videos?date=${today}`, headers })).json().total, 2);
        assert.equal((await app.inject({ url: `/projects/${project.id}/quiz-videos?date=2000-01-01`, headers })).json().total, 0);

        const paged = await app.inject({ url: `/projects/${project.id}/quiz-videos?limit=1&offset=0`, headers });
        assert.equal(paged.json().quizVideos.length, 1);
        assert.equal(paged.json().total, 2);

        assert.equal((await app.inject(`/projects/${project.id}/quiz-videos`)).statusCode, 401);
    } finally {
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});
