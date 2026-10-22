import { parseBuffer } from 'music-metadata';
import type { Language } from '@fako/content-sources';
import type { TTSProvider, VoiceSettings } from '@fako/ai-providers';
import { buildQuizNarration, type QuizNarration, type QuizSceneAudio, type QuizVideoProps } from '@fako/video-templates';
import { stageAudio } from './stageAudio.js';

export type VoiceConfig = { voiceId: string; model: string; settings?: VoiceSettings };
export type VoicesByLanguage = Record<Language, VoiceConfig>;

export class NarrationError extends Error {
    constructor(public readonly code: string) { super(code); }
}

// Synthesizes the narration for all six scenes (skipping the explanation when the question has
// none), measures each clip's real duration, and stages it into the Remotion project's public/
// folder. Pass a CachingTTSProvider (see @fako/ai-providers) to avoid paying for repeats.
export async function synthesizeQuizNarration(
    quiz: QuizVideoProps, provider: TTSProvider, voices: VoicesByLanguage, publicDir: string, volume = 1
): Promise<QuizNarration> {
    const voice = voices[quiz.language];
    if (!voice) throw new NarrationError(`NO_VOICE_CONFIGURED_FOR_${quiz.language.toUpperCase()}`);
    const texts = buildQuizNarration(quiz);

    async function synthesizeScene(text: string | null): Promise<QuizSceneAudio | null> {
        if (!text) return null;
        const output = await provider.synthesize({ text, language: quiz.language, voiceId: voice.voiceId, model: voice.model, settings: voice.settings ?? {} });
        const metadata = await parseBuffer(output.bytes, { mimeType: output.mimeType }, { duration: true });
        const durationSeconds = metadata.format.duration;
        if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new NarrationError('TTS_INVALID_DURATION');
        const fileName = await stageAudio(output.bytes, output.extension, publicDir);
        return { fileName, durationSeconds };
    }

    const [intro, question, countdown, reveal, explanation, outro] = await Promise.all([
        synthesizeScene(texts.intro), synthesizeScene(texts.question), synthesizeScene(texts.countdown),
        synthesizeScene(texts.reveal), synthesizeScene(texts.explanation), synthesizeScene(texts.outro)
    ]);

    return { volume, scenes: { intro, question, countdown, reveal, explanation, outro } };
}
