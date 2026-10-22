// Mission 15 section 7 — video retention. Dry-run by default: prints what WOULD be deleted and
// deletes nothing unless --confirm is passed explicitly. A QuizVideo's rendered file is only ever
// eligible once it is both old enough (QUIZ_VIDEO_RETENTION_DAYS, default 90) AND nothing active or
// unresolved still references it: no SocialPublication row in DRAFT/SCHEDULED/READY/PUBLISHING (still
// might need it) or OUTCOME_UNKNOWN (a human may still need to inspect it to resolve the ambiguity).
// The database row itself is never touched — only the underlying file is removed, via
// VideoStorage.delete() (packages/media-engine/src/storage.ts), which reuses the same strict key
// validation as every other storage access in this repo. A missing file is already handled gracefully
// everywhere it's read (404, not a crash — see apps/api/src/routes/quiz-videos.ts).
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { LocalVideoStorage } from '@fako/media-engine';

const confirm = process.argv.includes('--confirm');
const retentionDays = Number(process.env.QUIZ_VIDEO_RETENTION_DAYS ?? 90);
if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new Error('QUIZ_VIDEO_RETENTION_DAYS must be a positive integer');
const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

const storage = new LocalVideoStorage(process.env.QUIZ_VIDEO_STORAGE_ROOT || resolve(import.meta.dirname, '../../../storage/quiz-videos'));
const prisma = new PrismaClient();
const ACTIVE_OR_UNRESOLVED = ['DRAFT', 'SCHEDULED', 'READY', 'PUBLISHING', 'OUTCOME_UNKNOWN'] as const;

let eligible = 0, deleted = 0, failed = 0;
try {
    const candidates = await prisma.quizVideo.findMany({
        where: {
            fileKey: { not: null }, createdAt: { lt: cutoff },
            socialPublications: { none: { status: { in: [...ACTIVE_OR_UNRESOLVED] } } }
        },
        select: { id: true, fileKey: true, createdAt: true }
    });

    for (const video of candidates) {
        eligible++;
        console.log(`${confirm ? 'deleting' : 'would delete'}: QuizVideo ${video.id} (fileKey=${video.fileKey}, created ${video.createdAt.toISOString()})`);
        if (!confirm) continue;
        try {
            await storage.delete(video.fileKey!);
            deleted++;
        } catch (error) {
            failed++;
            console.error(`failed to delete file for QuizVideo ${video.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (!confirm) {
        console.log(`Dry run: ${eligible} file(s) eligible for deletion (older than ${retentionDays} days, no active/unresolved publication). Re-run with --confirm to actually delete.`);
    } else {
        console.log(`Done. eligible=${eligible} deleted=${deleted} failed=${failed}`);
        if (failed > 0) process.exitCode = 1;
    }
} finally { await prisma.$disconnect(); }
