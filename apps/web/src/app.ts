import Fastify, { type FastifyError } from 'fastify';
import secureSession from '@fastify/secure-session';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import { HttpApiClient, type ApiClient } from './api-client.js';
import { LoginRateLimiter } from './auth/rateLimiter.js';
import { registerCsrfProtection } from './csrf.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';

export type BuildWebAppOptions = {
    logger?: boolean;
    adminUsername: string; adminPasswordHash: string; sessionKey: Buffer; secureCookies?: boolean;
    apiClient?: ApiClient; apiBaseUrl?: string; apiToken?: string; projectSlug?: string;
    rateLimiter?: LoginRateLimiter; publicBaseUrl?: string;
};

// A thin BFF: every page here is server-rendered HTML, every write forwards to the existing,
// already-tested API (missions 10/11) — nothing is reimplemented, nothing new is persisted here.
export function buildApp(options: BuildWebAppOptions) {
    // Mission 15 section 5: `web` is never reachable directly from the internet in production (see
    // compose.production.yaml — no published port, only the `proxy` container can reach it over the
    // `application` Docker network), so trusting the proxy's X-Forwarded-* headers here cannot be
    // abused by an external client to spoof its own IP. Required for the login rate limiter below to
    // key on the real client IP instead of Caddy's one, which would otherwise lock out every admin
    // behind one failed attempt from any of them.
    const app = Fastify({ logger: options.logger ?? false, trustProxy: true });

    app.register(helmet, {
        // No template ever renders a <script> tag, so script-src stays locked to 'self'. Many
        // templates do use inline style="" attributes (apps/web/src/templates/*.ts) — converting all
        // of them to a stylesheet is out of scope here, so style-src allows 'unsafe-inline' only.
        contentSecurityPolicy: {
            directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"] }
        }
    });
    const publicBaseUrl = options.publicBaseUrl ?? 'http://127.0.0.1:3100';
    registerCsrfProtection(app, publicBaseUrl);

    app.register(formbody);
    app.register(secureSession, {
        key: options.sessionKey,
        cookieName: 'fako_admin_session',
        // A stateless, encrypted-cookie session has no server-side revocation list: logging out
        // clears the cookie the browser holds (Set-Cookie, Max-Age=0), but a *copied* cookie value
        // remains cryptographically valid until it expires. Bounding that window is the mitigation.
        expiry: 12 * 60 * 60,
        cookie: { httpOnly: true, sameSite: 'lax', secure: options.secureCookies ?? false, path: '/' }
    });

    app.setErrorHandler<FastifyError>((error, request, reply) => {
        request.log.error(error);
        const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
        return reply.code(statusCode).type('text/plain').send('Une erreur est survenue.');
    });

    // The only place the API token is ever read; held in this server process only.
    const apiClient = options.apiClient ?? new HttpApiClient(options.apiBaseUrl ?? 'http://127.0.0.1:3000', options.apiToken ?? '');

    app.register(authRoutes, { adminUsername: options.adminUsername, adminPasswordHash: options.adminPasswordHash, rateLimiter: options.rateLimiter });
    app.register(adminRoutes, { apiClient, projectSlug: options.projectSlug ?? 'rijpermis', publicBaseUrl });

    app.get('/', async (_request, reply) => reply.redirect('/admin'));

    return app;
}
