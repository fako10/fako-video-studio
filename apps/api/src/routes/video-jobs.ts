import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Prisma, PrismaClient, VideoJobStatus } from '@prisma/client';
import { cancellableStatuses } from '@fako/video-jobs';

const uuid = { type: 'string', format: 'uuid' };
const projectParams = { type: 'object', required: ['projectId'], additionalProperties: false, properties: { projectId: uuid } };
const jobParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: uuid } };
const statuses = ['PENDING', 'QUEUED', 'PROCESSING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'];
type CreateBody = { subject: string; language: string; format?: 'VERTICAL' | 'LANDSCAPE' | 'SQUARE'; targetDuration?: number; metadata?: Prisma.InputJsonObject };

export const videoJobRoutes: FastifyPluginAsync<{ prisma: PrismaClient; token?: string }> = async (app, { prisma, token }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!token || token.length < 32) return reply.code(503).send({ error: 'Video job administration is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });

    app.post<{ Params: { projectId: string }; Body: CreateBody }>('/projects/:projectId/video-jobs', {
        schema: { params: projectParams, body: {
            type: 'object', additionalProperties: false, required: ['subject', 'language'],
            properties: {
                subject: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
                language: { type: 'string', pattern: '^[a-z]{2}(?:-[A-Z]{2})?$' },
                format: { type: 'string', enum: ['VERTICAL', 'LANDSCAPE', 'SQUARE'] },
                targetDuration: { type: 'integer', minimum: 1, maximum: 600 },
                metadata: { type: 'object', maxProperties: 30, additionalProperties: true }
            }
        } }
    }, async (request, reply) => {
        const project = await prisma.project.findUnique({ where: { id: request.params.projectId }, include: { settings: true } });
        if (!project) return reply.code(404).send({ error: 'Project not found' });
        if (project.languages.length && !project.languages.includes(request.body.language)) {
            return reply.code(400).send({ error: 'Language not configured for this project' });
        }
        const settings = project.settings;
        const format = request.body.format ?? (settings && settings.width === settings.height ? 'SQUARE' : settings && settings.width > settings.height ? 'LANDSCAPE' : 'VERTICAL');
        const [width, height] = request.body.format
            ? format === 'VERTICAL' ? [1080, 1920] : format === 'LANDSCAPE' ? [1920, 1080] : [1080, 1080]
            : [settings?.width ?? 1080, settings?.height ?? 1920];
        const job = await prisma.videoJob.create({ data: {
            projectId: project.id, subject: request.body.subject.trim(), language: request.body.language,
            format, targetDuration: request.body.targetDuration ?? 30, width, height, fps: settings?.fps ?? 30,
            metadata: { ...(request.body.metadata ?? {}), simulated: true, humanApprovalRequired: true }
        } });
        return reply.code(201).header('Location', `/video-jobs/${job.id}`).send(job);
    });

    app.get<{ Params: { projectId: string }; Querystring: { limit?: string; offset?: string; status?: VideoJobStatus } }>('/projects/:projectId/video-jobs', {
        schema: { params: projectParams, querystring: { type: 'object', additionalProperties: false, properties: {
            limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' },
            offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})$' }, status: { type: 'string', enum: statuses }
        } } }
    }, async (request, reply) => {
        if (!await prisma.project.findUnique({ where: { id: request.params.projectId }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const where = { projectId: request.params.projectId, ...(request.query.status ? { status: request.query.status } : {}) };
        const [videoJobs, total] = await prisma.$transaction([
            prisma.videoJob.findMany({ where, take: Number(request.query.limit ?? 20), skip: Number(request.query.offset ?? 0), orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
            prisma.videoJob.count({ where })
        ]);
        return { videoJobs, total };
    });

    app.get<{ Params: { id: string } }>('/video-jobs/:id', { schema: { params: jobParams } }, async (request, reply) => {
        return await prisma.videoJob.findUnique({ where: { id: request.params.id } }) ?? reply.code(404).send({ error: 'Video job not found' });
    });

    app.post<{ Params: { id: string } }>('/video-jobs/:id/cancel', { schema: { params: jobParams } }, async (request, reply) => {
        const result = await prisma.videoJob.updateMany({ where: { id: request.params.id, status: { in: cancellableStatuses } },
            data: { status: 'CANCELLED', cancelledAt: new Date(), finishedAt: new Date() } });
        const job = await prisma.videoJob.findUnique({ where: { id: request.params.id } });
        if (!job) return reply.code(404).send({ error: 'Video job not found' });
        if (!result.count && job.status !== 'CANCELLED') return reply.code(409).send({ error: 'Video job cannot be cancelled in its current state' });
        return job;
    });

    app.post<{ Params: { id: string }; Body: { approvedBy: string } }>('/video-jobs/:id/approve', {
        schema: { params: jobParams, body: { type: 'object', additionalProperties: false, required: ['approvedBy'],
            properties: { approvedBy: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } } } }
    }, async (request, reply) => {
        const current = await prisma.videoJob.findUnique({ where: { id: request.params.id } });
        if (current?.scriptGenerationRequested) return reply.code(409).send({ error: 'Review the latest script version through /video-scripts/:id/review' });
        const result = await prisma.videoJob.updateMany({ where: { id: request.params.id, status: 'WAITING_APPROVAL', scriptGenerationRequested: false },
            data: { status: 'COMPLETED', approvedBy: request.body.approvedBy.trim(), approvedAt: new Date(), finishedAt: new Date() } });
        const job = await prisma.videoJob.findUnique({ where: { id: request.params.id } });
        if (!job) return reply.code(404).send({ error: 'Video job not found' });
        if (!result.count) return reply.code(409).send({ error: 'Video job is not waiting for approval' });
        return job;
    });
};
