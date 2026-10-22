import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingTTSProvider, LocalAudioCacheStore } from '../src/cache.js';
import { MeteringTTSProvider } from '../src/metering.js';
import { MockTTSProvider, type TTSInput, type TTSOutput, type TTSProvider } from '../src/tts.js';

const input: TTSInput = { text: 'Bonjour.', language: 'fr', voiceId: 'v', model: 'eleven_multilingual_v2', settings: {} };

test('accumulates character usage and call count across several syntheses', async () => {
    const fakeWithCharacters: TTSProvider = {
        name: 'fake', synthesize: async (i): Promise<TTSOutput> => ({ bytes: Buffer.from('x'), mimeType: 'audio/mpeg', extension: 'mp3', usage: { characters: i.text.length } })
    };
    const metering = new MeteringTTSProvider(fakeWithCharacters);
    await metering.synthesize(input);
    await metering.synthesize({ ...input, text: 'Au revoir.' });
    assert.equal(metering.usage.calls, 2);
    assert.equal(metering.usage.characters, 'Bonjour.'.length + 'Au revoir.'.length);
    assert.equal(metering.usage.cacheHits, 0);
});

test('reports characters as null, not zero, when the inner provider never reports any', async () => {
    const metering = new MeteringTTSProvider(new MockTTSProvider());
    await metering.synthesize(input);
    assert.equal(metering.usage.characters, null);
    assert.equal(metering.usage.calls, 1);
});

test('counts cache hits when stacked on top of a CachingTTSProvider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fako-metering-cache-'));
    try {
        const mock = new MockTTSProvider();
        const metering = new MeteringTTSProvider(new CachingTTSProvider(mock, new LocalAudioCacheStore(dir)));
        await metering.synthesize(input);
        await metering.synthesize(input);
        assert.equal(mock.calls, 1);
        assert.equal(metering.usage.calls, 2);
        assert.equal(metering.usage.cacheHits, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
