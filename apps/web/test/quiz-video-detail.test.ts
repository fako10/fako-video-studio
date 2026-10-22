import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp, loginAndGetCookie, sampleQuizVideo } from './helpers.js';

test('shows traceability, render info and the video player when a file is available', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.videos.set('vid-1', sampleQuizVideo({ fileKey: 'present.mp4', ttsProvider: 'elevenlabs' }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1', cookies });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /<video class="vertical"[^>]*src="\/admin\/quiz-videos\/vid-1\/preview"/);
        assert.match(response.body, /Qui a la priorité ici \?/);
        assert.match(response.body, new RegExp(`sha256:a{64}`));
        assert.match(response.body, /elevenlabs/);
    } finally { await app.close(); }
});

test('offers no video element when no file exists yet, instead of a broken player', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.videos.set('vid-1', sampleQuizVideo({ fileKey: null, status: 'PROCESSING' }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1', cookies });
        assert.doesNotMatch(response.body, /<video/);
        assert.match(response.body, /Aucun fichier vidéo disponible/);
    } finally { await app.close(); }
});

test('shows an explicit error message when generation failed', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.videos.set('vid-1', sampleQuizVideo({ status: 'FAILED', errorMessage: 'TTS_HTTP_429', fileKey: null }));
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/vid-1', cookies });
        assert.match(response.body, /TTS_HTTP_429/);
    } finally { await app.close(); }
});

test('offers approve/reject only while the video is actually awaiting review', async () => {
    const { app, apiClient } = await buildTestApp();
    const cookies = await loginAndGetCookie(app);
    try {
        apiClient.videos.set('vid-1', sampleQuizVideo({ status: 'WAITING_APPROVAL', validationStatus: 'PENDING_APPROVAL' }));
        const pending = await app.inject({ url: '/admin/quiz-videos/vid-1', cookies });
        assert.match(pending.body, /Approuver/);
        assert.match(pending.body, /Rejeter/);

        apiClient.videos.set('vid-1', sampleQuizVideo({ status: 'COMPLETED', validationStatus: 'APPROVED', reviewedBy: 'admin' }));
        const done = await app.inject({ url: '/admin/quiz-videos/vid-1', cookies });
        assert.doesNotMatch(done.body, /Approuver/);
        assert.doesNotMatch(done.body, /Rejeter/);
        assert.match(done.body, /admin/);
    } finally { await app.close(); }
});

test('a missing video id is a clear 404, not a crash', async () => {
    const { app } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin/quiz-videos/does-not-exist', cookies });
        assert.equal(response.statusCode, 404);
        assert.match(response.body, /Quiz video not found/);
    } finally { await app.close(); }
});
