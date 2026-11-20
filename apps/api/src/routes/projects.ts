import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { verifiedFactsSchema } from '@fako/video-jobs';

type Settings = { width?: number; height?: number; fps?: number; videosPerDay?: number; publicationEnabled?: boolean; humanValidationRequired?: boolean };
type ProjectBody = { brandId?: string | null; language?: string | null; timezone?: string; contentSource?: string | null; brandOverrides?: Prisma.InputJsonObject; name: string; description?: string | null; slug?: string | null; website?: string | null; category?: string | null; languages?: string[]; objective?: string | null; editorialInstructions?: string; verifiedFacts?: { id: string; text: string; source: string; kind?: 'BUSINESS' | 'ROAD_RULE' }[]; settings?: Settings };
const settingsSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        width: { type: 'integer', minimum: 1, maximum: 16384 },
        height: { type: 'integer', minimum: 1, maximum: 16384 },
        fps: { type: 'integer', minimum: 1, maximum: 240 },
        videosPerDay: { type: 'integer', minimum: 0, maximum: 1000 },
        publicationEnabled: { type: 'boolean' },
        humanValidationRequired: { type: 'boolean' }
    }
};
const properties = {
    name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    description: { anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'null' }] },
    slug: { anyOf: [{ type: 'string', maxLength: 100, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }, { type: 'null' }] },
    website: { anyOf: [{ type: 'string', maxLength: 2048, format: 'uri', pattern: '^https?://[^/?#\\s]+' }, { type: 'null' }] },
    category: { anyOf: [{ type: 'string', minLength: 1, maxLength: 200 }, { type: 'null' }] },
    languages: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[a-z]{2}(?:-[A-Z]{2})?$' } },
    objective: { anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'null' }] },
    editorialInstructions: { type: 'string', maxLength: 20000 },
    verifiedFacts: verifiedFactsSchema,
    settings: settingsSchema,
    brandId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    language: { anyOf: [{ type: 'string', pattern: '^[a-z]{2}$' }, { type: 'null' }] },
    timezone: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z_]+(?:/[A-Za-z_+-]+)*$' },
    contentSource: { anyOf: [{ type: 'string', pattern: '^[a-z][a-z0-9-]{1,49}$' }, { type: 'null' }] },
    brandOverrides: { type: 'object' }
};
const params = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } };

export const projectRoutes: FastifyPluginAsync<{ prisma: PrismaClient; token?: string }> = async (app, { prisma, token }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!token || token.length < 32) return reply.code(503).send({ error: 'Project administration is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });

    app.get('/projects', { schema: { querystring: {
        type: 'object', additionalProperties: false,
        properties: { offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})$' }, limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' } }
    } } }, async (request) => {
        const query = request.query as { offset?: string; limit?: string };
        const [projects, total] = await prisma.$transaction([
            prisma.project.findMany({ skip: Number(query.offset ?? 0), take: Number(query.limit ?? 20), orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], include: { settings: true } }),
            prisma.project.count()
        ]);
        return { projects, total };
    });

    app.post<{ Body: ProjectBody }>('/projects', { schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties } } }, async (request, reply) => {
        const { settings, ...data } = request.body;
        const project = await prisma.project.create({ data: { ...data, name: data.name.trim(), settings: { create: settings ?? {} } }, include: { settings: true } });
        return reply.code(201).header('Location', `/projects/${project.id}`).send(project);
    });

    app.get<{ Params: { id: string } }>('/projects/:id', { schema: { params } }, async (request, reply) => {
        const project = await prisma.project.findUnique({ where: { id: request.params.id }, include: { settings: true } });
        return project ?? reply.code(404).send({ error: 'Project not found' });
    });

    app.patch<{ Params: { id: string }; Body: Partial<ProjectBody> }>('/projects/:id', { schema: { params, body: { type: 'object', additionalProperties: false, minProperties: 1, properties } } }, async (request) => {
        const { settings, ...data } = request.body;
        return prisma.project.update({
            where: { id: request.params.id },
            data: { ...data, ...(data.name !== undefined ? { name: data.name.trim() } : {}), ...(settings ? { settings: { upsert: { create: settings, update: settings } } } : {}) },
            include: { settings: true }
        });
    });

    app.delete<{ Params: { id: string } }>('/projects/:id', { schema: { params } }, async (request, reply) => {
        await prisma.project.delete({ where: { id: request.params.id } });
        return reply.code(204).send();
    });
};
