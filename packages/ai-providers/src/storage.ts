import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
export interface AudioStorage {
    write(key: string, bytes: Buffer): Promise<void>;
    read(key: string): Promise<Buffer>;
}
export class LocalAudioStorage implements AudioStorage {
    private readonly root: string;
    constructor(root: string) { this.root = resolve(root); }
    private async path(key: string) {
        if (!/^[0-9a-f-]{36}\.(mp3|wav)$/.test(key)) throw new Error('Invalid audio key');
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        if ((await lstat(this.root)).isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error('Audio root must be a canonical directory');
        return join(this.root, key);
    }
    async write(key: string, bytes: Buffer) {
        const file = await open(await this.path(key), 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    }
    async read(key: string) {
        const path = await this.path(key);
        if (!(await lstat(path)).isFile()) throw new Error('Invalid audio file');
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { return await file.readFile(); } finally { await file.close(); }
    }
}
