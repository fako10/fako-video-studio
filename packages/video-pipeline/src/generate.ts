import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, UnrecoverableError } from '@fako/jobs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { TTSError } from '@fako/ai-providers';
import type { VoiceConfig } from '@fako/media-engine';
import { resolveBrandIdentity } from '@fako/video-types';
import { registryOf, type RenderPipelineDeps } from './deps.js';

export const videoRenderQueueName = 'video-renders';

export function createVideoRenderQueue() {
    return new Queue<{ videoId: string }>(videoRenderQueueName, {
        // Un rendu long (vidéo hebdomadaire de 8 min) dépasse largement l'expiration par défaut d'1 h.
        defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, expireInSeconds: 4 * 3600 }
    });
}

export type { RenderAndMeasure } from '@fako/video-types';
export { renderAndMeasureQuizVideo } from '@fako/video-types';
export type QuizVideoDeps = RenderPipelineDeps;

// Produit le MP4 d'une ligne Video, quel que soit son type : réservation de la ligne, délégation au
// module du type (narration + rendu), stockage du fichier, puis passage en attente de validation.
export async function generateVideo(prisma: PrismaClient, id: string, deps: RenderPipelineDeps, options: { attempt: number; maxAttempts: number }) {
    const claimed = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Video" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const video = await tx.video.findUnique({ where: { id } });
        if (!video || !['PENDING', 'PROCESSING'].includes(video.status)) return null;
        if (video.status === 'PROCESSING') {
            // Une tentative précédente s'est interrompue en cours de route ; la synthèse vocale a pu
            // être facturée. On échoue plutôt que de risquer un second appel payant à l'aveugle.
            await tx.video.update({ where: { id }, data: { status: 'FAILED', errorMessage: 'QUIZ_VIDEO_OUTCOME_UNKNOWN', finishedAt: new Date() } });
            return null;
        }
        return tx.video.update({ where: { id }, data: {
            status: 'PROCESSING', attempts: { increment: 1 }, startedAt: video.startedAt ?? new Date(), errorMessage: null
        } });
    });
    if (!claimed) return;

    let tempPath: string | undefined;
    try {
        const registry = registryOf(deps);
        const module = registry.get(claimed.videoType);
        const project = await prisma.project.findUniqueOrThrow({ where: { id: claimed.projectId }, include: { brand: true } });
        const program = claimed.programId ? await prisma.program.findUnique({ where: { id: claimed.programId } }) : null;
        // La voix a été copiée sur la ligne au moment de la demande : un changement ultérieur de
        // ProjectVoice ne modifie pas une demande déjà enregistrée.
        const voice: VoiceConfig = { voiceId: claimed.voiceId, model: claimed.ttsModel, settings: claimed.voiceSettings as VoiceConfig['settings'] };

        tempPath = join(tmpdir(), `video-${id}-${randomUUID()}.mp4`);
        const output = await module.render(
            { video: claimed, program, brand: resolveBrandIdentity(project, deps.brandAssetsRoot), voice },
            { ttsProvider: deps.ttsProvider, publicDir: deps.publicDir, mediaRoot: deps.mediaRoot, renderAndMeasure: deps.renderAndMeasure },
            tempPath
        );
        const bytes = await readFile(tempPath);
        const key = `${randomUUID()}.mp4`;
        await deps.videoStorage.write(key, bytes);

        await prisma.video.update({ where: { id }, data: {
            status: 'WAITING_APPROVAL', fileKey: key, durationSeconds: output.durationSeconds,
            ttsProvider: deps.ttsProvider.name, ttsUsage: (output.ttsUsage ?? null) as Prisma.InputJsonValue,
            generatedAt: new Date(), finishedAt: new Date(), errorMessage: null
        } });
    } catch (error) {
        const retryable = error instanceof TTSError && error.retryable;
        const retry = retryable && options.attempt < options.maxAttempts;
        const code = error instanceof TTSError ? error.code : error instanceof Error ? error.message.slice(0, 200) : 'QUIZ_VIDEO_PROCESSING_ERROR';
        await prisma.video.update({ where: { id }, data: { status: retry ? 'PENDING' : 'FAILED', errorMessage: code, finishedAt: retry ? null : new Date() } });
        if (!retry) throw new UnrecoverableError(code);
        throw error;
    } finally {
        if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
    }
}

/** @deprecated Utiliser generateVideo. */
export const generateQuizVideo = generateVideo;

// Outbox : les lignes Video font foi ; la file ne sert qu'à déclencher le rendu. jobId = id de la
// ligne, donc une nouvelle expédition ne crée jamais de doublon.
export async function dispatchVideos(prisma: PrismaClient, queue: Pick<ReturnType<typeof createVideoRenderQueue>, 'add' | 'getJob'>) {
    let cursor: string | undefined;
    for (;;) {
        const rows = await prisma.video.findMany({
            where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { id: 'asc' }, take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true }
        });
        for (const row of rows) {
            const existing = await queue.getJob(row.id);
            if (existing && await existing.getState() === 'failed') {
                await prisma.video.updateMany({ where: { id: row.id, status: { in: ['PENDING', 'PROCESSING'] } },
                    data: { status: 'FAILED', errorMessage: 'Queue attempts or stalled recovery exhausted', finishedAt: new Date() } });
                continue;
            }
            if (!existing) await queue.add('render', { videoId: row.id }, { jobId: row.id });
        }
        if (rows.length < 100) return;
        cursor = rows.at(-1)!.id;
    }
}

/** @deprecated Anciens noms, conservés pour compatibilité. */
export const quizVideoQueueName = videoRenderQueueName;
export const createQuizVideoQueue = createVideoRenderQueue;
export const dispatchQuizVideos = dispatchVideos;
