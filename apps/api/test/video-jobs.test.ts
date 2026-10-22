import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';

const TOKEN = 'test-video-jobs-token-1234567890123456';
const headers = { authorization: `Bearer ${TOKEN}` };

test('invalid video job requests never touch persistence', async () => {
    const prisma = new Proxy({}, { get() { throw new Error('Unexpected database call'); } }) as PrismaClient;
    const app = buildApp({ prisma, videoJobsToken: TOKEN });
    const projectId = '00000000-0000-4000-8000-000000000001';
    try {
        for (const fields of [
            { subject: '' }, { subject: '  ' }, { language: 'french' }, { format: 'UNKNOWN' },
            { targetDuration: 0 }, { targetDuration: 601 }, { targetDuration: '30' },
            { status: 'COMPLETED' }, { metadata: [] }
        ]) {
            const result = await app.inject({ method: 'POST', url: `/projects/${projectId}/video-jobs`, headers,
                payload: { subject: 'Quiz', language: 'fr', ...fields } });
            assert.equal(result.statusCode, 400, JSON.stringify(fields));
        }
        assert.equal((await app.inject({ url: '/video-jobs/invalid', headers })).statusCode, 400);
        assert.equal((await app.inject({ url: `/projects/${projectId}/video-jobs?status=UNKNOWN`, headers })).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/video-jobs/${projectId}/approve`, headers, payload: { approvedBy: ' ' } })).statusCode, 400);
    } finally { await app.close(); }
});
