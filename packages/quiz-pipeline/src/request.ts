import { Prisma, type PrismaClient } from '@prisma/client';
import { snapshotHash, type ContentSourceProvider, type Language, type MediaStorage, type SourceQuestion } from '@fako/content-sources';
import { QuizVideoRequestError } from './errors.js';
import { getQuestionUsageStats } from './rotation.js';
import { selectRijPermisQuestion, type SelectQuestionOptions } from './select.js';

// Already have the full question from selection, so unlike @fako/video-jobs' prepareRijPermisSource
// (built for a caller that only has an id) this never re-fetches the question — one request, one
// optional image download, respecting RijPermis' 60 req/min budget.
async function stageSourceImage(provider: ContentSourceProvider, mediaStorage: MediaStorage, question: SourceQuestion) {
    const image = await provider.downloadImage(question);
    if (!image) return {};
    const stored = await mediaStorage.writeImage(image.bytes, image.extension);
    return { imageKey: stored.key, imageHash: stored.hash, imageMimeType: image.mimeType };
}

// Cheap and fast (no TTS, no render): fetch/select the question, download its image if any, and
// persist the traceable snapshot. The expensive work is left to generateQuizVideo on the worker.
export async function requestQuizVideo(
    prisma: PrismaClient, provider: ContentSourceProvider, mediaStorage: MediaStorage,
    projectId: string, language: Language, requestId: string, options: SelectQuestionOptions = {}
) {
    const existing = await prisma.quizVideo.findUnique({ where: { requestId } });
    if (existing) return { quizVideo: existing, created: false };

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new QuizVideoRequestError(404, 'Project not found');
    if (project.languages.length && !project.languages.includes(language)) {
        throw new QuizVideoRequestError(409, 'Language not configured for this project');
    }
    const voice = await prisma.projectVoice.findUnique({ where: { projectId_language: { projectId, language } } });
    if (!voice) throw new QuizVideoRequestError(409, 'Configure a voice for this project and language first');

    const usage = await getQuestionUsageStats(prisma, projectId, language);
    const question = await selectRijPermisQuestion(provider, language, { ...options, usage });
    const image = await stageSourceImage(provider, mediaStorage, question);

    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
        const replay = await tx.quizVideo.findUnique({ where: { requestId } });
        if (replay) return { quizVideo: replay, created: false };
        const quizVideo = await tx.quizVideo.create({ data: {
            projectId, requestId, language,
            sourceId: provider.sourceId, origin: provider.origin, questionId: question.id,
            contentHash: question.contentHash, snapshotHash: snapshotHash(question), category: question.category,
            snapshot: question as unknown as Prisma.InputJsonObject, fetchedAt: new Date(), ...image,
            voiceId: voice.voiceId, ttsModel: voice.model, voiceSettings: voice.settings as Prisma.InputJsonValue
        } });
        return { quizVideo, created: true };
    });
}
