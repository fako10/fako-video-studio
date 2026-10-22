import React, { type CSSProperties } from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

// A single, calm entrance used everywhere: a short rise with a spring, never a bounce or a flashy
// swoop. Keeping it uniform across scenes is what reads as "designed" instead of "animated".
export function useEnter(delayFrames = 0): CSSProperties {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const local = Math.max(0, frame - delayFrames);
    const progress = spring({ frame: local, fps, config: { damping: 200, mass: 0.6 } });
    const opacity = interpolate(progress, [0, 1], [0, 1]);
    const translateY = interpolate(progress, [0, 1], [18, 0]);
    return { opacity, transform: `translateY(${translateY}px)` };
}

export function useFade(fromFrame: number, durationFrames = 15): CSSProperties {
    const frame = useCurrentFrame();
    const opacity = interpolate(frame, [fromFrame, fromFrame + durationFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return { opacity };
}

export const Stagger: React.FC<{ index: number; baseDelay?: number; step?: number; children: React.ReactNode; style?: CSSProperties }> = ({ index, baseDelay = 0, step = 5, children, style }) => {
    const enter = useEnter(baseDelay + index * step);
    return <div style={{ ...enter, ...style }}>{children}</div>;
};
