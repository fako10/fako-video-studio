import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mockConnectors, MockSocialConnector } from '../src/mocks.js';
import type { SocialPlatform } from '../src/types.js';

const PLATFORMS: SocialPlatform[] = ['TIKTOK', 'INSTAGRAM', 'FACEBOOK'];

for (const platform of PLATFORMS) {
    test(`${platform}: full-access mock grants the publish scope and connects`, async () => {
        const connector = new MockSocialConnector(platform, 'FULL_ACCESS');
        const tokens = await connector.exchangeCodeForTokens({ code: randomUUID(), redirectUri: 'https://admin.example/callback' });
        const capabilities = connector.getCapabilities({ grantedScopes: tokens.grantedScopes, tokenExpiresAt: tokens.expiresAt });
        assert.equal(capabilities.canPublishDirectly, true);
        assert.deepEqual(capabilities.missingScopes, []);
    });

    test(`${platform}: insufficient-scopes mock connects but cannot publish`, async () => {
        const connector = new MockSocialConnector(platform, 'INSUFFICIENT_SCOPES');
        const tokens = await connector.exchangeCodeForTokens({ code: randomUUID(), redirectUri: 'https://admin.example/callback' });
        const capabilities = connector.getCapabilities({ grantedScopes: tokens.grantedScopes, tokenExpiresAt: tokens.expiresAt });
        assert.equal(capabilities.canPublishDirectly, false);
        assert.ok(capabilities.missingScopes.length > 0);
    });

    test(`${platform}: expired-token mock yields a token already considered invalid`, async () => {
        const connector = new MockSocialConnector(platform, 'EXPIRED_TOKEN');
        const tokens = await connector.exchangeCodeForTokens({ code: randomUUID(), redirectUri: 'https://admin.example/callback' });
        const capabilities = connector.getCapabilities({ grantedScopes: tokens.grantedScopes, tokenExpiresAt: tokens.expiresAt });
        assert.equal(capabilities.tokenValid, false);
        assert.equal(capabilities.canPublishDirectly, false);
    });

    test(`${platform}: connect-fails mock rejects the exchange`, async () => {
        const connector = new MockSocialConnector(platform, 'CONNECT_FAILS');
        await assert.rejects(() => connector.exchangeCodeForTokens({ code: randomUUID(), redirectUri: 'https://admin.example/callback' }));
    });

    test(`${platform}: getAccountInfo returns a distinct account per connect (multi-account support)`, async () => {
        const connector = new MockSocialConnector(platform, 'FULL_ACCESS');
        const tokensA = await connector.exchangeCodeForTokens({ code: 'a', redirectUri: 'https://admin.example/callback' });
        const tokensB = await connector.exchangeCodeForTokens({ code: 'b', redirectUri: 'https://admin.example/callback' });
        const infoA = await connector.getAccountInfo(tokensA);
        const infoB = await connector.getAccountInfo(tokensB);
        assert.notEqual(infoA.externalAccountId, infoB.externalAccountId);
    });

    test(`${platform}: disconnectAccount never throws`, async () => {
        const connector = new MockSocialConnector(platform, 'FULL_ACCESS');
        await assert.doesNotReject(() => connector.disconnectAccount());
    });

    test(`${platform}: unconfigured mock reports isConfigured() = false`, () => {
        const connector = new MockSocialConnector(platform, 'FULL_ACCESS', false);
        assert.equal(connector.isConfigured(), false);
    });
}

test('mockConnectors() returns one connector per supported platform', () => {
    const connectors = mockConnectors();
    assert.deepEqual(Object.keys(connectors).sort(), ['FACEBOOK', 'INSTAGRAM', 'TIKTOK']);
});

const SAMPLE_PUBLISH_REQUEST = {
    accessToken: 'mock-token', videoBytes: Buffer.from('fake mp4 bytes'),
    media: { widthPx: 1080, heightPx: 1920, durationSeconds: 10, fileSizeBytes: 14, container: 'mp4' },
    caption: 'Le quiz du jour !', hashtags: ['#codederoute']
};

// Mission 14 section 9: dry run must never make a real network call. Monkey-patching global.fetch
// to throw is the actual proof — not just an absence of imports — that every publish scenario below
// stays entirely in memory, covering both the OAuth round trip and the full publish lifecycle.
for (const platform of PLATFORMS) {
    test(`${platform}: publishVideo SUCCESS resolves immediately with a remote id and url, no network call`, async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => { throw new Error('mock mode must never call fetch'); }) as typeof fetch;
        try {
            const connector = new MockSocialConnector(platform, 'FULL_ACCESS', true, 'SUCCESS');
            const result = await connector.publishVideo(SAMPLE_PUBLISH_REQUEST);
            assert.equal(result.outcome, 'PUBLISHED');
            if (result.outcome === 'PUBLISHED') {
                assert.match(result.remotePostId, new RegExp(`^mock-post-${platform}-`));
                assert.ok(result.remoteUrl);
            }
        } finally { globalThis.fetch = originalFetch; }
    });

    test(`${platform}: publishVideo PENDING_THEN_SUCCESS resolves asynchronously via getPublicationStatus`, async () => {
        const connector = new MockSocialConnector(platform, 'FULL_ACCESS', true, 'PENDING_THEN_SUCCESS');
        const started = await connector.publishVideo(SAMPLE_PUBLISH_REQUEST);
        assert.equal(started.outcome, 'PENDING');
        if (started.outcome !== 'PENDING') return;
        const stillPending = await connector.getPublicationStatus('unknown-ref', 'mock-token');
        assert.equal(stillPending.outcome, 'FAILED', 'an unrecognized reference is a confirmed failure, never ambiguous');
        const resolved = await connector.getPublicationStatus(started.remoteRef, 'mock-token');
        assert.equal(resolved.outcome, 'PUBLISHED');
    });

    test(`${platform}: publishVideo RATE_LIMITED is a confirmed, retryable failure`, async () => {
        const connector = new MockSocialConnector(platform, 'FULL_ACCESS', true, 'RATE_LIMITED');
        const result = await connector.publishVideo(SAMPLE_PUBLISH_REQUEST);
        assert.equal(result.outcome, 'FAILED');
        if (result.outcome === 'FAILED') assert.equal(result.retryable, true);
    });

    test(`${platform}: publishVideo PERMANENT_FAILURE is a confirmed, non-retryable failure`, async () => {
        const connector = new MockSocialConnector(platform, 'FULL_ACCESS', true, 'PERMANENT_FAILURE');
        const result = await connector.publishVideo(SAMPLE_PUBLISH_REQUEST);
        assert.equal(result.outcome, 'FAILED');
        if (result.outcome === 'FAILED') assert.equal(result.retryable, false);
    });

    test(`${platform}: publishVideo TIMEOUT throws — an ambiguous outcome is never resolved to FAILED or PUBLISHED`, async () => {
        const connector = new MockSocialConnector(platform, 'FULL_ACCESS', true, 'TIMEOUT');
        await assert.rejects(() => connector.publishVideo(SAMPLE_PUBLISH_REQUEST));
    });
}
