import type { FastifyInstance } from 'fastify';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Mission 15 section 5: this admin tool previously relied solely on the session cookie's
// `sameSite: 'lax'` for CSRF protection — a real mitigation against classic cross-site form
// submissions, but not a second independent layer. Verifying Origin (falling back to Referer) is the
// OWASP-recommended complement: a cross-origin attacker's page can submit a form here, but the
// browser-set Origin header on that request still names the attacker's own origin, never ours.
// Requests with neither header present (some non-browser HTTP clients) are allowed through rather
// than rejected outright, since this is additive defense-in-depth alongside SameSite, not the only
// protection — rejecting them too would be stricter but risks breaking a legitimate client that omits
// both headers for reasons unrelated to CSRF.
export function registerCsrfProtection(app: FastifyInstance, publicBaseUrl: string) {
    const expectedOrigin = new URL(publicBaseUrl).origin;
    app.addHook('onRequest', async (request, reply) => {
        if (!STATE_CHANGING_METHODS.has(request.method)) return;
        const originHeader = request.headers.origin;
        const refererHeader = request.headers.referer;
        let actualOrigin: string | undefined;
        if (typeof originHeader === 'string') actualOrigin = originHeader;
        else if (typeof refererHeader === 'string') { try { actualOrigin = new URL(refererHeader).origin; } catch { actualOrigin = undefined; } }
        if (actualOrigin !== undefined && actualOrigin !== expectedOrigin) {
            return reply.code(403).type('text/plain').send('Requête refusée : origine invalide.');
        }
    });
}
