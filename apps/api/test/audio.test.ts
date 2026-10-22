import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
test('Audio routes fail closed and validate requests before persistence', async () => {
    const token = 'test-only-token-123456789012345678901234';
    const app = buildApp({ audioToken: token });
    try {
        assert.equal((await app.inject(`/audio-assets/${randomUUID()}/preview`)).statusCode, 401);
        assert.equal((await app.inject({ url: '/audio-assets/bad', headers: { authorization: `Bearer ${token}` } })).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/video-scripts/${randomUUID()}/audio/generate`, headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode, 503);
        assert.equal((await app.inject({ method: 'PUT', url: `/projects/${randomUUID()}/voices/fr`, headers: { authorization: `Bearer ${token}` }, payload: { voiceId: '../bad', model: 'unknown', settings: { stability: 2 } } })).statusCode, 400);
        assert.equal((await app.inject('/health')).statusCode, 200);
    } finally { await app.close(); }
    const unconfigured = buildApp({ audioToken: '' });
    try { assert.equal((await unconfigured.inject(`/audio-assets/${randomUUID()}`)).statusCode, 503); }
    finally { await unconfigured.close(); }
});
