import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';

const TOKEN = 'test-video-scripts-token-1234567890123456';
const headers = { authorization: `Bearer ${TOKEN}` };

test('script generation is disabled by default; malformed generation/review requests are rejected', async () => {
    const app = buildApp({ prisma: {} as PrismaClient, scriptGenerationEnabled: false, videoScriptsToken: TOKEN });
    const id = '00000000-0000-4000-8000-000000000001';
    try {
        assert.equal((await app.inject({ method: 'POST', url: `/video-jobs/${id}/scripts/generate`, headers, payload: { requestId: id } })).statusCode, 503);
        assert.equal((await app.inject({ method: 'POST', url: `/video-jobs/${id}/scripts/generate`, headers, payload: { requestId: 'invalid' } })).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/video-scripts/${id}/review`, headers, payload: { reviewedBy: ' ', decision: 'APPROVED' } })).statusCode, 400);
    } finally { await app.close(); }
});
