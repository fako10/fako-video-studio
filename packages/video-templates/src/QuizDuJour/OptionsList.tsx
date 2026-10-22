import React from 'react';
import type { QuizVideoOption } from '../schema.js';
import { theme, fonts } from './theme.js';
import { Stagger } from './motion.js';

export const OptionsList: React.FC<{
    options: QuizVideoOption[]; correctOptionId: string; reveal: boolean; staggerBase?: number;
}> = ({ options, correctOptionId, reveal, staggerBase = 0 }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 44 }}>
        {options.map((option, index) => {
            const isCorrect = option.id === correctOptionId;
            const dim = reveal && !isCorrect;
            return (
                <Stagger index={index} baseDelay={staggerBase} key={option.id} style={{
                    display: 'flex', alignItems: 'center', gap: 24,
                    background: reveal && isCorrect ? theme.goodTint : theme.surface,
                    border: `2px solid ${reveal && isCorrect ? theme.good : theme.line}`,
                    borderRadius: 24, padding: '28px 32px', opacity: dim ? 0.45 : 1
                }}>
                    <span style={{
                        fontFamily: fonts.display, fontWeight: 800, fontSize: 40, lineHeight: 1,
                        width: 64, height: 64, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: reveal && isCorrect ? theme.good : theme.surfaceStrong,
                        color: reveal && isCorrect ? theme.accentInk : theme.ink, flexShrink: 0
                    }}>
                        {reveal && isCorrect ? '✓' : option.id}
                    </span>
                    <span style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 36, lineHeight: 1.25, color: theme.ink }}>
                        {option.text}
                    </span>
                </Stagger>
            );
        })}
    </div>
);
