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

    // A day's production report: what was planned, what actually happened to each slot, and the
    // resulting FR/NL split and question usage. Never shows a publication status — nothing here is
    // ever published automatically (see verifyQuizVideoBeforePublication / isPublicationBlocked).
    app.get<{ Params: { id: string; date: string } }>('/projects/:id/scheduler/days/:date', { schema: { params } }, async (request, reply) => {
        if (!await prisma.project.findUnique({ where: { id: request.params.id }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const scheduledDate = new Date(`${request.params.date}T00:00:00.000Z`);
        const slots = await prisma.scheduledQuizSlot.findMany({
            where: { projectId: request.params.id, scheduledDate },
            include: { quizVideo: { select: { id: true, status: true, validationStatus: true, questionId: true, category: true, durationSeconds: true } } },
            orderBy: [{ slotTime: 'asc' }, { language: 'asc' }]
        });

        const dispatched = slots.filter(slot => slot.quizVideo);
        return {
            date: request.params.date,
            planned: slots.length,
            jobsCreated: dispatched.length,
            generated: dispatched.filter(slot => slot.quizVideo!.status === 'WAITING_APPROVAL' || slot.quizVideo!.status === 'COMPLETED').length,
            waitingApproval: dispatched.filter(slot => slot.quizVideo!.status === 'WAITING_APPROVAL').length,
            approved: dispatched.filter(slot => slot.quizVideo!.validationStatus === 'APPROVED').length,
            rejected: dispatched.filter(slot => slot.quizVideo!.validationStatus === 'REJECTED').length,
            generationFailures: dispatched.filter(slot => slot.quizVideo!.status === 'FAILED' && slot.quizVideo!.validationStatus === 'PENDING_APPROVAL').length,
            schedulingFailures: slots.filter(slot => slot.status === 'FAILED').length,
            skipped: slots.filter(slot => slot.status === 'SKIPPED').length,
            byLanguage: { fr: slots.filter(slot => slot.language === 'fr').length, nl: slots.filter(slot => slot.language === 'nl').length },
            questionsUsed: dispatched.map(slot => ({ language: slot.language, questionId: slot.quizVideo!.questionId, category: slot.quizVideo!.category })),
            slots: slots.map(slot => ({
                slotTime: slot.slotTime, language: slot.language, status: slot.status, reason: slot.reason,
                quizVideoId: slot.quizVideoId, quizVideoStatus: slot.quizVideo?.status ?? null, validationStatus: slot.quizVideo?.validationStatus ?? null
            }))
        };
    });
};
