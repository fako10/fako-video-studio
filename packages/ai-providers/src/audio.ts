import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { parseBuffer } from 'music-metadata';
import { TTSError, type TTSProvider, type VoiceSettings } from './tts.js';
import type { AudioStorage } from './storage.js';
export const audioQueueName = 'audio-production';
export class AudioRequestError extends Error {
    constructor(public readonly statusCode: number, message: string) { super(message); }
}
export async function requestAudio(prisma: PrismaClient, scriptId: string) {
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "VideoScript" WHERE id=${scriptId}::uuid FOR UPDATE`;
        const script = await tx.videoScript.findUnique({ where: { id: scriptId }, include: { videoJob: true } });
        if (!script) throw new AudioRequestError(404, 'Script not found');
        if (script.generationStatus !== 'GENERATED' || script.validationStatus !== 'APPROVED' || !script.reviewedAt || !script.reviewedBy || !script.narration?.trim() || script.videoJob.status === 'CANCELLED')
            throw new AudioRequestError(409, 'An explicitly approved, generated script is required');
        const previous = await tx.audioAsset.findUnique({ where: { videoScriptId: scriptId } });
        if (previous) return { asset: previous, created: false };
        if (script.narration.length > 10000) throw new AudioRequestError(409, 'Narration exceeds 10000 characters');
        const voice = await tx.projectVoice.findUnique({ where: { projectId_language: { projectId: script.videoJob.projectId, language: script.language } } });
        if (!voice) throw new AudioRequestError(409, 'Configure a voice for this project and language');
        const asset = await tx.audioAsset.create({ data: {
            videoScriptId: script.id, videoJobId: script.videoJobId, scriptVersion: script.version,
            provider: 'elevenlabs', language: script.language, voiceId: voice.voiceId, model: voice.model,
            voiceSettings: voice.settings as Prisma.InputJsonValue
        } });
        return { asset, created: true };
    });
}

export async function processAudio(prisma: PrismaClient, id: string, provider: TTSProvider, storage: AudioStorage, maxAttempts = 3) {
    // The advisory lock survives across committed state changes, and is released if the process dies.
    // try-lock avoids a duplicate worker blocking or invalidating an active generation.
    await prisma.$transaction(async lock => {
        const [result] = await lock.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) AS acquired`;
        if (!result.acquired) throw new Error('Audio generation already running');
        const asset = await prisma.audioAsset.findUnique({ where: { id }, include: { videoScript: true, videoJob: true } });
        if (!asset || ['READY', 'FAILED'].includes(asset.status)) return;
        if (asset.status === 'PROCESSING') {
            await prisma.audioAsset.update({ where: { id }, data: { status: 'FAILED', errorCode: 'TTS_OUTCOME_UNKNOWN' } });
            return;
        }
        const script = asset.videoScript;
        if (script.validationStatus !== 'APPROVED' || script.generationStatus !== 'GENERATED' || !script.reviewedAt || !script.reviewedBy || !script.narration || asset.videoJob.status === 'CANCELLED') {
            await prisma.audioAsset.update({ where: { id }, data: { status: 'FAILED', errorCode: 'SCRIPT_NOT_APPROVED' } });
            return;
        }
        await prisma.audioAsset.update({ where: { id }, data: { status: 'PROCESSING', attempts: { increment: 1 }, errorCode: null } });
        try {
            const output = await provider.synthesize({ text: script.narration, language: asset.language, voiceId: asset.voiceId, model: asset.model, settings: asset.voiceSettings as VoiceSettings });
            await prisma.audioAsset.update({ where: { id }, data: { metadata: { usage: output.usage ?? {}, bytes: output.bytes.length } as Prisma.InputJsonValue } });
            const metadata = await parseBuffer(output.bytes, { mimeType: output.mimeType }, { duration: true });
            const duration = metadata.format.duration;
            if (!duration || !Number.isFinite(duration) || duration <= 0) throw new TTSError('TTS_INVALID_DURATION');
            const key = `${randomUUID()}.${output.extension}`;
            await storage.write(key, output.bytes);
            await prisma.audioAsset.update({ where: { id }, data: { status: 'READY', fileKey: key, mimeType: output.mimeType,
                durationSeconds: duration, completedAt: new Date(), provider: provider.name,
                metadata: { usage: output.usage ?? {}, bytes: output.bytes.length } as Prisma.InputJsonValue } });
        } catch (error) {
            const retry = error instanceof TTSError && error.retryable && asset.attempts + 1 < maxAttempts;
            const code = error instanceof TTSError ? error.code : 'TTS_PROCESSING_FAILED';
            await prisma.audioAsset.update({ where: { id }, data: { status: retry ? 'PENDING' : 'FAILED', errorCode: code } });
            if (retry) throw new Error(code);
            throw new UnrecoverableError(code);
        }
    }, { timeout: 120000, maxWait: 5000 });
}

export async function dispatchAudio(prisma: PrismaClient, queue: {
    getJob(id: string): Promise<{ getState(): Promise<string> } | undefined>;
    add(name: string, data: { audioAssetId: string }, options: { jobId: string }): Promise<unknown>;
}) {
    let cursor: string | undefined;
    for (;;) {
        const rows = await prisma.audioAsset.findMany({ where: { status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { id: 'asc' }, take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
        for (const row of rows) {
            const job = await queue.getJob(row.id);
            const state = job && await job.getState();
            if (state === 'failed' || state === 'completed') {
                await prisma.audioAsset.updateMany({ where: { id: row.id, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'FAILED', errorCode: 'QUEUE_RECOVERY_EXHAUSTED' } });
            } else if (!job) await queue.add('narration', { audioAssetId: row.id }, { jobId: row.id });
        }
        if (rows.length < 100) return;
        cursor = rows.at(-1)!.id;
    }
}
