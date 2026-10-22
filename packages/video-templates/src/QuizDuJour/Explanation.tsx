import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { QuizTranslations } from '../translations.js';
import { Background } from './Background.js';
import { theme, fonts } from './theme.js';
import { useEnter } from './motion.js';
import { SceneMedia, type SceneMediaProps } from './SceneMedia.js';

// Rendered only when props.explanation is non-null (see build.ts): a reused, already-approved
// RijPermis explanation, never authored here and never labeled as anything other than what it is.
export const Explanation: React.FC<{ text: string; t: QuizTranslations; media?: SceneMediaProps }> = ({ text, t, media }) => {
    const enter = useEnter(0);
    return (
        <Background>
            {media ? <SceneMedia {...media} /> : null}
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 24px' }}>
                <div style={{ ...enter, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 880 }}>
                    <span style={{ fontFamily: fonts.body, fontWeight: 700, fontSize: 24, letterSpacing: 3, textTransform: 'uppercase', color: theme.accent, textAlign: 'center' }}>
                        {t.explanationLabel}
                    </span>
                    <span style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 40, lineHeight: 1.35, color: theme.ink, textAlign: 'center' }}>
                        {text}
                    </span>
                </div>
            </AbsoluteFill>
        </Background>
    );
};
