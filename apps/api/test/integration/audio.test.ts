import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { redisConnection } from '@fako/video-jobs';
import { audioQueueName, dispatchAudio, LocalAudioStorage, MockTTSProvider, processAudio, TTSError, type TTSProvider } from '@fako/ai-providers';
import { buildApp } from '../../src/app.js';

test('Audio approval, concurrent idempotency, BullMQ retries, persistence and protected preview', async () => {
    const prisma = new PrismaClient();
    const token = 'test-audio-token-123456789012345678901234';
    const headers = { authorization: `Bearer ${token}` };
    const storage = new LocalAudioStorage(await mkdtemp(join(tmpdir(), 'fako-audio-integration-')));
    const app = buildApp({ prisma, audioToken: token, audioGenerationEnabled: true, audioStorage: storage });
    const project = await prisma.project.create({ data: { name: 'Audio tests', languages: ['fr', 'nl'] } });
    const job = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Daily exam', language: 'fr', width: 1080, height: 1920, fps: 30, status: 'COMPLETED', scriptGenerationRequested: true } });
    const queue = new Queue<{ audioAssetId: string }>(audioQueueName, { connection: redisConnection(), defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 30 } } });
    let worker: Worker | undefined;
    let version = 0;
    const createScript = (approved = true) => prisma.videoScript.create({ data: { videoJobId: job.id, requestId: randomUUID(), version: ++version, language: 'fr', narration: 'Entraînez-vous ensemble.', editorialSnapshot: {}, generationStatus: 'GENERATED', validationStatus: approved ? 'APPROVED' : 'PENDING_APPROVAL', reviewedAt: approved ? new Date() : null, reviewedBy: approved ? 'Human' : null } });
    const request = (id: string) => app.inject({ method: 'POST', url: `/video-scripts/${id}/audio/generate`, headers, payload: {} });
    const mock = new MockTTSProvider();
    try {
        assert.equal((await request((await createScript(false)).id)).statusCode, 409);
        const first = await createScript();
        assert.equal((await request(first.id)).statusCode, 409);
        assert.equal((await app.inject({ method: 'PUT', url: `/projects/${project.id}/voices/fr`, headers, payload: { voiceId: 'testVoice', model: 'eleven_multilingual_v2', settings: { stability: 0.5 } } })).statusCode, 200);
        const responses = await Promise.all([request(first.id), request(first.id)]);
        assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 202]);
        const asset = responses[0].json();
        assert.equal(asset.id, responses[1].json().id);
        let attempts = 0;
        const provider: TTSProvider = { name: 'mock', synthesize: async input => { if (++attempts === 1) throw new TTSError('TTS_HTTP_429', true); return mock.synthesize(input); } };
        worker = new Worker(audioQueueName, item => processAudio(prisma, item.data.audioAssetId, provider, storage), { connection: redisConnection(), concurrency: 2 });
        await dispatchAudio(prisma, queue); await dispatchAudio(prisma, queue);
        let current = await prisma.audioAsset.findUniqueOrThrow({ where: { id: asset.id } });
        const deadline = Date.now() + 10000;
        while (current.status !== 'READY' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 40));
            current = await prisma.audioAsset.findUniqueOrThrow({ where: { id: asset.id } });
        }
        assert.equal(current.status, 'READY'); assert.equal(current.attempts, 2); assert.equal(mock.calls, 1);
        assert.equal(current.durationSeconds, 1); assert.equal(current.scriptVersion, first.version);
        await processAudio(prisma, asset.id, mock, storage); assert.equal(mock.calls, 1);
        assert.equal((await app.inject(`/audio-assets/${asset.id}/preview`)).statusCode, 401);
        const preview = await app.inject({ url: `/audio-assets/${asset.id}/preview`, headers });
        assert.equal(preview.statusCode, 200); assert.equal(preview.headers['cache-control'], 'private, no-store'); assert.equal(preview.rawPayload.subarray(0, 4).toString(), 'RIFF');
        const newer = (await request((await createScript()).id)).json();
        // Close polling worker so subsequent failure cases run deterministically.
        await worker.close(); worker = undefined;
        await processAudio(prisma, newer.id, mock, storage);
        const second = await prisma.audioAsset.findUniqueOrThrow({ where: { id: newer.id } });
        assert.notEqual(second.fileKey, current.fileKey);
        assert.equal((await storage.read(current.fileKey!)).subarray(0, 4).toString(), 'RIFF');
        const failure = (await request((await createScript()).id)).json();
        await assert.rejects(processAudio(prisma, failure.id, { name: 'mock', synthesize: async () => { throw new TTSError('TTS_HTTP_401'); } }, storage));
        assert.equal((await prisma.audioAsset.findUniqueOrThrow({ where: { id: failure.id } })).status, 'FAILED');
        const exhausted = (await request((await createScript()).id)).json();
        const limited: TTSProvider = { name: 'mock', synthesize: async () => { throw new TTSError('TTS_HTTP_429', true); } };
        for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(processAudio(prisma, exhausted.id, limited, storage));
        const terminal = await prisma.audioAsset.findUniqueOrThrow({ where: { id: exhausted.id } });
        assert.equal(terminal.status, 'FAILED'); assert.equal(terminal.attempts, 3);
        await processAudio(prisma, exhausted.id, limited, storage);
        assert.equal((await prisma.audioAsset.findUniqueOrThrow({ where: { id: exhausted.id } })).attempts, 3);
        const invalid = (await request((await createScript()).id)).json();
        await assert.rejects(processAudio(prisma, invalid.id, { name: 'mock', synthesize: async () => ({ bytes: Buffer.from('not audio'), mimeType: 'audio/mpeg', extension: 'mp3', usage: { characters: 9 } }) }, storage));
        const invalidAsset = await prisma.audioAsset.findUniqueOrThrow({ where: { id: invalid.id } });
        assert.equal(invalidAsset.status, 'FAILED');
        assert.deepEqual((invalidAsset.metadata as { usage: object }).usage, { characters: 9 });
        const uncertain = (await request((await createScript()).id)).json();
        await prisma.audioAsset.update({ where: { id: uncertain.id }, data: { status: 'PROCESSING', attempts: 1 } });
        const calls = mock.calls;
        await processAudio(prisma, uncertain.id, mock, storage); assert.equal(mock.calls, calls);
        assert.equal((await prisma.audioAsset.findUniqueOrThrow({ where: { id: uncertain.id } })).errorCode, 'TTS_OUTCOME_UNKNOWN');
        const revokedScript = await createScript(); const revoked = (await request(revokedScript.id)).json();
        await prisma.videoScript.update({ where: { id: revokedScript.id }, data: { validationStatus: 'REJECTED' } });
        await processAudio(prisma, revoked.id, mock, storage); assert.equal(mock.calls, calls);
        assert.equal((await prisma.audioAsset.findUniqueOrThrow({ where: { id: revoked.id } })).errorCode, 'SCRIPT_NOT_APPROVED');
        // Duplicate processors cannot both call the provider.
        const concurrent = (await request((await createScript()).id)).json();
        let unblock!: () => void; let started!: () => void;
        const begun = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { unblock = r; });
        const running = processAudio(prisma, concurrent.id, { name: 'mock', synthesize: async input => { started(); await gate; return mock.synthesize(input); } }, storage);
        await begun;
        try { await assert.rejects(processAudio(prisma, concurrent.id, mock, storage), /already running/); }
        finally { unblock(); await running; }
        assert.equal(mock.calls, calls + 1);
        assert.equal((await app.inject({ url: `/audio-assets/${asset.id}`, headers })).json().status, 'READY');
    } finally {
        await worker?.close();
        const assets = await prisma.audioAsset.findMany({ where: { videoJobId: job.id } });
        for (const asset of assets) await (await queue.getJob(asset.id))?.remove();
        await queue.close();
        await prisma.audioAsset.deleteMany({ where: { videoJobId: job.id } });
        await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
        await prisma.videoScript.deleteMany({ where: { videoJobId: job.id } });
        await prisma.videoJob.delete({ where: { id: job.id } }); await prisma.project.delete({ where: { id: project.id } });
        await app.close(); await prisma.$disconnect();
    }
});
