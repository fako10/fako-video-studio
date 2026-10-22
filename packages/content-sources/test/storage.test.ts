import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalMediaStorage } from '../src/storage.js';
import { jpegBytes } from './helpers.js';

test('writes an image under a generated key and returns its sha256 hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fako-media-'));
    try {
        const storage = new LocalMediaStorage(root);
        const { key, hash } = await storage.writeImage(jpegBytes, 'jpg');
        assert.match(key, /^[0-9a-f-]{36}\.jpg$/);
        assert.equal(hash, createHash('sha256').update(jpegBytes).digest('hex'));
        assert.deepEqual(await readFile(join(root, key)), jpegBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects an extension outside the allowed image types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fako-media-'));
    try {
        await assert.rejects(new LocalMediaStorage(root).writeImage(jpegBytes, 'gif' as 'jpg'));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses to write through a symlinked media root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fako-media-'));
    const real = join(base, 'real');
    const link = join(base, 'link');
    try {
        await symlink(real, link, 'junction');
        await assert.rejects(new LocalMediaStorage(link).writeImage(jpegBytes, 'jpg'));
    } finally { await rm(base, { recursive: true, force: true }); }
});
