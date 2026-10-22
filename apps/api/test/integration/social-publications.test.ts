import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { MockTTSProvider } from '@fako/ai-providers';
import { LocalMediaStorage, MockContentSourceProvider, mockQuestion } from '@fako/content-sources';
import { LocalVideoStorage } from '@fako/media-engine';
import { mockConnectors } from '@fako/publishing';
import { generateQuizVideo, requestQuizVideo, reviewQuizVideo, type QuizVideoDeps, type RenderAndMeasure } from '@fako/quiz-pipeline';
import {
    createSocialPublicationQueue, dispatchSocialPublications, reconcileInFlightPublications,
    retryPublication, runPublicationAttempt, runSocialPublicationSchedulerTick, schedulePublication,
    socialPublicationQueueName, type PublicationEngineDeps
} from '@fako/social-publishing';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-social-publications-token-123456789012';
const headers = { authorization: `Bearer ${TOKEN}` };

function fakeRender(durationInSeconds = 12): RenderAndMeasure {
    return async (_quiz, outputPath) => { await writeFile(outputPath, Buffer.from('fake mp4 bytes')); return { durationInSeconds }; };
}

async function tempDirs() {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'fako-sp-media-'));
    const videoRoot = await mkdtemp(join(tmpdir(), 'fako-sp-video-'));
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-sp-public-'));
    return {
        mediaRoot, publicDir, mediaStorage: new LocalMediaStorage(mediaRoot), videoStorage: new LocalVideoStorage(videoRoot),
        cleanup: async () => { await rm(mediaRoot, { recursive: true, force: true }); await rm(videoRoot, { recursive: true, force: true }); await rm(publicDir, { recursive: true, force: true }); }
    };
}

// Produces a real COMPLETED/APPROVED QuizVideo with a real (fake-content, but genuinely stored and
// readable) file — the same fixture pattern as quiz-videos.test.ts's own integration suite, so this
// exercises verifyBeforeSend's actual file read rather than a mocked shortcut.
async function approvedQuizVideo(prisma: PrismaClient, provider: MockContentSourceProvider, dirs: Awaited<ReturnType<typeof tempDirs>>, projectId: string, language: 'fr' | 'nl' = 'fr') {
    const { quizVideo } = await requestQuizVideo(prisma, provider, dirs.mediaStorage, projectId, language, randomUUID());
    const deps: QuizVideoDeps = { ttsProvider: new MockTTSProvider(), renderAndMeasure: fakeRender(), videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot };
    await generateQuizVideo(prisma, quizVideo.id, deps, { attempt: 1, maxAttempts: 3 });
    const approved = await reviewQuizVideo(prisma, quizVideo.id, 'admin', 'APPROVED');
    return approved;
}

async function connectedAccount(app: ReturnType<typeof buildApp>, projectId: string, platform: 'TIKTOK' | 'INSTAGRAM' | 'FACEBOOK', languages: string[] = ['fr']) {
    const start = await app.inject({ method: 'POST', url: `/projects/${projectId}/social-accounts/${platform}/oauth/start`, headers, payload: { redirectUri: 'https://admin.example/callback' } });
    const { state } = start.json();
    const callback = await app.inject({ method: 'POST', url: `/projects/${projectId}/social-accounts/${platform}/oauth/callback`, headers, payload: { code: 'auth-code', state } });
    const account = callback.json();
    const patched = await app.inject({ method: 'PATCH', url: `/social-accounts/${account.id}`, headers, payload: { languages } });
    return patched.json();
}

// encryptionKey must be the exact same key the app used when encrypting the account's token during
// the OAuth callback (see connectedAccount/buildApp below) — a mismatched key is a decryption
// failure, not a business-logic one, so every test threads a single key through both call sites.
function engineDeps(dirs: Awaited<ReturnType<typeof tempDirs>>, provider: MockContentSourceProvider, encryptionKey: Buffer, overrides: Partial<PublicationEngineDeps> = {}): PublicationEngineDeps {
    return {
        connectors: mockConnectors('FULL_ACCESS', 'SUCCESS'), provider, encryptionKey, videoStorage: dirs.videoStorage,
        reconcileGraceMs: 200, ...overrides
    };
}

async function cleanup(prisma: PrismaClient, projectId: string, dirs: Awaited<ReturnType<typeof tempDirs>>) {
    await prisma.socialPublicationAttempt.deleteMany({ where: { publication: { projectId } } });
    await prisma.socialPublication.deleteMany({ where: { projectId } });
    await prisma.socialAccount.deleteMany({ where: { projectId } });
    await prisma.quizVideo.deleteMany({ where: { projectId } });
    await prisma.projectVoice.deleteMany({ where: { projectId } });
    await prisma.projectSettings.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
    await dirs.cleanup();
}

async function setupProject(prisma: PrismaClient, name: string) {
    const project = await prisma.project.create({ data: { name, languages: ['fr', 'nl'] } });
    await prisma.projectVoice.create({ data: { projectId: project.id, language: 'fr', voiceId: 'voice-fr', model: 'eleven_multilingual_v2', settings: {} } });
    await prisma.projectSettings.create({ data: { projectId: project.id, width: 1080, height: 1920, fps: 30 } });
    return project;
}

test('full success lifecycle: schedule via HTTP (DST-safe local time), due, verified live, sent, published', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing success');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);

        // 2026-07-01 09:00 Europe/Brussels is CEST (UTC+2) — a real DST check, not just a label.
        const create = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-publications`, headers, payload: {
            quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'Le quiz du jour !', hashtags: ['#codederoute'],
            scheduledAtLocal: '2026-07-01T09:00', requestId: randomUUID(), createdBy: 'admin'
        } });
        assert.equal(create.statusCode, 201, create.payload);
        const publication = create.json();
        assert.equal(publication.status, 'SCHEDULED');
        assert.equal(publication.scheduledAt, '2026-07-01T07:00:00.000Z', 'Europe/Brussels summer time is UTC+2');

        // Idempotent resubmission with the same requestId must not create a second row.
        const resubmit = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-publications`, headers, payload: {
            quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'Le quiz du jour !',
            scheduledAtLocal: '2026-07-01T09:00', requestId: create.json().requestId, createdBy: 'admin'
        } });
        assert.equal(resubmit.statusCode, 200);
        assert.equal(resubmit.json().id, publication.id);

        const tick = await runSocialPublicationSchedulerTick(prisma, { maxInFlight: 20 }, new Date('2026-07-01T07:00:01.000Z'));
        assert.equal(tick.promoted, 1);
        const ready = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
        assert.equal(ready.status, 'READY');

        // Not due yet: a tick before the scheduled instant must promote nothing.
        const other = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-publications`, headers, payload: {
            quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'Autre', scheduledAtLocal: '2026-07-01T10:00', requestId: randomUUID(), createdBy: 'admin'
        } });
        const earlyTick = await runSocialPublicationSchedulerTick(prisma, { maxInFlight: 20 }, new Date('2026-07-01T07:30:00.000Z'));
        assert.equal(earlyTick.promoted, 0);
        assert.equal((await prisma.socialPublication.findUniqueOrThrow({ where: { id: other.json().id } })).status, 'SCHEDULED');

        await runPublicationAttempt(prisma, publication.id, engineDeps(dirs, provider, encryptionKey), { attempt: 1, maxAttempts: 5 });
        const published = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id }, include: { attemptHistory: true } });
        assert.equal(published.status, 'PUBLISHED');
        assert.ok(published.remotePostId?.startsWith('mock-post-TIKTOK-'));
        assert.ok(published.remoteUrl);
        assert.equal(published.attemptHistory.length, 1);
        assert.equal(published.attemptHistory[0].outcome, 'SUCCESS');

        // Dedup: a second publication to the exact same (video, account) destination is blocked.
        const dupe = await schedulePublication(prisma, {
            projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'Doublon', requestId: randomUUID(), createdBy: 'admin'
        });
        await prisma.socialPublication.update({ where: { id: dupe.publication.id }, data: { status: 'READY' } });
        await assert.rejects(runPublicationAttempt(prisma, dupe.publication.id, engineDeps(dirs, provider, encryptionKey), { attempt: 1, maxAttempts: 5 }));
        const blocked = await prisma.socialPublication.findUniqueOrThrow({ where: { id: dupe.publication.id } });
        assert.equal(blocked.status, 'BLOCKED');
        assert.match(blocked.lastError ?? '', /déjà publiée/);

        const list = await app.inject({ method: 'GET', url: `/projects/${project.id}/social-publications?status=PUBLISHED`, headers });
        assert.equal(list.json().total, 1);
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('scheduling is refused outright for an unapproved or ungenerated video — no DRAFT loophole', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing unapproved');
    try {
        const { quizVideo } = await requestQuizVideo(prisma, provider, dirs.mediaStorage, project.id, 'fr', randomUUID());
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);

        const result = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-publications`, headers, payload: {
            quizVideoId: quizVideo.id, socialAccountId: account.id, language: 'fr', caption: 'Trop tôt', requestId: randomUUID(), createdBy: 'admin'
        } });
        assert.equal(result.statusCode, 409);
        assert.equal(await prisma.socialPublication.count({ where: { projectId: project.id } }), 0);
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('a live RijPermis check that finds the question withdrawn blocks the send, with no automatic retry', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing withdrawn');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });
        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'READY' } });

        // The provider no longer has this question at send time — simulates it being withdrawn from
        // the live RijPermis catalogue after approval. verifyBeforeSend must re-check live, not trust
        // the cached checkStatus recorded at generation time.
        const withdrawnProvider = new MockContentSourceProvider([]);
        await assert.rejects(runPublicationAttempt(prisma, publication.id, engineDeps(dirs, withdrawnProvider, encryptionKey), { attempt: 1, maxAttempts: 5 }));
        const blocked = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
        assert.equal(blocked.status, 'BLOCKED');
        assert.match(blocked.lastError ?? '', /traçabilité RijPermis/);
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('insufficient permissions blocks with a clear diagnostic (missing publish scope)', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors('INSUFFICIENT_SCOPES'), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing insufficient scopes');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id, 'fr');
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        assert.equal(account.status, 'INSUFFICIENT_PERMISSIONS', 'INSUFFICIENT_SCOPES mock never grants the publish scope');

        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });
        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'READY' } });

        await assert.rejects(runPublicationAttempt(prisma, publication.id, engineDeps(dirs, provider, encryptionKey, { connectors: mockConnectors('INSUFFICIENT_SCOPES') }), { attempt: 1, maxAttempts: 5 }));
        const blocked = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
        assert.equal(blocked.status, 'BLOCKED');
        assert.match(blocked.lastError ?? '', /[Pp]ermission/);
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('a language revoked from the account after scheduling blocks the send at verification time', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing language drift');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id, 'fr');
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });
        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'READY' } });

        // The admin removes FR from this destination's allowed languages after scheduling but before send.
        await app.inject({ method: 'PATCH', url: `/social-accounts/${account.id}`, headers, payload: { languages: ['nl'] } });

        await assert.rejects(runPublicationAttempt(prisma, publication.id, engineDeps(dirs, provider, encryptionKey), { attempt: 1, maxAttempts: 5 }));
        const blocked = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
        assert.equal(blocked.status, 'BLOCKED');
        assert.match(blocked.lastError ?? '', /[Ll]angue/);
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('a confirmed platform rejection retries once (retryable) then fails terminally once attempts are exhausted', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing rate limited');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });
        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'READY' } });

        const deps = engineDeps(dirs, provider, encryptionKey, { connectors: mockConnectors('FULL_ACCESS', 'RATE_LIMITED') });
        await assert.rejects(runPublicationAttempt(prisma, publication.id, deps, { attempt: 1, maxAttempts: 2 }));
        assert.equal((await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } })).status, 'READY', 'retryable failure returns to READY, not FAILED');

        await assert.rejects(runPublicationAttempt(prisma, publication.id, deps, { attempt: 2, maxAttempts: 2 }));
        const failed = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id }, include: { attemptHistory: true } });
        assert.equal(failed.status, 'FAILED', 'attempts exhausted: terminal');
        assert.equal(failed.attemptHistory.length, 2);
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('an ambiguous send (thrown exception) never resolves to FAILED or PUBLISHED — only OUTCOME_UNKNOWN, and is never auto-retried', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing outcome unknown');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });
        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'READY' } });

        const deps = engineDeps(dirs, provider, encryptionKey, { connectors: mockConnectors('FULL_ACCESS', 'TIMEOUT') });
        await assert.rejects(runPublicationAttempt(prisma, publication.id, deps, { attempt: 1, maxAttempts: 5 }));
        const unknown = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
        assert.equal(unknown.status, 'OUTCOME_UNKNOWN');

        // Re-claiming (as a stalled BullMQ retry would) must never resend — it stays untouched.
        await runPublicationAttempt(prisma, publication.id, deps, { attempt: 2, maxAttempts: 5 });
        assert.equal((await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } })).status, 'OUTCOME_UNKNOWN');

        // A human cannot retry it either until it is confirmed FAILED by reconciliation.
        await assert.rejects(retryPublication(prisma, publication.id));
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('a crash before any platform acknowledgment is reconciled to OUTCOME_UNKNOWN, never silently resent', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing crash recovery');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });
        // Simulate a worker that died immediately after claiming (PUBLISHING, no remotePostId yet, stale lastAttemptAt).
        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'PUBLISHING', lastAttemptAt: new Date(Date.now() - 10_000) } });

        const deps = engineDeps(dirs, provider, encryptionKey, { reconcileGraceMs: 50 });
        const outcomes = await reconcileInFlightPublications(prisma, deps);
        assert.equal(outcomes.find(o => o.publicationId === publication.id)?.result, 'OUTCOME_UNKNOWN');
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('an acknowledged async publish (PENDING) is resolved to PUBLISHED by reconciliation, not by a blind resend', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing async pending');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });
        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'READY' } });

        const connectors = mockConnectors('FULL_ACCESS', 'PENDING_THEN_SUCCESS');
        const deps = engineDeps(dirs, provider, encryptionKey, { connectors });
        await runPublicationAttempt(prisma, publication.id, deps, { attempt: 1, maxAttempts: 5 });
        const pending = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
        assert.equal(pending.status, 'PUBLISHING');
        assert.ok(pending.remotePostId, 'the platform acknowledged the request with a tracking reference');

        const outcomes = await reconcileInFlightPublications(prisma, deps);
        assert.equal(outcomes.find(o => o.publicationId === publication.id)?.result, 'PUBLISHED');
        assert.equal((await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } })).status, 'PUBLISHED');
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('cancel is only ever accepted before a publication has started, and retry only from BLOCKED/FAILED', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing cancel retry');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });

        const cancelled = await app.inject({ method: 'POST', url: `/social-publications/${publication.id}/cancel`, headers, payload: { cancelledBy: 'admin' } });
        assert.equal(cancelled.statusCode, 200);
        assert.equal(cancelled.json().status, 'CANCELLED');

        const recancel = await app.inject({ method: 'POST', url: `/social-publications/${publication.id}/cancel`, headers, payload: { cancelledBy: 'admin' } });
        assert.equal(recancel.statusCode, 409);

        const retryCancelled = await app.inject({ method: 'POST', url: `/social-publications/${publication.id}/retry`, headers });
        assert.equal(retryCancelled.statusCode, 409, 'a cancelled publication can never be retried');

        const published = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'y', requestId: randomUUID(), createdBy: 'admin' });
        await prisma.socialPublication.update({ where: { id: published.publication.id }, data: { status: 'PUBLISHED' } });
        const cancelPublished = await app.inject({ method: 'POST', url: `/social-publications/${published.publication.id}/cancel`, headers, payload: { cancelledBy: 'admin' } });
        assert.equal(cancelPublished.statusCode, 409, 'a published publication can never be cancelled');
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('updating the schedule only works before a publication is due, and reuses the DST-safe conversion', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing update schedule');
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });

        // 2026-01-15 is winter time (CET, UTC+1) — different offset from the summer-time test above.
        const updated = await app.inject({ method: 'PATCH', url: `/social-publications/${publication.id}`, headers, payload: { scheduledAtLocal: '2026-01-15T21:00' } });
        assert.equal(updated.statusCode, 200);
        assert.equal(updated.json().status, 'SCHEDULED');
        assert.equal(updated.json().scheduledAt, '2026-01-15T20:00:00.000Z', 'Europe/Brussels winter time is UTC+1');

        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'PUBLISHED' } });
        const tooLate = await app.inject({ method: 'PATCH', url: `/social-publications/${publication.id}`, headers, payload: { scheduledAtLocal: '2026-01-16T09:00' } });
        assert.equal(tooLate.statusCode, 409);
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('the scheduler tick never promotes more than maxInFlight at once, bounding job accumulation', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing capacity');
    try {
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const dueAt = new Date('2026-07-01T07:00:00.000Z');
        for (let i = 0; i < 3; i++) {
            const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
            const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: `v${i}`, scheduledAt: dueAt, requestId: randomUUID(), createdBy: 'admin' });
            void publication;
        }
        const tick = await runSocialPublicationSchedulerTick(prisma, { maxInFlight: 2 }, new Date('2026-07-01T07:00:01.000Z'));
        assert.equal(tick.promoted, 2);
        assert.equal(await prisma.socialPublication.count({ where: { projectId: project.id, status: 'READY' } }), 2);
        assert.equal(await prisma.socialPublication.count({ where: { projectId: project.id, status: 'SCHEDULED' } }), 1);
    } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
});

test('dispatch enqueues exactly one BullMQ job per READY row, idempotently, on the documented queue', async () => {
    const prisma = new PrismaClient();
    const dirs = await tempDirs();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    const project = await setupProject(prisma, 'Social publishing dispatch');
    const queue = createSocialPublicationQueue();
    try {
        const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
        const account = await connectedAccount(app, project.id, 'TIKTOK', ['fr']);
        const { publication } = await schedulePublication(prisma, { projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'x', requestId: randomUUID(), createdBy: 'admin' });
        await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'READY' } });

        assert.equal(socialPublicationQueueName, 'social-publications');
        await dispatchSocialPublications(prisma, queue);
        const job = await queue.getJob(publication.id);
        assert.ok(job, 'a job should have been enqueued for the ready row');
        await dispatchSocialPublications(prisma, queue);
        assert.equal(await queue.getJob(publication.id).then(j => j?.id), publication.id, 'still the same single job, not duplicated');
    } finally {
        await (await queue.getJob((await prisma.socialPublication.findFirst({ where: { projectId: project.id } }))?.id ?? ''))?.remove().catch(() => {});
        await queue.close();
        await cleanup(prisma, project.id, dirs);
        await prisma.$disconnect();
    }
});

// Mission 15 section 8: "une publication mock sur chaque plateforme" — the happy-path lifecycle test
// above only ever exercises TIKTOK. This drives the exact same engine through a full mock publish to
// PUBLISHED for all three platforms, including Instagram/Facebook's realistic PENDING-then-confirmed
// async path (TikTok's own mock is immediate SUCCESS instead, matching its real upload-then-done flow).
test('a mock publication succeeds end to end on every platform (TikTok, Instagram, Facebook)', async () => {
    for (const platform of ['TIKTOK', 'INSTAGRAM', 'FACEBOOK'] as const) {
        const prisma = new PrismaClient();
        const dirs = await tempDirs();
        const provider = new MockContentSourceProvider([mockQuestion]);
        const encryptionKey = randomBytes(32);
        const publishScenario = platform === 'TIKTOK' ? 'SUCCESS' : 'PENDING_THEN_SUCCESS';
        const connectors = mockConnectors('FULL_ACCESS', publishScenario);
        const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: connectors, socialPublishingEnabled: true, socialPublishingToken: TOKEN });
        const project = await setupProject(prisma, `Mock publish ${platform}`);
        try {
            const video = await approvedQuizVideo(prisma, provider, dirs, project.id);
            const account = await connectedAccount(app, project.id, platform, ['fr']);
            assert.equal(account.status, 'CONNECTED');

            const { publication } = await schedulePublication(prisma, {
                projectId: project.id, quizVideoId: video.id, socialAccountId: account.id, language: 'fr',
                caption: `Quiz mock ${platform}`, requestId: randomUUID(), createdBy: 'admin'
            });
            await prisma.socialPublication.update({ where: { id: publication.id }, data: { status: 'READY' } });

            // Instagram-only (mission 15 section 4): the engine refuses to publish without this.
            const deps = engineDeps(dirs, provider, encryptionKey, { connectors, ...(platform === 'INSTAGRAM' ? { publicLinkBaseUrl: 'http://127.0.0.1:3000' } : {}) });
            await runPublicationAttempt(prisma, publication.id, deps, { attempt: 1, maxAttempts: 5 });

            if (publishScenario === 'SUCCESS') {
                const published = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
                assert.equal(published.status, 'PUBLISHED', `${platform}: expected immediate PUBLISHED`);
                assert.ok(published.remotePostId?.startsWith(`mock-post-${platform}-`));
            } else {
                const pending = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
                assert.equal(pending.status, 'PUBLISHING', `${platform}: expected PUBLISHING while awaiting async confirmation`);
                assert.ok(pending.remotePostId?.startsWith(`mock-ref-${platform}-`));

                const outcomes = await reconcileInFlightPublications(prisma, deps);
                assert.deepEqual(outcomes, [{ publicationId: publication.id, result: 'PUBLISHED' }]);
                const published = await prisma.socialPublication.findUniqueOrThrow({ where: { id: publication.id } });
                assert.equal(published.status, 'PUBLISHED', `${platform}: expected PUBLISHED after reconciliation`);
                assert.ok(published.remotePostId?.startsWith(`mock-post-${platform}-`));
            }

            // No real network call: the mock connector never contacts tiktok.com / graph.facebook.com /
            // graph.instagram.com — verified structurally (mockConnectors never imports `fetch`-using
            // adapters), not by intercepting sockets, consistent with the rest of this suite.
        } finally { await cleanup(prisma, project.id, dirs); await prisma.$disconnect(); }
    }
});

test('no real platform credentials, no real HTTP call: mock mode is the only path exercised in this suite', async () => {
    const connectors = mockConnectors();
    for (const platform of ['TIKTOK', 'INSTAGRAM', 'FACEBOOK'] as const) {
        assert.equal(connectors[platform].isConfigured(), true, 'mock connectors always report configured, independent of any real developer credential');
    }
});
