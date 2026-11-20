import type { PrismaClient } from '@prisma/client';
import { VideoRequestError } from '@fako/video-types';

// Une vidéo générée n'est jamais publiée automatiquement. Seule une vidéo en attente de validation
// peut être tranchée ; un rejet clôt cette tentative (une nouvelle demande est nécessaire).
export async function reviewVideo(prisma: PrismaClient, id: string, reviewer: string, decision: 'APPROVED' | 'REJECTED', comment?: string) {
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const video = await tx.video.findUnique({ where: { id } });
        if (!video) throw new VideoRequestError(404, 'Quiz video not found');
        if (video.status !== 'WAITING_APPROVAL' || video.validationStatus !== 'PENDING_APPROVAL') {
            throw new VideoRequestError(409, 'Only a generated video awaiting review can be validated');
        }
        return tx.video.update({ where: { id }, data: {
            validationStatus: decision, reviewedBy: reviewer, reviewedAt: new Date(), reviewComment: comment,
            status: decision === 'APPROVED' ? 'COMPLETED' : 'FAILED',
            errorMessage: decision === 'REJECTED' ? 'REJECTED_BY_REVIEWER' : null,
            finishedAt: new Date()
        } });
    });
}

/** @deprecated Utiliser reviewVideo. */
export const reviewQuizVideo = reviewVideo;
