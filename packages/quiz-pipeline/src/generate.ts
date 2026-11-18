import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, UnrecoverableError } from '@fako/jobs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getVideoMetadata } from '@remotion/renderer';
import type { SourceQuestion } from '@fako/content-sources';
import { MeteringTTSProvider, TTSError, type TTSProvider } from '@fako/ai-providers';
import { attachNarration, buildQuizVideoProps, type QuizVideoProps } from '@fako/video-templates';
import { renderQuizVideo, stageImage, synthesizeQuizNarration, type VideoStorage, type VoiceConfig, type VoicesByLanguage } from '@fako/media-engine';

export const quizVideoQueueName = 'quiz-videos';

export function createQuizVideoQueue() {
    return new Queue<{ quizVideoId: string }>(quizVideoQueueName, {
        // Un rendu long (vidéo hebdomadaire) peut durer bien plus que l'expiration par défaut d'1 h.
        defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, expireInSeconds: 4 * 3600 }
    });
}

export type RenderAndMeasure = (quiz: QuizVideoProps, outputPath: string, publicDir: string) => Promise<{ durationInSeconds: number }>;

// The real Remotion pipeline (mission 8/9), separated out so tests can swap in a fast fake for the
// scenarios that exercise claim/retry/idempotency logic rather than the renderer itself.
export const renderAndMeasureQuizVideo: RenderAndMeasure = async (quiz, outputPath, publicDir) => {
    await renderQuizVideo(quiz, { outputPath, publicDir });
    const meta = await getVideoMetadata(outputPath);
    if (!meta.durationInSeconds || !Number.isFinite(meta.durationInSeconds)) throw new Error('QUIZ_VIDEO_INVALID_DURATION');
    return { durationInSeconds: meta.durationInSeconds };
};

export type QuizVideoDeps = {
    ttsProvider: TTSProvider; videoStorage: VideoStorage;
    publicDir: string; mediaRoot: string; renderAndMeasure?: RenderAndMeasure;
};

export async function generateQuizVideo(prisma: PrismaClient, id: string, deps: QuizVideoDeps, options: { attempt: number; maxAttempts: number }) {
    const claimed = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "QuizVideo" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const quizVideo = await tx.quizVideo.findUnique({ where: { id } });
        if (!quizVideo || !['PENDING', 'PROCESSING'].includes(quizVideo.status)) return null;
        if (quizVideo.status === 'PROCESSING') {
            // A previous attempt crashed mid-flight; TTS may already have been billed. Fail rather
            // than silently retrying and risking a second paid call for an unknown outcome.
            await tx.quizVideo.update({ where: { id }, data: { status: 'FAILED', errorMessage: 'QUIZ_VIDEO_OUTCOME_UNKNOWN', finishedAt: new Date() } });
            return null;
        }
        return tx.quizVideo.update({ where: { id }, data: {
            status: 'PROCESSING', attempts: { increment: 1 }, startedAt: quizVideo.startedAt ?? new Date(), errorMessage: null
        } });
    });
    if (!claimed) return;

    let tempPath: string | undefined;
    try {
        const question = claimed.snapshot as unknown as SourceQuestion;
        const imageFileName = claimed.imageKey ? await stageImage(join(deps.mediaRoot, claimed.imageKey), deps.publicDir) : null;
        const silent = buildQuizVideoProps(question, { imageFileName });

        // The voice was resolved and copied onto this row at request time (see requestQuizVideo);
        // a later change to ProjectVoice does not alter an already-registered request.
        const voice: VoiceConfig = { voiceId: claimed.voiceId, model: claimed.ttsModel, settings: claimed.voiceSettings as VoiceConfig['settings'] };
        const voices = { [claimed.language]: voice } as VoicesByLanguage;
        const metering = new MeteringTTSProvider(deps.ttsProvider);
        const narration = await synthesizeQuizNarration(silent, metering, voices, deps.publicDir);
        const narrated = attachNarration(silent, narration);

        tempPath = join(tmpdir(), `quiz-video-${id}-${randomUUID()}.mp4`);
        const render = deps.renderAndMeasure ?? renderAndMeasureQuizVideo;
        const { durationInSeconds } = await render(narrated, tempPath, deps.publicDir);
        const bytes = await readFile(tempPath);
        const key = `${randomUUID()}.mp4`;
        await deps.videoStorage.write(key, bytes);

        await prisma.quizVideo.update({ where: { id }, data: {
            status: 'WAITING_APPROVAL', fileKey: key, durationSeconds: durationInSeconds,
            ttsProvider: deps.ttsProvider.name, ttsUsage: metering.usage as unknown as Prisma.InputJsonObject,
            generatedAt: new Date(), finishedAt: new Date(), errorMessage: null
        } });
    } catch (error) {
        const retryable = error instanceof TTSError && error.retryable;
        const retry = retryable && options.attempt < options.maxAttempts;
        const code = error instanceof TTSError ? error.code : error instanceof Error ? error.message.slice(0, 200) : 'QUIZ_VIDEO_PROCESSING_ERROR';
        await prisma.quizVideo.update({ where: { id }, data: { status: retry ? 'PENDING' : 'FAILED', errorMessage: code, finishedAt: retry ? null : new Date() } });
        if (!retry) throw new UnrecoverableError(code);
        throw error;
    } finally {
        if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
    }
}

export async function dispatchQuizVideos(prisma: PrismaClient, queue: Pick<ReturnType<typeof createQuizVideoQueue>, 'add' | 'getJob'>) {
    let cursor: string | undefined;
    for (;;) {
        const rows = await prisma.quizVideo.findMany({
            where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { id: 'asc' }, take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true }
        });
        for (const row of rows) {
            const existing = await queue.getJob(row.id);
            if (existing && await existing.getState() === 'failed') {
                await prisma.quizVideo.updateMany({ where: { id: row.id, status: { in: ['PENDING', 'PROCESSING'] } },
                    data: { status: 'FAILED', errorMessage: 'Queue attempts or stalled recovery exhausted', finishedAt: new Date() } });
                continue;
            }
            if (!existing) await queue.add('render', { quizVideoId: row.id }, { jobId: row.id });
        }
        if (rows.length < 100) return;
        cursor = rows.at(-1)!.id;
    }
}
