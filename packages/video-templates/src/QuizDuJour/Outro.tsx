import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { QuizVideoProps } from '../schema.js';
import type { QuizTranslations } from '../translations.js';
import { Background } from './Background.js';
import { theme, fonts } from './theme.js';
import { useEnter } from './motion.js';
import { SceneMedia, type SceneMediaProps } from './SceneMedia.js';

export const Outro: React.FC<{ brand: QuizVideoProps['brand']; t: QuizTranslations; media?: SceneMediaProps }> = ({ brand, t, media }) => {
    const enter = useEnter(0);
    return (
        <Background>
            {media ? <SceneMedia {...media} /> : null}
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 24 }}>
                <div style={{ ...enter, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
                    <span style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 52, color: theme.ink, textAlign: 'center' }}>
                        {t.outroHeadline}
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 28, color: theme.inkSoft }}>{t.outroCta}</span>
                        <span style={{
                            fontFamily: fonts.display, fontWeight: 800, fontSize: 44, color: theme.accentInk,
                            background: theme.accent, borderRadius: 16, padding: '14px 32px'
                        }}>{brand.website}</span>
                    </div>
                </div>
            </AbsoluteFill>
        </Background>
    );
};
