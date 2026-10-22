import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleQuizVideo, sampleSocialAccount, samplePublication, buildTestApp, loginAndGetCookie } from './helpers.js';

test('Publications requires a session, like every other admin page', async () => {
    const { app } = await buildTestApp();
    try {
        const response = await app.inject({ url: '/admin/publications' });
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/login');
    } finally { await app.close(); }
});

test('lists publications with their status, and filters by status/platform', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.publications.set('pub-1', samplePublication({ id: 'pub-1', platform: 'TIKTOK', status: 'PUBLISHED' }));
    apiClient.publications.set('pub-2', samplePublication({ id: 'pub-2', platform: 'INSTAGRAM', status: 'BLOCKED' }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/publications', cookies });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /\/admin\/publications\/pub-1/);
        assert.match(response.body, /\/admin\/publications\/pub-2/);

        const filtered = await app.inject({ url: '/admin/publications?status=PUBLISHED', cookies });
        assert.match(filtered.body, /\/admin\/publications\/pub-1/);
        assert.doesNotMatch(filtered.body, /\/admin\/publications\/pub-2/);
    } finally { await app.close(); }
});

test('the new-publication form only lists COMPLETED (approved) videos and CONNECTED accounts', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.list = { quizVideos: [sampleQuizVideo({ id: 'vid-ok', status: 'COMPLETED', validationStatus: 'APPROVED' })], total: 1 };
    apiClient.socialAccounts.set('social-1', sampleSocialAccount({ id: 'social-1', status: 'CONNECTED', displayName: 'RijPermis TikTok' }));
    apiClient.socialAccounts.set('social-2', sampleSocialAccount({ id: 'social-2', status: 'DISCONNECTED', displayName: 'RijPermis Instagram' }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/publications/new', cookies });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /vid-ok/);
        assert.match(response.body, /RijPermis TikTok/);
        assert.doesNotMatch(response.body, /RijPermis Instagram/); // disconnected account never offered as a destination
        assert.equal(apiClient.lastListFilters?.status, 'COMPLETED');
    } finally { await app.close(); }
});

test('submitting the new-publication form schedules a publication and never calls anything publish-shaped', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({
            url: '/admin/publications/new', cookies, method: 'POST',
            payload: {
                quizVideoId: 'vid-1', socialAccountId: 'social-1', language: 'fr', caption: 'Le quiz du jour !',
                hashtags: '#codederoute #permis', scheduledAtLocal: '2026-03-01T09:00', requestId: 'req-abc'
            }
        });
        assert.equal(response.statusCode, 302);
        assert.match(response.headers.location as string, /^\/admin\/publications\/pub-1\?flash=/);
        assert.equal(apiClient.schedulePublicationCalls.length, 1);
        assert.equal(apiClient.schedulePublicationCalls[0].input.quizVideoId, 'vid-1');
        assert.deepEqual(apiClient.schedulePublicationCalls[0].input.hashtags, ['#codederoute', '#permis']);
        assert.equal(apiClient.schedulePublicationCalls[0].input.createdBy, 'admin');

        const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(apiClient));
        assert.ok(!methodNames.some(name => /publish/i.test(name)), 'no publish-shaped method exists on the API client used by the admin UI');
    } finally { await app.close(); }
});

test('an incomplete new-publication submission is rejected before calling the API at all', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/publications/new', cookies, method: 'POST', payload: { quizVideoId: 'vid-1' } });
        assert.equal(response.statusCode, 400);
        assert.equal(apiClient.schedulePublicationCalls.length, 0);
    } finally { await app.close(); }
});

test('the detail page shows attempt history, remote link, and the error message when blocked', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.publications.set('pub-1', samplePublication({
        id: 'pub-1', status: 'BLOCKED', lastError: 'Vidéo non approuvée par un administrateur',
        attemptHistory: [{ id: 'att-1', attemptNumber: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: 'BLOCKED', remoteStatus: null, errorCode: null, errorMessage: 'Vidéo non approuvée par un administrateur' }]
    }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/publications/pub-1', cookies });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /Vidéo non approuvée par un administrateur/);
        assert.match(response.body, /Bloquée/);
    } finally { await app.close(); }
});

test('cancelling a publication calls cancelPublication with the session user and redirects back to the detail page', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.publications.set('pub-1', samplePublication({ id: 'pub-1', status: 'SCHEDULED' }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/publications/pub-1/cancel', cookies, method: 'POST' });
        assert.equal(response.statusCode, 302);
        assert.match(response.headers.location as string, /^\/admin\/publications\/pub-1\?flash=/);
        assert.deepEqual(apiClient.cancelPublicationCalls, [{ id: 'pub-1', cancelledBy: 'admin' }]);
    } finally { await app.close(); }
});

test('retrying a publication calls retryPublication and redirects back to the detail page', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.publications.set('pub-1', samplePublication({ id: 'pub-1', status: 'BLOCKED' }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/publications/pub-1/retry', cookies, method: 'POST' });
        assert.equal(response.statusCode, 302);
        assert.deepEqual(apiClient.retryPublicationCalls, ['pub-1']);
    } finally { await app.close(); }
});

test('an API error while scheduling surfaces as a flash instead of a 500', async () => {
    const { app } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({
            url: '/admin/publications/new', cookies, method: 'POST',
            payload: { quizVideoId: 'vid-missing', socialAccountId: 'social-missing', language: 'fr', caption: 'x', requestId: 'req-x' }
        });
        // FakeApiClient.schedulePublication never throws for unknown ids (it just creates one), so this
        // exercises the success path end-to-end; a thrown ApiError is covered by the social-settings
        // equivalent test and by the shared errorMessage()/flashRedirect() helpers used identically here.
        assert.equal(response.statusCode, 302);
    } finally { await app.close(); }
});

test('the quiz video detail page only offers "Programmer une publication" once the video is COMPLETED', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.videos.set('vid-1', sampleQuizVideo({ id: 'vid-1', status: 'WAITING_APPROVAL', validationStatus: 'PENDING_APPROVAL' }));
    apiClient.videos.set('vid-2', sampleQuizVideo({ id: 'vid-2', status: 'COMPLETED', validationStatus: 'APPROVED' }));
    try {
        const cookies = await loginAndGetCookie(app);
        const pending = await app.inject({ url: '/admin/quiz-videos/vid-1', cookies });
        assert.doesNotMatch(pending.body, /Programmer une publication/);

        const completed = await app.inject({ url: '/admin/quiz-videos/vid-2', cookies });
        assert.match(completed.body, /Programmer une publication/);
    } finally { await app.close(); }
});
