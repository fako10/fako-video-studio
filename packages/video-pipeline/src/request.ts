import { Prisma, type PrismaClient } from '@prisma/client';
import type { ContentSourceProvider, Language, MediaStorage } from '@fako/content-sources';
import { DAILY_QUIZ, resolveBrandIdentity, VideoRequestError } from '@fako/video-types';
import { registryOf, type RequestDeps } from './deps.js';

export type VideoRequest = {
    projectId: string;
    requestId: string;
    /** Programme d'origine ; sinon demande manuelle, et `videoType` est obligatoire. */
    programId?: string;
    videoType?: string;
    /** Langue demandée ; doit correspondre à celle du projet quand elle est définie. */
    language?: string;
    questionId?: string;
};

// Rapide (ni synthèse vocale ni rendu) : choisit le contenu via le module du type de vidéo et
// enregistre une ligne Video traçable. Le travail coûteux est fait plus tard par le worker.
// Idempotent sur requestId.
export async function requestVideo(prisma: PrismaClient, deps: RequestDeps, request: VideoRequest) {
    const existing = await prisma.video.findUnique({ where: { requestId: request.requestId } });
    if (existing) return { video: existing, created: false };

    const project = await prisma.project.findUnique({ where: { id: request.projectId }, include: { brand: true } });
    if (!project) throw new VideoRequestError(404, 'Project not found');
    const program = request.programId ? await prisma.program.findUnique({ where: { id: request.programId } }) : null;
    if (request.programId && (!program || program.projectId !== project.id)) throw new VideoRequestError(404, 'Program not found');
    const videoType = program?.videoType ?? request.videoType;
    if (!videoType) throw new VideoRequestError(400, 'videoType is required without a program');

    const language = request.language ?? project.language;
    if (!language) throw new VideoRequestError(409, 'No language configured for this project');
    if (project.language && project.language !== language) throw new VideoRequestError(409, 'Language not configured for this project');
    if (!project.language && project.languages.length && !project.languages.includes(language)) {
        throw new VideoRequestError(409, 'Language not configured for this project');
    }
    const voice = await prisma.projectVoice.findUnique({ where: { projectId_language: { projectId: project.id, language } } });
    if (!voice) throw new VideoRequestError(409, 'Configure a voice for this project and language first');

    const registry = registryOf(deps);
    const module = registry.get(videoType);
    const params = registry.resolveParams(videoType, program?.params ?? {});
    const contentSource = deps.contentSourceFor(project);
    if (module.requiresContentSource && !contentSource) throw new VideoRequestError(409, 'No content source configured for this project');
    const brand = resolveBrandIdentity(project, deps.brandAssetsRoot);
    const prepared = await module.prepare(
        { prisma, project, program, brand, language, params, questionId: request.questionId },
        { contentSource, mediaStorage: deps.mediaStorage }
    );

    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${project.id}::uuid FOR UPDATE`;
        const replay = await tx.video.findUnique({ where: { requestId: request.requestId } });
        if (replay) return { video: replay, created: false };
        const video = await tx.video.create({ data: {
            projectId: project.id, programId: program?.id ?? null, videoType, requestId: request.requestId, language,
            title: prepared.title ?? null, content: prepared.content, ...(prepared.source ?? {}),
            voiceId: voice.voiceId, ttsModel: voice.model, voiceSettings: voice.settings as Prisma.InputJsonValue
        } });
        return { video, created: true };
    });
}

/** Demande manuelle d'un quiz du jour (route historique /projects/:id/quiz-videos). */
export async function requestQuizVideo(
    prisma: PrismaClient, provider: ContentSourceProvider, mediaStorage: MediaStorage,
    projectId: string, language: Language, requestId: string, options: { questionId?: string } = {}
) {
    const { video, created } = await requestVideo(prisma, { contentSourceFor: () => provider, mediaStorage }, {
        projectId, requestId, videoType: DAILY_QUIZ, language, questionId: options.questionId
    });
    return { quizVideo: video, created };
}
