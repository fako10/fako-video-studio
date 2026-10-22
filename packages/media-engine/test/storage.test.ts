import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalVideoStorage } from '../src/storage.js';

test('writes and reads back an MP4 under a UUID key, refusing to overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fako-video-storage-'));
    try {
        const storage = new LocalVideoStorage(root);
        const key = `${randomUUID()}.mp4`;
        const bytes = Buffer.from('fake mp4 bytes');
        await storage.write(key, bytes);
        assert.deepEqual(await storage.read(key), bytes);
        await assert.rejects(storage.write(key, Buffer.from('different')));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a key that is not a UUID.mp4', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fako-video-storage-'));
    try {
        const storage = new LocalVideoStorage(root);
        await assert.rejects(storage.write('../escape.mp4', Buffer.from('x')));
        await assert.rejects(storage.read('not-a-uuid.mp4'));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses a symlinked storage root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fako-video-storage-'));
    const link = join(base, 'link');
    try {
        await symlink(join(base, 'real'), link, 'junction');
        await assert.rejects(new LocalVideoStorage(link).write(`${randomUUID()}.mp4`, Buffer.from('x')));
    } finally { await rm(base, { recursive: true, force: true }); }
});
