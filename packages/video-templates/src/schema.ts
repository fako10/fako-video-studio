import { Ajv } from 'ajv';
import type { Language } from '@fako/content-sources';

export class QuizTemplateError extends Error {
    constructor(public readonly code: string) { super(code); }
}

export type QuizVideoOption = { id: string; text: string };

export type QuizVideoDurations = {
    introSeconds: number; questionSeconds: number; countdownSeconds: number;
    revealSeconds: number; explanationSeconds: number; outroSeconds: number;
};

// A staged, already-measured narration clip for one scene — never a remote URL, never a guessed duration.
export type QuizSceneAudio = { fileName: string; durationSeconds: number };

export type QuizNarration = {
    volume: number;
    scenes: {
        intro: QuizSceneAudio | null; question: QuizSceneAudio | null; countdown: QuizSceneAudio | null;
        reveal: QuizSceneAudio | null; explanation: QuizSceneAudio | null; outro: QuizSceneAudio | null;
    };
};

export type QuizBackgroundMusic = { fileName: string; volume: number };

export type QuizVideoProps = {
    schemaVersion: 1;
    language: Language;
    brand: { name: string; website: string };
    source: { sourceId: string; questionId: string; contentHash: string; category: string };
    question: string;
    options: QuizVideoOption[];
    correctOptionId: string;
    // Only ever populated when the RijPermis explanation itself has status APPROVED; never AI-authored.
    explanation: string | null;
    // Name of an image already staged into the Remotion project's public/ folder, or null. Never a remote URL.
    imageFileName: string | null;
    durations: QuizVideoDurations;
    fps: number; width: number; height: number;
    // Narration is absent (null) for a silent video — the mission 8 default, unchanged. When present,
    // each scene's rendered duration can only grow to fit it (see resolveSceneDurations), never shrink.
    narration: QuizNarration | null;
    // Disabled unless a rights-cleared track is explicitly supplied.
    backgroundMusic: QuizBackgroundMusic | null;
    interSceneSilenceSeconds: number;
};

const positiveNumber = { type: 'number', exclusiveMinimum: 0 };
const nonNegativeNumber = { type: 'number', minimum: 0 };
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const fileName = { type: 'string', minLength: 1, maxLength: 300, pattern: '^[A-Za-z0-9_.-]+$' };
const volume = { type: 'number', minimum: 0, maximum: 1 };
const sceneAudioSchema = nullable({
    type: 'object', additionalProperties: false, required: ['fileName', 'durationSeconds'],
    properties: { fileName, durationSeconds: positiveNumber }
});

const quizVideoPropsSchema = {
    type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'language', 'brand', 'source', 'question', 'options', 'correctOptionId', 'explanation', 'imageFileName', 'durations', 'fps', 'width', 'height', 'narration', 'backgroundMusic', 'interSceneSilenceSeconds'],
    properties: {
        schemaVersion: { const: 1 },
        language: { enum: ['fr', 'nl'] },
        brand: { type: 'object', additionalProperties: false, required: ['name', 'website'], properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 }, website: { type: 'string', minLength: 1, maxLength: 200 }
        } },
        source: { type: 'object', additionalProperties: false, required: ['sourceId', 'questionId', 'contentHash', 'category'], properties: {
            sourceId: { type: 'string', minLength: 1, maxLength: 50 }, questionId: { type: 'string', minLength: 1, maxLength: 100 },
            contentHash: { type: 'string', pattern: '^sha256:[a-fA-F0-9]{64}$' }, category: { type: 'string', minLength: 1, maxLength: 300 }
        } },
        question: { type: 'string', minLength: 1, maxLength: 10000 },
        options: { type: 'array', minItems: 2, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: {
            id: { type: 'string', minLength: 1, maxLength: 100 }, text: { type: 'string', minLength: 1, maxLength: 5000 }
        } } },
        correctOptionId: { type: 'string', minLength: 1, maxLength: 100 },
        explanation: { anyOf: [{ type: 'string', minLength: 1, maxLength: 10000 }, { type: 'null' }] },
        imageFileName: nullable(fileName),
        durations: { type: 'object', additionalProperties: false,
            required: ['introSeconds', 'questionSeconds', 'countdownSeconds', 'revealSeconds', 'explanationSeconds', 'outroSeconds'],
            properties: {
                introSeconds: positiveNumber, questionSeconds: positiveNumber, countdownSeconds: positiveNumber,
                revealSeconds: positiveNumber, explanationSeconds: nonNegativeNumber, outroSeconds: positiveNumber
            } },
        fps: { type: 'integer', minimum: 1, maximum: 60 },
        width: { type: 'integer', minimum: 2, maximum: 7680 },
        height: { type: 'integer', minimum: 2, maximum: 7680 },
        narration: nullable({ type: 'object', additionalProperties: false, required: ['volume', 'scenes'], properties: {
            volume, scenes: { type: 'object', additionalProperties: false,
                required: ['intro', 'question', 'countdown', 'reveal', 'explanation', 'outro'],
                properties: { intro: sceneAudioSchema, question: sceneAudioSchema, countdown: sceneAudioSchema, reveal: sceneAudioSchema, explanation: sceneAudioSchema, outro: sceneAudioSchema }
            }
        } }),
        backgroundMusic: nullable({ type: 'object', additionalProperties: false, required: ['fileName', 'volume'], properties: { fileName, volume } }),
        interSceneSilenceSeconds: nonNegativeNumber
    }
};

const ajv = new Ajv({ strict: true });
const validate = ajv.compile(quizVideoPropsSchema);

export function validateQuizVideoProps(value: unknown): QuizVideoProps {
    if (!validate(value)) throw new QuizTemplateError('INVALID_QUIZ_VIDEO_PROPS');
    const props = value as QuizVideoProps;
    if (new Set(props.options.map(option => option.id)).size !== props.options.length) throw new QuizTemplateError('DUPLICATE_OPTION_IDS');
    if (!props.options.some(option => option.id === props.correctOptionId)) throw new QuizTemplateError('CORRECT_OPTION_NOT_FOUND');
    // An explanation scene with nothing to say, or a non-zero duration with nothing shown, both indicate a wiring bug upstream.
    if ((props.explanation === null) !== (props.durations.explanationSeconds === 0)) throw new QuizTemplateError('INCONSISTENT_EXPLANATION_DURATION');
    // Narration for an explanation that does not exist (or a missing narration for one that does) is the same class of bug.
    if (props.narration && (props.explanation === null) !== (props.narration.scenes.explanation === null)) {
        throw new QuizTemplateError('INCONSISTENT_NARRATION_EXPLANATION');
    }
    return props;
}

export function totalDurationInFrames(durations: QuizVideoDurations, fps: number): number {
    const totalSeconds = durations.introSeconds + durations.questionSeconds + durations.countdownSeconds
        + durations.revealSeconds + durations.explanationSeconds + durations.outroSeconds;
    return Math.round(totalSeconds * fps);
}

// A narration clip may run longer than the visual minimum configured for its scene; a scene never
// shrinks below that minimum (the countdown, in particular, always completes). Returns `durations`
// unchanged when there is no narration, so every mission 8 render stays byte-for-byte identical.
export function resolveSceneDurations(quiz: QuizVideoProps): QuizVideoDurations {
    const silence = quiz.narration ? quiz.interSceneSilenceSeconds : 0;
    const narrationBuffer = 0.3;
    const fit = (configuredSeconds: number, audio: QuizSceneAudio | null | undefined) =>
        Math.max(configuredSeconds, audio ? audio.durationSeconds + narrationBuffer : 0);
    const scenes = quiz.narration?.scenes;
    const explanationBase = quiz.explanation !== null ? fit(quiz.durations.explanationSeconds, scenes?.explanation) : 0;
    return {
        introSeconds: fit(quiz.durations.introSeconds, scenes?.intro) + silence,
        questionSeconds: fit(quiz.durations.questionSeconds, scenes?.question) + silence,
        countdownSeconds: fit(quiz.durations.countdownSeconds, scenes?.countdown) + silence,
        revealSeconds: fit(quiz.durations.revealSeconds, scenes?.reveal) + silence,
        explanationSeconds: explanationBase + (explanationBase > 0 ? silence : 0),
        outroSeconds: fit(quiz.durations.outroSeconds, scenes?.outro)
    };
}
