import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { requestVideoScript, reviewVideoScript } from '@fako/video-jobs';

const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
export const videoScriptRoutes: FastifyPluginAsync<{ prisma: PrismaClient; enabled: boolean; token?: string }> = async (app, { prisma, enabled, token }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!token || token.length < 32) return reply.code(503).send({ error: 'Video script administration is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });

    app.post<{ Params: { id: string }; Body: { requestId: string; contentType?: 'PROMOTION' | 'EDUCATIONAL' | 'QUIZ' } }>('/video-jobs/:id/scripts/generate', {
        schema: { params, body: { type: 'object', additionalProperties: false, required: ['requestId'],
            properties: { requestId: { type: 'string', format: 'uuid' }, contentType: { type: 'string', enum: ['PROMOTION', 'EDUCATIONAL', 'QUIZ'] } } } }
    }, async (request, reply) => {
        if (!enabled) return reply.code(503).send({ error: 'Script generation disabled; configure AI_PROVIDER on the API and worker' });
        const result = await requestVideoScript(prisma, request.params.id, request.body.requestId, request.body.contentType);
        return reply.code(result.created ? 202 : 200).header('Location', `/video-scripts/${result.script.id}`).send(result.script);
    });
    app.get<{ Params: { id: string } }>('/video-jobs/:id/scripts', { schema: { params } }, async (request, reply) => {
        if (!await prisma.videoJob.findUnique({ where: { id: request.params.id }, select: { id: true } })) return reply.code(404).send({ error: 'Video job not found' });
        return { scripts: await prisma.videoScript.findMany({ where: { videoJobId: request.params.id }, orderBy: { version: 'desc' } }) };
    });
    app.get<{ Params: { id: string } }>('/video-scripts/:id', { schema: { params } }, async (request, reply) => {
        return await prisma.videoScript.findUnique({ where: { id: request.params.id }, include: { aiRequests: { orderBy: { createdAt: 'asc' } } } }) ?? reply.code(404).send({ error: 'Video script not found' });
    });
    app.post<{ Params: { id: string }; Body: { reviewedBy: string; decision: 'APPROVED' | 'REJECTED'; comment?: string } }>('/video-scripts/:id/review', {
        schema: { params, body: { type: 'object', additionalProperties: false, required: ['reviewedBy', 'decision'], properties: {
            reviewedBy: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
            decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] }, comment: { type: 'string', maxLength: 2000 }
        } } }
    }, async request => reviewVideoScript(prisma, request.params.id, request.body.reviewedBy.trim(), request.body.decision, request.body.comment));
};
