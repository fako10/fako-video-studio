import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { ContentSourceProvider, MediaStorage } from '@fako/content-sources';
import type { VideoStorage } from '@fako/media-engine';
import { requestQuizVideo, reviewQuizVideo } from '@fako/video-pipeline';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
const projectParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
const quizVideoStatuses = ['PENDING', 'QUEUED', 'PROCESSING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED'];

export const quizVideoRoutes: FastifyPluginAsync<{
    prisma: PrismaClient; enabled: boolean; token?: string;
    provider?: ContentSourceProvider; mediaStorage: MediaStorage; videoStorage: VideoStorage;
}> = async (app, { prisma, enabled, token, provider, mediaStorage, videoStorage }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!token || token.length < 32) return reply.code(503).send({ error: 'Quiz video access is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });

    app.post<{ Params: { id: string }; Body: { requestId: string; language: 'fr' | 'nl'; questionId?: string } }>('/projects/:id/quiz-videos', {
        schema: { params: projectParams, body: { type: 'object', additionalProperties: false, required: ['requestId', 'language'],
            properties: { requestId: uuid, language: { type: 'string', enum: ['fr', 'nl'] }, questionId: { type: 'string', minLength: 1, maxLength: 100 } } } }
    }, async (request, reply) => {
        if (!enabled || !provider) return reply.code(503).send({ error: 'Quiz video generation disabled; configure QUIZ_VIDEO_ENABLED and the RijPermis connector' });
        const { quizVideo, created } = await requestQuizVideo(prisma, provider, mediaStorage, request.params.id, request.body.language, request.body.requestId,
            { questionId: request.body.questionId });
        return reply.code(created ? 202 : 200).header('Location', `/quiz-videos/${quizVideo.id}`).send(quizVideo);
    });

    // Filters are independent and composable; a missing one simply isn't applied. `date` matches the
    // UTC calendar day a QuizVideo was created on — a deliberate simplification over the scheduler's
    // own Europe/Brussels slot bookkeeping, adequate for an admin list view.
    app.get<{ Params: { id: string }; Querystring: { language?: 'fr' | 'nl'; status?: string; date?: string; limit?: string; offset?: string } }>('/projects/:id/quiz-videos', {
        schema: { params: projectParams, querystring: { type: 'object', additionalProperties: false, properties: {
            language: { type: 'string', enum: ['fr', 'nl'] }, status: { type: 'string', enum: quizVideoStatuses },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' }, offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})$' }
        } } }
    }, async (request, reply) => {
        if (!await prisma.project.findUnique({ where: { id: request.params.id }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const { language, status, date } = request.query;
        const dayStart = date ? new Date(`${date}T00:00:00.000Z`) : undefined;
        const where = {
            projectId: request.params.id, ...(language ? { language } : {}), ...(status ? { status: status as never } : {}),
            ...(dayStart ? { createdAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } } : {})
        };
        const [quizVideos, total] = await prisma.$transaction([
            prisma.video.findMany({ where, take: Number(request.query.limit ?? 20), skip: Number(request.query.offset ?? 0), orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
            prisma.video.count({ where })
        ]);
        return { quizVideos, total };
    });

    app.get<{ Params: { id: string } }>('/quiz-videos/:id', { schema: { params: idParams } }, async (request, reply) =>
        await prisma.video.findUnique({ where: { id: request.params.id } }) ?? reply.code(404).send({ error: 'Quiz video not found' }));

    // Quiz videos are short (a few MB); reading the whole file and slicing it in memory is simpler
    // and just as correct as a ranged read from storage, and still gives the browser real 206/
    // Content-Range behavior — which it needs to seek in the player at all (mission 12 gap).
    app.get<{ Params: { id: string } }>('/quiz-videos/:id/preview', { schema: { params: idParams } }, async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').header('Accept-Ranges', 'bytes');
        const quizVideo = await prisma.video.findUnique({ where: { id: request.params.id } });
        if (!quizVideo) return reply.code(404).send({ error: 'Quiz video not found' });
        if (!quizVideo.fileKey || !['WAITING_APPROVAL', 'COMPLETED'].includes(quizVideo.status)) return reply.code(409).send({ error: 'Quiz video unavailable' });
        let buffer: Buffer;
        try { buffer = await videoStorage.read(quizVideo.fileKey); }
        catch { return reply.code(404).send({ error: 'Quiz video file unavailable' }); }

        const range = parseRangeHeader(request.headers.range, buffer.length);
        if (range.kind === 'unsatisfiable') return reply.code(416).header('Content-Range', `bytes */${buffer.length}`).send();
        if (range.kind === 'none') return reply.type('video/mp4').send(buffer);
        return reply.code(206).type('video/mp4').header('Content-Range', `bytes ${range.start}-${range.end}/${buffer.length}`)
            .send(buffer.subarray(range.start, range.end + 1));
    });

    app.post<{ Params: { id: string }; Body: { reviewedBy: string; decision: 'APPROVED' | 'REJECTED'; comment?: string } }>('/quiz-videos/:id/review', {
        schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reviewedBy', 'decision'], properties: {
            reviewedBy: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
            decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] }, comment: { type: 'string', maxLength: 2000 }
        } } }
    }, async request => reviewQuizVideo(prisma, request.params.id, request.body.reviewedBy.trim(), request.body.decision, request.body.comment));
};

type RangeResult = { kind: 'none' } | { kind: 'satisfiable'; start: number; end: number } | { kind: 'unsatisfiable' };

// Single-range requests only (`bytes=start-end`, `bytes=start-`, `bytes=-suffixLength`) — the only
// forms browsers send for `<video>` seeking; multi-range requests are treated as absent, which is a
// conforming fallback (the client simply gets the whole file instead of several parts).
function parseRangeHeader(header: string | undefined, size: number): RangeResult {
    if (!header) return { kind: 'none' };
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return { kind: 'none' };
    let start: number, end: number;
    if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
    else { start = Math.max(0, size - Number(match[2])); end = size - 1; }
    if (end > size - 1) end = size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) return { kind: 'unsatisfiable' };
    return { kind: 'satisfiable', start, end };
}
