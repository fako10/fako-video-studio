import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';

const params = {
    type: 'object', additionalProperties: false, required: ['id', 'date'],
    properties: { id: { type: 'string', format: 'uuid' }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }
};

export const schedulerRoutes: FastifyPluginAsync<{ prisma: PrismaClient; token?: string }> = async (app, { prisma, token }) => {
    app.addHook('onRequest', async (request, reply) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (!token || token.length < 32) return reply.code(503).send({ error: 'Scheduler reporting is not configured' });
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
    });

    // Rapport de production d'une journée : ce qui était prévu, ce qui est arrivé à chaque créneau,
    // la répartition par type de vidéo et les questions utilisées. Aucun statut de publication :
    // rien n'est jamais publié automatiquement.
    app.get<{ Params: { id: string; date: string } }>('/projects/:id/scheduler/days/:date', { schema: { params } }, async (request, reply) => {
        if (!await prisma.project.findUnique({ where: { id: request.params.id }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const scheduledDate = new Date(`${request.params.date}T00:00:00.000Z`);
        const slots = await prisma.scheduledSlot.findMany({
            where: { projectId: request.params.id, scheduledDate },
            include: {
                video: { select: { id: true, videoType: true, status: true, validationStatus: true, questionId: true, category: true, durationSeconds: true } },
                program: { select: { id: true, name: true, videoType: true } }
            },
            orderBy: [{ slotTime: 'asc' }, { language: 'asc' }]
        });

        const dispatched = slots.flatMap(slot => (slot.video ? [{ slot, video: slot.video }] : []));
        const countBy = (values: string[]) => values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {});
        return {
            date: request.params.date,
            planned: slots.length,
            jobsCreated: dispatched.length,
            generated: dispatched.filter(({ video }) => video.status === 'WAITING_APPROVAL' || video.status === 'COMPLETED').length,
            waitingApproval: dispatched.filter(({ video }) => video.status === 'WAITING_APPROVAL').length,
            approved: dispatched.filter(({ video }) => video.validationStatus === 'APPROVED').length,
            rejected: dispatched.filter(({ video }) => video.validationStatus === 'REJECTED').length,
            generationFailures: dispatched.filter(({ video }) => video.status === 'FAILED' && video.validationStatus === 'PENDING_APPROVAL').length,
            schedulingFailures: slots.filter(slot => slot.status === 'FAILED').length,
            skipped: slots.filter(slot => slot.status === 'SKIPPED').length,
            byLanguage: countBy(slots.map(slot => slot.language)),
            byVideoType: countBy(slots.map(slot => slot.program?.videoType ?? slot.video?.videoType ?? 'unknown')),
            questionsUsed: dispatched.filter(({ video }) => video.questionId)
                .map(({ slot, video }) => ({ language: slot.language, questionId: video.questionId, category: video.category })),
            slots: slots.map(slot => ({
                slotTime: slot.slotTime, language: slot.language, status: slot.status, reason: slot.reason,
                programId: slot.programId, programName: slot.program?.name ?? null, videoType: slot.program?.videoType ?? slot.video?.videoType ?? null,
                videoId: slot.videoId, videoStatus: slot.video?.status ?? null, validationStatus: slot.video?.validationStatus ?? null
            }))
        };
    });
};
