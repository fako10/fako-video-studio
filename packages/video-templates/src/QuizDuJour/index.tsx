import React from 'react';
import { Audio, Series, staticFile } from 'remotion';
import type { QuizSceneAudio, QuizVideoProps } from '../schema.js';
import { resolveSceneDurations } from '../schema.js';
import { buildQuizNarration } from '../narration.js';
import { quizTranslations } from '../translations.js';
import { Intro } from './Intro.js';
import { QuestionScene } from './QuestionScene.js';
import { Countdown } from './Countdown.js';
import { Reveal } from './Reveal.js';
import { Explanation } from './Explanation.js';
import { Outro } from './Outro.js';
import type { SceneMediaProps } from './SceneMedia.js';

const framesFor = (secondsValue: number, fps: number) => Math.round(secondsValue * fps);

// The single place the six scenes are sequenced. Scene order and presence (the explanation only
// appears when the source provided an approved one) follow directly from the resolved durations,
// which only ever grow to fit narration (see resolveSceneDurations) — never shrink or cut a clip.
export const QuizDuJour: React.FC<QuizVideoProps> = quiz => {
    const t = quizTranslations[quiz.language];
    const { fps, narration } = quiz;
    const durations = resolveSceneDurations(quiz);
    const texts = narration ? buildQuizNarration(quiz) : null;

    const mediaFor = (audio: QuizSceneAudio | null | undefined, text: string | null, seconds: number): SceneMediaProps | undefined =>
        narration ? { audio: audio ?? null, text, volume: narration.volume, durationInFrames: framesFor(seconds, fps) } : undefined;

    return (
        <>
            {quiz.backgroundMusic ? <Audio src={staticFile(quiz.backgroundMusic.fileName)} volume={quiz.backgroundMusic.volume} loop /> : null}
            <Series>
                <Series.Sequence durationInFrames={framesFor(durations.introSeconds, fps)}>
                    <Intro brand={quiz.brand} t={t} media={mediaFor(narration?.scenes.intro, texts?.intro ?? null, durations.introSeconds)} />
                </Series.Sequence>
                <Series.Sequence durationInFrames={framesFor(durations.questionSeconds, fps)}>
                    <QuestionScene props={quiz} media={mediaFor(narration?.scenes.question, texts?.question ?? null, durations.questionSeconds)} />
                </Series.Sequence>
                <Series.Sequence durationInFrames={framesFor(durations.countdownSeconds, fps)}>
                    <Countdown props={quiz} t={t} totalSeconds={quiz.durations.countdownSeconds}
                        media={mediaFor(narration?.scenes.countdown, texts?.countdown ?? null, durations.countdownSeconds)} />
                </Series.Sequence>
                <Series.Sequence durationInFrames={framesFor(durations.revealSeconds, fps)}>
                    <Reveal props={quiz} t={t} media={mediaFor(narration?.scenes.reveal, texts?.reveal ?? null, durations.revealSeconds)} />
                </Series.Sequence>
                {quiz.explanation && durations.explanationSeconds > 0 ? (
                    <Series.Sequence durationInFrames={framesFor(durations.explanationSeconds, fps)}>
                        {/* The explanation is already fully on screen; narrate it, but skip a redundant caption. */}
                        <Explanation text={quiz.explanation} t={t} media={mediaFor(narration?.scenes.explanation, null, durations.explanationSeconds)} />
                    </Series.Sequence>
                ) : null}
                <Series.Sequence durationInFrames={framesFor(durations.outroSeconds, fps)}>
                    <Outro brand={quiz.brand} t={t} media={mediaFor(narration?.scenes.outro, texts?.outro ?? null, durations.outroSeconds)} />
                </Series.Sequence>
            </Series>
        </>
    );
};
