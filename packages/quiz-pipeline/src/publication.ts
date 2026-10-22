import type { PrismaClient } from '@prisma/client';
import { checkQuestion, type ContentSourceProvider, type SourceQuestion } from '@fako/content-sources';
import type { PublicationCheck } from '@fako/video-jobs';

export { isPublicationBlocked, type PublicationCheck } from '@fako/video-jobs';

// The same verification mission 7 prepared for VideoScript-sourced content (checkQuestion), applied
// to a QuizVideo. Not wired into a publication engine here (none exists yet) — this is the
// integration point section 5 asks to prepare, for whenever one is built.
export async function verifyQuizVideoBeforePublication(prisma: PrismaClient, provider: ContentSourceProvider, quizVideoId: string): Promise<PublicationCheck> {
    const quizVideo = await prisma.quizVideo.findUnique({ where: { id: quizVideoId } });
    if (!quizVideo) return { status: 'NOT_SOURCED' };
    const result = await checkQuestion(provider, quizVideo.snapshot as unknown as SourceQuestion);
    await prisma.quizVideo.update({ where: { id: quizVideoId }, data: {
        checkStatus: result.status, checkedAt: new Date(result.checkedAt),
        ...(result.status !== 'WITHDRAWN' ? { contentHash: result.contentHash } : {})
    } });
    return result;
}
