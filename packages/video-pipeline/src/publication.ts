import type { PrismaClient } from '@prisma/client';
import { checkQuestion, type ContentSourceProvider, type SourceQuestion } from '@fako/content-sources';
import type { PublicationCheck } from '@fako/video-jobs';

export { isPublicationBlocked, type PublicationCheck } from '@fako/video-jobs';

// The same verification mission 7 prepared for VideoScript-sourced content (checkQuestion), applied
// to a QuizVideo. Not wired into a publication engine here (none exists yet) — this is the
// integration point section 5 asks to prepare, for whenever one is built.
export async function verifyQuizVideoBeforePublication(prisma: PrismaClient, provider: ContentSourceProvider, videoId: string): Promise<PublicationCheck> {
    const quizVideo = await prisma.video.findUnique({ where: { id: videoId } });
    // Les types de vidéos qui ne reposent pas sur une question (invitation, concept généré…)
    // n'ont rien à revérifier auprès de la source.
    if (!quizVideo?.snapshot) return { status: 'NOT_SOURCED' };
    const result = await checkQuestion(provider, quizVideo.snapshot as unknown as SourceQuestion);
    await prisma.video.update({ where: { id: videoId }, data: {
        checkStatus: result.status, checkedAt: new Date(result.checkedAt),
        ...(result.status !== 'WITHDRAWN' ? { contentHash: result.contentHash } : {})
    } });
    return result;
}
