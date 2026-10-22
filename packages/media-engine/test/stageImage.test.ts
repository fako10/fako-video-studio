import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageImage } from '../src/stageImage.js';

test('stages a local image into the public directory under a content-derived name', async () => {
    const src = await mkdtemp(join(tmpdir(), 'fako-media-src-'));
    const publicDir = await mkdtemp(join(tmpdir(), 'fako-media-public-'));
    try {
        const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
        const sourcePath = join(src, '917000.jpg');
        await writeFile(sourcePath, bytes);
        const fileName = await stageImage(sourcePath, publicDir);
        assert.match(fileName, /^rijpermis-[0-9a-f]{24}\.jpg$/);
        assert.deepEqual(await readFile(join(publicDir, fileName)), bytes);
        assert.ok(fileName.includes(createHash('sha256').update(bytes).digest('hex').slice(0, 24)));
    } finally {
        await rm(src, { recursive: true, force: true });
        await rm(publicDir, { recursive: true, force: true });
    }
});

test('refuses to stage a file with an unsupported extension', async () => {
    const src = await mkdtemp(join(tmpdir(), 'fako-media-src-'));
    const publicDir = join(src, 'public');
    try {
        const sourcePath = join(src, 'notes.txt');
        await writeFile(sourcePath, 'hello');
        await assert.rejects(stageImage(sourcePath, publicDir), /Unsupported image extension/);
    } finally {
        await rm(src, { recursive: true, force: true });
    }
});
