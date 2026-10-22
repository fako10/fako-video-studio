import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from './helpers.js';

test('CSRF: a POST whose Origin matches this server succeeds, a cross-origin one is rejected (403), and an absent Origin/Referer is allowed through (SameSite cookie stays the primary defense)', async () => {
    const { app } = await buildTestApp({ publicBaseUrl: 'http://127.0.0.1:3100' });
    try {
        const sameOrigin = await app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://127.0.0.1:3100' }, payload: { username: 'wrong', password: 'wrong' } });
        assert.notEqual(sameOrigin.statusCode, 403);

        const crossOrigin = await app.inject({ method: 'POST', url: '/login', headers: { origin: 'https://attacker.example' }, payload: { username: 'wrong', password: 'wrong' } });
        assert.equal(crossOrigin.statusCode, 403);

        const crossOriginViaReferer = await app.inject({ method: 'POST', url: '/login', headers: { referer: 'https://attacker.example/evil-page' }, payload: { username: 'wrong', password: 'wrong' } });
        assert.equal(crossOriginViaReferer.statusCode, 403);

        const noOriginAtAll = await app.inject({ method: 'POST', url: '/login', payload: { username: 'wrong', password: 'wrong' } });
        assert.notEqual(noOriginAtAll.statusCode, 403);

        // GET requests are never subject to the check at all (nothing state-changing to protect).
        const get = await app.inject({ method: 'GET', url: '/login', headers: { origin: 'https://attacker.example' } });
        assert.notEqual(get.statusCode, 403);
    } finally { await app.close(); }
});

test('trustProxy: the login rate limiter keys on the real client IP from X-Forwarded-For, not a shared proxy IP', async () => {
    const { app } = await buildTestApp();
    try {
        const attempt = (forwardedFor: string) => app.inject({
            method: 'POST', url: '/login', headers: { 'x-forwarded-for': forwardedFor },
            payload: { username: 'wrong', password: 'wrong' }
        });
        for (let i = 0; i < 5; i++) {
            const response = await attempt('203.0.113.10');
            assert.ok(!response.body.includes('Trop de tentatives'), `attempt ${i + 1} should not be locked yet`);
        }
        const sixth = await attempt('203.0.113.10');
        assert.ok(sixth.body.includes('Trop de tentatives'), 'the 6th failure from the same forwarded IP must be locked out');

        // A different forwarded client IP is a separate bucket — proves the limiter is actually
        // differentiating clients via X-Forwarded-For, not collapsing everyone onto one key.
        const otherClient = await attempt('203.0.113.99');
        assert.ok(!otherClient.body.includes('Trop de tentatives'), 'a different forwarded IP must not be affected by the first one\'s lockout');
    } finally { await app.close(); }
});
