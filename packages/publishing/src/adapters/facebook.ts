import type { SocialPlatformConnector } from '../connector.js';
import { validateMediaRequirements } from '../media.js';
import type {
    AuthorizationRequest, Capabilities, CodeExchangeRequest, ExternalAccountInfo,
    MediaDescriptor, MediaValidationResult, OAuthTokenSet, PublicationStatusResult,
    PublishVideoRequest, PublishVideoResult
} from '../types.js';

type GraphError = { error?: { code: number; message: string; error_subcode?: number } };

function isRetryableGraphError(code: number): boolean {
    // 613 = application request limit reached; 1/2 = transient Graph-side server errors
    // (documented as "please retry"). Everything else (permissions, invalid parameter, etc.) is
    // treated as a confirmed, non-retryable rejection.
    return code === 613 || code === 1 || code === 2;
}

const API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;

// Facebook Login for the existing RijPermis Page. Unlike TikTok/Instagram, the OAuth exchange
// itself only yields a *user* token — a durable Page token is a separate derived step
// (/me/accounts), and that derivation is the credential actually worth storing, since it's what a
// future publish call needs. This genuine platform asymmetry is deliberately not hidden behind the
// shared interface (mission 13 section 3): exchangeCodeForTokens does the full user-token →
// long-lived-user-token → Page-token chain and returns the Page token, carrying the Page id along
// in `metadata` so getAccountInfo doesn't need to re-enumerate every Page again.
export class FacebookPagesConnector implements SocialPlatformConnector {
    readonly platform = 'FACEBOOK' as const;

    constructor(private readonly appId?: string, private readonly appSecret?: string) {}

    isConfigured(): boolean {
        return Boolean(this.appId && this.appSecret);
    }

    private requireCredentials(): { appId: string; appSecret: string } {
        if (!this.appId || !this.appSecret) throw new Error('Facebook connector is not configured (missing FACEBOOK_APP_ID/FACEBOOK_APP_SECRET)');
        return { appId: this.appId, appSecret: this.appSecret };
    }

    getAuthorizationUrl(request: AuthorizationRequest): string {
        const { appId } = this.requireCredentials();
        const params = new URLSearchParams({
            client_id: appId, redirect_uri: request.redirectUri, state: request.state,
            scope: 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management'
        });
        return `https://www.facebook.com/${API_VERSION}/dialog/oauth?${params.toString()}`;
    }

    async exchangeCodeForTokens(request: CodeExchangeRequest): Promise<OAuthTokenSet> {
        const { appId, appSecret } = this.requireCredentials();

        const shortLivedUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
        shortLivedUrl.searchParams.set('client_id', appId);
        shortLivedUrl.searchParams.set('client_secret', appSecret);
        shortLivedUrl.searchParams.set('redirect_uri', request.redirectUri);
        shortLivedUrl.searchParams.set('code', request.code);
        const shortLivedResponse = await fetch(shortLivedUrl);
        if (!shortLivedResponse.ok) throw new Error(`Facebook token exchange failed (HTTP ${shortLivedResponse.status})`);
        const shortLived = await shortLivedResponse.json() as { access_token: string };

        // Exchange for a long-lived USER token (~60 days) — required before /me/accounts yields a
        // Page token that is effectively non-expiring; a short-lived user token only yields a
        // short-lived Page token.
        const longLivedUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
        longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
        longLivedUrl.searchParams.set('client_id', appId);
        longLivedUrl.searchParams.set('client_secret', appSecret);
        longLivedUrl.searchParams.set('fb_exchange_token', shortLived.access_token);
        const longLivedResponse = await fetch(longLivedUrl);
        if (!longLivedResponse.ok) throw new Error(`Facebook long-lived token exchange failed (HTTP ${longLivedResponse.status})`);
        const longLived = await longLivedResponse.json() as { access_token: string };

        const pagesUrl = new URL(`${GRAPH_BASE}/me/accounts`);
        pagesUrl.searchParams.set('access_token', longLived.access_token);
        const pagesResponse = await fetch(pagesUrl);
        if (!pagesResponse.ok) throw new Error(`Facebook Page enumeration failed (HTTP ${pagesResponse.status})`);
        const pagesData = await pagesResponse.json() as { data: { id: string; name: string; access_token: string; tasks?: string[] }[] };
        const page = pagesData.data[0];
        if (!page) throw new Error('No Facebook Page accessible to this user — the admin must be a Page admin, not just a personal profile');

        return {
            accessToken: page.access_token, grantedScopes: page.tasks ?? [],
            metadata: { pageId: page.id, pageName: page.name }
        };
    }

    // Page tokens derived from a long-lived user token are, in practice, non-expiring — there is no
    // documented "refresh" grant for them. This re-verifies the stored token is still accepted by
    // the Graph API (it can silently stop working if the admin's role changes or the app is
    // removed) rather than minting a new one.
    async refreshCredentials(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
        const pageId = tokens.metadata?.pageId as string | undefined;
        if (!pageId) throw new Error('Cannot verify a Facebook Page token without a known Page id');
        const url = new URL(`${GRAPH_BASE}/${pageId}`);
        url.searchParams.set('fields', 'id');
        url.searchParams.set('access_token', tokens.accessToken);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Facebook Page token is no longer valid (HTTP ${response.status})`);
        return tokens;
    }

    async getAccountInfo(tokens: OAuthTokenSet): Promise<ExternalAccountInfo> {
        const pageId = tokens.metadata?.pageId as string | undefined;
        if (pageId && tokens.metadata?.pageName) return { externalAccountId: pageId, displayName: tokens.metadata.pageName as string, accountType: 'PAGE' };
        if (!pageId) throw new Error('Cannot fetch Facebook Page info without a known Page id');
        const url = new URL(`${GRAPH_BASE}/${pageId}`);
        url.searchParams.set('fields', 'id,name,category');
        url.searchParams.set('access_token', tokens.accessToken);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Facebook Page info request failed (HTTP ${response.status})`);
        const data = await response.json() as { id: string; name: string; category?: string };
        return { externalAccountId: data.id, displayName: data.name, accountType: 'PAGE', metadata: { category: data.category } };
    }

    getCapabilities(context: { grantedScopes: string[]; tokenExpiresAt?: Date }): Capabilities {
        const required = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
        const missingScopes = required.filter(scope => !context.grantedScopes.includes(scope));
        const tokenValid = !context.tokenExpiresAt || context.tokenExpiresAt.getTime() > Date.now();
        return {
            platform: this.platform, connected: tokenValid, tokenValid, grantedScopes: context.grantedScopes, missingScopes,
            canPublishDirectly: tokenValid && missingScopes.length === 0,
            requiresManualStep: false,
            notes: ['pages_manage_posts nécessite une App Review Meta validée pour publier sur des Pages réelles (Standard Access ne couvre que les Pages où l\'app a déjà un rôle).']
        };
    }

    validateMediaRequirements(media: MediaDescriptor): MediaValidationResult {
        return validateMediaRequirements('FACEBOOK', media);
    }

    // Meta exposes DELETE /{user-id}/permissions to revoke a user token's grants; there is no
    // documented Page-token-specific revoke, so this is a best-effort call that must never throw —
    // local disconnection always proceeds regardless of whether the remote revoke succeeds.
    async disconnectAccount(tokens: OAuthTokenSet): Promise<void> {
        const pageId = tokens.metadata?.pageId as string | undefined;
        if (!pageId) return;
        try {
            const url = new URL(`${GRAPH_BASE}/${pageId}/permissions`);
            url.searchParams.set('access_token', tokens.accessToken);
            await fetch(url, { method: 'DELETE' });
        } catch { /* best-effort only, see comment above */ }
    }

    // Mission 14. Two official Meta pages disagree on the exact shape of `upload_phase`: the
    // `video_reels` API reference documents it as a two-value enum {START, FINISH}, while the
    // separate "Reels publishing" guide describes a 3-step flow (start → transfer raw bytes to a
    // dedicated rupload.facebook.com upload URL → finish). The 3-step guide is implemented below
    // because it's the only one of the two that supports a direct local-byte upload instead of
    // requiring a public video_url (same constraint Instagram's publishVideo hits, see that adapter)
    // — this installation has no public URL to hand Meta.
    async publishVideo(request: PublishVideoRequest): Promise<PublishVideoResult> {
        if (request.videoBytes.length === 0) {
            return { outcome: 'FAILED', retryable: false, code: 'EMPTY_VIDEO', message: 'La vidéo à publier est vide (0 octet)' };
        }

        // Same externalAccountId carry-along contract as Instagram's igUserId (see that adapter):
        // not part of the platform-agnostic PublishVideoRequest, so the engine passes it through
        // accountMetadata.externalAccountId — the same Page id getAccountInfo() returns and
        // SocialAccount already stores at connection time.
        const pageId = request.accountMetadata?.externalAccountId as string | undefined;
        if (!pageId) throw new Error('Facebook publishVideo requires accountMetadata.externalAccountId (Page id)');

        // Step 1: start.
        const startParams = new URLSearchParams({ upload_phase: 'start', access_token: request.accessToken });
        const startResponse = await fetch(`${GRAPH_BASE}/${pageId}/video_reels`, { method: 'POST', body: startParams });
        const startData = await startResponse.json().catch(() => undefined) as (GraphError & { video_id?: string; upload_url?: string }) | undefined;
        if (!startData) throw new Error(`Facebook Reels start phase returned no parseable body (HTTP ${startResponse.status})`);
        if (startData.error) {
            return { outcome: 'FAILED', retryable: isRetryableGraphError(startData.error.code), code: `FACEBOOK_START_${startData.error.code}`, message: startData.error.message };
        }
        if (!startResponse.ok || !startData.video_id || !startData.upload_url) {
            throw new Error(`Facebook Reels start phase returned an unexpected response (HTTP ${startResponse.status})`);
        }
        const videoId = startData.video_id;

        // Step 2: transfer — raw bytes posted to the exact upload_url Meta returned above (not a
        // locally reconstructed URL: the guide only guarantees the *shape*, Meta owns the real one).
        // A non-ok response here is ambiguous — some or all bytes may have landed before the
        // connection dropped — so this must throw, never resolve to FAILED.
        const transferResponse = await fetch(startData.upload_url, {
            method: 'POST',
            headers: {
                Authorization: `OAuth ${request.accessToken}`, offset: '0', file_size: String(request.videoBytes.length),
                'Content-Type': 'application/octet-stream'
            },
            // Cast needed: lib.dom's BlobPart/BodyInit types a Buffer's `.buffer` as ArrayBuffer,
            // while @types/node's Buffer.buffer is the wider ArrayBufferLike (ArrayBuffer |
            // SharedArrayBuffer) — a real-world no-op at runtime (fetch/undici accept a Buffer
            // directly), just a type-level mismatch between those two lib definitions.
            body: request.videoBytes as unknown as BodyInit
        });
        if (!transferResponse.ok) throw new Error(`Facebook Reels transfer phase failed (HTTP ${transferResponse.status}), outcome unknown`);

        // Step 3: finish. No officially confirmed character limit for Reels descriptions was found
        // (unlike Instagram's documented 2200-char caption cap), so nothing is truncated to an
        // invented number — hashtags are appended only if not already present in the caption.
        const hashtagsToAppend = request.hashtags.filter(tag => !request.caption.includes(tag));
        const description = [request.caption, ...hashtagsToAppend].join(' ');
        const finishParams = new URLSearchParams({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description, access_token: request.accessToken });
        const finishResponse = await fetch(`${GRAPH_BASE}/${pageId}/video_reels`, { method: 'POST', body: finishParams });
        const finishData = await finishResponse.json().catch(() => undefined) as (GraphError & { success?: boolean }) | undefined;
        if (!finishData) throw new Error(`Facebook Reels finish phase returned no parseable body (HTTP ${finishResponse.status})`);
        if (finishData.error) {
            return { outcome: 'FAILED', retryable: isRetryableGraphError(finishData.error.code), code: `FACEBOOK_FINISH_${finishData.error.code}`, message: finishData.error.message };
        }
        if (!finishResponse.ok || !finishData.success) {
            throw new Error(`Facebook Reels finish phase returned an unexpected response (HTTP ${finishResponse.status})`);
        }

        // A successful "finish" response only means Meta accepted the upload, not that processing is
        // done — getPublicationStatus must still be polled before this counts as published.
        return { outcome: 'PENDING', remoteRef: videoId };
    }

    async getPublicationStatus(remoteRef: string, accessToken: string): Promise<PublicationStatusResult> {
        const url = new URL(`${GRAPH_BASE}/${remoteRef}`);
        url.searchParams.set('fields', 'status');
        url.searchParams.set('access_token', accessToken);
        const response = await fetch(url);
        const data = await response.json().catch(() => undefined) as (GraphError & { status?: { video_status?: string } }) | undefined;
        if (!data) throw new Error(`Facebook video status request returned no parseable body (HTTP ${response.status})`);
        if (data.error) return { outcome: 'FAILED', retryable: isRetryableGraphError(data.error.code), code: `FACEBOOK_STATUS_${data.error.code}`, message: data.error.message };
        if (!response.ok) throw new Error(`Facebook video status request failed (HTTP ${response.status})`);
        const videoStatus = data.status?.video_status;
        if (!videoStatus) throw new Error('Facebook video status response had an unexpected shape');

        switch (videoStatus) {
            case 'ready':
                // Graph does not reliably return a direct permalink on this field for a Reel; this is
                // a known Facebook URL convention, not a value confirmed by the API response itself.
                return { outcome: 'PUBLISHED', remotePostId: remoteRef, remoteUrl: `https://www.facebook.com/${remoteRef}` };
            case 'processing':
                return { outcome: 'PENDING' };
            case 'error':
                return { outcome: 'FAILED', retryable: false, code: 'FACEBOOK_VIDEO_ERROR', message: 'Facebook a signalé une erreur de traitement de la vidéo Reels' };
            case 'expired':
                return { outcome: 'FAILED', retryable: false, code: 'FACEBOOK_VIDEO_EXPIRED', message: 'Vidéo Reels expirée avant finalisation' };
            default:
                throw new Error(`Facebook video_status "${videoStatus}" was not recognized`);
        }
    }
}
