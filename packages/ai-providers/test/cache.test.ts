import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingTTSProvider, LocalAudioCacheStore, ttsCacheKey } from '../src/cache.js';
import { MockTTSProvider, type TTSInput } from '../src/tts.js';

const input: TTSInput = { text: 'Bonjour.', language: 'fr', voiceId: 'voice-1', model: 'eleven_multilingual_v2', settings: { stability: 0.5 } };

test('identical text, voice, model and settings reuse the cached audio instead of calling the provider again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fako-tts-cache-'));
    try {
        const mock = new MockTTSProvider();
        const provider = new CachingTTSProvider(mock, new LocalAudioCacheStore(dir));
        const first = await provider.synthesize(input);
        const second = await provider.synthesize(input);
        assert.equal(mock.calls, 1);
        assert.deepEqual(second.bytes, first.bytes);
        assert.equal(second.usage?.cacheHit, true);
        assert.equal(first.usage?.cacheHit, undefined);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a different text, voice, model or setting is a cache miss and calls the provider again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fako-tts-cache-'));
    try {
        const mock = new MockTTSProvider();
        const provider = new CachingTTSProvider(mock, new LocalAudioCacheStore(dir));
        await provider.synthesize(input);
        await provider.synthesize({ ...input, text: 'Au revoir.' });
        await provider.synthesize({ ...input, voiceId: 'voice-2' });
        await provider.synthesize({ ...input, model: 'eleven_flash_v2_5' });
        await provider.synthesize({ ...input, settings: { stability: 0.9 } });
        assert.equal(mock.calls, 5);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the cache key ignores key order in settings but not their values', () => {
    const a = ttsCacheKey(input);
    const b = ttsCacheKey({ ...input, settings: { stability: 0.5 } });
    const c = ttsCacheKey({ ...input, settings: { stability: 0.6 } });
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test('persists across cache store instances pointed at the same directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fako-tts-cache-'));
    try {
        const mock = new MockTTSProvider();
        await new CachingTTSProvider(mock, new LocalAudioCacheStore(dir)).synthesize(input);
        await new CachingTTSProvider(mock, new LocalAudioCacheStore(dir)).synthesize(input);
        assert.equal(mock.calls, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
