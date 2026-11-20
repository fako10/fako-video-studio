import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { Prisma, type PrismaClient, type SocialPlatform } from '@prisma/client';
import { VideoRequestError, type VideoTypeRegistry } from '@fako/video-types';

// Configuration de l'usine : types de vidéos disponibles, marques et programmes des projets.
// Même jeton administrateur partagé que les autres routes d'administration.

const uuidParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const brandProperties = {
    slug: { type: 'string', maxLength: 100, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
    name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    websiteUrl: { anyOf: [{ type: 'string', maxLength: 2048, format: 'uri', pattern: '^https?://[^/?#\\s]+' }, { type: 'null' }] },
    logoKey: { anyOf: [{ type: 'string', maxLength: 500, pattern: '^[a-z0-9-]+/[A-Za-z0-9._-]+$' }, { type: 'null' }] },
    colors: {
        type: 'object', additionalProperties: false,
        properties: { primary: color, secondary: color, accent: color, background: color, text: color }
    }
};
const PLATFORMS: SocialPlatform[] = ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'YOUTUBE', 'SNAPCHAT'];
const programProperties = {
    videoType: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,49}$' },
    name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    enabled: { type: 'boolean' },
    slots: { type: 'array', maxItems: 24, uniqueItems: true, items: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } },
    daysOfWeek: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
    minDurationSeconds: { type: 'integer', minimum: 5, maximum: 3600 },
    maxDurationSeconds: { type: 'integer', minimum: 5, maximum: 3600 },
    leadDays: { type: 'integer', minimum: 0, maximum: 7 },
    platforms: { type: 'array', uniqueItems: true, items: { enum: PLATFORMS } },
    params: { type: 'object' }
};
type ProgramBody = {
    videoType: string; name: string; enabled?: boolean; slots?: string[]; daysOfWeek?: number[];
    minDurationSeconds?: number; maxDurationSeconds?: number; leadDays?: number; platforms?: SocialPlatform[]; params?: Record<string, unknown>;
};
type BrandBody = { slug: string; name: string; websiteUrl?: string | null; logoKey?: string | null; colors?: Record<string, string> };

export const catalogRoutes: FastifyPluginAsync<{ prisma: PrismaClient; token?: string; registry: VideoTypeRegistry }> = async (app, { prisma, token, registry }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!token || token.length < 32) return reply.code(503).send({ error: 'Factory administration is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof VideoRequestError) return reply.code(error.statusCode).send({ error: error.message });
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return reply.code(409).send({ error: 'Already exists' });
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return reply.code(404).send({ error: 'Not found' });
        if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: (error as Error).message });
        return reply.send(error);
    });

    app.get('/video-types', async () => ({
        videoTypes: registry.list().map(type => ({
            id: type.id, label: type.label, description: type.description, paramsSchema: type.paramsSchema,
            defaultParams: type.defaultParams, defaultDuration: type.defaultDuration, requiresContentSource: type.requiresContentSource
        }))
    }));

    // Marques
    app.get('/brands', async () => ({ brands: await prisma.brand.findMany({ orderBy: { name: 'asc' }, include: { projects: { select: { id: true, name: true, language: true } } } }) }));
    app.post<{ Body: BrandBody }>('/brands', { schema: { body: { type: 'object', additionalProperties: false, required: ['slug', 'name'], properties: brandProperties } } }, async (request, reply) => {
        const brand = await prisma.brand.create({ data: { ...request.body, name: request.body.name.trim() } });
        return reply.code(201).header('Location', `/brands/${brand.id}`).send(brand);
    });
    app.get<{ Params: { id: string } }>('/brands/:id', { schema: { params: uuidParams } }, async (request, reply) =>
        (await prisma.brand.findUnique({ where: { id: request.params.id } })) ?? reply.code(404).send({ error: 'Brand not found' }));
    app.patch<{ Params: { id: string }; Body: Partial<BrandBody> }>('/brands/:id', {
        schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: brandProperties } }
    }, async request => prisma.brand.update({ where: { id: request.params.id }, data: request.body }));

    // Programmes d'un projet
    function checkDurations(min?: number, max?: number) {
        if (min !== undefined && max !== undefined && min > max) throw new VideoRequestError(400, 'minDurationSeconds must not exceed maxDurationSeconds');
    }

    app.get<{ Params: { id: string } }>('/projects/:id/programs', { schema: { params: uuidParams } }, async (request, reply) => {
        if (!await prisma.project.findUnique({ where: { id: request.params.id }, select: { id: true } })) return reply.code(404).send({ error: 'Project not found' });
        return { programs: await prisma.program.findMany({ where: { projectId: request.params.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) };
    });

    app.post<{ Params: { id: string }; Body: ProgramBody }>('/projects/:id/programs', {
        schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, required: ['videoType', 'name'], properties: programProperties } }
    }, async (request, reply) => {
        const project = await prisma.project.findUnique({ where: { id: request.params.id } });
        if (!project) return reply.code(404).send({ error: 'Project not found' });
        const module = registry.get(request.body.videoType);
        const params = registry.resolveParams(module.id, request.body.params ?? {});
        const minDurationSeconds = request.body.minDurationSeconds ?? module.defaultDuration.minSeconds;
        const maxDurationSeconds = request.body.maxDurationSeconds ?? module.defaultDuration.maxSeconds;
        checkDurations(minDurationSeconds, maxDurationSeconds);
        const { params: _ignored, ...rest } = request.body;
        const program = await prisma.program.create({ data: {
            ...rest, name: rest.name.trim(), projectId: project.id, params: params as Prisma.InputJsonObject,
            minDurationSeconds, maxDurationSeconds
        } });
        return reply.code(201).header('Location', `/programs/${program.id}`).send(program);
    });

    app.get<{ Params: { id: string } }>('/programs/:id', { schema: { params: uuidParams } }, async (request, reply) =>
        (await prisma.program.findUnique({ where: { id: request.params.id } })) ?? reply.code(404).send({ error: 'Program not found' }));

    app.patch<{ Params: { id: string }; Body: Partial<Omit<ProgramBody, 'videoType'>> }>('/programs/:id', {
        schema: { params: uuidParams, body: {
            type: 'object', additionalProperties: false, minProperties: 1,
            properties: Object.fromEntries(Object.entries(programProperties).filter(([key]) => key !== 'videoType'))
        } }
    }, async (request, reply) => {
        const current = await prisma.program.findUnique({ where: { id: request.params.id } });
        if (!current) return reply.code(404).send({ error: 'Program not found' });
        checkDurations(request.body.minDurationSeconds ?? current.minDurationSeconds, request.body.maxDurationSeconds ?? current.maxDurationSeconds);
        const { params: rawParams, ...rest } = request.body;
        const params = rawParams !== undefined ? registry.resolveParams(current.videoType, rawParams) as Prisma.InputJsonObject : undefined;
        return prisma.program.update({ where: { id: current.id }, data: {
            ...rest, ...(rest.name !== undefined ? { name: rest.name.trim() } : {}), ...(params ? { params } : {})
        } });
    });
};
