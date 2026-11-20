// Type de vidéo « Quiz du jour » : une question de la source de contenu du projet (rotation sans
// répétition), narrée puis rendue avec le template Remotion QuizDuJour.
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { getVideoMetadata } from '@remotion/renderer';
import { MeteringTTSProvider } from '@fako/ai-providers';
import { snapshotHash, type ContentSourceProvider, type Language, type MediaStorage, type SourceQuestion } from '@fako/content-sources';
import { renderQuizVideo, stageImage, synthesizeQuizNarration, type VoicesByLanguage } from '@fako/media-engine';
import { attachNarration, buildQuizVideoProps, type QuizVideoProps } from '@fako/video-templates';
import type { RenderAndMeasure, VideoTypeModule } from '../contract.js';
import { VideoRequestError } from '../errors.js';
import { getQuestionUsageStats } from './rotation.js';
import { selectRijPermisQuestion } from './select.js';

export * from './rotation.js';
export * from './select.js';

export const DAILY_QUIZ = 'daily-quiz';

export type DailyQuizParams = {
    /** Hashtags ajoutés à la légende de publication. */
    hashtags: string[];
    /** Phrase d'accroche ajoutée avant la question dans la légende. */
    captionIntro: string;
};

/** Rendu réel (Remotion) mesuré ; remplacé par un faux rendu dans les tests. */
export const renderAndMeasureQuizVideo: RenderAndMeasure = async (props, outputPath, publicDir) => {
    await renderQuizVideo(props as QuizVideoProps, { outputPath, publicDir });
    const meta = await getVideoMetadata(outputPath);
    if (!meta.durationInSeconds || !Number.isFinite(meta.durationInSeconds)) throw new Error('QUIZ_VIDEO_INVALID_DURATION');
    return { durationInSeconds: meta.durationInSeconds };
};

// La question complète vient déjà de la sélection : une seule requête, plus un téléchargement
// d'image éventuel (budget de 60 requêtes/minute de l'API RijPermis).
async function stageSourceImage(provider: ContentSourceProvider, mediaStorage: MediaStorage | undefined, question: SourceQuestion) {
    if (!mediaStorage) return {};
    const image = await provider.downloadImage(question);
    if (!image) return {};
    const stored = await mediaStorage.writeImage(image.bytes, image.extension);
    return { imageKey: stored.key, imageHash: stored.hash, imageMimeType: image.mimeType };
}

export const dailyQuiz: VideoTypeModule<DailyQuizParams> = {
    id: DAILY_QUIZ,
    label: 'Quiz du jour',
    description: 'Une question de la source de contenu du projet, sans répétition, avec révélation de la bonne réponse.',
    paramsSchema: {
        type: 'object', additionalProperties: false,
        required: ['hashtags', 'captionIntro'],
        properties: {
            hashtags: { type: 'array', maxItems: 30, items: { type: 'string', pattern: '^#?[\\p{L}\\p{N}_]{1,100}$' } },
            captionIntro: { type: 'string', maxLength: 300 }
        }
    },
    defaultParams: { hashtags: [], captionIntro: '' },
    defaultDuration: { minSeconds: 30, maxSeconds: 60 },
    requiresContentSource: true,

    async prepare(context, deps) {
        const provider = deps.contentSource;
        if (!provider) throw new VideoRequestError(409, 'No content source configured for this project');
        const language = context.language as Language;
        const usage = await getQuestionUsageStats(context.prisma, context.project.id, language);
        const question = await selectRijPermisQuestion(provider, language, { usage, questionId: context.questionId });
        const image = await stageSourceImage(provider, deps.mediaStorage, question);
        return {
            title: question.question.slice(0, 300),
            content: { questionId: question.id },
            source: {
                sourceId: provider.sourceId, origin: provider.origin, questionId: question.id,
                contentHash: question.contentHash, snapshotHash: snapshotHash(question), category: question.category,
                snapshot: question as unknown as Prisma.InputJsonObject, fetchedAt: new Date(), ...image
            }
        };
    },

    async render(input, deps, outputPath) {
        const { video } = input;
        if (!video.snapshot) throw new Error('QUIZ_VIDEO_MISSING_SNAPSHOT');
        const question = video.snapshot as unknown as SourceQuestion;
        const imageFileName = video.imageKey ? await stageImage(join(deps.mediaRoot, video.imageKey), deps.publicDir) : null;
        const silent = buildQuizVideoProps(question, { imageFileName });
        const voices = { [video.language]: input.voice } as VoicesByLanguage;
        const metering = new MeteringTTSProvider(deps.ttsProvider);
        const narration = await synthesizeQuizNarration(silent, metering, voices, deps.publicDir);
        const narrated = attachNarration(silent, narration);
        const render = deps.renderAndMeasure ?? renderAndMeasureQuizVideo;
        const { durationInSeconds } = await render(narrated, outputPath, deps.publicDir);
        return { durationSeconds: durationInSeconds, ttsUsage: metering.usage };
    },

    caption(video, brand, params) {
        const question = video.snapshot as unknown as SourceQuestion | null;
        const intro = params.captionIntro?.trim();
        const text = [intro, question?.question, brand.websiteUrl].filter(Boolean).join('\n\n');
        const hashtags = (params.hashtags ?? []).map(tag => tag.startsWith('#') ? tag : `#${tag}`);
        return { caption: text.slice(0, 2200), hashtags };
    }
};
