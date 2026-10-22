import React from 'react';
import type { QuizVideoProps } from '../schema.js';
import type { QuizTranslations } from '../translations.js';
import { QuestionScene } from './QuestionScene.js';
import { theme, fonts } from './theme.js';
import { useEnter } from './motion.js';
import type { SceneMediaProps } from './SceneMedia.js';

const RevealBadge: React.FC<{ label: string }> = ({ label }) => {
    const enter = useEnter(0);
    return (
        <div style={{
            ...enter, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 12,
            background: theme.good, color: theme.accentInk, borderRadius: 999, padding: '12px 24px', marginBottom: 24
        }}>
            <span style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 26 }}>✓</span>
            <span style={{ fontFamily: fonts.body, fontWeight: 700, fontSize: 24, letterSpacing: 0.5 }}>{label}</span>
        </div>
    );
};

export const Reveal: React.FC<{ props: QuizVideoProps; t: QuizTranslations; media?: SceneMediaProps }> = ({ props, t, media }) => (
    <QuestionScene props={props} reveal banner={<RevealBadge label={t.revealCorrectLabel} />} media={media} />
);
