import type { QuizVideo, SocialConnectionStatus, SocialPlatform } from '@prisma/client';

export { SocialPlatform, SocialConnectionStatus };

// What a successful (or refreshed) OAuth exchange yields. Tokens are plaintext here only in
// memory, for the brief instant between the platform's response and encryptSecret() — never
// logged, never persisted unencrypted, never sent to a browser.
export type OAuthTokenSet = {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    refreshTokenExpiresAt?: Date;
    grantedScopes: string[];
    // Adapter-specific, non-secret carry-along data derived during the OAuth exchange itself, so a
    // second round-trip isn't needed just to learn it (e.g. Facebook's Page id, discovered while
    // deriving the Page access token from the user's long-lived token).
    metadata?: Record<string, unknown>;
};

export type ExternalAccountInfo = {
    externalAccountId: string;
    displayName: string;
    accountType?: string;
    metadata?: Record<string, unknown>;
};

// The section-12 diagnostic. Deliberately distinct from SocialConnectionStatus: a CONNECTED
// account can still have canPublishDirectly === false (e.g. TikTok app not yet audited, or the
// publish scope was never granted) — "connexion réussie ≠ autorisation de publier".
export type Capabilities = {
    platform: SocialPlatform;
    connected: boolean;
    tokenValid: boolean;
    grantedScopes: string[];
    missingScopes: string[];
    canPublishDirectly: boolean;
    requiresManualStep: boolean;
    notes: string[];
};

export type MediaDescriptor = {
    widthPx: number;
    heightPx: number;
    durationSeconds: number;
    fileSizeBytes: number;
    container: string;
};

export type MediaValidationIssue = {
    code: string;
    message: string;
    confidence: 'confirmed' | 'unverified';
};

export type MediaValidationResult = {
    ok: boolean;
    errors: MediaValidationIssue[];
    warnings: MediaValidationIssue[];
};

// Only the QuizVideo fields the readiness check actually reasons about — callers pass a real
// Prisma row, but tests can build a plain object without touching a database.
export type QuizVideoReadinessInput = Pick<QuizVideo, 'status' | 'validationStatus' | 'checkStatus' | 'checkedAt' | 'contentHash'>;

export type ReadinessResult = {
    ready: boolean;
    reasons: string[];
};

export type AuthorizationRequest = {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
};

export type CodeExchangeRequest = {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
};

// Mission 14. videoBytes is always provided (TikTok and Facebook Pages accept a direct local
// upload, confirmed against their official APIs); publicVideoUrl is required ONLY by Instagram's
// Content Publishing API, which has no documented raw-upload alternative for Reels — the engine
// passes it along only when one is actually configured (never fabricated), and the Instagram
// adapter refuses to proceed without it rather than guessing an endpoint that doesn't exist.
export type PublishVideoRequest = {
    accessToken: string;
    videoBytes: Buffer;
    media: MediaDescriptor;
    caption: string;
    hashtags: string[];
    accountMetadata?: Record<string, unknown>;
    publicVideoUrl?: string;
};

// A thrown exception (network error, timeout, non-HTTP failure) is deliberately NOT part of this
// type — the caller must treat it as ambiguous (OUTCOME_UNKNOWN), never as FAILED. Only an
// explicit, confirmed response from the platform is allowed to resolve to PUBLISHED or FAILED.
export type PublishVideoResult =
    | { outcome: 'PUBLISHED'; remotePostId: string; remoteUrl?: string }
    | { outcome: 'PENDING'; remoteRef: string }
    | { outcome: 'FAILED'; retryable: boolean; code: string; message: string };

export type PublicationStatusResult =
    | { outcome: 'PUBLISHED'; remotePostId: string; remoteUrl?: string }
    | { outcome: 'PENDING' }
    | { outcome: 'FAILED'; retryable: boolean; code: string; message: string };
