import { randomUUID } from 'node:crypto';
import type { SocialPlatformConnector } from './connector.js';
import { PUBLISH_SCOPE_BY_PLATFORM, BASIC_SCOPES_BY_PLATFORM } from './connector.js';
import { validateMediaRequirements } from './media.js';
import type {
    AuthorizationRequest, Capabilities, CodeExchangeRequest, ExternalAccountInfo,
    MediaDescriptor, MediaValidationResult, OAuthTokenSet, PublicationStatusResult,
    PublishVideoRequest, PublishVideoResult, SocialPlatform
} from './types.js';

export type MockScenario = 'FULL_ACCESS' | 'INSUFFICIENT_SCOPES' | 'EXPIRED_TOKEN' | 'CONNECT_FAILS';

// Independent from MockScenario (which governs connect/OAuth) so a test can connect cleanly and
// still exercise every publish outcome the real platforms can produce (mission 14 section 9: dry
// run must simulate success, async processing, rate limits and ambiguous/lost responses).
export type MockPublishScenario = 'SUCCESS' | 'PENDING_THEN_SUCCESS' | 'RATE_LIMITED' | 'PERMANENT_FAILURE' | 'TIMEOUT';

// In-memory connectors for the three platforms — no network call, ever (mission 13 section 13/15:
// "absence d'appels réels aux plateformes", "ne jamais utiliser une clé OAuth de production dans
// les tests automatisés"). `scenario` lets a test pick exactly what mission 13's test matrix needs:
// a clean connect, a connect that only grants read scopes, one that returns an already-expired
// token, or one where the platform itself refuses to connect (e.g. revoked consent).
export class MockSocialConnector implements SocialPlatformConnector {
    private accountCounter = 0;

    private readonly pendingRefs = new Set<string>();

    constructor(
        readonly platform: SocialPlatform,
        private readonly scenario: MockScenario = 'FULL_ACCESS',
        private readonly configured = true,
        private readonly publishScenario: MockPublishScenario = 'SUCCESS'
    ) {}

    isConfigured(): boolean {
        return this.configured;
    }

    getAuthorizationUrl(request: AuthorizationRequest): string {
        return `https://mock.invalid/${this.platform.toLowerCase()}/authorize?state=${encodeURIComponent(request.state)}&redirect_uri=${encodeURIComponent(request.redirectUri)}`;
    }

    async exchangeCodeForTokens(request: CodeExchangeRequest): Promise<OAuthTokenSet> {
        if (this.scenario === 'CONNECT_FAILS') throw new Error(`Mock ${this.platform} connection refused (simulated)`);
        const basic = BASIC_SCOPES_BY_PLATFORM[this.platform];
        const publish = PUBLISH_SCOPE_BY_PLATFORM[this.platform];
        const grantedScopes = this.scenario === 'INSUFFICIENT_SCOPES' ? basic : [...basic, publish];
        const expiresAt = this.scenario === 'EXPIRED_TOKEN' ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3600_000);
        return {
            accessToken: `mock-access-${this.platform}-${request.code}`, refreshToken: `mock-refresh-${this.platform}-${request.code}`,
            expiresAt, refreshTokenExpiresAt: new Date(Date.now() + 86_400_000 * 30), grantedScopes,
            metadata: this.platform === 'FACEBOOK' ? { pageId: `mock-page-${++this.accountCounter}`, pageName: 'RijPermis (mock)' } : undefined
        };
    }

    async refreshCredentials(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
        return { ...tokens, accessToken: `${tokens.accessToken}-refreshed`, expiresAt: new Date(Date.now() + 3600_000) };
    }

    async getAccountInfo(tokens: OAuthTokenSet): Promise<ExternalAccountInfo> {
        if (tokens.metadata?.pageId) return { externalAccountId: tokens.metadata.pageId as string, displayName: tokens.metadata.pageName as string, accountType: 'PAGE' };
        this.accountCounter += 1;
        return { externalAccountId: `mock-account-${this.platform}-${this.accountCounter}`, displayName: `RijPermis ${this.platform} (mock)`, accountType: 'BUSINESS' };
    }

    getCapabilities(context: { grantedScopes: string[]; tokenExpiresAt?: Date; appAudited?: boolean }): Capabilities {
        const publishScope = PUBLISH_SCOPE_BY_PLATFORM[this.platform];
        const missingScopes = [publishScope].filter(scope => !context.grantedScopes.includes(scope));
        const tokenValid = !context.tokenExpiresAt || context.tokenExpiresAt.getTime() > Date.now();
        return {
            platform: this.platform, connected: tokenValid, tokenValid, grantedScopes: context.grantedScopes, missingScopes,
            canPublishDirectly: tokenValid && missingScopes.length === 0, requiresManualStep: false, notes: []
        };
    }

    validateMediaRequirements(media: MediaDescriptor): MediaValidationResult {
        return validateMediaRequirements(this.platform, media);
    }

    async disconnectAccount(): Promise<void> {}

    // No real network call ever happens here (mission 14 section 9: zero network calls, zero media
    // sent, zero AI credits in dry run) — every branch below is a locally simulated platform
    // response, chosen by `publishScenario` rather than by actually looking at the request.
    async publishVideo(_request: PublishVideoRequest): Promise<PublishVideoResult> {
        switch (this.publishScenario) {
            case 'SUCCESS': {
                const id = `mock-post-${this.platform}-${randomUUID()}`;
                return { outcome: 'PUBLISHED', remotePostId: id, remoteUrl: `https://mock.invalid/${this.platform.toLowerCase()}/post/${id}` };
            }
            case 'PENDING_THEN_SUCCESS': {
                const ref = `mock-ref-${this.platform}-${randomUUID()}`;
                this.pendingRefs.add(ref);
                return { outcome: 'PENDING', remoteRef: ref };
            }
            case 'RATE_LIMITED':
                return { outcome: 'FAILED', retryable: true, code: 'RATE_LIMITED', message: `Mock ${this.platform} rate limit reached (simulated)` };
            case 'PERMANENT_FAILURE':
                return { outcome: 'FAILED', retryable: false, code: 'CONTENT_REJECTED', message: `Mock ${this.platform} rejected the content (simulated)` };
            case 'TIMEOUT':
                // Deliberately a thrown exception, not a resolved FAILED: this is what an ambiguous
                // "we don't know if the platform received it" outcome looks like to a caller.
                throw new Error(`Mock ${this.platform} publish request timed out (simulated, outcome unknown)`);
        }
    }

    // First poll after a PENDING publish resolves it to PUBLISHED — enough to exercise the
    // async-processing path (container/init → poll → confirmed) without an unbounded mock state
    // machine; a second, independent PENDING_THEN_SUCCESS connector models "still not confirmed".
    async getPublicationStatus(remoteRef: string): Promise<PublicationStatusResult> {
        if (!this.pendingRefs.has(remoteRef)) return { outcome: 'FAILED', retryable: false, code: 'UNKNOWN_REFERENCE', message: 'Mock reference not found (simulated)' };
        this.pendingRefs.delete(remoteRef);
        const id = `mock-post-${this.platform}-${randomUUID()}`;
        return { outcome: 'PUBLISHED', remotePostId: id, remoteUrl: `https://mock.invalid/${this.platform.toLowerCase()}/post/${id}` };
    }
}

export function mockConnectors(scenario: MockScenario = 'FULL_ACCESS', publishScenario: MockPublishScenario = 'SUCCESS'): Record<SocialPlatform, SocialPlatformConnector> {
    return {
        TIKTOK: new MockSocialConnector('TIKTOK', scenario, true, publishScenario),
        INSTAGRAM: new MockSocialConnector('INSTAGRAM', scenario, true, publishScenario),
        FACEBOOK: new MockSocialConnector('FACEBOOK', scenario, true, publishScenario),
        YOUTUBE: new MockSocialConnector('YOUTUBE', scenario, true, publishScenario),
        SNAPCHAT: new MockSocialConnector('SNAPCHAT', scenario, true, publishScenario)
    };
}
