import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { zonedTimeToUtc } from '@fako/video-pipeline';
import { cancelPublication, retryPublication, schedulePublication, updatePublicationSchedule } from '@fako/social-publishing';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
const projectParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
const publicationStatuses = ['DRAFT', 'SCHEDULED', 'READY', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'BLOCKED', 'OUTCOME_UNKNOWN'];
const PUBLICATION_TIME_ZONE = 'Europe/Brussels';
const localDateTime = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$' };

// apps/web only ever collects a plain "YYYY-MM-DDTHH:mm" from an HTML datetime-local input — always
// wall-clock Europe/Brussels (the only locale this project serves) — and forwards it verbatim; the
// DST-safe conversion to a stored UTC instant happens here, once, reusing mission 11's own
// zonedTimeToUtc rather than a second timezone implementation.
function parseLocalDateTime(value: string): Date {
    const [datePart, timePart] = value.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);
    return zonedTimeToUtc(year, month, day, hour, minute, PUBLICATION_TIME_ZONE);
}

// Same Bearer trust boundary as quiz-videos.ts/social-accounts.ts (QUIZ_VIDEO_API_TOKEN) — this
// route is only ever meant to be called server-to-server by apps/web, never directly by a browser.
export const socialPublicationRoutes: FastifyPluginAsync<{ prisma: PrismaClient; enabled: boolean; token?: string }> = async (app, { prisma, enabled, token }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!enabled || !token || token.length < 32) return reply.code(503).send({ error: 'Social publishing is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });

    app.post<{ Params: { id: string }; Body: {
        videoId: string; socialAccountId: string; language: 'fr' | 'nl'; caption: string; hashtags?: string[];
        scheduledAtLocal?: string; requestId: string; createdBy: string;
    } }>('/projects/:id/social-publications', {
        schema: { params: projectParams, body: { type: 'object', additionalProperties: false,
            required: ['videoId', 'socialAccountId', 'language', 'caption', 'requestId', 'createdBy'],
            properties: {
                videoId: uuid, socialAccountId: uuid, language: { type: 'string', enum: ['fr', 'nl'] },
                caption: { type: 'string', minLength: 1, maxLength: 2200 },
                hashtags: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 30 },
                scheduledAtLocal: localDateTime, requestId: uuid,
                createdBy: { type: 'string', minLength: 1, maxLength: 200 }
            } } }
    }, async (request, reply) => {
        const { publication, created } = await schedulePublication(prisma, {
            projectId: request.params.id, videoId: request.body.videoId, socialAccountId: request.body.socialAccountId,
            language: request.body.language, caption: request.body.caption, hashtags: request.body.hashtags,
            scheduledAt: request.body.scheduledAtLocal ? parseLocalDateTime(request.body.scheduledAtLocal) : undefined,
            requestId: request.body.requestId, createdBy: request.body.createdBy
        });
        return reply.code(created ? 201 : 200).send(publication);
    });

    app.get<{ Params: { id: string }; Querystring: {
        status?: string; platform?: string; videoId?: string; limit?: string; offset?: string;
    } }>('/projects/:id/social-publications', {
        schema: { params: projectParams, querystring: { type: 'object', additionalProperties: false, properties: {
            status: { type: 'string', enum: publicationStatuses }, platform: { type: 'string', enum: ['TIKTOK', 'INSTAGRAM', 'FACEBOOK'] },
            videoId: uuid, limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' }, offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})$' }
        } } }
    }, async (request, reply) => {
        if (!await prisma.project.findUnique({ where: { id: request.params.id }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const { status, platform, videoId } = request.query;
        const where = {
            projectId: request.params.id, ...(status ? { status: status as never } : {}),
            ...(platform ? { platform: platform as never } : {}), ...(videoId ? { videoId } : {})
        };
        const [socialPublications, total] = await prisma.$transaction([
            prisma.socialPublication.findMany({ where, take: Number(request.query.limit ?? 20), skip: Number(request.query.offset ?? 0), orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
            prisma.socialPublication.count({ where })
        ]);
        return { socialPublications, total };
    });

    app.get<{ Params: { id: string } }>('/social-publications/:id', { schema: { params: idParams } }, async (request, reply) => {
        const publication = await prisma.socialPublication.findUnique({ where: { id: request.params.id }, include: { attemptHistory: { orderBy: { attemptNumber: 'asc' } } } });
        return publication ?? reply.code(404).send({ error: 'Publication not found' });
    });

    app.patch<{ Params: { id: string }; Body: { caption?: string; hashtags?: string[]; scheduledAtLocal?: string | null } }>(
        '/social-publications/:id',
        { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: {
            caption: { type: 'string', minLength: 1, maxLength: 2200 }, hashtags: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 30 },
            scheduledAtLocal: { anyOf: [localDateTime, { type: 'null' }] }
        } } } },
        async request => updatePublicationSchedule(prisma, request.params.id, {
            caption: request.body.caption, hashtags: request.body.hashtags,
            scheduledAt: request.body.scheduledAtLocal === undefined ? undefined : request.body.scheduledAtLocal === null ? null : parseLocalDateTime(request.body.scheduledAtLocal)
        })
    );

    app.post<{ Params: { id: string }; Body: { cancelledBy: string } }>(
        '/social-publications/:id/cancel',
        { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['cancelledBy'], properties: { cancelledBy: { type: 'string', minLength: 1, maxLength: 200 } } } } },
        async request => cancelPublication(prisma, request.params.id, request.body.cancelledBy)
    );

    app.post<{ Params: { id: string } }>('/social-publications/:id/retry', { schema: { params: idParams } }, async request => retryPublication(prisma, request.params.id));
};
