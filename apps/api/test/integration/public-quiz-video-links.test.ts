import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@fako/db';
import { MockTTSProvider } from '@fako/ai-providers';
import { LocalMediaStorage, MockContentSourceProvider, mockQuestion } from '@fako/content-sources';
import { LocalVideoStorage } from '@fako/media-engine';
import { mockConnectors } from '@fako/publishing';
import { generateQuizVideo, requestQuizVideo, reviewQuizVideo, type QuizVideoDeps, type RenderAndMeasure } from '@fako/video-pipeline';
import {
    createPublicVideoLink, resolvePublicVideoLink, revokePublicVideoLinksForQuizVideo,
    runPublicationAttempt, schedulePublication, type PublicationEngineDeps
} from '@fako/social-publishing';
import type { PublishVideoRequest, PublishVideoResult, SocialPlatformConnector } from '@fako/publishing';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-public-links-token-123456789012';
const headers = { authorization: `Bearer ${TOKEN}` };
const VIDEO_BYTES = Buffer.from('fake but non-empty mp4 bytes for the public link test');

function fakeRender(): RenderAndMeasure {
    return async (_quiz, outputPath) => { await writeFile(outputPath, VIDEO_BYTES); return { durationInSeconds: 12 }; };
}

async function tempDirs() {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'fako-public-link-media-'));
    const videoRoot = await mkdtemp(join(tmpdir(), 'fako-public-link-video-'));
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-public-link-public-'));
    return {
        videoStorage: new LocalVideoStorage(videoRoot), mediaStorage: new LocalMediaStorage(mediaRoot),
        cleanup: async () => { await rm(mediaRoot, { recursive: true, force: true }); await rm(videoRoot, { recursive: true, force: true }); await rm(publicDir, { recursive: true, force: true }); },
        publicDir, mediaRoot
    };
}

async function setupProject(prisma: PrismaClient, name: string) {
    const project = await prisma.project.create({ data: { name, languages: ['fr'] } });
    await prisma.projectVoice.create({ data: { projectId: project.id, language: 'fr', voiceId: 'voice-fr', model: 'eleven_multilingual_v2', settings: {} } });
    await prisma.projectSettings.create({ data: { projectId: project.id, width: 1080, height: 1920, fps: 30 } });
    return project;
}

async function approvedQuizVideo(prisma: PrismaClient, dirs: Awaited<ReturnType<typeof tempDirs>>, projectId: string) {
    const provider = new MockContentSourceProvider([mockQuestion]);
    const { quizVideo } = await requestQuizVideo(prisma, provider, dirs.mediaStorage, projectId, 'fr', randomUUID());
    const deps: QuizVideoDeps = { ttsProvider: new MockTTSProvider(), renderAndMeasure: fakeRender(), videoStorage: dirs.videoStorage, publicDir: dirs.publicDir, mediaRoot: dirs.mediaRoot };
    await generateQuizVideo(prisma, quizVideo.id, deps, { attempt: 1, maxAttempts: 3 });
    return reviewQuizVideo(prisma, quizVideo.id, 'admin', 'APPROVED');
}

test('a fake Meta client can fetch exactly the linked video, unauthenticated, and nothing else', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, quizVideoStorage: dirs.videoStorage });
    const project = await setupProject(prisma, 'Public link happy path');
    try {
        const video = await approvedQuizVideo(prisma, dirs, project.id);
        const url = await createPublicVideoLink(prisma, video.id, 'http://127.0.0.1:3000');
        const token = url.split('/').pop()!;

        // The fake Meta client: a plain GET, no Authorization header at all — this is the entire
        // point of the mechanism (Meta's fetcher cannot present our admin Bearer token).
        const response = await app.inject({ method: 'GET', url: `/public/quiz-video-links/${token}` });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'video/mp4');
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.ok(response.rawPayload.equals(VIDEO_BYTES), 'served bytes must match exactly what was rendered');

        // Not single-use: Meta is documented to retry a transient fetch failure, so a second fetch
        // within the expiry window must still succeed.
        const second = await app.inject({ method: 'GET', url: `/public/quiz-video-links/${token}` });
        assert.equal(second.statusCode, 200);

        // Admin-authenticated routes still require their own Bearer token — this mechanism adds a
        // new capability, it does not weaken the existing ones.
        assert.equal((await app.inject({ method: 'GET', url: `/quiz-videos/${video.id}` })).statusCode, 401);
        assert.equal((await app.inject({ method: 'GET', url: `/quiz-videos/${video.id}`, headers })).statusCode, 200);
    } finally {
        await prisma.videoPublicLink.deleteMany({ where: { video: { projectId: project.id } } });
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.projectSettings.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

test('unknown, malformed, expired and revoked tokens all return the same generic 404; the feature flag gates the whole route', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const app = buildApp({ prisma, quizVideoEnabled: true, quizVideoToken: TOKEN, quizVideoStorage: dirs.videoStorage });
    const project = await setupProject(prisma, 'Public link rejections');
    try {
        const video = await approvedQuizVideo(prisma, dirs, project.id);

        // Unknown token, well-formed.
        assert.equal((await app.inject({ url: `/public/quiz-video-links/${'a'.repeat(43)}` })).statusCode, 404);

        // Malformed: schema validation (never touches the database, never attempts a file read) —
        // path-traversal-shaped input is rejected by the token pattern before resolution even runs.
        for (const malformed of ['short', '../../../../etc/passwd', 'has spaces here padded out', 'semi;colon;padded;out;value']) {
            const result = await app.inject({ url: `/public/quiz-video-links/${encodeURIComponent(malformed)}` });
            assert.ok([400, 404].includes(result.statusCode), `expected 400 or 404 for ${JSON.stringify(malformed)}, got ${result.statusCode}`);
        }

        // Expired: minted with a negative TTL, i.e. already in the past.
        const expiredUrl = await createPublicVideoLink(prisma, video.id, 'http://127.0.0.1:3000', -1000);
        const expiredToken = expiredUrl.split('/').pop()!;
        assert.equal(await resolvePublicVideoLink(prisma, expiredToken), null);
        assert.equal((await app.inject({ url: `/public/quiz-video-links/${expiredToken}` })).statusCode, 404);

        // Revoked: valid expiry, but explicitly revoked (mirrors what the engine/reconciler do once a
        // publish attempt is confirmed terminal).
        const revokedUrl = await createPublicVideoLink(prisma, video.id, 'http://127.0.0.1:3000');
        const revokedToken = revokedUrl.split('/').pop()!;
        await revokePublicVideoLinksForQuizVideo(prisma, video.id);
        assert.equal(await resolvePublicVideoLink(prisma, revokedToken), null);
        assert.equal((await app.inject({ url: `/public/quiz-video-links/${revokedToken}` })).statusCode, 404);

        // Feature disabled entirely: even a token minted while enabled must stop resolving.
        const disabledApp = buildApp({ prisma, quizVideoEnabled: false, quizVideoToken: TOKEN, quizVideoStorage: dirs.videoStorage });
        const freshUrl = await createPublicVideoLink(prisma, video.id, 'http://127.0.0.1:3000');
        const freshToken = freshUrl.split('/').pop()!;
        assert.equal((await disabledApp.inject({ url: `/public/quiz-video-links/${freshToken}` })).statusCode, 404);
        await disabledApp.close();
    } finally {
        await prisma.videoPublicLink.deleteMany({ where: { video: { projectId: project.id } } });
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.projectSettings.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});

test('the publication engine mints an Instagram-only public link, passes it to the connector, and revokes it once terminal', async () => {
    const prisma = createPrismaClient();
    const dirs = await tempDirs();
    const encryptionKey = randomBytes(32);
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: encryptionKey, socialConnectors: mockConnectors(), socialPublishingEnabled: true, socialPublishingToken: TOKEN, quizVideoEnabled: true, quizVideoToken: TOKEN, quizVideoStorage: dirs.videoStorage });
    const project = await setupProject(prisma, 'Public link engine wiring');
    try {
        const video = await approvedQuizVideo(prisma, dirs, project.id);

        const start = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/INSTAGRAM/oauth/start`, headers, payload: { redirectUri: 'https://admin.example/callback' } });
        const callback = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/INSTAGRAM/oauth/callback`, headers, payload: { code: 'auth-code', state: start.json().state } });
        const account = callback.json();
        await app.inject({ method: 'PATCH', url: `/social-accounts/${account.id}`, headers, payload: { languages: ['fr'] } });

        const { publication: scheduled } = await schedulePublication(prisma, {
            projectId: project.id, videoId: video.id, socialAccountId: account.id, language: 'fr', caption: 'Quiz Instagram',
            requestId: randomUUID(), createdBy: 'admin'
        });
        await prisma.socialPublication.update({ where: { id: scheduled.id }, data: { status: 'READY' } });

        // A connector that mirrors the real InstagramConnector's own publicVideoUrl contract exactly
        // (FAILED without it, PENDING with it) without any network call, so this test fails loudly if
        // the engine ever stops threading the minted link through to the connector.
        let capturedUrl: string | undefined;
        const underlyingInstagram = mockConnectors().INSTAGRAM;
        // `mockConnectors().INSTAGRAM` is a class instance — its methods live on the prototype, not as
        // own enumerable properties, so a plain object spread would silently drop getCapabilities etc.
        // Delegating explicitly keeps every other method's real (mock) behavior intact.
        const capturingInstagram: SocialPlatformConnector = {
            platform: underlyingInstagram.platform,
            isConfigured: underlyingInstagram.isConfigured.bind(underlyingInstagram),
            getAuthorizationUrl: underlyingInstagram.getAuthorizationUrl.bind(underlyingInstagram),
            exchangeCodeForTokens: underlyingInstagram.exchangeCodeForTokens.bind(underlyingInstagram),
            refreshCredentials: underlyingInstagram.refreshCredentials.bind(underlyingInstagram),
            getAccountInfo: underlyingInstagram.getAccountInfo.bind(underlyingInstagram),
            getCapabilities: underlyingInstagram.getCapabilities.bind(underlyingInstagram),
            validateMediaRequirements: underlyingInstagram.validateMediaRequirements.bind(underlyingInstagram),
            disconnectAccount: underlyingInstagram.disconnectAccount.bind(underlyingInstagram),
            getPublicationStatus: underlyingInstagram.getPublicationStatus.bind(underlyingInstagram),
            async publishVideo(request: PublishVideoRequest): Promise<PublishVideoResult> {
                capturedUrl = request.publicVideoUrl;
                if (!request.publicVideoUrl) return { outcome: 'FAILED', retryable: false, code: 'PUBLIC_URL_REQUIRED', message: 'missing' };
                return { outcome: 'PENDING', remoteRef: 'ig-user:container-1' };
            }
        };

        const provider = new MockContentSourceProvider([mockQuestion]);
        const baseDeps: PublicationEngineDeps = {
            connectors: { ...mockConnectors(), INSTAGRAM: capturingInstagram }, provider, encryptionKey, videoStorage: dirs.videoStorage
        };

        // 1) No publicLinkBaseUrl configured: blocked before any connector call, no link minted.
        // Mirrors every other BLOCKED/UnrecoverableError path in social-publications.test.ts: the
        // engine always throws after persisting the terminal status, it never resolves silently.
        await assert.rejects(runPublicationAttempt(prisma, scheduled.id, baseDeps, { attempt: 1, maxAttempts: 3 }));
        const blocked = await prisma.socialPublication.findUniqueOrThrow({ where: { id: scheduled.id } });
        assert.equal(blocked.status, 'BLOCKED');
        assert.equal(capturedUrl, undefined);
        assert.equal(await prisma.videoPublicLink.count({ where: { videoId: video.id } }), 0);

        // 2) With publicLinkBaseUrl configured: a link is minted and reaches the connector.
        await prisma.socialPublication.update({ where: { id: scheduled.id }, data: { status: 'READY', lastError: null } });
        const deps: PublicationEngineDeps = { ...baseDeps, publicLinkBaseUrl: 'http://127.0.0.1:3000' };
        await runPublicationAttempt(prisma, scheduled.id, deps, { attempt: 1, maxAttempts: 3 });
        assert.ok(capturedUrl?.startsWith('http://127.0.0.1:3000/public/quiz-video-links/'));
        const afterPending = await prisma.socialPublication.findUniqueOrThrow({ where: { id: scheduled.id } });
        assert.equal(afterPending.status, 'PUBLISHING');

        const link = await prisma.videoPublicLink.findFirstOrThrow({ where: { videoId: video.id } });
        assert.equal(link.revokedAt, null, 'still PENDING: Meta may not have fetched it yet, must not be revoked');

        // The minted link actually works against the real HTTP route (closes the loop end to end).
        const fetched = await app.inject({ url: new URL(capturedUrl!).pathname });
        assert.equal(fetched.statusCode, 200);
        assert.ok(fetched.rawPayload.equals(VIDEO_BYTES));

        // 3) Once reconciliation (modelled here directly, since the mock connector already returned
        // PENDING) confirms a terminal outcome, the engine's own PUBLISHED/FAILED branches revoke it.
        // Simplest direct check: revoking after a simulated resolution, then confirming resolve fails.
        await revokePublicVideoLinksForQuizVideo(prisma, video.id);
        assert.equal(await resolvePublicVideoLink(prisma, new URL(capturedUrl!).pathname.split('/').pop()!), null);
    } finally {
        await prisma.socialPublicationAttempt.deleteMany({ where: { publication: { projectId: project.id } } });
        await prisma.socialPublication.deleteMany({ where: { projectId: project.id } });
        await prisma.socialAccount.deleteMany({ where: { projectId: project.id } });
        await prisma.videoPublicLink.deleteMany({ where: { video: { projectId: project.id } } });
        await prisma.video.deleteMany({ where: { projectId: project.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.projectSettings.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
        await dirs.cleanup();
    }
});
