import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageAudio } from '../src/stageAudio.js';

test('stages narration bytes into the public directory under a content-derived name', async () => {
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-audio-public-'));
    try {
        const bytes = Buffer.from('fake mp3 bytes');
        const fileName = await stageAudio(bytes, 'mp3', publicDir);
        assert.match(fileName, /^narration-[0-9a-f]{24}\.mp3$/);
        assert.deepEqual(await readFile(join(publicDir, fileName)), bytes);
    } finally { await rm(publicDir, { recursive: true, force: true }); }
});

test('staging identical bytes twice is an idempotent no-op, not a duplicate file', async () => {
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-audio-public-'));
    try {
        const bytes = Buffer.from('same content');
        const first = await stageAudio(bytes, 'wav', publicDir);
        const second = await stageAudio(bytes, 'wav', publicDir);
        assert.equal(first, second);
    } finally { await rm(publicDir, { recursive: true, force: true }); }
});
