// A night-driving palette: deep road-at-dusk navy, signal-amber for attention, go-green for the
// correct answer. Deliberately distinct from any document/report palette used elsewhere in this repo.
export const theme = {
    bg: '#0A1A2F',
    bgDeep: '#071221',
    ink: '#F4F7FA',
    inkSoft: '#AEC0D4',
    muted: '#6E8097',
    line: 'rgba(244, 247, 250, 0.14)',
    surface: 'rgba(244, 247, 250, 0.06)',
    surfaceStrong: 'rgba(244, 247, 250, 0.1)',
    accent: '#FFB224',
    accentInk: '#241502',
    good: '#2BC48A',
    goodTint: 'rgba(43, 196, 138, 0.16)'
} as const;

// System stacks only: the render must stay fully offline-reproducible, with no font fetched
// from a network CDN during rendering.
export const fonts = {
    display: '-apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    body: '-apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
} as const;
