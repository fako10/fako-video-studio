import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

// Copies an already-downloaded, already-verified local image (see @fako/content-sources'
// LocalMediaStorage from mission 7) into the Remotion project's public/ folder, under a
// content-derived name. Never fetches anything over the network; never accepts a remote URL.
export async function stageImage(sourcePath: string, publicDir: string): Promise<string> {
    const extension = extname(sourcePath).slice(1).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`Unsupported image extension for staging: ${extension || '(none)'}`);
    const bytes = await readFile(sourcePath);
    const fileName = `rijpermis-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${extension}`;
    await mkdir(publicDir, { recursive: true });
    await copyFile(sourcePath, join(publicDir, fileName));
    return fileName;
}
