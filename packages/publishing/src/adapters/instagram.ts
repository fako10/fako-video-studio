import type { SocialPlatformConnector } from '../connector.js';
import { validateMediaRequirements } from '../media.js';
import type {
    AuthorizationRequest, Capabilities, CodeExchangeRequest, ExternalAccountInfo,
    MediaDescriptor, MediaValidationResult, OAuthTokenSet, PublicationStatusResult,
    PublishVideoRequest, PublishVideoResult
} from '../types.js';

const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const SHORT_LIVED_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const LONG_LIVED_EXCHANGE_URL = 'https://graph.instagram.com/access_token';
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';
const GRAPH_BASE = 'https://graph.instagram.com';

// Content Publishing (media container creation / media_publish) is a *different* Graph API surface
// than the Instagram-Login OAuth endpoints above: it lives on graph.facebook.com and is keyed by
// ig-user-id, not on graph.instagram.com. Version pinned to the same 'v21.0' facebook.ts already
// uses, for consistency across the package's two Meta-backed adapters.
const CONTENT_PUBLISHING_API_VERSION = 'v21.0';
const CONTENT_PUBLISHING_BASE = `https://graph.facebook.com/${CONTENT_PUBLISHING_API_VERSION}`;

// Graph API rate-limit codes per Meta's documented rate limiting error codes (application-level
// throttling / too-many-calls); 5xx is treated as retryable regardless of code.
const RATE_LIMIT_ERROR_CODES = [4, 17, 32, 613];

// "Instagram API with Instagram Login" (chosen path for mission 13 — the user confirmed this over
// "Instagram API with Facebook Login", which would additionally require linking a Facebook Page).
// Scopes use the instagram_business_* names Meta renamed to on 2025-01-27; the older
// instagram_basic/instagram_content_publish names belong to the Facebook Login path and must not
// be mixed in here. No PKCE: not documented anywhere in Meta's OAuth implementation.
export class InstagramConnector implements SocialPlatformConnector {
    readonly platform = 'INSTAGRAM' as const;

    constructor(private readonly appId?: string, private readonly appSecret?: string) {}

    isConfigured(): boolean {
        return Boolean(this.appId && this.appSecret);
    }

    private requireCredentials(): { appId: string; appSecret: string } {
        if (!this.appId || !this.appSecret) throw new Error('Instagram connector is not configured (missing INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET)');
        return { appId: this.appId, appSecret: this.appSecret };
    }

    getAuthorizationUrl(request: AuthorizationRequest): string {
        const { appId } = this.requireCredentials();
        const params = new URLSearchParams({
            client_id: appId, redirect_uri: request.redirectUri, response_type: 'code',
            scope: 'instagram_business_basic,instagram_business_content_publish', state: request.state
        });
        return `${AUTHORIZE_URL}?${params.toString()}`;
    }

    async exchangeCodeForTokens(request: CodeExchangeRequest): Promise<OAuthTokenSet> {
        const { appId, appSecret } = this.requireCredentials();
        const shortLivedBody = new URLSearchParams({
            client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: request.redirectUri, code: request.code
        });
        const shortLivedResponse = await fetch(SHORT_LIVED_TOKEN_URL, { method: 'POST', body: shortLivedBody });
        if (!shortLivedResponse.ok) throw new Error(`Instagram short-lived token exchange failed (HTTP ${shortLivedResponse.status})`);
        const shortLived = await shortLivedResponse.json() as { access_token: string; permissions?: string[] };

        // Immediately exchange for a long-lived token (60 days) — the short-lived one is single-use
        // and only valid ~1h, not durable enough to store.
        const exchangeUrl = new URL(LONG_LIVED_EXCHANGE_URL);
        exchangeUrl.searchParams.set('grant_type', 'ig_exchange_token');
        exchangeUrl.searchParams.set('client_secret', appSecret);
        exchangeUrl.searchParams.set('access_token', shortLived.access_token);
        const longLivedResponse = await fetch(exchangeUrl);
        if (!longLivedResponse.ok) throw new Error(`Instagram long-lived token exchange failed (HTTP ${longLivedResponse.status})`);
        const longLived = await longLivedResponse.json() as { access_token: string; expires_in: number };

        return {
            accessToken: longLived.access_token, expiresAt: new Date(Date.now() + longLived.expires_in * 1000),
            grantedScopes: shortLived.permissions ?? ['instagram_business_basic', 'instagram_business_content_publish']
        };
    }

    // Instagram's long-lived token refreshes itself (no separate refresh_token, unlike TikTok) —
    // only possible once the token is already at least 24h old and not yet expired.
    async refreshCredentials(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
        const url = new URL(REFRESH_URL);
        url.searchParams.set('grant_type', 'ig_refresh_token');
        url.searchParams.set('access_token', tokens.accessToken);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Instagram token refresh failed (HTTP ${response.status})`);
        const data = await response.json() as { access_token: string; expires_in: number };
        return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000), grantedScopes: tokens.grantedScopes };
    }

    async getAccountInfo(tokens: OAuthTokenSet): Promise<ExternalAccountInfo> {
        const url = new URL(`${GRAPH_BASE}/me`);
        url.searchParams.set('fields', 'id,username,account_type');
        url.searchParams.set('access_token', tokens.accessToken);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Instagram account info request failed (HTTP ${response.status})`);
        const data = await response.json() as { id: string; username: string; account_type?: string };
        return { externalAccountId: data.id, displayName: data.username, accountType: data.account_type };
    }

    getCapabilities(context: { grantedScopes: string[]; tokenExpiresAt?: Date }): Capabilities {
        const required = ['instagram_business_basic', 'instagram_business_content_publish'];
        const missingScopes = required.filter(scope => !context.grantedScopes.includes(scope));
        const tokenValid = !context.tokenExpiresAt || context.tokenExpiresAt.getTime() > Date.now();
        return {
            platform: this.platform, connected: tokenValid, tokenValid, grantedScopes: context.grantedScopes, missingScopes,
            canPublishDirectly: tokenValid && missingScopes.length === 0,
            requiresManualStep: false,
            notes: [
                'Nécessite un compte Instagram Business ou Creator — un compte personnel ne peut jamais publier via cette API (non vérifiable à partir des scopes seuls, à confirmer via getAccountInfo().accountType).',
                'Le quota de publication (/content_publishing_limit) doit être vérifié en direct avant chaque publication : les chiffres documentés par Meta varient selon les pages.'
            ]
        };
    }

    validateMediaRequirements(media: MediaDescriptor): MediaValidationResult {
        return validateMediaRequirements('INSTAGRAM', media);
    }

    // No documented Instagram-specific revoke endpoint; the user revoking access from their own
    // Instagram/Facebook account settings is the platform-sanctioned path. Local disconnection
    // always proceeds regardless.
    async disconnectAccount(): Promise<void> {}

    // Unlike TikTok (chunked upload) and Facebook Pages (resumable local upload), Meta's Content
    // Publishing API for Instagram Reels has no documented raw-upload alternative: media creation
    // requires `video_url`, a public HTTPS URL Meta's own servers fetch from. This install (local
    // storage behind an authenticated BFF, no deployment) does not expose one — detected locally,
    // with certainty, before any network call, rather than discovered as a remote failure.
    async publishVideo(request: PublishVideoRequest): Promise<PublishVideoResult> {
        if (!request.publicVideoUrl) {
            return {
                outcome: 'FAILED', retryable: false, code: 'PUBLIC_URL_REQUIRED',
                message: "Instagram exige une URL HTTPS publique pour la vidéo (video_url) ; aucune n'est configurée dans cette installation (pas de déploiement, mission 14)."
            };
        }

        // The ig-user-id the /media and /media_publish calls are scoped to: not part of
        // PublishVideoRequest (which is platform-agnostic), so the engine must carry it through as
        // accountMetadata.igUserId — mirrors facebook.ts's accountMetadata.pageId convention.
        const igUserId = request.accountMetadata?.igUserId as string | undefined;
        if (!igUserId) {
            return {
                outcome: 'FAILED', retryable: false, code: 'IG_USER_ID_REQUIRED',
                message: "Identifiant du compte Instagram Business (accountMetadata.igUserId) introuvable."
            };
        }

        const caption = [request.caption, ...request.hashtags.map(tag => (tag.startsWith('#') ? tag : `#${tag}`))].join(' ');
        const body = new URLSearchParams({ media_type: 'REELS', video_url: request.publicVideoUrl, caption, access_token: request.accessToken });
        const response = await fetch(`${CONTENT_PUBLISHING_BASE}/${igUserId}/media`, { method: 'POST', body });
        // Graph API returns confirmed error bodies on non-2xx (e.g. HTTP 400) just as often as on 200,
        // so the `error` field — not response.ok — is what decides FAILED vs. "throw as ambiguous".
        const data = await response.json() as { id?: string; error?: { message: string; type?: string; code?: number } };
        if (data.error) {
            const retryable = (typeof data.error.code === 'number' && RATE_LIMIT_ERROR_CODES.includes(data.error.code)) || response.status >= 500;
            return { outcome: 'FAILED', retryable, code: `INSTAGRAM_GRAPH_ERROR_${data.error.code ?? 'UNKNOWN'}`, message: data.error.message };
        }
        if (!data.id) throw new Error('Instagram media container creation returned neither an id nor an error — unexpected response shape');

        // The container id alone isn't enough to call media_publish later: getPublicationStatus only
        // receives `remoteRef`, not accountMetadata, so igUserId is carried inside remoteRef itself.
        return { outcome: 'PENDING', remoteRef: `${igUserId}:${data.id}` };
    }

    async getPublicationStatus(remoteRef: string, accessToken: string): Promise<PublicationStatusResult> {
        const separatorIndex = remoteRef.indexOf(':');
        if (separatorIndex === -1) throw new Error(`Invalid Instagram remoteRef (expected "igUserId:containerId"): ${remoteRef}`);
        const igUserId = remoteRef.slice(0, separatorIndex);
        const containerId = remoteRef.slice(separatorIndex + 1);

        const statusUrl = new URL(`${CONTENT_PUBLISHING_BASE}/${containerId}`);
        statusUrl.searchParams.set('fields', 'status_code');
        statusUrl.searchParams.set('access_token', accessToken);
        const statusResponse = await fetch(statusUrl);
        // Unlike the create/publish calls above, the status GET has no documented confirmed-error
        // body shape here — a non-ok response is treated as ambiguous and left to throw.
        if (!statusResponse.ok) throw new Error(`Instagram container status request failed (HTTP ${statusResponse.status})`);
        const statusData = await statusResponse.json() as { status_code?: string };

        if (statusData.status_code === 'IN_PROGRESS') return { outcome: 'PENDING' };
        if (statusData.status_code === 'ERROR') {
            return { outcome: 'FAILED', retryable: false, code: 'INSTAGRAM_CONTAINER_ERROR', message: 'Instagram a signalé une erreur de traitement du conteneur média (status_code=ERROR).' };
        }
        if (statusData.status_code === 'EXPIRED') {
            return { outcome: 'FAILED', retryable: false, code: 'INSTAGRAM_CONTAINER_EXPIRED', message: 'Conteneur expiré avant publication (24h)' };
        }
        if (statusData.status_code === 'FINISHED') {
            const publishBody = new URLSearchParams({ creation_id: containerId, access_token: accessToken });
            const publishResponse = await fetch(`${CONTENT_PUBLISHING_BASE}/${igUserId}/media_publish`, { method: 'POST', body: publishBody });
            const publishData = await publishResponse.json() as { id?: string; error?: { message: string; type?: string; code?: number } };
            if (publishData.error) {
                const retryable = (typeof publishData.error.code === 'number' && RATE_LIMIT_ERROR_CODES.includes(publishData.error.code)) || publishResponse.status >= 500;
                return { outcome: 'FAILED', retryable, code: `INSTAGRAM_GRAPH_ERROR_${publishData.error.code ?? 'UNKNOWN'}`, message: publishData.error.message };
            }
            if (!publishData.id) throw new Error('Instagram media_publish returned neither an id nor an error — unexpected response shape');
            // Graph does not return a permalink synchronously here; remoteUrl is deliberately left
            // undefined rather than guessing a URL shape the API response didn't confirm.
            return { outcome: 'PUBLISHED', remotePostId: publishData.id };
        }

        throw new Error(`Unexpected Instagram container status_code: ${String(statusData.status_code)}`);
    }
}
