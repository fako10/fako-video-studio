import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Mirrors @fako/ai-providers' LocalAudioStorage exactly: a canonical, access-controlled directory,
// exclusive-create writes (no overwrite), UUID-only keys. Rendered MP4s move here from a scratch
// path once renderQuizVideo finishes; nothing reads or writes an arbitrary filesystem path.
export interface VideoStorage {
    write(key: string, bytes: Buffer): Promise<void>;
    read(key: string): Promise<Buffer>;
    // Mission 15 section 7 (retention): deliberately NOT called by any request-serving route — only
    // by apps/api/prisma/prune-old-quiz-videos.ts, an explicit, operator-run, dry-run-by-default
    // script. Reuses the same key validation as read/write, so a retention script can never be the
    // path through which an arbitrary filesystem path gets deleted.
    delete(key: string): Promise<void>;
}

export class LocalVideoStorage implements VideoStorage {
    private readonly root: string;
    constructor(root: string) { this.root = resolve(root); }

    private async path(key: string) {
        if (!/^[0-9a-f-]{36}\.mp4$/.test(key)) throw new Error('Invalid video key');
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        if ((await lstat(this.root)).isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error('Video root must be a canonical directory');
        return join(this.root, key);
    }

    async write(key: string, bytes: Buffer) {
        const file = await open(await this.path(key), 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    }

    async read(key: string) {
        const path = await this.path(key);
        if (!(await lstat(path)).isFile()) throw new Error('Invalid video file');
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { return await file.readFile(); } finally { await file.close(); }
    }

    async delete(key: string) {
        const path = await this.path(key);
        if (!(await lstat(path)).isFile()) throw new Error('Invalid video file');
        await rm(path);
    }
}
