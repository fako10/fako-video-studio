import type { PrismaClient } from '@prisma/client';
import { QuizVideoRequestError } from './errors.js';

// A generated video is never published automatically. Only the video currently awaiting review can
// be decided; approving marks it reusable, rejecting ends this attempt (a fresh request/requestId
// is required to try again, consistent with how a rejected VideoScript needs a new version).
export async function reviewQuizVideo(prisma: PrismaClient, id: string, reviewer: string, decision: 'APPROVED' | 'REJECTED', comment?: string) {
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "QuizVideo" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const quizVideo = await tx.quizVideo.findUnique({ where: { id } });
        if (!quizVideo) throw new QuizVideoRequestError(404, 'Quiz video not found');
        if (quizVideo.status !== 'WAITING_APPROVAL' || quizVideo.validationStatus !== 'PENDING_APPROVAL') {
            throw new QuizVideoRequestError(409, 'Only a generated video awaiting review can be validated');
        }
        return tx.quizVideo.update({ where: { id }, data: {
            validationStatus: decision, reviewedBy: reviewer, reviewedAt: new Date(), reviewComment: comment,
            status: decision === 'APPROVED' ? 'COMPLETED' : 'FAILED',
            errorMessage: decision === 'REJECTED' ? 'REJECTED_BY_REVIEWER' : null,
            finishedAt: new Date()
        } });
    });
}
