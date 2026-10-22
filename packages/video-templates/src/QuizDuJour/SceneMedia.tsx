import React from 'react';
import { Audio, staticFile } from 'remotion';
import type { QuizSceneAudio } from '../schema.js';
import { Subtitles } from './Subtitles.js';

export type SceneMediaProps = { audio: QuizSceneAudio | null; text: string | null; volume: number; durationInFrames: number };

// A no-op (renders nothing) whenever a scene has no narration — the silent, mission 8 behavior.
export const SceneMedia: React.FC<SceneMediaProps> = ({ audio, text, volume, durationInFrames }) => (
    <>
        {audio ? <Audio src={staticFile(audio.fileName)} volume={volume} /> : null}
        {text ? <Subtitles text={text} durationInFrames={durationInFrames} /> : null}
    </>
);
