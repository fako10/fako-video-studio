import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { buildTestApp, loginAndGetCookie } from './helpers.js';

function webStreamFrom(bytes: Buffer): ReadableStream<Uint8Array> {
    return Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>;
}

test('streams the MP4 bytes to an authenticated session, with the right content type and caching headers', async () => {
    const { app, apiClient } = await buildTestApp();
    const bytes = Buffer.from('fake mp4 bytes');
    apiClient.preview = { body: webStreamFrom(bytes), contentType: 'video/mp4', status: 200 };
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1/preview', cookies });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'video/mp4');
        assert.equal(response.headers['cache-control'], 'private, no-store');
        assert.deepEqual(response.rawPayload, bytes);
    } finally { await app.close(); }
});

test('a video with no file yet (or not yet approved for preview) is a clear 404, not a broken stream', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.preview = null;
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1/preview', cookies });
        assert.equal(response.statusCode, 404);
    } finally { await app.close(); }
});

test('refuses to stream a preview without a valid session — no anonymous access to unpublished videos', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.preview = { body: webStreamFrom(Buffer.from('x')), contentType: 'video/mp4', status: 200 };
    try {
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1/preview' });
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/login');
    } finally { await app.close(); }
});

test('forwards the browser Range header to the API and mirrors a 206 partial response', async () => {
    const { app, apiClient } = await buildTestApp();
    const chunk = Buffer.from('partial-bytes');
    apiClient.preview = { body: webStreamFrom(chunk), contentType: 'video/mp4', status: 206, contentRange: 'bytes 10-22/9999' };
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1/preview', cookies, headers: { range: 'bytes=10-22' } });
        assert.equal(apiClient.lastPreviewRange, 'bytes=10-22');
        assert.equal(response.statusCode, 206);
        assert.equal(response.headers['content-range'], 'bytes 10-22/9999');
        assert.equal(response.headers['accept-ranges'], 'bytes');
        assert.deepEqual(response.rawPayload, chunk);
    } finally { await app.close(); }
});

test('a request with no Range header still advertises Accept-Ranges so the player knows seeking is possible', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.preview = { body: webStreamFrom(Buffer.from('full file')), contentType: 'video/mp4', status: 200 };
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1/preview', cookies });
        assert.equal(apiClient.lastPreviewRange, undefined);
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['accept-ranges'], 'bytes');
    } finally { await app.close(); }
});
