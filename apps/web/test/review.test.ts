import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api-client.js';
import { ADMIN_USERNAME, buildTestApp, loginAndGetCookie } from './helpers.js';

const form = { 'content-type': 'application/x-www-form-urlencoded' };

test('approving requires an explicit confirmation step before anything is sent to the API', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const confirm = await app.inject({ url: '/admin/quiz-videos/vid-1/confirm?decision=APPROVED', cookies });
        assert.equal(confirm.statusCode, 200);
        assert.match(confirm.body, /approuver cette vidéo/i);
        assert.match(confirm.body, /action="\/admin\/quiz-videos\/vid-1\/review"/);
        assert.equal(apiClient.reviewCalls.length, 0, 'visiting the confirmation page must not itself approve anything');
    } finally { await app.close(); }
});

test('rejects a confirm request with an invalid or missing decision', async () => {
    const { app } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1/confirm?decision=PUBLISH', cookies });
        assert.equal(response.statusCode, 400);
    } finally { await app.close(); }
});

test('confirming approval forwards to the existing review endpoint with the session user as reviewer, and only that', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ method: 'POST', url: '/admin/quiz-videos/vid-1/review', cookies, headers: form, payload: 'decision=APPROVED&comment=Contenu+v%C3%A9rifi%C3%A9' });
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/admin/quiz-videos/vid-1?flash=Vid%C3%A9o%20approuv%C3%A9e.');
        assert.deepEqual(apiClient.reviewCalls, [{ id: 'vid-1', reviewedBy: ADMIN_USERNAME, decision: 'APPROVED', comment: 'Contenu vérifié' }]);
    } finally { await app.close(); }
});

test('confirming rejection forwards REJECTED and nothing else', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ method: 'POST', url: '/admin/quiz-videos/vid-1/review', cookies, headers: form, payload: 'decision=REJECTED' });
        assert.equal(response.statusCode, 302);
        assert.match(response.headers.location!, /flash=Vid%C3%A9o%20rejet%C3%A9e/);
        assert.equal(apiClient.reviewCalls[0].decision, 'REJECTED');
    } finally { await app.close(); }
});

test('an API rejection (already reviewed, etc.) surfaces as an explicit flash error, not a crash', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.reviewQuizVideo = async () => { throw new ApiError(409, 'Only a generated video awaiting review can be validated'); };
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ method: 'POST', url: '/admin/quiz-videos/vid-1/review', cookies, headers: form, payload: 'decision=APPROVED' });
        assert.equal(response.statusCode, 302);
        assert.match(response.headers.location!, /flashType=error/);
        assert.match(decodeURIComponent(response.headers.location!), /awaiting review/);
    } finally { await app.close(); }
});

test('review requires a session, exactly like every other write action', async () => {
    const { app } = await buildTestApp();
    try {
        const response = await app.inject({ method: 'POST', url: '/admin/quiz-videos/vid-1/review', headers: form, payload: 'decision=APPROVED' });
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/login');
    } finally { await app.close(); }
});

test('the API client exposes no publish-like method at all: approving can only ever call reviewQuizVideo', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        await app.inject({ method: 'POST', url: '/admin/quiz-videos/vid-1/review', cookies, headers: form, payload: 'decision=APPROVED' });
        const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(apiClient));
        assert.ok(!methodNames.some(name => /publish/i.test(name)), 'no publish-shaped method exists on the API client used by the admin UI');
        assert.equal(apiClient.reviewCalls.length, 1);
    } finally { await app.close(); }
});
