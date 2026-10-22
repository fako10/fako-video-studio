import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from '../src/auth/rateLimiter.js';
import { ADMIN_PASSWORD, ADMIN_USERNAME, buildTestApp, loginAndGetCookie } from './helpers.js';

test('rejects wrong credentials and never starts a session', async () => {
    const { app } = await buildTestApp();
    try {
        const response = await app.inject({ method: 'POST', url: '/login', payload: { username: ADMIN_USERNAME, password: 'wrong' } });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /Identifiants invalides/);
        assert.equal(response.cookies.find(c => c.name === 'fako_admin_session'), undefined);
    } finally { await app.close(); }
});

test('accepts correct credentials and starts a session usable on subsequent requests', async () => {
    const { app } = await buildTestApp();
    try {
        const login = await app.inject({ method: 'POST', url: '/login', payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
        assert.equal(login.statusCode, 302);
        assert.equal(login.headers.location, '/admin');
        const cookies = await loginAndGetCookie(app);
        const dashboard = await app.inject({ url: '/admin', cookies });
        assert.equal(dashboard.statusCode, 200);
    } finally { await app.close(); }
});

test('every /admin route redirects to /login without a valid session; no anonymous access to unpublished videos', async () => {
    const { app } = await buildTestApp();
    try {
        for (const url of ['/admin', '/admin/quiz-videos', '/admin/quiz-videos/vid-1', '/admin/quiz-videos/vid-1/preview', '/admin/quiz-videos/vid-1/confirm?decision=APPROVED']) {
            const response = await app.inject({ url });
            assert.equal(response.statusCode, 302, `${url} should redirect when unauthenticated`);
            assert.equal(response.headers.location, '/login');
        }
    } finally { await app.close(); }
});

test('a forged or garbage session cookie is rejected just like no cookie at all', async () => {
    const { app } = await buildTestApp();
    try {
        const response = await app.inject({ url: '/admin', cookies: { fako_admin_session: 'not-a-real-session-value' } });
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/login');
    } finally { await app.close(); }
});

test('logging out tells the browser to clear the session cookie immediately', async () => {
    // @fastify/secure-session is a stateless, encrypted-cookie session: there is no server-side
    // revocation list, so logout cannot retroactively invalidate a *copy* of the old cookie value
    // (a real browser never replays a cookie it was told to expire). The session is additionally
    // time-bounded (see app.ts) so a copied cookie cannot be replayed indefinitely.
    const { app } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        assert.equal((await app.inject({ url: '/admin', cookies })).statusCode, 200);
        const logout = await app.inject({ method: 'POST', url: '/logout', cookies });
        assert.equal(logout.statusCode, 302);
        assert.equal(logout.headers.location, '/login');
        const cleared = logout.cookies.find(c => c.name === 'fako_admin_session');
        assert.ok(cleared, 'logout must send a Set-Cookie clearing the session');
        assert.equal(cleared!.value, '');
        assert.equal(cleared!.maxAge, 0);
    } finally { await app.close(); }
});

test('login attempts are rate-limited per client after repeated failures', async () => {
    const rateLimiter = new LoginRateLimiter(3, 15 * 60_000);
    const { app } = await buildTestApp({ rateLimiter });
    try {
        for (let i = 0; i < 3; i++) {
            const response = await app.inject({ method: 'POST', url: '/login', payload: { username: ADMIN_USERNAME, password: 'wrong' } });
            assert.match(response.body, /Identifiants invalides/);
        }
        const locked = await app.inject({ method: 'POST', url: '/login', payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
        assert.match(locked.body, /Trop de tentatives/);
        assert.equal(locked.cookies.find(c => c.name === 'fako_admin_session'), undefined, 'even the correct password is refused while locked out');
    } finally { await app.close(); }
});

test('already logged in, visiting /login redirects straight to the dashboard', async () => {
    const { app } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/login', cookies });
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/admin');
    } finally { await app.close(); }
});
