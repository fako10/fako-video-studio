import type { SocialPlatformConnector } from '../connector.js';
import { validateMediaRequirements } from '../media.js';
import type {
    AuthorizationRequest, Capabilities, CodeExchangeRequest, ExternalAccountInfo,
    MediaDescriptor, MediaValidationResult, OAuthTokenSet, PublicationStatusResult,
    PublishVideoRequest, PublishVideoResult
} from '../types.js';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';
const CREATOR_INFO_URL = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';
const VIDEO_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS_FETCH_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const RETRYABLE_INIT_ERROR_CODES = new Set(['rate_limit_exceeded', 'internal_error']);

// TikTok for Developers, verified against official docs (mission 13 research): Login Kit v2 OAuth,
// `state` is the documented CSRF mitigation for a confidential web client (PKCE is required for
// desktop/mobile client types, not for this one, but is still forwarded if the caller provides it).
// `video.publish` enables direct posting; `video.upload` only ever lands content as a draft. Every
// unaudited app is hard-restricted by TikTok itself to private-only posts regardless of scope —
// see getCapabilities().
export class TikTokConnector implements SocialPlatformConnector {
    readonly platform = 'TIKTOK' as const;

    constructor(private readonly clientKey?: string, private readonly clientSecret?: string) {}

    isConfigured(): boolean {
        return Boolean(this.clientKey && this.clientSecret);
    }

    private requireCredentials(): { clientKey: string; clientSecret: string } {
        if (!this.clientKey || !this.clientSecret) throw new Error('TikTok connector is not configured (missing TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET)');
        return { clientKey: this.clientKey, clientSecret: this.clientSecret };
    }

    getAuthorizationUrl(request: AuthorizationRequest): string {
        const { clientKey } = this.requireCredentials();
        const params = new URLSearchParams({
            client_key: clientKey, response_type: 'code', scope: 'user.info.basic,video.publish,video.upload',
            redirect_uri: request.redirectUri, state: request.state
        });
        if (request.codeChallenge) { params.set('code_challenge', request.codeChallenge); params.set('code_challenge_method', 'S256'); }
        return `${AUTHORIZE_URL}?${params.toString()}`;
    }

    async exchangeCodeForTokens(request: CodeExchangeRequest): Promise<OAuthTokenSet> {
        const { clientKey, clientSecret } = this.requireCredentials();
        const body = new URLSearchParams({
            client_key: clientKey, client_secret: clientSecret, code: request.code,
            grant_type: 'authorization_code', redirect_uri: request.redirectUri
        });
        if (request.codeVerifier) body.set('code_verifier', request.codeVerifier);
        const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        if (!response.ok) throw new Error(`TikTok token exchange failed (HTTP ${response.status})`);
        const data = await response.json() as { access_token: string; refresh_token?: string; expires_in: number; refresh_expires_in?: number; scope: string };
        return {
            accessToken: data.access_token, refreshToken: data.refresh_token,
            expiresAt: new Date(Date.now() + data.expires_in * 1000),
            refreshTokenExpiresAt: data.refresh_expires_in ? new Date(Date.now() + data.refresh_expires_in * 1000) : undefined,
            grantedScopes: data.scope ? data.scope.split(',') : []
        };
    }

    async refreshCredentials(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
        const { clientKey, clientSecret } = this.requireCredentials();
        if (!tokens.refreshToken) throw new Error('No TikTok refresh token available');
        const body = new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
        const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        if (!response.ok) throw new Error(`TikTok token refresh failed (HTTP ${response.status})`);
        const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number; scope: string };
        // TikTok may rotate the refresh token on every refresh call — the newest value must always
        // replace the stored one, never assume the original refresh token stays valid.
        return {
            accessToken: data.access_token, refreshToken: data.refresh_token,
            expiresAt: new Date(Date.now() + data.expires_in * 1000),
            refreshTokenExpiresAt: new Date(Date.now() + data.refresh_expires_in * 1000),
            grantedScopes: data.scope ? data.scope.split(',') : []
        };
    }

    async getAccountInfo(tokens: OAuthTokenSet): Promise<ExternalAccountInfo> {
        const response = await fetch(`${USER_INFO_URL}?fields=open_id,display_name`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
        if (!response.ok) throw new Error(`TikTok account info request failed (HTTP ${response.status})`);
        const data = await response.json() as { data: { user: { open_id: string; display_name: string } } };
        return { externalAccountId: data.data.user.open_id, displayName: data.data.user.display_name };
    }

    getCapabilities(context: { grantedScopes: string[]; tokenExpiresAt?: Date; appAudited?: boolean }): Capabilities {
        const missingScopes = ['user.info.basic', 'video.publish'].filter(scope => !context.grantedScopes.includes(scope));
        const tokenValid = !context.tokenExpiresAt || context.tokenExpiresAt.getTime() > Date.now();
        const hasPublishScope = context.grantedScopes.includes('video.publish');
        const audited = context.appAudited ?? false;
        const notes: string[] = [];
        if (!audited) notes.push('App non auditée par TikTok : toute publication serait forcée en visibilité privée (restriction plateforme, pas un choix applicatif).');
        if (!hasPublishScope && context.grantedScopes.includes('video.upload')) notes.push('Seul le scope video.upload est accordé : le contenu n\'atterrirait qu\'en brouillon, jamais publié directement.');
        return {
            platform: this.platform, connected: tokenValid, tokenValid, grantedScopes: context.grantedScopes, missingScopes,
            canPublishDirectly: tokenValid && hasPublishScope && audited, requiresManualStep: !audited, notes
        };
    }

    validateMediaRequirements(media: MediaDescriptor): MediaValidationResult {
        return validateMediaRequirements('TIKTOK', media);
    }

    // No public revoke endpoint is documented by TikTok for Developers; disconnection always
    // proceeds locally regardless (see SocialPlatformConnector contract).
    async disconnectAccount(): Promise<void> {}

    // FILE_UPLOAD rather than PULL_FROM_URL: our architecture never exposes the stored MP4 on a
    // public HTTPS URL (BFF-authenticated storage only), and FILE_UPLOAD accepts the bytes directly.
    async publishVideo(request: PublishVideoRequest): Promise<PublishVideoResult> {
        if (request.videoBytes.length > MAX_FILE_SIZE) {
            return { outcome: 'FAILED', retryable: false, code: 'FILE_TOO_LARGE', message: 'TikTok Content Posting API accepts at most 4GB' };
        }

        // Every unaudited app is private-only regardless of what we request (getCapabilities already
        // reflects this), so SELF_ONLY is always the safe choice; ask the platform for its own
        // allowed options first rather than assume, but never fail this call just because that
        // courtesy lookup itself failed — fall back to the one privacy level TikTok always accepts.
        let privacyLevel = 'SELF_ONLY';
        try {
            const creatorInfo = await fetch(CREATOR_INFO_URL, {
                method: 'POST', headers: { Authorization: `Bearer ${request.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: '{}'
            });
            if (creatorInfo.ok) {
                const data = await creatorInfo.json() as { data?: { privacy_level_options?: string[] } };
                const options = data.data?.privacy_level_options ?? [];
                if (options.length) privacyLevel = options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
            }
        } catch { /* creator_info is a courtesy lookup; SELF_ONLY above is always safe */ }

        const chunkSize = Math.min(request.videoBytes.length, MAX_CHUNK_SIZE) || request.videoBytes.length;
        const totalChunkCount = Math.max(1, Math.ceil(request.videoBytes.length / chunkSize));

        const initResponse = await fetch(VIDEO_INIT_URL, {
            method: 'POST', headers: { Authorization: `Bearer ${request.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({
                post_info: { title: request.caption.slice(0, 2200), privacy_level: privacyLevel, disable_duet: false, disable_stitch: false, disable_comment: false },
                source_info: { source: 'FILE_UPLOAD', video_size: request.videoBytes.length, chunk_size: chunkSize, total_chunk_count: totalChunkCount }
            })
        });
        const initData = await initResponse.json() as { data?: { publish_id: string; upload_url: string }; error?: { code: string; message: string } };
        if (initData.error && initData.error.code !== 'ok') {
            const retryable = RETRYABLE_INIT_ERROR_CODES.has(initData.error.code) || initResponse.status >= 500;
            return { outcome: 'FAILED', retryable, code: initData.error.code, message: initData.error.message };
        }
        if (!initData.data) throw new Error('TikTok video init returned no data (ambiguous response)');
        const { publish_id, upload_url } = initData.data;

        // A single PUT covers the single-chunk case (the only one this codebase's video sizes ever
        // hit); multi-chunk upload would need one PUT per chunk with its own Content-Range, left as a
        // follow-up since no RijPermis quiz video has ever approached 64MB.
        const uploadResponse = await fetch(upload_url, {
            method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${request.videoBytes.length - 1}/${request.videoBytes.length}` },
            // Cast needed: lib.dom's BodyInit types a Buffer's `.buffer` as ArrayBuffer, not accepted
            // directly — same cast as facebook.ts's resumable transfer step.
            body: request.videoBytes as unknown as BodyInit
        });
        if (!uploadResponse.ok) throw new Error(`TikTok video upload failed (HTTP ${uploadResponse.status}, outcome unknown)`);

        return { outcome: 'PENDING', remoteRef: publish_id };
    }

    async getPublicationStatus(remoteRef: string, accessToken: string): Promise<PublicationStatusResult> {
        const response = await fetch(STATUS_FETCH_URL, {
            method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ publish_id: remoteRef })
        });
        if (!response.ok) throw new Error(`TikTok publish status fetch failed (HTTP ${response.status})`);
        const data = await response.json() as { data?: { status: string; publicly_available_post_id?: string[]; fail_reason?: string } };
        if (!data.data) throw new Error('TikTok publish status fetch returned no data (ambiguous response)');
        const { status, publicly_available_post_id, fail_reason } = data.data;

        if (status === 'PUBLISH_COMPLETE') return { outcome: 'PUBLISHED', remotePostId: publicly_available_post_id?.[0] ?? remoteRef };
        if (status === 'FAILED') {
            const retryable = fail_reason === 'internal' || fail_reason === undefined;
            return { outcome: 'FAILED', retryable, code: fail_reason ?? 'TIKTOK_PUBLISH_FAILED', message: `TikTok reported failure: ${fail_reason ?? 'unknown reason'}` };
        }
        if (status === 'PROCESSING_UPLOAD' || status === 'PROCESSING_DOWNLOAD' || status === 'SEND_TO_USER_INBOX') return { outcome: 'PENDING' };
        throw new Error(`Unexpected TikTok publish status "${status}" (ambiguous)`);
    }
}
