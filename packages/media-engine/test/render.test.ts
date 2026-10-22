import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getVideoMetadata } from '@remotion/renderer';
import { MockTTSProvider } from '@fako/ai-providers';
import { mockQuestion } from '@fako/content-sources';
import { attachNarration, buildQuizVideoProps, resolveSceneDurations, totalDurationInFrames } from '@fako/video-templates';
import { renderQuizVideo } from '../src/render.js';
import { synthesizeQuizNarration, type VoicesByLanguage } from '../src/narrate.js';

// Spins up a headless browser and encodes a real MP4 (downloads headless Chrome on first use).
// Opt in explicitly rather than on every `npm test`, per "render a demo MP4 if the environment allows".
const RUN = process.env.MEDIA_ENGINE_RENDER_TESTS === 'true';

test('renders a real demo MP4 at 1080x1920/30fps with the expected scene durations', { skip: !RUN && 'set MEDIA_ENGINE_RENDER_TESTS=true to run (downloads headless Chrome on first use)' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fako-render-'));
    try {
        const props = buildQuizVideoProps(mockQuestion);
        const { outputPath } = await renderQuizVideo(props, { outputPath: join(dir, 'demo.mp4') });
        const meta = await getVideoMetadata(outputPath);
        assert.equal(meta.width, 1080);
        assert.equal(meta.height, 1920);
        assert.equal(meta.fps, 30);
        assert.equal(meta.codec, 'h264');
        const expectedSeconds = totalDurationInFrames(props.durations, props.fps) / props.fps;
        assert.ok(Math.abs(meta.durationInSeconds - expectedSeconds) <= 1, `expected ~${expectedSeconds}s, got ${meta.durationInSeconds}s`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

const voices: VoicesByLanguage = {
    fr: { voiceId: 'mock-fr', model: 'eleven_multilingual_v2' },
    nl: { voiceId: 'mock-nl', model: 'eleven_multilingual_v2' }
};

test('renders a real narrated demo MP4 with mock audio, subtitles and extended scene durations', { skip: !RUN && 'set MEDIA_ENGINE_RENDER_TESTS=true to run (downloads headless Chrome on first use)' }, async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'fako-render-'));
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-public-'));
    try {
        const silent = buildQuizVideoProps(mockQuestion, { durations: { introSeconds: 1 } });
        const narration = await synthesizeQuizNarration(silent, new MockTTSProvider(), voices, publicDir);
        const narrated = attachNarration(silent, narration);
        const { outputPath } = await renderQuizVideo(narrated, { outputPath: join(outDir, 'narrated.mp4'), publicDir });
        const meta = await getVideoMetadata(outputPath);
        assert.equal(meta.width, 1080);
        assert.equal(meta.height, 1920);
        assert.equal(meta.fps, 30);
        const resolved = resolveSceneDurations(narrated);
        const expectedSeconds = totalDurationInFrames(resolved, narrated.fps) / narrated.fps;
        assert.ok(resolved.introSeconds > 1, 'a 1s configured intro should have grown to fit the narration clip');
        assert.ok(Math.abs(meta.durationInSeconds - expectedSeconds) <= 1, `expected ~${expectedSeconds}s, got ${meta.durationInSeconds}s`);
    } finally {
        await rm(outDir, { recursive: true, force: true });
        await rm(publicDir, { recursive: true, force: true });
    }
});
