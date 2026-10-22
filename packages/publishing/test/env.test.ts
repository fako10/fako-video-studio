import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socialConnectorsFromEnv } from '../src/env.js';

test('socialConnectorsFromEnv returns mock connectors outside production', () => {
    const connectors = socialConnectorsFromEnv({ SOCIAL_MOCK_MODE: 'true', NODE_ENV: 'test' });
    assert.equal(connectors.TIKTOK.platform, 'TIKTOK');
});

test('socialConnectorsFromEnv refuses mock mode in production even if explicitly requested', () => {
    assert.throws(() => socialConnectorsFromEnv({ SOCIAL_MOCK_MODE: 'true', NODE_ENV: 'production' }), /SOCIAL_MOCK_MODE_FORBIDDEN_IN_PRODUCTION/);
});

// Mission 16: same explicit, separate opt-in as @fako/content-sources' contentSourceFromEnv.
test('socialConnectorsFromEnv allows mock mode in production only with the explicit FAKO_ALLOW_MOCK_IN_PRODUCTION opt-in', () => {
    const connectors = socialConnectorsFromEnv({ SOCIAL_MOCK_MODE: 'true', NODE_ENV: 'production', FAKO_ALLOW_MOCK_IN_PRODUCTION: 'true' });
    assert.equal(connectors.INSTAGRAM.platform, 'INSTAGRAM');
    assert.throws(() => socialConnectorsFromEnv({ SOCIAL_MOCK_MODE: 'true', NODE_ENV: 'production', FAKO_ALLOW_MOCK_IN_PRODUCTION: 'false' }), /SOCIAL_MOCK_MODE_FORBIDDEN_IN_PRODUCTION/);
});

test('socialConnectorsFromEnv builds real connectors when not in mock mode', () => {
    const connectors = socialConnectorsFromEnv({});
    assert.equal(connectors.FACEBOOK.platform, 'FACEBOOK');
    assert.equal(connectors.FACEBOOK.isConfigured(), false);
});
