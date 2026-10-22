import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api-client.js';
import { buildTestApp, loginAndGetCookie, sampleQuizVideo } from './helpers.js';

test('lists videos with the columns the mission requires', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.list = { quizVideos: [sampleQuizVideo({ id: 'vid-1', language: 'fr', category: 'Priorité', questionId: 'q-1', status: 'WAITING_APPROVAL', durationSeconds: 18.4 })], total: 1 };
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos', cookies });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /FR/);
        assert.match(response.body, /Priorité/);
        assert.match(response.body, /q-1/);
        assert.match(response.body, /18\.4/);
        assert.match(response.body, /vid-1/);
    } finally { await app.close(); }
});

test('forwards language, status and date filters to the API unchanged', async () => {
    const { app, apiClient } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        await app.inject({ url: '/admin/quiz-videos?language=nl&status=WAITING_APPROVAL&date=2026-01-15', cookies });
        assert.deepEqual(apiClient.lastListFilters, { language: 'nl', status: 'WAITING_APPROVAL', date: '2026-01-15', offset: 0, limit: 20 });
    } finally { await app.close(); }
});

test('paginates: shows next/previous links consistently with offset and total', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.list = { quizVideos: [sampleQuizVideo()], total: 45 };
    try {
        const cookies = await loginAndGetCookie(app);
        const page1 = await app.inject({ url: '/admin/quiz-videos', cookies });
        assert.match(page1.body, /Suivant/);
        assert.doesNotMatch(page1.body, /Précédent/);

        const page2 = await app.inject({ url: '/admin/quiz-videos?offset=20', cookies });
        assert.match(page2.body, /Précédent/);
        assert.match(page2.body, /Suivant/);
    } finally { await app.close(); }
});

test('an empty result set is shown as a clear, non-alarming message', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.list = { quizVideos: [], total: 0 };
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos', cookies });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /Aucune vidéo ne correspond/);
    } finally { await app.close(); }
});

test('an API failure on the list page is shown explicitly, not silently swallowed', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.listQuizVideos = async () => { throw new ApiError(500, 'Internal server error'); };
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos', cookies });
        assert.equal(response.statusCode, 500);
        assert.match(response.body, /Internal server error/);
    } finally { await app.close(); }
});

test('requires a session like every other admin page', async () => {
    const { app } = await buildTestApp();
    try {
        const response = await app.inject({ url: '/admin/quiz-videos' });
        assert.equal(response.statusCode, 302);
        assert.equal(response.headers.location, '/login');
    } finally { await app.close(); }
});
