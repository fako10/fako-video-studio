import React from 'react';
import { AbsoluteFill } from 'remotion';
import { theme } from './theme.js';

export const Background: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <AbsoluteFill style={{
        background: `radial-gradient(130% 90% at 50% 0%, ${theme.bg} 0%, ${theme.bgDeep} 100%)`,
        fontFamily: 'inherit'
    }}>
        <AbsoluteFill style={{ padding: '96px 72px', display: 'flex', flexDirection: 'column' }}>
            {children}
        </AbsoluteFill>
    </AbsoluteFill>
);
