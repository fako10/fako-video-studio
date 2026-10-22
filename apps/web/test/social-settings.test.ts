import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api-client.js';
import { buildTestApp, loginAndGetCookie, sampleCapabilities, sampleSocialAccount } from './helpers.js';

test('Paramètres → Réseaux sociaux requires a session, like every other admin page', async () => {
    const { app } = await buildTestApp();
    try {
        const response = await app.inject({ url: '/admin/settings/social' });
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/login');
    } finally { await app.close(); }
});

test('lists platforms and connected accounts with their capability diagnostic', async () => {
    const { app, apiClient } = await buildTestApp();
    const account = sampleSocialAccount({ id: 'social-1', platform: 'TIKTOK', status: 'CONNECTED', languages: ['fr', 'nl'] });
    apiClient.socialAccounts.set(account.id, account);
    apiClient.capabilities.set(account.id, sampleCapabilities({ socialAccountId: account.id, canPublishDirectly: false, notes: ['App non auditée.'] }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/settings/social', cookies });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /TikTok/);
        assert.match(response.body, /RijPermis FR/);
        // "Connexion réussie ≠ autorisation de publier" must be visible even though status is CONNECTED
        assert.match(response.body, /Publication non autorisée/);
        assert.match(response.body, /Identifiants développeur non configurés/); // Facebook is unconfigured in the fake client
    } finally { await app.close(); }
});

test('connecting to a mock-mode platform redirects the browser to the local simulated consent screen, never to mock.invalid', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/settings/social/TIKTOK/connect', cookies, method: 'POST' });
        assert.equal(response.statusCode, 302);
        assert.match(response.headers.location as string, /^\/admin\/settings\/social\/TIKTOK\/mock-consent\?state=abc$/);
        assert.equal(apiClient.oauthStartCalls[0]?.platform, 'TIKTOK');
        assert.equal(apiClient.oauthStartCalls[0]?.redirectUri, 'http://127.0.0.1:3100/admin/settings/social/TIKTOK/callback');
    } finally { await app.close(); }
});

test('a bare GET can never start an OAuth connection (mission 15 CSRF hardening: POST only)', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/settings/social/TIKTOK/connect', cookies, method: 'GET' });
        assert.notEqual(response.statusCode, 302);
        assert.equal(apiClient.oauthStartCalls.length, 0, 'a GET must never trigger the OAuth side effect');
    } finally { await app.close(); }
});

test('an unconfigured platform surfaces the API error as a flash instead of a broken redirect', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.oauthStartResult = new ApiError(503, 'FACEBOOK is not configured with developer credentials');
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/settings/social/FACEBOOK/connect', cookies, method: 'POST' });
        assert.equal(response.statusCode, 302);
        assert.match(response.headers.location as string, /^\/admin\/settings\/social\?flash=.*flashType=error$/);
    } finally { await app.close(); }
});

test('mock consent screen renders the state as a hidden field, and allow completes the callback', async () => {
    const { app, apiClient } = await buildTestApp();
    const account = sampleSocialAccount({ id: 'social-2' });
    apiClient.oauthCallbackResult = account;
    try {
        const cookies = await loginAndGetCookie(app);
        const consentPage = await app.inject({ url: '/admin/settings/social/TIKTOK/mock-consent?state=xyz', cookies });
        assert.equal(consentPage.statusCode, 200);
        assert.match(consentPage.body, /value="xyz"/);

        const allow = await app.inject({ url: '/admin/settings/social/TIKTOK/mock-consent', cookies, method: 'POST', payload: { state: 'xyz', decision: 'allow' } });
        assert.equal(allow.statusCode, 302);
        const callbackUrl = new URL(allow.headers.location as string, 'http://localhost');
        assert.equal(callbackUrl.pathname, '/admin/settings/social/TIKTOK/callback');
        assert.equal(callbackUrl.searchParams.get('state'), 'xyz');
        assert.ok(callbackUrl.searchParams.get('code'));

        const callback = await app.inject({ url: callbackUrl.pathname + callbackUrl.search, cookies });
        assert.equal(callback.statusCode, 302);
        assert.match(callback.headers.location as string, /^\/admin\/settings\/social\?flash=/);
        assert.equal(apiClient.oauthCallbackCalls[0]?.state, 'xyz');
        assert.equal(apiClient.socialAccounts.get('social-2')?.id, 'social-2');
    } finally { await app.close(); }
});

test('refusing in the mock consent screen never calls the callback endpoint', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const deny = await app.inject({ url: '/admin/settings/social/TIKTOK/mock-consent', cookies, method: 'POST', payload: { state: 'xyz', decision: 'deny' } });
        assert.equal(deny.statusCode, 302);
        assert.match(deny.headers.location as string, /flashType=error/);
        assert.equal(apiClient.oauthCallbackCalls.length, 0);
    } finally { await app.close(); }
});

test('disconnecting an account calls the API and never the review/publication path', async () => {
    const { app, apiClient } = await buildTestApp();
    const account = sampleSocialAccount({ id: 'social-3' });
    apiClient.socialAccounts.set(account.id, account);
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/settings/social/social-3/disconnect', cookies, method: 'POST' });
        assert.equal(response.statusCode, 302);
        assert.deepEqual(apiClient.disconnectCalls, ['social-3']);
        assert.equal(apiClient.socialAccounts.get('social-3')?.status, 'DISCONNECTED');
    } finally { await app.close(); }
});

test('updating languages accepts zero, one or several checked checkboxes', async () => {
    const { app, apiClient } = await buildTestApp();
    const account = sampleSocialAccount({ id: 'social-4', languages: ['fr'] });
    apiClient.socialAccounts.set(account.id, account);
    try {
        const cookies = await loginAndGetCookie(app);
        await app.inject({ url: '/admin/settings/social/social-4/languages', cookies, method: 'POST', payload: { languages: ['fr', 'nl'] } });
        assert.deepEqual(apiClient.languageUpdateCalls[0], { id: 'social-4', languages: ['fr', 'nl'] });

        await app.inject({ url: '/admin/settings/social/social-4/languages', cookies, method: 'POST', payload: { languages: 'nl' } });
        assert.deepEqual(apiClient.languageUpdateCalls[1], { id: 'social-4', languages: ['nl'] });

        await app.inject({ url: '/admin/settings/social/social-4/languages', cookies, method: 'POST', payload: {} });
        assert.deepEqual(apiClient.languageUpdateCalls[2], { id: 'social-4', languages: [] });
    } finally { await app.close(); }
});

test('no platform access token or OAuth secret ever appears in the rendered Paramètres page', async () => {
    const { app, apiClient } = await buildTestApp();
    const account = sampleSocialAccount({ id: 'social-5' });
    apiClient.socialAccounts.set(account.id, account);
    apiClient.capabilities.set(account.id, sampleCapabilities({ socialAccountId: account.id }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/settings/social', cookies });
        for (const forbidden of ['accessTokenCiphertext', 'refreshTokenCiphertext', 'Bearer ']) {
            assert.equal(response.body.includes(forbidden), false, `must never render ${forbidden}`);
        }
    } finally { await app.close(); }
});
