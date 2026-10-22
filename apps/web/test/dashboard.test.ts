import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api-client.js';
import { buildTestApp, loginAndGetCookie, sampleDayReport } from './helpers.js';

test('renders every required dashboard figure for the requested day', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.dayReport = sampleDayReport({ planned: 6, jobsCreated: 5, generated: 3, waitingApproval: 2, approved: 1, rejected: 1, schedulingFailures: 1, generationFailures: 0, skipped: 0 });
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin?date=2026-01-15', cookies });
        assert.equal(response.statusCode, 200);
        for (const expected of ['6', '5', '3', '2', '1']) assert.match(response.body, new RegExp(`>${expected}<`));
        assert.match(response.body, /09:00/);
        assert.match(response.body, /Priorité/);
        assert.match(response.body, /<strong>3<\/strong> FR/);
    } finally { await app.close(); }
});

test('defaults to today when no date is given, and date navigation links are present', async () => {
    const { app } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin', cookies });
        assert.equal(response.statusCode, 200);
        const today = new Date().toISOString().slice(0, 10);
        assert.match(response.body, new RegExp(today));
        assert.match(response.body, /Veille/);
        assert.match(response.body, /Lendemain/);
    } finally { await app.close(); }
});

test('an API error renders an explicit, readable message instead of crashing', async () => {
    const { app, apiClient } = await buildTestApp();
    apiClient.dayReport = new ApiError(503, 'Scheduler reporting is not configured');
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin', cookies });
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /Scheduler reporting is not configured/);
    } finally { await app.close(); }
});

test('an invalid date query parameter is ignored in favor of today, rather than crashing', async () => {
    const { app } = await buildTestApp();
    try {
        const cookies = await loginAndGetCookie(app);
        const response = await app.inject({ url: '/admin?date=not-a-date', cookies });
        assert.equal(response.statusCode, 200);
    } finally { await app.close(); }
});
