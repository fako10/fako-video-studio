import React from 'react';
import { useCurrentFrame } from 'remotion';
import { theme, fonts } from './theme.js';

function splitSentences(text: string): string[] {
    const parts = text.match(/[^.!?]+[.!?]*/g) ?? [text];
    return parts.map(part => part.trim()).filter(Boolean);
}

// Scene-level synchronization: we only know each clip's total measured duration, not word-level
// timestamps, so sentences share that duration proportionally to their length. This is an honest
// approximation, not invented precision — see docs/rijpermis-narration.md.
export const Subtitles: React.FC<{ text: string; durationInFrames: number }> = ({ text, durationInFrames }) => {
    const frame = useCurrentFrame();
    const sentences = splitSentences(text);
    const totalChars = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;

    let cursor = 0;
    let active = sentences[sentences.length - 1] ?? text;
    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        const frames = Math.round((sentence.length / totalChars) * durationInFrames);
        if (i === sentences.length - 1 || frame < cursor + frames) { active = sentence; break; }
        cursor += frames;
    }

    return (
        <div style={{ position: 'absolute', left: 56, right: 56, bottom: 72, display: 'flex', justifyContent: 'center' }}>
            <span style={{
                fontFamily: fonts.body, fontWeight: 700, fontSize: 30, lineHeight: 1.3, color: theme.ink, textAlign: 'center',
                background: 'rgba(7, 12, 18, 0.6)', borderRadius: 14, padding: '10px 22px', maxWidth: '100%'
            }}>{active}</span>
        </div>
    );
};
