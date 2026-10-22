import React from 'react';
import { Img, staticFile } from 'remotion';
import type { QuizVideoProps } from '../schema.js';
import { Background } from './Background.js';
import { OptionsList } from './OptionsList.js';
import { theme, fonts } from './theme.js';
import { useEnter } from './motion.js';
import { SceneMedia, type SceneMediaProps } from './SceneMedia.js';

export const QuestionScene: React.FC<{ props: QuizVideoProps; reveal?: boolean; banner?: React.ReactNode; media?: SceneMediaProps }> = ({ props, reveal = false, banner, media }) => {
    const enter = useEnter(0);
    return (
        <Background>
            {media ? <SceneMedia {...media} /> : null}
            <div style={{ ...enter, display: 'flex', flexDirection: 'column', flex: 1 }}>
                {banner}
                <span style={{ fontFamily: fonts.body, fontWeight: 700, fontSize: 24, letterSpacing: 3, textTransform: 'uppercase', color: theme.accent }}>
                    {props.source.category}
                </span>
                {props.imageFileName ? (
                    <div style={{ marginTop: 28, borderRadius: 28, overflow: 'hidden', border: `1px solid ${theme.line}`, maxHeight: 420 }}>
                        <Img src={staticFile(props.imageFileName)} style={{ width: '100%', display: 'block', objectFit: 'cover' }} />
                    </div>
                ) : null}
                <span style={{
                    fontFamily: fonts.display, fontWeight: 800, color: theme.ink, lineHeight: 1.18,
                    fontSize: props.imageFileName ? 44 : 56, marginTop: props.imageFileName ? 28 : 36
                }}>
                    {props.question}
                </span>
                <OptionsList options={props.options} correctOptionId={props.correctOptionId} reveal={reveal} staggerBase={8} />
            </div>
        </Background>
    );
};
