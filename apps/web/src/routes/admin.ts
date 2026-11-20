import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { ApiError, type ApiClient, type SocialPlatform, type SocialPublicationStatus } from '../api-client.js';
import { getSessionUser } from '../auth/session.js';
import { confirmReviewPage } from '../templates/confirm.js';
import { dashboardPage } from '../templates/dashboard.js';
import { errorPage } from '../templates/layout.js';
import { mockConsentPage } from '../templates/mock-consent.js';
import { publicationsDetailPage } from '../templates/publications-detail.js';
import { publicationsListPage } from '../templates/publications-list.js';
import { publicationsNewPage } from '../templates/publications-new.js';
import { quizVideoDetailPage } from '../templates/quiz-video-detail.js';
import { quizVideoListPage } from '../templates/quiz-video-list.js';
import { socialSettingsPage } from '../templates/social-settings.js';

const PLATFORMS: readonly SocialPlatform[] = ['TIKTOK', 'INSTAGRAM', 'FACEBOOK'];
function isPlatform(value: string): value is SocialPlatform { return (PLATFORMS as readonly string[]).includes(value); }

function todayUtcDate(): string { return new Date().toISOString().slice(0, 10); }
function errorMessage(error: unknown): string { return error instanceof ApiError ? error.message : 'Une erreur inattendue est survenue.'; }
function flashRedirect(reply: FastifyReply, path: string, message: string, isError = false) {
    return reply.redirect(`${path}?flash=${encodeURIComponent(message)}${isError ? '&flashType=error' : ''}`);
}

// Every route here requires a session (see the onRequest hook below) — "aucun accès anonyme aux
// vidéos non publiées". The only write actions are reviewQuizVideo and the social-account
// connect/disconnect/language routes added in mission 12's finalization; there is no publish
// action anywhere in this app.
export const adminRoutes: FastifyPluginAsync<{ apiClient: ApiClient; projectSlug: string; publicBaseUrl: string }> = async (app, { apiClient, projectSlug, publicBaseUrl }) => {
    app.addHook('onRequest', async (request, reply) => {
        if (!getSessionUser(request)) return reply.redirect('/login');
    });

    const resolveProjectId = () => apiClient.resolveProjectId(projectSlug);

    app.get<{ Querystring: { date?: string; flash?: string; flashType?: string } }>('/admin', async (request, reply) => {
        const username = getSessionUser(request)!;
        const date = request.query.date && /^\d{4}-\d{2}-\d{2}$/.test(request.query.date) ? request.query.date : todayUtcDate();
        try {
            const report = await apiClient.getDayReport(await resolveProjectId(), date);
            return reply.type('text/html').send(dashboardPage({ username, date, report, query: request.query }));
        } catch (error) {
            return reply.type('text/html').send(dashboardPage({ username, date, report: null, error: errorMessage(error) }));
        }
    });

    app.get<{ Querystring: { language?: 'fr' | 'nl'; status?: string; date?: string; offset?: string; flash?: string; flashType?: string } }>('/admin/quiz-videos', async (request, reply) => {
        const username = getSessionUser(request)!;
        const filters = {
            language: request.query.language || undefined, status: request.query.status || undefined,
            date: request.query.date || undefined, offset: Number(request.query.offset ?? 0) || 0, limit: 20
        };
        try {
            const { quizVideos, total } = await apiClient.listQuizVideos(await resolveProjectId(), filters);
            return reply.type('text/html').send(quizVideoListPage({ username, quizVideos, total, filters, query: request.query }));
        } catch (error) {
            return reply.code(error instanceof ApiError ? error.statusCode : 500).type('text/html').send(errorPage(username, errorMessage(error)));
        }
    });

    app.get<{ Params: { id: string }; Querystring: { flash?: string; flashType?: string } }>('/admin/quiz-videos/:id', async (request, reply) => {
        const username = getSessionUser(request)!;
        try {
            const video = await apiClient.getQuizVideo(request.params.id);
            return reply.type('text/html').send(quizVideoDetailPage({ username, video, query: request.query }));
        } catch (error) {
            return reply.code(error instanceof ApiError ? error.statusCode : 500).type('text/html').send(errorPage(username, errorMessage(error)));
        }
    });

    // Streams the MP4 bytes from the API to the browser; the Bearer token never leaves this server.
    // The Range header is forwarded both ways so the player can actually seek (mission 12 gap).
    app.get<{ Params: { id: string } }>('/admin/quiz-videos/:id/preview', async (request, reply) => {
        const range = request.headers.range as string | undefined;
        const preview = await apiClient.getQuizVideoPreview(request.params.id, range);
        if (!preview) return reply.code(404).type('text/plain').send('Vidéo indisponible');
        reply.code(preview.status).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
            .header('Accept-Ranges', 'bytes').type(preview.contentType);
        if (preview.contentRange) reply.header('Content-Range', preview.contentRange);
        // Node's fetch ReadableStream and node:stream/web's expected type disagree on a buffer-view
        // generic parameter that doesn't affect runtime behavior; this cast is the standard workaround.
        return reply.send(Readable.fromWeb(preview.body as Parameters<typeof Readable.fromWeb>[0]));
    });

    app.get<{ Params: { id: string }; Querystring: { decision?: string } }>('/admin/quiz-videos/:id/confirm', async (request, reply) => {
        const username = getSessionUser(request)!;
        const decision = request.query.decision;
        if (decision !== 'APPROVED' && decision !== 'REJECTED') return reply.code(400).type('text/plain').send('Décision invalide');
        try {
            const video = await apiClient.getQuizVideo(request.params.id);
            return reply.type('text/html').send(confirmReviewPage({ username, video, decision }));
        } catch (error) {
            return reply.code(error instanceof ApiError ? error.statusCode : 500).type('text/html').send(errorPage(username, errorMessage(error)));
        }
    });

    app.post<{ Params: { id: string }; Body: { decision?: string; comment?: string } }>('/admin/quiz-videos/:id/review', async (request, reply) => {
        const username = getSessionUser(request)!;
        const decision = request.body.decision;
        if (decision !== 'APPROVED' && decision !== 'REJECTED') return reply.code(400).type('text/plain').send('Décision invalide');
        try {
            await apiClient.reviewQuizVideo(request.params.id, username, decision, request.body.comment || undefined);
            const message = decision === 'APPROVED' ? 'Vidéo approuvée.' : 'Vidéo rejetée.';
            return reply.redirect(`/admin/quiz-videos/${request.params.id}?flash=${encodeURIComponent(message)}`);
        } catch (error) {
            return reply.redirect(`/admin/quiz-videos/${request.params.id}?flash=${encodeURIComponent(errorMessage(error))}&flashType=error`);
        }
    });

    // Paramètres → Réseaux sociaux (mission 12 finalization). Reuses the 8 social endpoints added in
    // mission 13 as-is — no new API endpoint. Connection happens through this BFF, never directly in
    // the browser: oauth/start and oauth/callback are both called server-to-server, exactly like
    // reviewQuizVideo above.
    app.get<{ Querystring: { flash?: string; flashType?: string } }>('/admin/settings/social', async (request, reply) => {
        const username = getSessionUser(request)!;
        try {
            const projectId = await resolveProjectId();
            const [platforms, accounts] = await Promise.all([apiClient.listSocialPlatforms(), apiClient.listSocialAccounts(projectId)]);
            const capabilities = await Promise.all(accounts.map(account => apiClient.getSocialAccountCapabilities(account.id)));
            const accountsWithCapabilities = accounts.map((account, index) => ({ account, capabilities: capabilities[index] }));
            return reply.type('text/html').send(socialSettingsPage({ username, platforms, accounts: accountsWithCapabilities, query: request.query }));
        } catch (error) {
            return reply.code(error instanceof ApiError ? error.statusCode : 500).type('text/html').send(errorPage(username, errorMessage(error)));
        }
    });

    // Starts the OAuth round trip server-to-server, then sends the *browser* to the real platform —
    // or, when apps/api is running with SOCIAL_MOCK_MODE, to a local simulated consent screen
    // instead (a real browser cannot resolve the mock connector's `mock.invalid` authorization URL).
    // POST, not GET (mission 15 security audit): this has a side effect (creates a SocialOAuthState
    // row and can redirect the admin's browser into a platform consent screen) — a bare GET could be
    // triggered by a mere link/image on another page while the admin is logged in. sameSite=lax
    // already blocks the cookie on a cross-site POST, so this closes the gap without a CSRF token.
    app.post<{ Params: { platform: string } }>('/admin/settings/social/:platform/connect', async (request, reply) => {
        if (!isPlatform(request.params.platform)) return reply.code(400).type('text/plain').send('Plateforme invalide');
        try {
            const projectId = await resolveProjectId();
            const redirectUri = `${publicBaseUrl}/admin/settings/social/${request.params.platform}/callback`;
            const { authorizationUrl, state } = await apiClient.startSocialOAuth(projectId, request.params.platform, redirectUri);
            const isMock = new URL(authorizationUrl).hostname === 'mock.invalid';
            if (isMock) return reply.redirect(`/admin/settings/social/${request.params.platform}/mock-consent?state=${encodeURIComponent(state)}`);
            return reply.redirect(authorizationUrl);
        } catch (error) {
            return flashRedirect(reply, '/admin/settings/social', errorMessage(error), true);
        }
    });

    // Only ever reached when apps/api runs with SOCIAL_MOCK_MODE=true — simulates the platform's
    // consent screen locally so the whole OAuth loop can be exercised in a real browser without any
    // developer credentials or network call to TikTok/Meta.
    app.get<{ Params: { platform: string }; Querystring: { state?: string } }>('/admin/settings/social/:platform/mock-consent', async (request, reply) => {
        const username = getSessionUser(request)!;
        if (!isPlatform(request.params.platform) || !request.query.state) return reply.code(400).type('text/plain').send('Requête invalide');
        return reply.type('text/html').send(mockConsentPage({ username, platform: request.params.platform, state: request.query.state }));
    });

    app.post<{ Params: { platform: string }; Body: { state?: string; decision?: string } }>('/admin/settings/social/:platform/mock-consent', async (request, reply) => {
        if (!isPlatform(request.params.platform) || !request.body.state) return reply.code(400).type('text/plain').send('Requête invalide');
        if (request.body.decision !== 'allow') return flashRedirect(reply, '/admin/settings/social', 'Connexion refusée (simulation).', true);
        const code = `mock-code-${randomUUID()}`;
        return reply.redirect(`/admin/settings/social/${request.params.platform}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(request.body.state)}`);
    });

    app.get<{ Params: { platform: string }; Querystring: { code?: string; state?: string } }>('/admin/settings/social/:platform/callback', async (request, reply) => {
        if (!isPlatform(request.params.platform) || !request.query.code || !request.query.state) {
            return flashRedirect(reply, '/admin/settings/social', 'Paramètres de callback invalides.', true);
        }
        try {
            const projectId = await resolveProjectId();
            const account = await apiClient.completeSocialOAuthCallback(projectId, request.params.platform, request.query.code, request.query.state);
            return flashRedirect(reply, '/admin/settings/social', `Compte ${account.platform} connecté (${account.status}).`);
        } catch (error) {
            return flashRedirect(reply, '/admin/settings/social', errorMessage(error), true);
        }
    });

    app.post<{ Params: { id: string } }>('/admin/settings/social/:id/disconnect', async (request, reply) => {
        try {
            await apiClient.disconnectSocialAccount(request.params.id);
            return flashRedirect(reply, '/admin/settings/social', 'Compte déconnecté.');
        } catch (error) {
            return flashRedirect(reply, '/admin/settings/social', errorMessage(error), true);
        }
    });

    app.post<{ Params: { id: string }; Body: { languages?: string | string[] } }>('/admin/settings/social/:id/languages', async (request, reply) => {
        const raw = request.body.languages;
        const languages = Array.isArray(raw) ? raw : raw ? [raw] : [];
        try {
            await apiClient.updateSocialAccountLanguages(request.params.id, languages);
            return flashRedirect(reply, '/admin/settings/social', 'Langues mises à jour.');
        } catch (error) {
            return flashRedirect(reply, '/admin/settings/social', errorMessage(error), true);
        }
    });

    // Publications (mission 14). Scheduling, editing, cancelling and retrying are the only write
    // actions here — there is no "publish now" route anywhere in this app: the actual send always
    // happens autonomously, server-side, in apps/worker, never synchronously from a click.
    app.get<{ Querystring: { status?: string; platform?: string; offset?: string; flash?: string; flashType?: string } }>('/admin/publications', async (request, reply) => {
        const username = getSessionUser(request)!;
        const filters = { status: request.query.status || undefined, platform: request.query.platform || undefined, offset: Number(request.query.offset ?? 0) || 0, limit: 20 };
        try {
            const { socialPublications, total } = await apiClient.listSocialPublications(await resolveProjectId(), {
                status: filters.status as SocialPublicationStatus | undefined, platform: filters.platform as SocialPlatform | undefined,
                offset: filters.offset, limit: filters.limit
            });
            return reply.type('text/html').send(publicationsListPage({ username, publications: socialPublications, total, filters, query: request.query }));
        } catch (error) {
            return reply.code(error instanceof ApiError ? error.statusCode : 500).type('text/html').send(errorPage(username, errorMessage(error)));
        }
    });

    app.get<{ Querystring: { videoId?: string; flash?: string; flashType?: string } }>('/admin/publications/new', async (request, reply) => {
        const username = getSessionUser(request)!;
        try {
            const projectId = await resolveProjectId();
            const [{ quizVideos }, accounts] = await Promise.all([
                apiClient.listQuizVideos(projectId, { status: 'COMPLETED', limit: 50, offset: 0 }),
                apiClient.listSocialAccounts(projectId)
            ]);
            return reply.type('text/html').send(publicationsNewPage({
                username, quizVideos, accounts, requestId: randomUUID(), preselectedQuizVideoId: request.query.videoId, query: request.query
            }));
        } catch (error) {
            return reply.code(error instanceof ApiError ? error.statusCode : 500).type('text/html').send(errorPage(username, errorMessage(error)));
        }
    });

    app.post<{ Body: {
        videoId?: string; socialAccountId?: string; language?: string; caption?: string; hashtags?: string;
        scheduledAtLocal?: string; requestId?: string;
    } }>('/admin/publications/new', async (request, reply) => {
        const username = getSessionUser(request)!;
        const { videoId, socialAccountId, language, caption, requestId } = request.body;
        if (!videoId || !socialAccountId || (language !== 'fr' && language !== 'nl') || !caption?.trim() || !requestId) {
            return reply.code(400).type('text/plain').send('Champs manquants ou invalides');
        }
        const hashtags = (request.body.hashtags ?? '').split(/\s+/).map(h => h.trim()).filter(Boolean);
        try {
            const projectId = await resolveProjectId();
            const publication = await apiClient.schedulePublication(projectId, {
                videoId, socialAccountId, language, caption: caption.trim(), hashtags,
                scheduledAtLocal: request.body.scheduledAtLocal || undefined, requestId, createdBy: username
            });
            return flashRedirect(reply, `/admin/publications/${publication.id}`, publication.status === 'SCHEDULED' ? 'Publication programmée.' : 'Publication enregistrée en brouillon.');
        } catch (error) {
            return flashRedirect(reply, '/admin/publications/new', errorMessage(error), true);
        }
    });

    app.get<{ Params: { id: string }; Querystring: { flash?: string; flashType?: string } }>('/admin/publications/:id', async (request, reply) => {
        const username = getSessionUser(request)!;
        try {
            const publication = await apiClient.getSocialPublication(request.params.id);
            return reply.type('text/html').send(publicationsDetailPage({ username, publication, query: request.query }));
        } catch (error) {
            return reply.code(error instanceof ApiError ? error.statusCode : 500).type('text/html').send(errorPage(username, errorMessage(error)));
        }
    });

    app.post<{ Params: { id: string }; Body: { scheduledAtLocal?: string } }>('/admin/publications/:id/schedule', async (request, reply) => {
        try {
            await apiClient.updatePublicationSchedule(request.params.id, { scheduledAtLocal: request.body.scheduledAtLocal || null });
            return flashRedirect(reply, `/admin/publications/${request.params.id}`, 'Programmation mise à jour.');
        } catch (error) {
            return flashRedirect(reply, `/admin/publications/${request.params.id}`, errorMessage(error), true);
        }
    });

    app.post<{ Params: { id: string } }>('/admin/publications/:id/cancel', async (request, reply) => {
        const username = getSessionUser(request)!;
        try {
            await apiClient.cancelPublication(request.params.id, username);
            return flashRedirect(reply, `/admin/publications/${request.params.id}`, 'Publication annulée.');
        } catch (error) {
            return flashRedirect(reply, `/admin/publications/${request.params.id}`, errorMessage(error), true);
        }
    });

    app.post<{ Params: { id: string } }>('/admin/publications/:id/retry', async (request, reply) => {
        try {
            await apiClient.retryPublication(request.params.id);
            return flashRedirect(reply, `/admin/publications/${request.params.id}`, 'Publication relancée.');
        } catch (error) {
            return flashRedirect(reply, `/admin/publications/${request.params.id}`, errorMessage(error), true);
        }
    });
};
