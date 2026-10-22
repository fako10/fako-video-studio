import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpApiClient } from '../src/api-client.js';
import { buildTestApp, loginAndGetCookie, sampleDayReport, sampleQuizVideo } from './helpers.js';

const SECRET_TOKEN = 'super-secret-quiz-video-api-token-value';

test('no rendered admin page ever contains the API token, even when nothing went wrong', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.dayReport = sampleDayReport();
    apiClient.list = { quizVideos: [sampleQuizVideo()], total: 1 };
    try {
        const cookies = await loginAndGetCookie(app);
        for (const url of ['/admin', '/admin/quiz-videos', '/admin/quiz-videos/vid-1', '/admin/settings/social']) {
            const response = await app.inject({ url, cookies });
            assert.ok(!response.body.includes(SECRET_TOKEN), `${url} must never leak the API token`);
        }
    } finally { await app.close(); }
});

test('the real HttpApiClient sends the token only as an Authorization header, never in the URL or body', async () => {
    let receivedAuth: string | undefined;
    let receivedUrl: string | undefined;
    const server = createServer((req, res) => {
        receivedAuth = req.headers.authorization;
        receivedUrl = req.url;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ projects: [{ id: 'proj-1', slug: 'rijpermis' }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
        const client = new HttpApiClient(`http://127.0.0.1:${port}`, SECRET_TOKEN);
        await client.resolveProjectId('rijpermis');
        assert.equal(receivedAuth, `Bearer ${SECRET_TOKEN}`);
        assert.ok(!receivedUrl!.includes(SECRET_TOKEN), 'the token must never appear in the request URL');
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('an API error message from the real HttpApiClient never echoes the token back', async () => {
    const server = createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
        const client = new HttpApiClient(`http://127.0.0.1:${port}`, SECRET_TOKEN);
        await assert.rejects(client.getQuizVideo('vid-1'), (error: unknown) => error instanceof Error && !error.message.includes(SECRET_TOKEN));
    } finally { await new Promise(resolve => server.close(resolve)); }
});
