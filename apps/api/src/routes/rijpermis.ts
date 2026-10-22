import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { ContentSourceProvider, MediaStorage } from '@fako/content-sources';
import { isPublicationBlocked, prepareRijPermisSource, requestVideoScript, verifySourceBeforePublication } from '@fako/video-jobs';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
const questionId = { type: 'string', minLength: 1, maxLength: 100 };

export const rijPermisRoutes: FastifyPluginAsync<{ prisma: PrismaClient; provider?: ContentSourceProvider; storage: MediaStorage; token?: string }> = async (app, { prisma, provider, storage, token }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!token || token.length < 32) return reply.code(503).send({ error: 'RijPermis access is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
        if (!provider) return reply.code(503).send({ error: 'RijPermis connector disabled; configure RIJPERMIS_API_ENABLED or RIJPERMIS_MOCK_MODE' });
    });

    app.get<{ Querystring: { language?: 'fr' | 'nl' } }>('/rijpermis/themes', {
        schema: { querystring: { type: 'object', additionalProperties: false, properties: { language: { type: 'string', enum: ['fr', 'nl'] } } } }
    }, async request => provider!.listThemes(request.query.language));

    app.get<{ Querystring: { language?: 'fr' | 'nl'; category?: string; page?: string; size?: string } }>('/rijpermis/questions', {
        schema: { querystring: { type: 'object', additionalProperties: false, properties: {
            language: { type: 'string', enum: ['fr', 'nl'] }, category: { type: 'string', minLength: 1, maxLength: 300 },
            page: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, size: { type: 'string', pattern: '^([1-9][0-9]?|100)$' }
        } } }
    }, async request => provider!.listQuestions({
        language: request.query.language, category: request.query.category,
        page: request.query.page !== undefined ? Number(request.query.page) : undefined,
        size: request.query.size !== undefined ? Number(request.query.size) : undefined
    }));

    app.get<{ Params: { id: string } }>('/rijpermis/questions/:id', {
        schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: questionId } } }
    }, async request => provider!.getQuestion(request.params.id));

    // A quiz video job is generated from an exact RijPermis question; see requestVideoScript's source
    // parameter for the invariants enforced (same language, verbatim reproduction, human review still required).
    app.post<{ Params: { id: string }; Body: { requestId: string; questionId: string } }>('/video-jobs/:id/scripts/generate-from-rijpermis', {
        schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['requestId', 'questionId'],
            properties: { requestId: uuid, questionId } } }
    }, async (request, reply) => {
        const source = await prepareRijPermisSource(provider!, storage, request.body.questionId);
        const result = await requestVideoScript(prisma, request.params.id, request.body.requestId, 'QUIZ', source);
        return reply.code(result.created ? 202 : 200).header('Location', `/video-scripts/${result.script.id}`).send(result.script);
    });

    // Prepared for the future publication flow: re-checks the source question and blocks reuse if it
    // was changed or withdrawn since it was fetched. No publication engine exists yet in this codebase.
    app.post<{ Params: { id: string } }>('/video-scripts/:id/verify-source', { schema: { params: idParams } }, async request => {
        const check = await verifySourceBeforePublication(prisma, provider!, request.params.id);
        return { ...check, publicationBlocked: isPublicationBlocked(check) };
    });
};
