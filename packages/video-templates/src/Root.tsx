import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { buildQuizVideoProps } from './build.js';
import { resolveSceneDurations, totalDurationInFrames, type QuizVideoProps } from './schema.js';
import { sampleQuestion } from './sampleQuestion.js';
import { QuizDuJour } from './QuizDuJour/index.js';

const defaultProps = buildQuizVideoProps(sampleQuestion);

const calculateMetadata: CalculateMetadataFunction<QuizVideoProps> = ({ props }) => ({
    durationInFrames: totalDurationInFrames(resolveSceneDurations(props), props.fps),
    fps: props.fps, width: props.width, height: props.height
});

export const RemotionRoot: React.FC = () => (
    <Composition
        id="QuizDuJour"
        component={QuizDuJour}
        durationInFrames={totalDurationInFrames(defaultProps.durations, defaultProps.fps)}
        fps={defaultProps.fps}
        width={defaultProps.width}
        height={defaultProps.height}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
    />
);
