import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@fako/db';
import { mockConnectors } from '@fako/publishing';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-social-accounts-token-1234567890123456';
const headers = { authorization: `Bearer ${TOKEN}` };

function buildTestApp(prisma: PrismaClient, scenario: Parameters<typeof mockConnectors>[0] = 'FULL_ACCESS') {
    return buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: randomBytes(32), socialConnectors: mockConnectors(scenario) });
}

async function startOAuth(app: ReturnType<typeof buildApp>, projectId: string, platform: string, redirectUri = 'https://admin.example/callback') {
    const result = await app.inject({ method: 'POST', url: `/projects/${projectId}/social-accounts/${platform}/oauth/start`, headers, payload: { redirectUri } });
    assert.equal(result.statusCode, 201, result.payload);
    return result.json() as { authorizationUrl: string; state: string; expiresAt: string };
}

// SocialAccount.project uses onDelete: Restrict (like QuizVideo/VideoJob elsewhere in this repo) —
// connected accounts must be removed before their owning test project can be deleted. Filtered by
// id (not name): a name shared with a real project on a non-isolated database must never be deleted.
async function cleanupProjects(prisma: PrismaClient, projectIds: string[]) {
    await prisma.socialAccount.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
}

test('full OAuth lifecycle: start, callback, list, capabilities, patch languages, disconnect', async () => {
    const prisma = createPrismaClient();
    const app = buildTestApp(prisma);
    let project: { id: string } | undefined;
    try {
        project = await prisma.project.create({ data: { name: 'Social connectors FR/NL' } });

        const { authorizationUrl, state } = await startOAuth(app, project.id, 'TIKTOK');
        assert.match(authorizationUrl, /^https:\/\/mock\.invalid\/tiktok\/authorize/);

        const callback = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'auth-code-1', state } });
        assert.equal(callback.statusCode, 201, callback.payload);
        const account = callback.json();
        assert.equal(account.status, 'CONNECTED');
        assert.equal(account.platform, 'TIKTOK');
        assert.ok(account.grantedScopes.includes('video.publish'));
        assert.equal('accessTokenCiphertext' in account, false, 'ciphertext must never be returned to a client');
        assert.equal('refreshTokenCiphertext' in account, false);

        const list = await app.inject({ method: 'GET', url: `/projects/${project.id}/social-accounts`, headers });
        assert.equal(list.statusCode, 200);
        assert.equal(list.json().socialAccounts.length, 1);

        const capabilities = await app.inject({ method: 'GET', url: `/social-accounts/${account.id}/capabilities`, headers });
        assert.equal(capabilities.statusCode, 200);
        assert.equal(capabilities.json().canPublishDirectly, true);

        const patched = await app.inject({ method: 'PATCH', url: `/social-accounts/${account.id}`, headers, payload: { languages: ['fr', 'nl'] } });
        assert.equal(patched.statusCode, 200);
        assert.deepEqual(patched.json().languages.sort(), ['fr', 'nl']);

        const disconnected = await app.inject({ method: 'POST', url: `/social-accounts/${account.id}/disconnect`, headers });
        assert.equal(disconnected.statusCode, 200);
        assert.equal(disconnected.json().status, 'DISCONNECTED');
        assert.deepEqual(disconnected.json().grantedScopes, []);
    } finally { await app.close(); await cleanupProjects(prisma, project ? [project.id] : []); await prisma.$disconnect(); }
});

test('an account connected with only basic scopes is marked INSUFFICIENT_PERMISSIONS, not CONNECTED', async () => {
    const prisma = createPrismaClient();
    const app = buildTestApp(prisma, 'INSUFFICIENT_SCOPES');
    let project: { id: string } | undefined;
    try {
        project = await prisma.project.create({ data: { name: 'Insufficient scopes FR' } });
        const { state } = await startOAuth(app, project.id, 'INSTAGRAM');
        const callback = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/INSTAGRAM/oauth/callback`, headers, payload: { code: 'auth-code-2', state } });
        assert.equal(callback.statusCode, 201);
        assert.equal(callback.json().status, 'INSUFFICIENT_PERMISSIONS');

        const capabilities = await app.inject({ method: 'GET', url: `/social-accounts/${callback.json().id}/capabilities`, headers });
        assert.equal(capabilities.json().canPublishDirectly, false);
        assert.ok(capabilities.json().missingScopes.length > 0);
    } finally { await app.close(); await cleanupProjects(prisma, project ? [project.id] : []); await prisma.$disconnect(); }
});

test('OAuth state CSRF protections: unknown, cross-platform, expired, and replayed states are all rejected', async () => {
    const prisma = createPrismaClient();
    const app = buildTestApp(prisma);
    let project: { id: string } | undefined;
    let otherProject: { id: string } | undefined;
    try {
        project = await prisma.project.create({ data: { name: 'OAuth state protections' } });

        const unknown = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'x', state: 'does-not-exist' } });
        assert.equal(unknown.statusCode, 400);

        const { state: tiktokState } = await startOAuth(app, project.id, 'TIKTOK');
        const wrongPlatform = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/INSTAGRAM/oauth/callback`, headers, payload: { code: 'x', state: tiktokState } });
        assert.equal(wrongPlatform.statusCode, 400);

        otherProject = await prisma.project.create({ data: { name: 'OAuth state protections - other project' } });
        const wrongProject = await app.inject({ method: 'POST', url: `/projects/${otherProject.id}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'x', state: tiktokState } });
        assert.equal(wrongProject.statusCode, 400);

        const expiredState = 'expired-state-value-1234567890';
        await prisma.socialOAuthState.create({ data: { state: expiredState, projectId: project.id, platform: 'TIKTOK', redirectUri: 'https://admin.example/callback', expiresAt: new Date(Date.now() - 1000) } });
        const expired = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'x', state: expiredState } });
        assert.equal(expired.statusCode, 400);

        const first = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'replay-code', state: tiktokState } });
        assert.equal(first.statusCode, 201);
        const replay = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'replay-code', state: tiktokState } });
        assert.equal(replay.statusCode, 400);
    } finally { await app.close(); await cleanupProjects(prisma, [project, otherProject].filter(Boolean).map(p => p!.id)); await prisma.$disconnect(); }
});

test('social accounts are isolated between projects', async () => {
    const prisma = createPrismaClient();
    const app = buildTestApp(prisma);
    let projectA: { id: string } | undefined;
    let projectB: { id: string } | undefined;
    try {
        projectA = await prisma.project.create({ data: { name: 'Isolation A' } });
        projectB = await prisma.project.create({ data: { name: 'Isolation B' } });

        const { state } = await startOAuth(app, projectA.id, 'FACEBOOK');
        const callback = await app.inject({ method: 'POST', url: `/projects/${projectA.id}/social-accounts/FACEBOOK/oauth/callback`, headers, payload: { code: 'iso-1', state } });
        assert.equal(callback.statusCode, 201);

        const listA = await app.inject({ method: 'GET', url: `/projects/${projectA.id}/social-accounts`, headers });
        const listB = await app.inject({ method: 'GET', url: `/projects/${projectB.id}/social-accounts`, headers });
        assert.equal(listA.json().socialAccounts.length, 1);
        assert.equal(listB.json().socialAccounts.length, 0);
    } finally { await app.close(); await cleanupProjects(prisma, [projectA, projectB].filter(Boolean).map(p => p!.id)); await prisma.$disconnect(); }
});

test('multiple accounts per platform are supported (FR and NL destinations)', async () => {
    const prisma = createPrismaClient();
    const app = buildTestApp(prisma);
    let project: { id: string } | undefined;
    try {
        project = await prisma.project.create({ data: { name: 'Multi-account TikTok FR NL' } });

        const first = await startOAuth(app, project.id, 'TIKTOK');
        const firstCallback = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'fr-account', state: first.state } });
        assert.equal(firstCallback.statusCode, 201);
        await app.inject({ method: 'PATCH', url: `/social-accounts/${firstCallback.json().id}`, headers, payload: { languages: ['fr'] } });

        const second = await startOAuth(app, project.id, 'TIKTOK');
        const secondCallback = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'nl-account', state: second.state } });
        assert.equal(secondCallback.statusCode, 201);
        await app.inject({ method: 'PATCH', url: `/social-accounts/${secondCallback.json().id}`, headers, payload: { languages: ['nl'] } });

        assert.notEqual(firstCallback.json().id, secondCallback.json().id);
        const list = await app.inject({ method: 'GET', url: `/projects/${project.id}/social-accounts`, headers });
        assert.equal(list.json().socialAccounts.length, 2);
        assert.deepEqual(list.json().socialAccounts.map((a: { languages: string[] }) => a.languages).sort(), [['fr'], ['nl']]);
    } finally { await app.close(); await cleanupProjects(prisma, project ? [project.id] : []); await prisma.$disconnect(); }
});

test('connecting a Facebook Page never requires or exposes a personal profile token', async () => {
    const prisma = createPrismaClient();
    const app = buildTestApp(prisma);
    let project: { id: string } | undefined;
    try {
        project = await prisma.project.create({ data: { name: 'Facebook Page only' } });
        const { state } = await startOAuth(app, project.id, 'FACEBOOK');
        const callback = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/FACEBOOK/oauth/callback`, headers, payload: { code: 'fb-1', state } });
        assert.equal(callback.statusCode, 201);
        // The Facebook Page id IS the externalAccountId (not a personal profile id) — there is no
        // separate "user token" concept exposed to the client at all.
        assert.ok(callback.json().externalAccountId.startsWith('mock-page-'));
    } finally { await app.close(); await cleanupProjects(prisma, project ? [project.id] : []); await prisma.$disconnect(); }
});

test('a platform the admin never developer-configured refuses to start an OAuth flow (503), not a silent mock success', async () => {
    const prisma = createPrismaClient();
    const app = buildApp({ prisma, socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: randomBytes(32) });
    let project: { id: string } | undefined;
    try {
        project = await prisma.project.create({ data: { name: 'Unconfigured platform' } });
        const result = await app.inject({ method: 'POST', url: `/projects/${project.id}/social-accounts/TIKTOK/oauth/start`, headers, payload: { redirectUri: 'https://admin.example/callback' } });
        assert.equal(result.statusCode, 503);
    } finally { await app.close(); await cleanupProjects(prisma, project ? [project.id] : []); await prisma.$disconnect(); }
});
