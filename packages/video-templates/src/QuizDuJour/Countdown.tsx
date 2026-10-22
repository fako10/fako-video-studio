import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import type { QuizVideoProps } from '../schema.js';
import type { QuizTranslations } from '../translations.js';
import { Background } from './Background.js';
import { theme, fonts } from './theme.js';
import { SceneMedia, type SceneMediaProps } from './SceneMedia.js';

export const Countdown: React.FC<{ props: QuizVideoProps; t: QuizTranslations; totalSeconds: number; media?: SceneMediaProps }> = ({ props, t, totalSeconds, media }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const remaining = Math.max(1, totalSeconds - Math.floor(frame / fps));
    const tickProgress = (frame % fps) / fps;

    return (
        <Background>
            {media ? <SceneMedia {...media} /> : null}
            <span style={{ fontFamily: fonts.body, fontWeight: 700, fontSize: 24, letterSpacing: 3, textTransform: 'uppercase', color: theme.accent }}>
                {props.source.category}
            </span>
            <span style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 36, lineHeight: 1.25, color: theme.inkSoft, marginTop: 20 }}>
                {props.question}
            </span>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
                <div style={{
                    width: 280, height: 280, borderRadius: '50%', position: 'relative',
                    border: `10px solid ${theme.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <div style={{
                        position: 'absolute', inset: -10, borderRadius: '50%',
                        background: `conic-gradient(${theme.accent} ${tickProgress * 360}deg, transparent 0deg)`,
                        WebkitMaskImage: 'radial-gradient(farthest-side, transparent calc(100% - 10px), black calc(100% - 10px))',
                        maskImage: 'radial-gradient(farthest-side, transparent calc(100% - 10px), black calc(100% - 10px))'
                    }} />
                    <span style={{ fontFamily: fonts.mono, fontWeight: 700, fontSize: 128, color: theme.ink, fontVariantNumeric: 'tabular-nums' }}>
                        {remaining}
                    </span>
                </div>
                <span style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 30, letterSpacing: 1, color: theme.muted }}>
                    {t.countdownLabel}
                </span>
            </div>
        </Background>
    );
};
