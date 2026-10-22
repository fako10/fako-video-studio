import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { requestAudio, type AudioStorage } from '@fako/ai-providers';
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
const settings = { type: 'object', additionalProperties: false, properties: {
    stability: { type: 'number', minimum: 0, maximum: 1 }, similarity_boost: { type: 'number', minimum: 0, maximum: 1 },
    style: { type: 'number', minimum: 0, maximum: 1 }, use_speaker_boost: { type: 'boolean' }, speed: { type: 'number', minimum: 0.7, maximum: 1.2 }
} };
export const audioRoutes: FastifyPluginAsync<{ prisma: PrismaClient; enabled: boolean; token?: string; storage: AudioStorage }> = async (app, { prisma, enabled, token, storage }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!token || token.length < 32) return reply.code(503).send({ error: 'Audio access is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });
    app.put<{ Params: { id: string; language: string }; Body: { voiceId: string; model: string; settings?: object } }>('/projects/:id/voices/:language', { schema: {
        params: { ...params, required: ['id', 'language'], properties: { ...params.properties, language: { type: 'string', enum: ['fr', 'nl'] } } },
        body: { type: 'object', additionalProperties: false, required: ['voiceId', 'model'], properties: { voiceId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' }, model: { type: 'string', enum: ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'] }, settings } }
    } }, async (request, reply) => {
        const { id, language } = request.params;
        const project = await prisma.project.findUnique({ where: { id } });
        if (!project) return reply.code(404).send({ error: 'Project not found' });
        if (!project.languages.includes(language)) return reply.code(409).send({ error: 'Language is not configured on project' });
        const data = { voiceId: request.body.voiceId, model: request.body.model, settings: request.body.settings ?? {} };
        return prisma.projectVoice.upsert({ where: { projectId_language: { projectId: id, language } }, create: { projectId: id, language, ...data }, update: data });
    });
    app.post<{ Params: { id: string } }>('/video-scripts/:id/audio/generate', { schema: { params, body: { type: 'object', additionalProperties: false } } }, async (request, reply) => {
        if (!enabled) return reply.code(503).send({ error: 'Audio generation disabled' });
        const { asset, created } = await requestAudio(prisma, request.params.id);
        return reply.code(created ? 202 : 200).header('Location', `/audio-assets/${asset.id}`).send(asset);
    });
    app.get<{ Params: { id: string } }>('/audio-assets/:id', { schema: { params } }, async (request, reply) =>
        await prisma.audioAsset.findUnique({ where: { id: request.params.id } }) ?? reply.code(404).send({ error: 'Audio not found' }));
    app.get<{ Params: { id: string } }>('/audio-assets/:id/preview', { schema: { params } }, async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
        const asset = await prisma.audioAsset.findUnique({ where: { id: request.params.id }, include: { videoScript: true, videoJob: true } });
        if (!asset) return reply.code(404).send({ error: 'Audio not found' });
        if (asset.status !== 'READY' || !asset.fileKey || asset.videoScript.validationStatus !== 'APPROVED' || asset.videoJob.status === 'CANCELLED') return reply.code(409).send({ error: 'Audio unavailable' });
        try { return reply.type(asset.mimeType ?? 'application/octet-stream').send(await storage.read(asset.fileKey)); }
        catch { return reply.code(404).send({ error: 'Audio file unavailable' }); }
    });
};
