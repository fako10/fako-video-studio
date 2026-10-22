import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';

const TOKEN = 'test-projects-token-1234567890123456';
const headers = { authorization: `Bearer ${TOKEN}` };

test('health stays available without a database connection', async () => {
    const app = buildApp();
    try {
        const response = await app.inject('/health');
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().status, 'UP');
        assert.equal(response.json().application, 'Fako Video Studio');
    } finally { await app.close(); }
});

test('invalid requests are rejected before touching persistence', async () => {
    const prisma = new Proxy({}, { get() { throw new Error('Database must not be called'); } }) as PrismaClient;
    const app = buildApp({ prisma, projectsToken: TOKEN });
    try {
        for (const payload of [{}, { name: '   ' }, { name: 'x', extra: true }, { name: 'x', settings: { fps: 0 } }, { name: 'x', settings: { width: '1920' } }, { name: 'x', settings: { height: 20000 } }]) {
            const response = await app.inject({ method: 'POST', url: '/projects', headers, payload });
            assert.equal(response.statusCode, 400, JSON.stringify(payload));
        }
        for (const url of ['/projects/bad-id', '/projects?limit=101', '/projects?offset=-1', '/projects?unknown=1']) {
            assert.equal((await app.inject({ url, headers })).statusCode, 400, url);
        }
        for (const fields of [
            { slug: 'Invalid Slug' }, { website: 'ftp://example.com' }, { website: 'https://' },
            { languages: ['fr', 'fr'] }, { languages: ['french'] },
            { settings: { videosPerDay: -1 } }, { settings: { publicationEnabled: 'false' } },
            { settings: { humanValidationRequired: null } }
        ]) {
            assert.equal((await app.inject({ method: 'POST', url: '/projects', headers, payload: { name: 'Test', ...fields } })).statusCode, 400, JSON.stringify(fields));
        }
        assert.equal((await app.inject({ method: 'PATCH', url: '/projects/00000000-0000-4000-8000-000000000001', headers, payload: {} })).statusCode, 400);
    } finally { await app.close(); }
});

test('missing projects return 404 and internal errors are hidden', async () => {
    const missing = new Prisma.PrismaClientKnownRequestError('missing', { code: 'P2025', clientVersion: '6' });
    const prisma = { project: {
        findUnique: async () => null,
        update: async () => { throw missing; },
        delete: async () => { throw missing; },
        create: async () => { throw new Error('private database details'); }
    } } as unknown as PrismaClient;
    const app = buildApp({ prisma, projectsToken: TOKEN });
    try {
        const url = '/projects/00000000-0000-4000-8000-000000000001';
        assert.equal((await app.inject({ url, headers })).statusCode, 404);
        assert.equal((await app.inject({ method: 'PATCH', url, headers, payload: { name: 'x' } })).statusCode, 404);
        assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 404);
        const response = await app.inject({ method: 'POST', url: '/projects', headers, payload: { name: 'x' } });
        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.json(), { error: 'Internal server error' });
    } finally { await app.close(); }
});
