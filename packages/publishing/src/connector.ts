import type {
    AuthorizationRequest, Capabilities, CodeExchangeRequest, ExternalAccountInfo,
    MediaDescriptor, MediaValidationResult, OAuthTokenSet, PublicationStatusResult,
    PublishVideoRequest, PublishVideoResult, SocialPlatform
} from './types.js';

// Mission 13 section 3: one shared shape, three adapters (TikTok, Instagram, Facebook Pages) that
// implement it without hiding how differently each platform actually behaves — connectAccount is
// intentionally split into getAuthorizationUrl + exchangeCodeForTokens rather than one opaque call,
// because the redirect step must happen in the admin's browser while the exchange is server-only.
export interface SocialPlatformConnector {
    readonly platform: SocialPlatform;

    // True only when this process has the developer app credentials (client id/secret) this
    // platform's real OAuth flow needs. The admin UI must never present a connect button as
    // functional when this is false (mission 13 section 9).
    isConfigured(): boolean;

    getAuthorizationUrl(request: AuthorizationRequest): string;

    exchangeCodeForTokens(request: CodeExchangeRequest): Promise<OAuthTokenSet>;

    refreshCredentials(tokens: OAuthTokenSet): Promise<OAuthTokenSet>;

    getAccountInfo(tokens: OAuthTokenSet): Promise<ExternalAccountInfo>;

    // Pure/local: derives what's actually possible from scopes already granted plus whatever
    // platform-specific gate applies (e.g. TikTok's unaudited-app private-only restriction). Never
    // makes a network call itself — callers needing live state (e.g. Instagram's publishing quota)
    // must fetch it separately and pass it in via `context`.
    getCapabilities(context: { grantedScopes: string[]; tokenExpiresAt?: Date; appAudited?: boolean }): Capabilities;

    validateMediaRequirements(media: MediaDescriptor): MediaValidationResult;

    // Best-effort revoke at the platform; must never throw just because the platform has no
    // revoke endpoint (TikTok/Meta don't universally expose one) — disconnection of the local
    // record always proceeds regardless of whether the remote revoke succeeded.
    disconnectAccount(tokens: OAuthTokenSet): Promise<void>;

    // Mission 14. Initiates a real publish. MUST throw (never resolve to `FAILED`) on anything
    // ambiguous — network error, timeout, non-2xx with no clear platform-confirmed meaning — so the
    // caller can tell "the platform said no" from "we don't know what happened" (section 7's
    // impérative rule: an unknown outcome must never be silently retried as if it were a clean
    // failure). Only resolve to `FAILED` when the platform's response unambiguously confirms the
    // content was rejected before anything was accepted.
    publishVideo(request: PublishVideoRequest): Promise<PublishVideoResult>;

    // Polls a `PENDING` publish's remote processing state (TikTok's publish/status/fetch, Meta's
    // container status_code / video status fields). Same ambiguity contract as publishVideo: throw
    // rather than guess.
    getPublicationStatus(remoteRef: string, accessToken: string): Promise<PublicationStatusResult>;
}

export const PUBLISH_SCOPE_BY_PLATFORM: Record<SocialPlatform, string> = {
    TIKTOK: 'video.publish',
    INSTAGRAM: 'instagram_business_content_publish',
    FACEBOOK: 'pages_manage_posts'
};

export const BASIC_SCOPES_BY_PLATFORM: Record<SocialPlatform, string[]> = {
    TIKTOK: ['user.info.basic'],
    INSTAGRAM: ['instagram_business_basic'],
    FACEBOOK: ['pages_show_list', 'pages_read_engagement']
};
