import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingTTSProvider, LocalAudioCacheStore, MockTTSProvider } from '@fako/ai-providers';
import { buildQuizVideoProps } from '@fako/video-templates';
import { NarrationError, synthesizeQuizNarration, type VoicesByLanguage } from '../src/narrate.js';

const question = (overrides: Record<string, unknown> = {}) => ({
    id: '6337', externalCode: 'N-1', language: 'fr', category: 'Priorité', question: 'Qui a la priorité ?',
    answerType: 'SINGLE_CHOICE' as const, options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }, { id: 'C', text: 'C' }],
    correctOptionIds: ['B'], explanation: { text: 'Explication validée.', status: 'APPROVED' as const }, image: null,
    regulatoryReferences: [], validationStatus: 'APPROVED' as const, contentHash: `sha256:${'1'.repeat(64)}`, ...overrides
});

const voices: VoicesByLanguage = {
    fr: { voiceId: 'voice-fr', model: 'eleven_multilingual_v2' },
    nl: { voiceId: 'voice-nl', model: 'eleven_multilingual_v2' }
};

test('synthesizes all six scenes for a question with an approved explanation', async () => {
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-public-'));
    try {
        const mock = new MockTTSProvider();
        const quiz = buildQuizVideoProps(question());
        const narration = await synthesizeQuizNarration(quiz, mock, voices, publicDir);
        for (const scene of ['intro', 'question', 'countdown', 'reveal', 'explanation', 'outro'] as const) {
            assert.ok(narration.scenes[scene], `expected ${scene} to have narration`);
            assert.ok(narration.scenes[scene]!.durationSeconds > 0);
        }
        // MockTTSProvider always returns byte-identical audio regardless of text, so content-addressed
        // staging correctly collapses all six clips to a single file; the provider is still called six times.
        assert.equal((await readdir(publicDir)).length, 1);
        assert.equal(mock.calls, 6);
    } finally { await rm(publicDir, { recursive: true, force: true }); }
});

test('skips the explanation scene entirely when the question has none', async () => {
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-public-'));
    try {
        const mock = new MockTTSProvider();
        const quiz = buildQuizVideoProps(question({ explanation: null }));
        const narration = await synthesizeQuizNarration(quiz, mock, voices, publicDir);
        assert.equal(narration.scenes.explanation, null);
        assert.equal(mock.calls, 5);
    } finally { await rm(publicDir, { recursive: true, force: true }); }
});

test('works for a Dutch question using the Dutch voice', async () => {
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-public-'));
    try {
        const mock = new MockTTSProvider();
        const quiz = buildQuizVideoProps(question({ language: 'nl', explanation: null }));
        const narration = await synthesizeQuizNarration(quiz, mock, voices, publicDir);
        assert.ok(narration.scenes.intro);
        assert.equal(mock.calls, 5);
    } finally { await rm(publicDir, { recursive: true, force: true }); }
});

test('refuses to synthesize when no voice is configured for the question language', async () => {
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-public-'));
    try {
        const quiz = buildQuizVideoProps(question({ language: 'nl' }));
        await assert.rejects(synthesizeQuizNarration(quiz, new MockTTSProvider(), { fr: voices.fr } as VoicesByLanguage, publicDir),
            (e: unknown) => e instanceof NarrationError && e.code === 'NO_VOICE_CONFIGURED_FOR_NL');
    } finally { await rm(publicDir, { recursive: true, force: true }); }
});

test('wrapped in a cache, re-synthesizing the same quiz does not call the provider again', async () => {
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-public-'));
    const cacheDir = await mkdtemp(join(tmpdir(), 'fako-tts-cache-'));
    try {
        const mock = new MockTTSProvider();
        const cached = new CachingTTSProvider(mock, new LocalAudioCacheStore(cacheDir));
        const quiz = buildQuizVideoProps(question());
        await synthesizeQuizNarration(quiz, cached, voices, publicDir);
        await synthesizeQuizNarration(quiz, cached, voices, publicDir);
        assert.equal(mock.calls, 6, 'the second pass should be served entirely from cache');
    } finally {
        await rm(publicDir, { recursive: true, force: true });
        await rm(cacheDir, { recursive: true, force: true });
    }
});
