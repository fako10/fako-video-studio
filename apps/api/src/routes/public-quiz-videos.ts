import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { VideoStorage } from '@fako/media-engine';
import { markPublicVideoLinkConsumed, resolvePublicVideoLink } from '@fako/social-publishing';

const tokenParams = {
    type: 'object', additionalProperties: false, required: ['token'],
    properties: { token: { type: 'string', minLength: 32, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } }
};

// Mission 15 section 4. Deliberately NOT behind the admin Bearer hook every other route in this API
// uses: Meta's Content Publishing fetcher cannot present one (it pulls `video_url` itself, with no
// custom header). Security instead comes entirely from the token — unguessable (256 bits), scoped to
// exactly one QuizVideo, short-lived — never from path obscurity. No route parameter is ever used as
// a filename or path segment, so there is no directory to traverse and nothing to list: a token
// resolves to a QuizVideo id in the database, which resolves to a fileKey already validated by
// LocalVideoStorage's own strict UUID.mp4 check (packages/media-engine/src/storage.ts) — this route
// never constructs a filesystem path itself. See packages/social-publishing/src/public-link.ts for
// token minting/expiry/revocation.
export const publicQuizVideoRoutes: FastifyPluginAsync<{ prisma: PrismaClient; videoStorage: VideoStorage; enabled: boolean }> = async (app, { prisma, videoStorage, enabled }) => {
    app.get<{ Params: { token: string } }>('/public/quiz-video-links/:token', { schema: { params: tokenParams } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
        // Same generic 404 as every other branch below when the feature is off — never a 503 that
        // would confirm to a prober that this route exists but is merely unconfigured.
        if (!enabled) return reply.code(404).send();

        const link = await resolvePublicVideoLink(prisma, request.params.token);
        // "Not found", "expired" and "revoked" all return the exact same generic 404 — a probing
        // request must never learn which one it hit. The token itself is never logged, only here and
        // in every branch below; only the outcome and (once resolved) the quizVideoId are.
        if (!link) { request.log.info({ event: 'public_quiz_video_link', result: 'miss' }); return reply.code(404).send(); }

        const quizVideo = await prisma.quizVideo.findUnique({ where: { id: link.quizVideoId }, select: { fileKey: true } });
        if (!quizVideo?.fileKey) {
            request.log.warn({ event: 'public_quiz_video_link', result: 'no_file_key', quizVideoId: link.quizVideoId });
            return reply.code(404).send();
        }

        let buffer: Buffer;
        try { buffer = await videoStorage.read(quizVideo.fileKey); }
        catch {
            request.log.warn({ event: 'public_quiz_video_link', result: 'file_unreadable', quizVideoId: link.quizVideoId });
            return reply.code(404).send();
        }
        if (buffer.length === 0) {
            request.log.warn({ event: 'public_quiz_video_link', result: 'empty_file', quizVideoId: link.quizVideoId });
            return reply.code(404).send();
        }

        await markPublicVideoLinkConsumed(prisma, link.id);
        request.log.info({ event: 'public_quiz_video_link', result: 'served', quizVideoId: link.quizVideoId, bytes: buffer.length });
        return reply.type('video/mp4').header('Content-Length', String(buffer.length)).send(buffer);
    });
};
