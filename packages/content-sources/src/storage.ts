import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
export interface MediaStorage {
    writeImage(bytes: Buffer, extension: 'jpg' | 'png' | 'webp'): Promise<{ key: string; hash: string }>;
}
export class LocalMediaStorage implements MediaStorage {
    private readonly root: string;
    constructor(root: string) { this.root = resolve(root); }
    async writeImage(bytes: Buffer, extension: 'jpg' | 'png' | 'webp') {
        if (!['jpg', 'png', 'webp'].includes(extension)) throw new Error('Invalid media extension');
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        if ((await lstat(this.root)).isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error('Media directory must be canonical');
        const key = `${randomUUID()}.${extension}`;
        const file = await open(join(this.root, key), 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        return { key, hash: createHash('sha256').update(bytes).digest('hex') };
    }
}
