import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuestion, imageUrl, RijPermisContentProvider, snapshotHash } from '../src/provider.js';
import { ContentSourceError } from '../src/schema.js';
import { jpegBytes, page, question, sendJson, startServer } from './helpers.js';

const noSleep = async () => {};
function provider(origin: string, opts: Partial<ConstructorParameters<typeof RijPermisContentProvider>[0]> = {}) {
    return new RijPermisContentProvider({ baseUrl: origin, apiKey: 'test-key', environment: 'test', sleep: noSleep, intervalMs: 0, attempts: 2, ...opts });
}

test('refuses invalid configuration before ever making a network call', () => {
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'not a url', apiKey: 'k' }), ContentSourceError);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'http://rijpermis.example', apiKey: 'k' }), /RIJPERMIS_INVALID_CONFIGURATION/);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'https://user:pass@rijpermis.example', apiKey: 'k' }), ContentSourceError);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'https://rijpermis.example/sub', apiKey: 'k' }), ContentSourceError);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'https://rijpermis.example', apiKey: '' }), ContentSourceError);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'https://rijpermis.example', apiKey: 'bad\nkey' }), ContentSourceError);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'https://rijpermis.example', apiKey: 'k', attempts: 4 }), ContentSourceError);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'https://rijpermis.example', apiKey: 'k', timeoutMs: 0 }), ContentSourceError);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'https://rijpermis.example', apiKey: 'k', intervalMs: -1 }), ContentSourceError);
});

test('allows plain HTTP only against loopback in test/development environments', () => {
    assert.doesNotThrow(() => new RijPermisContentProvider({ baseUrl: 'http://127.0.0.1:4000', apiKey: 'k', environment: 'development' }));
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'http://127.0.0.1:4000', apiKey: 'k', environment: 'production' }), ContentSourceError);
    assert.throws(() => new RijPermisContentProvider({ baseUrl: 'http://rijpermis.example', apiKey: 'k', environment: 'test' }), ContentSourceError);
});

test('sends the technical API key as a header and never logs it', async () => {
    let seenHeader: string | undefined;
    const server = await startServer((req, res) => { seenHeader = req.headers['x-fako-api-key'] as string; sendJson(res, 200, { schemaVersion: '1', items: [] }); });
    const log: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...args) => log.push(args.join(' '));
    console.error = (...args) => log.push(args.join(' '));
    console.warn = (...args) => log.push(args.join(' '));
    try {
        await provider(server.origin, { apiKey: 'super-secret-key' }).listThemes();
        assert.equal(seenHeader, 'super-secret-key');
        assert.ok(!log.some(line => line.includes('super-secret-key')));
    } finally {
        Object.assign(console, original);
        await server.close();
    }
});

test('listQuestions sends language, pagination and category, and accepts an empty result as valid', async () => {
    let received: URL | undefined;
    const server = await startServer((req, res) => { received = new URL(req.url!, 'http://x'); sendJson(res, 200, page([], { page: { number: 2, size: 5 } })); });
    try {
        const result = await provider(server.origin).listQuestions({ language: 'nl', category: 'Voorrang', page: 2, size: 5 });
        assert.deepEqual(result.items, []);
        assert.equal(received!.searchParams.get('language'), 'nl');
        assert.equal(received!.searchParams.get('category'), 'Voorrang');
        assert.equal(received!.searchParams.get('page'), '2');
        assert.equal(received!.searchParams.get('size'), '5');
    } finally { await server.close(); }
});

test('listQuestions defaults to language fr, page 0, size 20 when omitted', async () => {
    let received: URL | undefined;
    const server = await startServer((req, res) => { received = new URL(req.url!, 'http://x'); sendJson(res, 200, page([])); });
    try {
        await provider(server.origin).listQuestions();
        assert.equal(received!.searchParams.get('language'), 'fr');
        assert.equal(received!.searchParams.get('page'), '0');
        assert.equal(received!.searchParams.get('size'), '20');
    } finally { await server.close(); }
});

test('rejects an invalid query locally without making any request', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => { calls++; sendJson(res, 200, page([])); });
    const p = provider(server.origin);
    try {
        await assert.rejects(p.listQuestions({ size: 101 }), /INVALID_QUESTION_QUERY/);
        await assert.rejects(p.listQuestions({ page: -1 }), /INVALID_QUESTION_QUERY/);
        await assert.rejects(p.listQuestions({ language: 'en' as 'fr' }), /INVALID_QUESTION_QUERY/);
        assert.equal(calls, 0);
    } finally { await server.close(); }
});

test('getQuestion fetches by id and rejects a server response with a mismatched id', async () => {
    const server = await startServer((req, res) => sendJson(res, 200, question()));
    try {
        const p = provider(server.origin);
        assert.equal((await p.getQuestion('6337')).id, '6337');
        await assert.rejects(p.getQuestion('other-id'), /RIJPERMIS_QUESTION_ID_MISMATCH/);
        await assert.rejects(p.getQuestion('bad id!'), /INVALID_QUESTION_ID/);
    } finally { await server.close(); }
});

test('listThemes only accepts fr or nl', async () => {
    const server = await startServer((_req, res) => sendJson(res, 200, { schemaVersion: '1', items: [{ category: 'Voorrang', count: 2 }] }));
    try {
        const p = provider(server.origin);
        assert.equal((await p.listThemes('nl')).items[0].category, 'Voorrang');
        await assert.rejects(p.listThemes('en' as 'fr'), /INVALID_LANGUAGE/);
    } finally { await server.close(); }
});

test('maps 401 to an authentication failure without retrying', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => { calls++; res.writeHead(401); res.end(); });
    try {
        await assert.rejects(provider(server.origin).listThemes(), /RIJPERMIS_AUTHENTICATION_FAILED/);
        assert.equal(calls, 1);
    } finally { await server.close(); }
});

test('maps 404 on getQuestion to not-exportable without retrying', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => { calls++; res.writeHead(404); res.end(); });
    try {
        const error = await provider(server.origin).getQuestion('6337').catch(e => e);
        assert.ok(error instanceof ContentSourceError && error.statusCode === 404 && error.code === 'RIJPERMIS_NOT_EXPORTABLE');
        assert.equal(calls, 1);
    } finally { await server.close(); }
});

test('429 respects a numeric Retry-After and eventually fails with the computed delay', async () => {
    let calls = 0;
    const waits: number[] = [];
    const server = await startServer((_req, res) => { calls++; res.writeHead(429, { 'retry-after': '2' }); res.end(); });
    try {
        const p = provider(server.origin, { attempts: 2, sleep: async ms => { waits.push(ms); } });
        const error = await p.listThemes().catch(e => e);
        assert.ok(error instanceof ContentSourceError && error.statusCode === 429 && error.code === 'RIJPERMIS_RATE_LIMITED');
        assert.equal(error.retryAfter, 2);
        assert.equal(calls, 2);
        assert.ok(waits[1] >= 1900, `expected the second wait to honor Retry-After (~2000ms), got ${waits[1]}`);
    } finally { await server.close(); }
});

test('429 respects an HTTP-date Retry-After', async () => {
    const retryAt = new Date(Date.now() + 3000).toUTCString();
    const server = await startServer((_req, res) => { res.writeHead(429, { 'retry-after': retryAt }); res.end(); });
    try {
        const error = await provider(server.origin, { attempts: 1 }).listThemes().catch(e => e);
        assert.ok(error instanceof ContentSourceError && error.code === 'RIJPERMIS_RATE_LIMITED' && error.retryAfter! >= 2);
    } finally { await server.close(); }
});

test('5xx is retried then surfaced as temporarily unavailable', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => { calls++; res.writeHead(503); res.end(); });
    try {
        await assert.rejects(provider(server.origin, { attempts: 3 }).listThemes(), /RIJPERMIS_TEMPORARILY_UNAVAILABLE/);
        assert.equal(calls, 3);
    } finally { await server.close(); }
});

test('a transient 503 followed by success recovers within the attempt budget', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
        calls++;
        if (calls === 1) { res.writeHead(503); return res.end(); }
        sendJson(res, 200, { schemaVersion: '1', items: [] });
    });
    try {
        const result = await provider(server.origin, { attempts: 2 }).listThemes();
        assert.deepEqual(result.items, []);
        assert.equal(calls, 2);
    } finally { await server.close(); }
});

test('an unreachable host fails as a network error without hanging', async () => {
    await assert.rejects(provider('http://127.0.0.1:1', { attempts: 1, timeoutMs: 1000 }).listThemes(), /RIJPERMIS_NETWORK_OR_TIMEOUT/);
});

test('a slow server is aborted at the configured timeout', async () => {
    const server = await startServer(async (_req, res) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        sendJson(res, 200, { schemaVersion: '1', items: [] });
    });
    try {
        await assert.rejects(provider(server.origin, { attempts: 1, timeoutMs: 30 }).listThemes(), /RIJPERMIS_NETWORK_OR_TIMEOUT/);
    } finally { await server.close(); }
});

test('rejects a non-JSON content type and an oversized response announced via Content-Length', async () => {
    const htmlServer = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); });
    const hugeServer = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) }); res.end(); });
    try {
        await assert.rejects(provider(htmlServer.origin, { attempts: 1 }).listThemes(), /RIJPERMIS_INVALID_RESPONSE/);
        await assert.rejects(provider(hugeServer.origin, { attempts: 1 }).listThemes(), /RIJPERMIS_RESPONSE_TOO_LARGE/);
    } finally { await htmlServer.close(); await hugeServer.close(); }
});

test('rejects invalid JSON bodies', async () => {
    const server = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json'); });
    try { await assert.rejects(provider(server.origin, { attempts: 1 }).listThemes(), /RIJPERMIS_INVALID_JSON/); } finally { await server.close(); }
});

test('a question without an image stays usable; downloadImage returns null without a network call', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => { calls++; sendJson(res, 200, { schemaVersion: '1', items: [] }); });
    try {
        const result = await provider(server.origin).downloadImage(question({ image: null }));
        assert.equal(result, null);
        assert.equal(calls, 0);
    } finally { await server.close(); }
});

test('downloads and type-checks an image strictly from image.url, resolved against the configured origin', async () => {
    const server = await startServer((req, res) => {
        if (req.url === '/api/images/917000.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(jpegBytes); }
        res.writeHead(404); res.end();
    });
    try {
        const p = provider(server.origin);
        const result = await p.downloadImage(question({ image: { filename: '917000.jpg', url: '/api/images/917000.jpg' } }));
        assert.equal(result?.mimeType, 'image/jpeg');
        assert.equal(result?.extension, 'jpg');
    } finally { await server.close(); }
});

test('refuses an image URL outside the API image namespace, path traversal, or a foreign origin', () => {
    const origin = 'https://rijpermis.example';
    assert.throws(() => imageUrl(origin, '/api/images/../../etc/passwd'), ContentSourceError);
    assert.throws(() => imageUrl(origin, '/static/other.jpg'), ContentSourceError);
    assert.throws(() => imageUrl(origin, 'https://evil.example/api/images/x.jpg'), ContentSourceError);
    assert.equal(imageUrl(origin, '/api/images/x.jpg').toString(), 'https://rijpermis.example/api/images/x.jpg');
});

test('rejects image bytes whose magic number does not match the declared content type', async () => {
    const server = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(Buffer.from('not a jpeg')); });
    try {
        await assert.rejects(provider(server.origin).downloadImage(question({ image: { filename: 'x.jpg', url: '/api/images/x.jpg' } })), /RIJPERMIS_INVALID_IMAGE/);
    } finally { await server.close(); }
});

test('listQuestions rejects any item whose image escapes the configured origin', async () => {
    const server = await startServer((_req, res) => sendJson(res, 200, page([question({ image: { filename: 'x.jpg', url: 'https://evil.example/x.jpg' } })])));
    try {
        await assert.rejects(provider(server.origin).listQuestions(), ContentSourceError);
    } finally { await server.close(); }
});

test('checkQuestion reports CURRENT, CHANGED and WITHDRAWN', async () => {
    let behavior: 'same' | 'changed' | 'gone' = 'same';
    const server = await startServer((_req, res) => {
        if (behavior === 'gone') { res.writeHead(404); return res.end(); }
        sendJson(res, 200, question(behavior === 'changed' ? { contentHash: `sha256:${'b'.repeat(64)}` } : {}));
    });
    try {
        const p = provider(server.origin);
        const snapshot = question();
        assert.equal((await checkQuestion(p, snapshot as never)).status, 'CURRENT');
        behavior = 'changed';
        assert.equal((await checkQuestion(p, snapshot as never)).status, 'CHANGED');
        behavior = 'gone';
        assert.equal((await checkQuestion(p, snapshot as never)).status, 'WITHDRAWN');
    } finally { await server.close(); }
});

test('snapshotHash is stable across key order and sensitive to content changes', () => {
    const a = question();
    const b = { ...question() };
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    assert.equal(snapshotHash(a as never), snapshotHash(reordered as never));
    assert.notEqual(snapshotHash(a as never), snapshotHash(question({ question: 'Different wording ?' }) as never));
});

test('spaces out requests to respect the RijPermis rate limit instead of bursting', async () => {
    const server = await startServer((_req, res) => sendJson(res, 200, { schemaVersion: '1', items: [] }));
    try {
        const waits: number[] = [];
        const paced = provider(server.origin, { sleep: async ms => { waits.push(ms); }, intervalMs: 1050, attempts: 1 });
        await paced.listThemes();
        await paced.listThemes();
        assert.ok(waits[1] > 0, 'the second call should wait for the configured interval');
    } finally { await server.close(); }
});
