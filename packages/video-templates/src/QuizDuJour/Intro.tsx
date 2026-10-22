import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { QuizVideoProps } from '../schema.js';
import type { QuizTranslations } from '../translations.js';
import { Background } from './Background.js';
import { theme, fonts } from './theme.js';
import { useEnter } from './motion.js';
import { SceneMedia, type SceneMediaProps } from './SceneMedia.js';

export const Intro: React.FC<{ brand: QuizVideoProps['brand']; t: QuizTranslations; media?: SceneMediaProps }> = ({ brand, t, media }) => {
    const enter = useEnter(0);
    return (
        <Background>
            {media ? <SceneMedia {...media} /> : null}
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 20 }}>
                <div style={{ ...enter, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
                    <span style={{
                        fontFamily: fonts.body, fontWeight: 700, fontSize: 28, letterSpacing: 4, textTransform: 'uppercase', color: theme.accent
                    }}>{brand.name}</span>
                    <span style={{
                        fontFamily: fonts.display, fontWeight: 800, fontSize: 76, lineHeight: 1.05, color: theme.ink, textAlign: 'center'
                    }}>{t.brandLine}</span>
                </div>
            </AbsoluteFill>
        </Background>
    );
};
