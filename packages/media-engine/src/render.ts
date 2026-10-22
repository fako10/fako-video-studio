import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { QuizVideoProps } from '@fako/video-templates';

export type RenderQuizVideoOptions = { outputPath: string; entryPoint?: string; compositionId?: string; publicDir?: string; concurrency?: number | null };

// Mission 15 section 3: left unset, Remotion's own default uses every available CPU core for a single
// render — fine on a developer machine, but a real risk of starving the rest of the stack (API,
// PostgreSQL, Redis, the worker's other three queues) on a modest VPS. QUIZ_VIDEO_RENDER_CONCURRENCY
// governs this independently of QUIZ_VIDEO_WORKER_CONCURRENCY (how many videos render in *parallel*,
// at the BullMQ level) — this one bounds how many threads/tabs Remotion uses *within* a single render.
function defaultConcurrency(): number | null {
    const raw = process.env.QUIZ_VIDEO_RENDER_CONCURRENCY;
    if (raw === undefined || raw === '') return 1;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('QUIZ_VIDEO_RENDER_CONCURRENCY must be a positive integer');
    return value;
}

const defaultEntryPoint = resolve(import.meta.dirname, '../../video-templates/src/entry.ts');
export const defaultPublicDir = resolve(import.meta.dirname, '../../video-templates/public');

// Wraps Remotion's bundle + renderMedia into the one call this repo needs: given already-validated
// quiz props (see @fako/video-templates buildQuizVideoProps), produce a local, reproducible MP4.
// No network calls other than Remotion's own one-time headless browser setup.
export async function renderQuizVideo(quiz: QuizVideoProps, options: RenderQuizVideoOptions): Promise<{ outputPath: string }> {
    const entryPoint = options.entryPoint ?? defaultEntryPoint;
    const compositionId = options.compositionId ?? 'QuizDuJour';
    const outputPath = resolve(options.outputPath);

    // This repo writes explicit ".js" extensions on every relative import (NodeNext style), including
    // in the .tsx composition sources that webpack bundles here; teach it to also try .ts/.tsx.
    const serveUrl = await bundle({
        entryPoint,
        publicDir: options.publicDir ?? defaultPublicDir,
        webpackOverride: config => ({
            ...config,
            resolve: { ...config.resolve, extensionAlias: { ...config.resolve?.extensionAlias, '.js': ['.ts', '.tsx', '.js'] } }
        })
    });
    const composition = await selectComposition({ serveUrl, id: compositionId, inputProps: quiz });
    await mkdir(dirname(outputPath), { recursive: true });
    const concurrency = options.concurrency !== undefined ? options.concurrency : defaultConcurrency();
    await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: outputPath, inputProps: quiz, concurrency });

    return { outputPath };
}
