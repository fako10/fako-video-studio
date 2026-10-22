import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Content-addressed: staging the same bytes twice (e.g. the same cached narration reused across
// scenes or renders) is a harmless no-op overwrite rather than a duplicate file.
export async function stageAudio(bytes: Buffer, extension: 'mp3' | 'wav', publicDir: string): Promise<string> {
    const fileName = `narration-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${extension}`;
    await mkdir(publicDir, { recursive: true });
    await writeFile(join(publicDir, fileName), bytes);
    return fileName;
}
