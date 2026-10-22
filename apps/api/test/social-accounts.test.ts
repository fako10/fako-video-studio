import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { mockConnectors } from '@fako/publishing';
import { buildApp } from '../src/app.js';

const TOKEN = 'test-social-accounts-token-1234567890123456';
const headers = { authorization: `Bearer ${TOKEN}` };
const projectId = '00000000-0000-4000-8000-000000000001';

function throwingPrisma(): PrismaClient {
    return new Proxy({}, { get() { throw new Error('Unexpected database call'); } }) as PrismaClient;
}

test('social account routes are disabled by default (503), even with a valid-looking token', async () => {
    const app = buildApp({ prisma: throwingPrisma() });
    try {
        const result = await app.inject({ method: 'GET', url: '/social/platforms', headers });
        assert.equal(result.statusCode, 503);
    } finally { await app.close(); }
});

test('invalid requests are rejected by schema validation before touching persistence', async () => {
    const app = buildApp({
        prisma: throwingPrisma(), socialAccountsEnabled: true, socialAccountsToken: TOKEN,
        socialEncryptionKey: randomBytes(32), socialConnectors: mockConnectors()
    });
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/projects/not-a-uuid/social-accounts', headers })).statusCode, 400);
        assert.equal((await app.inject({ method: 'GET', url: '/social-accounts/not-a-uuid', headers })).statusCode, 400);
        assert.equal((await app.inject({ method: 'GET', url: '/social-accounts/not-a-uuid/capabilities', headers })).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/projects/${projectId}/social-accounts/MYSPACE/oauth/start`, headers, payload: { redirectUri: 'https://admin.example/callback' } })).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/projects/${projectId}/social-accounts/TIKTOK/oauth/start`, headers, payload: {} })).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/projects/${projectId}/social-accounts/TIKTOK/oauth/callback`, headers, payload: { code: 'abc' } })).statusCode, 400);
        assert.equal((await app.inject({ method: 'PATCH', url: '/social-accounts/not-a-uuid', headers, payload: { languages: ['fr'] } })).statusCode, 400);
        assert.equal((await app.inject({ method: 'PATCH', url: `/social-accounts/${projectId}`, headers, payload: { languages: ['de'] } })).statusCode, 400);
        assert.equal((await app.inject({ method: 'PATCH', url: `/social-accounts/${projectId}`, headers, payload: {} })).statusCode, 400);
    } finally { await app.close(); }
});

test('a wrong or missing bearer token is rejected without touching persistence', async () => {
    const app = buildApp({
        prisma: throwingPrisma(), socialAccountsEnabled: true, socialAccountsToken: TOKEN,
        socialEncryptionKey: randomBytes(32), socialConnectors: mockConnectors()
    });
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/social/platforms' })).statusCode, 401);
        assert.equal((await app.inject({ method: 'GET', url: '/social/platforms', headers: { authorization: 'Bearer wrong-token' } })).statusCode, 401);
    } finally { await app.close(); }
});

test('an unconfigured real connector is reported as such, never implied functional', async () => {
    const app = buildApp({ socialAccountsEnabled: true, socialAccountsToken: TOKEN, socialEncryptionKey: randomBytes(32), prisma: throwingPrisma() });
    try {
        const result = await app.inject({ method: 'GET', url: '/social/platforms', headers });
        assert.equal(result.statusCode, 200);
        const body = result.json() as { platforms: { platform: string; configured: boolean }[] };
        assert.equal(body.platforms.length, 3);
        for (const platform of body.platforms) assert.equal(platform.configured, false, `${platform.platform} should not be configured without developer credentials`);
    } finally { await app.close(); }
});
