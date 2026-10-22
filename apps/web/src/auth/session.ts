import type { FastifyRequest } from 'fastify';

// @fastify/secure-session only types `.get(key: string): any` generically; `.set` has no matching
// string-keyed overload without module augmentation of its internal (non-exported) SessionData
// interface. Isolating the cast here keeps it to one place instead of scattered `as unknown` casts.
export function getSessionUser(request: FastifyRequest): string | undefined {
    return request.session.get('user') as string | undefined;
}

export function setSessionUser(request: FastifyRequest, username: string): void {
    (request.session as unknown as { set(key: string, value: unknown): void }).set('user', username);
}
