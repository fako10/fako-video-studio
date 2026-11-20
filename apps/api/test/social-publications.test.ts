import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';

const TOKEN = 'test-social-publications-token-123456789012';
const headers = { authorization: `Bearer ${TOKEN}` };
const uuid = '00000000-0000-4000-8000-000000000001';

function throwingPrisma(): PrismaClient {
    return new Proxy({}, { get() { throw new Error('Unexpected database call'); } }) as PrismaClient;
}

test('social publication routes are disabled by default (503), even with a valid-looking token', async () => {
    const app = buildApp({ prisma: throwingPrisma() });
    try {
        const result = await app.inject({ method: 'GET', url: `/projects/${uuid}/social-publications`, headers });
        assert.equal(result.statusCode, 503);
    } finally { await app.close(); }
});

test('a wrong or missing bearer token is rejected without touching persistence', async () => {
    const app = buildApp({ prisma: throwingPrisma(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    try {
        assert.equal((await app.inject({ method: 'GET', url: `/projects/${uuid}/social-publications` })).statusCode, 401);
        assert.equal((await app.inject({ method: 'GET', url: `/projects/${uuid}/social-publications`, headers: { authorization: 'Bearer wrong-token' } })).statusCode, 401);
    } finally { await app.close(); }
});

test('invalid requests are rejected by schema validation before touching persistence', async () => {
    const app = buildApp({ prisma: throwingPrisma(), socialPublishingEnabled: true, socialPublishingToken: TOKEN });
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/projects/not-a-uuid/social-publications', headers })).statusCode, 400);
        assert.equal((await app.inject({ method: 'GET', url: '/social-publications/not-a-uuid', headers })).statusCode, 400);
        assert.equal((await app.inject({
            method: 'POST', url: `/projects/${uuid}/social-publications`, headers, payload: { videoId: uuid, socialAccountId: uuid, language: 'de', caption: 'x', requestId: uuid, createdBy: 'admin' }
        })).statusCode, 400, 'language must be fr or nl');
        assert.equal((await app.inject({
            method: 'POST', url: `/projects/${uuid}/social-publications`, headers, payload: { videoId: uuid, socialAccountId: uuid, language: 'fr', caption: '', requestId: uuid, createdBy: 'admin' }
        })).statusCode, 400, 'caption must be non-empty');
        assert.equal((await app.inject({
            method: 'POST', url: `/projects/${uuid}/social-publications`, headers, payload: { videoId: uuid, socialAccountId: uuid, language: 'fr', caption: 'x', scheduledAtLocal: '2026-07-01T09:00:00Z', requestId: uuid, createdBy: 'admin' }
        })).statusCode, 400, 'scheduledAtLocal must be a bare wall-clock string, never an absolute ISO instant');
        assert.equal((await app.inject({
            method: 'POST', url: `/projects/${uuid}/social-publications`, headers, payload: { videoId: 'not-a-uuid', socialAccountId: uuid, language: 'fr', caption: 'x', requestId: uuid, createdBy: 'admin' }
        })).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/social-publications/${uuid}/cancel`, headers, payload: {} })).statusCode, 400, 'cancelledBy is required');
        assert.equal((await app.inject({ method: 'PATCH', url: `/social-publications/${uuid}`, headers, payload: { caption: '' } })).statusCode, 400);
    } finally { await app.close(); }
});
