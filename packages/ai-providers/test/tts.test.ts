import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { ElevenLabsProvider, MockTTSProvider, TTSError } from '../src/tts.js';
import { LocalAudioStorage } from '../src/storage.js';
const input = { text: 'Bonjour', language: 'fr', voiceId: 'test-voice', model: 'eleven_multilingual_v2', settings: { stability: 0.5 } };
test('Mock produces a valid WAV with a measured duration, without network', async () => {
    const provider = new MockTTSProvider();
    const result = await provider.synthesize(input);
    assert.equal((await parseBuffer(result.bytes, { mimeType: result.mimeType })).format.duration, 1);
    assert.equal(provider.calls, 1);
});
test('ElevenLabs transport sends server credentials and validated voice configuration', async () => {
    const fake = await new MockTTSProvider().synthesize(input);
    const provider = new ElevenLabsProvider('test-only', async (url, options) => {
        assert.match(String(url), /test-voice\?output_format=mp3_44100_128/);
        assert.equal((options!.headers as Record<string, string>)['xi-api-key'], 'test-only');
        assert.equal(JSON.parse(String(options!.body)).voice_settings.stability, 0.5);
        assert.equal(JSON.parse(String(options!.body)).language_code, undefined);
        return new Response(fake.bytes, { headers: { 'content-type': 'audio/mpeg', 'character-cost': '7', 'request-id': 'fake' } });
    });
    assert.deepEqual((await provider.synthesize(input)).usage, { characters: 7, requestId: 'fake' });
});
test('Only definite rate limits retry; errors never expose response body or secret', async () => {
    for (const status of [429, 401, 500]) {
        const provider = new ElevenLabsProvider('secret', async () => new Response('private upstream details', { status }));
        await assert.rejects(provider.synthesize(input), (error: unknown) => error instanceof TTSError && error.retryable === (status === 429) && error.message === `TTS_HTTP_${status}`);
    }
    await assert.rejects(new ElevenLabsProvider('secret', async () => { throw new Error('secret'); }).synthesize(input), /TTS_OUTCOME_UNKNOWN/);
});
test('Local storage rejects traversal, symlinks and overwrite, preserving existing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fako-storage-test-'));
    const storage = new LocalAudioStorage(root);
    const key = `${randomUUID()}.wav`;
    await storage.write(key, Buffer.from('test'));
    assert.equal((await storage.read(key)).toString(), 'test');
    await assert.rejects(storage.write(key, Buffer.from('overwrite')));
    await assert.rejects(storage.read('../secret.wav'));
    await assert.rejects(storage.write('/tmp/file.wav', Buffer.alloc(0)));
    assert.equal((await storage.read(key)).toString(), 'test');
    // Junction creation works on Windows without Developer Mode.
    const link = join(await mkdtemp(join(tmpdir(), 'fako-link-test-')), 'audio');
    await symlink(root, link, 'junction');
    await assert.rejects(new LocalAudioStorage(link).read(key));
});
