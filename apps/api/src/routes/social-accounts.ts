import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient, SocialPlatform } from '@prisma/client';
import {
    decryptSecret, encryptSecret, generateOAuthState, generatePkcePair, OAUTH_STATE_TTL_MS,
    BASIC_SCOPES_BY_PLATFORM, PUBLISH_SCOPE_BY_PLATFORM, type SocialPlatformConnector
} from '@fako/publishing';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
const PLATFORMS = ['TIKTOK', 'INSTAGRAM', 'FACEBOOK'] as const;
const platformEnum = { type: 'string', enum: PLATFORMS };
const projectPlatformParams = { type: 'object', additionalProperties: false, required: ['id', 'platform'], properties: { id: uuid, platform: platformEnum } };
const projectParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };

// Never leak ciphertexts to a client — this is the only place `select` is defined, every route
// below uses it.
const PUBLIC_SELECT = {
    id: true, projectId: true, platform: true, externalAccountId: true, displayName: true, languages: true,
    status: true, grantedScopes: true, connectedAt: true, tokenExpiresAt: true, refreshTokenExpiresAt: true,
    lastVerifiedAt: true, lastError: true, captionTemplates: true, metadata: true, createdAt: true, updatedAt: true
} as const;

function isValidRedirectUri(value: string, nodeEnv: string | undefined): boolean {
    try {
        const url = new URL(value);
        const local = nodeEnv === 'development' || nodeEnv === 'test';
        if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return false;
        if (url.username || url.password || url.hash) return false;
        return true;
    } catch { return false; }
}

export const socialAccountRoutes: FastifyPluginAsync<{
    prisma: PrismaClient; enabled: boolean; token?: string; encryptionKey?: Buffer; previousEncryptionKey?: Buffer;
    connectors: Record<SocialPlatform, SocialPlatformConnector>;
}> = async (app, { prisma, enabled, token, encryptionKey, previousEncryptionKey, connectors }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!enabled || !token || token.length < 32) return reply.code(503).send({ error: 'Social account management is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });

    // Section 9: never present a connect button as functional if developer credentials are missing.
    app.get('/social/platforms', async () => ({
        platforms: PLATFORMS.map(platform => ({ platform, configured: connectors[platform].isConfigured() }))
    }));

    app.get<{ Params: { id: string } }>('/projects/:id/social-accounts', { schema: { params: projectParams } }, async (request, reply) => {
        if (!await prisma.project.findUnique({ where: { id: request.params.id }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const socialAccounts = await prisma.socialAccount.findMany({
            where: { projectId: request.params.id }, select: PUBLIC_SELECT, orderBy: [{ platform: 'asc' }, { createdAt: 'asc' }]
        });
        return { socialAccounts };
    });

    app.post<{ Params: { id: string; platform: SocialPlatform }; Body: { redirectUri: string } }>(
        '/projects/:id/social-accounts/:platform/oauth/start',
        { schema: { params: projectPlatformParams, body: { type: 'object', additionalProperties: false, required: ['redirectUri'], properties: { redirectUri: { type: 'string', maxLength: 2048 } } } } },
        async (request, reply) => {
            const { id: projectId, platform } = request.params;
            if (!await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })) {
                return reply.code(404).send({ error: 'Project not found' });
            }
            const connector = connectors[platform];
            if (!connector.isConfigured()) return reply.code(503).send({ error: `${platform} is not configured with developer credentials` });
            if (!isValidRedirectUri(request.body.redirectUri, process.env.NODE_ENV)) return reply.code(400).send({ error: 'Invalid redirect URI' });

            const state = generateOAuthState();
            const pkce = platform === 'TIKTOK' ? generatePkcePair() : undefined;
            const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
            await prisma.socialOAuthState.create({
                data: { state, projectId, platform, redirectUri: request.body.redirectUri, codeVerifier: pkce?.codeVerifier, expiresAt }
            });
            const authorizationUrl = connector.getAuthorizationUrl({ state, redirectUri: request.body.redirectUri, codeChallenge: pkce?.codeChallenge });
            return reply.code(201).send({ authorizationUrl, state, expiresAt });
        }
    );

    // Called server-to-server by the admin BFF after it receives the browser's OAuth redirect —
    // never hit directly by a browser (see docs/social-connectors.md for the integration contract).
    app.post<{ Params: { id: string; platform: SocialPlatform }; Body: { code: string; state: string } }>(
        '/projects/:id/social-accounts/:platform/oauth/callback',
        { schema: { params: projectPlatformParams, body: { type: 'object', additionalProperties: false, required: ['code', 'state'], properties: { code: { type: 'string', minLength: 1, maxLength: 2000 }, state: { type: 'string', minLength: 1, maxLength: 200 } } } } },
        async (request, reply) => {
            const { id: projectId, platform } = request.params;
            const { code, state } = request.body;

            const oauthState = await prisma.socialOAuthState.findUnique({ where: { state } });
            if (!oauthState || oauthState.projectId !== projectId || oauthState.platform !== platform) {
                return reply.code(400).send({ error: 'Invalid or unknown OAuth state' });
            }
            if (oauthState.expiresAt.getTime() <= Date.now()) return reply.code(400).send({ error: 'OAuth state has expired' });

            // Claim the state atomically: a replayed callback (same state used twice, e.g. a
            // double-submitted redirect) must only ever succeed once.
            const claimed = await prisma.socialOAuthState.updateMany({ where: { id: oauthState.id, consumedAt: null }, data: { consumedAt: new Date() } });
            if (claimed.count !== 1) return reply.code(400).send({ error: 'OAuth state has already been used' });

            const connector = connectors[platform];
            const tokens = await connector.exchangeCodeForTokens({ code, redirectUri: oauthState.redirectUri, codeVerifier: oauthState.codeVerifier ?? undefined });
            const accountInfo = await connector.getAccountInfo(tokens);

            // "Connecté" (status CONNECTED) requires both the basic read scope and the publish
            // scope — anything less is INSUFFICIENT_PERMISSIONS, a user-fixable state (reconnect
            // with broader consent). This is distinct from the platform-level "Publication non
            // autorisée" gate (e.g. TikTok's unaudited-app restriction) surfaced by
            // getCapabilities() even on a CONNECTED account that *did* grant the publish scope.
            const requiredScopes = [...BASIC_SCOPES_BY_PLATFORM[platform], PUBLISH_SCOPE_BY_PLATFORM[platform]];
            const hasRequiredScopes = requiredScopes.every(scope => tokens.grantedScopes.includes(scope));
            const key = encryptionKey!;

            const socialAccount = await prisma.socialAccount.upsert({
                where: { projectId_platform_externalAccountId: { projectId, platform, externalAccountId: accountInfo.externalAccountId } },
                create: {
                    projectId, platform, externalAccountId: accountInfo.externalAccountId, displayName: accountInfo.displayName,
                    status: hasRequiredScopes ? 'CONNECTED' : 'INSUFFICIENT_PERMISSIONS', grantedScopes: tokens.grantedScopes,
                    connectedAt: new Date(), tokenExpiresAt: tokens.expiresAt, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
                    lastVerifiedAt: new Date(), lastError: null,
                    accessTokenCiphertext: encryptSecret(tokens.accessToken, key),
                    refreshTokenCiphertext: tokens.refreshToken ? encryptSecret(tokens.refreshToken, key) : null,
                    metadata: (accountInfo.metadata ?? {}) as object
                },
                update: {
                    displayName: accountInfo.displayName, status: hasRequiredScopes ? 'CONNECTED' : 'INSUFFICIENT_PERMISSIONS',
                    grantedScopes: tokens.grantedScopes, connectedAt: new Date(), tokenExpiresAt: tokens.expiresAt,
                    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt, lastVerifiedAt: new Date(), lastError: null,
                    accessTokenCiphertext: encryptSecret(tokens.accessToken, key),
                    refreshTokenCiphertext: tokens.refreshToken ? encryptSecret(tokens.refreshToken, key) : null,
                    metadata: (accountInfo.metadata ?? {}) as object
                },
                select: PUBLIC_SELECT
            });
            return reply.code(201).send(socialAccount);
        }
    );

    app.get<{ Params: { id: string } }>('/social-accounts/:id', { schema: { params: idParams } }, async (request, reply) => {
        const socialAccount = await prisma.socialAccount.findUnique({ where: { id: request.params.id }, select: PUBLIC_SELECT });
        return socialAccount ?? reply.code(404).send({ error: 'Social account not found' });
    });

    app.get<{ Params: { id: string } }>('/social-accounts/:id/capabilities', { schema: { params: idParams } }, async (request, reply) => {
        const socialAccount = await prisma.socialAccount.findUnique({ where: { id: request.params.id } });
        if (!socialAccount) return reply.code(404).send({ error: 'Social account not found' });
        const connector = connectors[socialAccount.platform];
        const capabilities = connector.getCapabilities({
            grantedScopes: socialAccount.grantedScopes, tokenExpiresAt: socialAccount.tokenExpiresAt ?? undefined, appAudited: false
        });
        return { socialAccountId: socialAccount.id, status: socialAccount.status, ...capabilities };
    });

    app.patch<{ Params: { id: string }; Body: { languages: string[] } }>(
        '/social-accounts/:id',
        { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['languages'], properties: { languages: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['fr', 'nl'] } } } } } },
        async (request, reply) => {
            if (!await prisma.socialAccount.findUnique({ where: { id: request.params.id }, select: { id: true } })) {
                return reply.code(404).send({ error: 'Social account not found' });
            }
            return prisma.socialAccount.update({ where: { id: request.params.id }, data: { languages: request.body.languages }, select: PUBLIC_SELECT });
        }
    );

    app.post<{ Params: { id: string } }>('/social-accounts/:id/disconnect', { schema: { params: idParams } }, async (request, reply) => {
        const socialAccount = await prisma.socialAccount.findUnique({ where: { id: request.params.id } });
        if (!socialAccount) return reply.code(404).send({ error: 'Social account not found' });

        if (socialAccount.accessTokenCiphertext && encryptionKey) {
            try {
                const tokens = { accessToken: decryptSecret(socialAccount.accessTokenCiphertext, encryptionKey, previousEncryptionKey), grantedScopes: socialAccount.grantedScopes, metadata: socialAccount.metadata as Record<string, unknown> };
                await connectors[socialAccount.platform].disconnectAccount(tokens);
            } catch { /* best-effort remote revoke only; local disconnection always proceeds */ }
        }

        return prisma.socialAccount.update({
            where: { id: request.params.id },
            data: { status: 'DISCONNECTED', accessTokenCiphertext: null, refreshTokenCiphertext: null, grantedScopes: [], tokenExpiresAt: null, refreshTokenExpiresAt: null, connectedAt: null },
            select: PUBLIC_SELECT
        });
    });
};
