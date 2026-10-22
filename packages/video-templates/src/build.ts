import type { SourceQuestion } from '@fako/content-sources';
import { QuizTemplateError, validateQuizVideoProps, type QuizBackgroundMusic, type QuizNarration, type QuizVideoDurations, type QuizVideoProps } from './schema.js';

export type BuildQuizVideoPropsOptions = {
    sourceId?: string; brand?: { name: string; website: string }; imageFileName?: string | null;
    durations?: Partial<QuizVideoDurations>; fps?: number; width?: number; height?: number;
};

const DEFAULT_DURATIONS = { introSeconds: 3, questionSeconds: 5, countdownSeconds: 3, revealSeconds: 3, outroSeconds: 3 } as const;
const DEFAULT_EXPLANATION_SECONDS = 4;

// The only place a RijPermis question becomes video content. Nothing here may reword the statement,
// the propositions or the correct answer, and an explanation is only ever reused, never authored.
export function buildQuizVideoProps(question: SourceQuestion, options: BuildQuizVideoPropsOptions = {}): QuizVideoProps {
    if (question.validationStatus !== 'APPROVED') throw new QuizTemplateError('QUESTION_NOT_APPROVED');
    if (question.answerType !== 'SINGLE_CHOICE') throw new QuizTemplateError('UNSUPPORTED_ANSWER_TYPE');
    if (question.options.length < 2) throw new QuizTemplateError('NOT_ENOUGH_OPTIONS');
    if (question.correctOptionIds.length !== 1) throw new QuizTemplateError('UNSUPPORTED_ANSWER_TYPE');
    const correctOptionId = question.correctOptionIds[0];
    if (!question.options.some(option => option.id === correctOptionId)) throw new QuizTemplateError('CORRECT_OPTION_NOT_FOUND');

    const explanation = question.explanation?.status === 'APPROVED' ? question.explanation.text : null;
    const durations: QuizVideoDurations = {
        introSeconds: options.durations?.introSeconds ?? DEFAULT_DURATIONS.introSeconds,
        questionSeconds: options.durations?.questionSeconds ?? DEFAULT_DURATIONS.questionSeconds,
        countdownSeconds: options.durations?.countdownSeconds ?? DEFAULT_DURATIONS.countdownSeconds,
        revealSeconds: options.durations?.revealSeconds ?? DEFAULT_DURATIONS.revealSeconds,
        explanationSeconds: options.durations?.explanationSeconds ?? (explanation ? DEFAULT_EXPLANATION_SECONDS : 0),
        outroSeconds: options.durations?.outroSeconds ?? DEFAULT_DURATIONS.outroSeconds
    };

    return validateQuizVideoProps({
        schemaVersion: 1, language: question.language,
        brand: options.brand ?? { name: 'RijPermis', website: 'rijpermis.be' },
        source: { sourceId: options.sourceId ?? 'rijpermis', questionId: question.id, contentHash: question.contentHash, category: question.category },
        question: question.question,
        options: question.options.map(option => ({ id: option.id, text: option.text })),
        correctOptionId, explanation,
        imageFileName: question.image ? (options.imageFileName ?? null) : null,
        durations, fps: options.fps ?? 30, width: options.width ?? 1080, height: options.height ?? 1920,
        narration: null, backgroundMusic: null, interSceneSilenceSeconds: 0
    });
}

export type AttachNarrationOptions = { backgroundMusic?: QuizBackgroundMusic | null; interSceneSilenceSeconds?: number };

// Attaches already-synthesized, already-staged narration (see @fako/media-engine's
// synthesizeQuizNarration) to a silent QuizVideoProps. Re-validates the result, so a narration
// that doesn't match the question's explanation (present/absent) is rejected rather than rendered.
export function attachNarration(quiz: QuizVideoProps, narration: QuizNarration, options: AttachNarrationOptions = {}): QuizVideoProps {
    return validateQuizVideoProps({
        ...quiz, narration,
        backgroundMusic: options.backgroundMusic ?? null,
        interSceneSilenceSeconds: options.interSceneSilenceSeconds ?? 0.35
    });
}
