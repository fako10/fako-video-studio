import type { FastifyPluginAsync } from 'fastify';
import { verifyPassword } from '../auth/password.js';
import { LoginRateLimiter } from '../auth/rateLimiter.js';
import { getSessionUser, setSessionUser } from '../auth/session.js';
import { loginPage } from '../templates/login.js';

export const authRoutes: FastifyPluginAsync<{ adminUsername: string; adminPasswordHash: string; rateLimiter?: LoginRateLimiter }> = async (app, { adminUsername, adminPasswordHash, rateLimiter }) => {
    const limiter = rateLimiter ?? new LoginRateLimiter();

    app.get<{ Querystring: { flash?: string; flashType?: string; locked?: string } }>('/login', async (request, reply) => {
        if (getSessionUser(request)) return reply.redirect('/admin');
        return reply.type('text/html').send(loginPage(request.query));
    });

    app.post<{ Body: { username?: string; password?: string } }>('/login', async (request, reply) => {
        const ip = request.ip;
        if (limiter.isLocked(ip)) return reply.type('text/html').send(loginPage({ locked: 'true' }));
        const { username, password } = request.body ?? {};
        const valid = typeof username === 'string' && typeof password === 'string'
            && username === adminUsername && await verifyPassword(password, adminPasswordHash);
        if (!valid) {
            limiter.recordFailure(ip);
            return reply.type('text/html').send(loginPage({ flash: 'Identifiants invalides.', flashType: 'error' }));
        }
        limiter.recordSuccess(ip);
        setSessionUser(request, username);
        return reply.redirect('/admin');
    });

    app.post('/logout', async (request, reply) => {
        request.session.delete();
        return reply.redirect('/login');
    });
};
