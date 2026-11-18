import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@fako/db';
import { UnrecoverableError, Worker } from '@fako/jobs';
import {
    AIProviderError, createScriptQueue, dispatchScripts, generateVideoScript, rijPermisEditorial,
    scriptQueueName, simulateVideoJob, type AIProvider, type ScriptInput
} from '@fako/video-jobs';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-video-scripts-integration-token-1234567890';
const headers = { authorization: `Bearer ${TOKEN}` };

function fakeContent(input: ScriptInput) {
    const narration = input.language === 'nl' ? 'Doe samen het dagelijkse examen en volg je voortgang.' : "Passez ensemble l'examen quotidien et suivez vos progrès.";
    return JSON.stringify({ language: input.language, title: input.language === 'nl' ? 'Samen oefenen' : 'Apprendre ensemble',
        hook: input.language === 'nl' ? 'Klaar?' : 'Prêt ?', narration,
        scenes: [{ duration: input.targetDuration, narration, visualDescription: 'Groupe apprenant',
            onScreenText: 'RijPermis', factIds: ['daily-group-exam', 'progress-tracking'], quiz: null }],
        onScreenTexts: ['RijPermis'], estimatedDuration: input.targetDuration });
}

test('script outbox, fake AI, idempotency, languages, usage, version approval and cancellation', async () => {
    const prisma = createPrismaClient();
    const app = buildApp({ prisma, scriptGenerationEnabled: true, videoScriptsToken: TOKEN, videoJobsToken: TOKEN });
    const project = await prisma.project.create({ data: { name: 'Script tests', languages: ['fr', 'nl'], ...rijPermisEditorial } });
    const job = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Examen quotidien en groupe', language: 'fr', width: 1080, height: 1920, fps: 30 } });
    const queue = createScriptQueue();
    let worker: Worker | undefined;
    let calls = 0;
    const provider: AIProvider = { name: 'fake', model: 'test-model', generate: async input => {
        calls++;
        assert.match(input.instructions, /Ne jamais inventer/);
        return { text: fakeContent(input), model: 'test-model', responseId: `fake-${calls}`, usage: { inputTokens: 100, outputTokens: 50 } };
    } };
    const scriptIds: string[] = [];
    const request = async (requestId = randomUUID()) => app.inject({ method: 'POST', url: `/video-jobs/${job.id}/scripts/generate`, headers, payload: { requestId } });
    try {
        assert.equal((await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/scripts/generate`, headers, payload: { requestId: randomUUID(), contentType: 'QUIZ' } })).statusCode, 409);
        const requestId = randomUUID();
        const [a, b] = await Promise.all([request(requestId), request(requestId)]);
        assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 202]);
        const script = a.json();
        scriptIds.push(script.id);
        assert.equal(script.id, b.json().id);
        assert.equal(script.version, 1);
        assert.equal((await request()).statusCode, 409);
        await simulateVideoJob(prisma, job.id, { attempt: 1, maxAttempts: 3, stepDelayMs: 1 });
        assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'QUEUED');
        await dispatchScripts(prisma, queue);
        await dispatchScripts(prisma, queue);
        worker = new Worker(scriptQueueName, item => generateVideoScript(prisma, item.data.scriptId, provider, {
            attempt: item.attemptsMade + 1, maxAttempts: 3, pricing: { model: 'test-model', inputPerMillion: 1, outputPerMillion: 2 }
        }), { pollingIntervalSeconds: 0.5 });
        const deadline = Date.now() + 10000;
        let generated = await prisma.videoScript.findUniqueOrThrow({ where: { id: script.id } });
        while (generated.generationStatus !== 'GENERATED' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 40));
            generated = await prisma.videoScript.findUniqueOrThrow({ where: { id: script.id } });
        }
        assert.equal(generated.generationStatus, 'GENERATED');
        assert.equal(generated.validationStatus, 'PENDING_APPROVAL');
        assert.equal(calls, 1);
        const detail = await app.inject({ url: `/video-scripts/${script.id}`, headers });
        assert.equal(detail.statusCode, 200);
        assert.equal(detail.json().aiRequests[0].inputTokens, 100);
        assert.equal(Number(detail.json().aiRequests[0].estimatedCostUsd), 0.0002);
        assert.equal((await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/approve`, headers, payload: { approvedBy: 'Bypass' } })).statusCode, 409);
        const review = (id: string, decision: string) => app.inject({ method: 'POST', url: `/video-scripts/${id}/review`, headers, payload: { reviewedBy: 'Human', decision } });
        assert.equal((await review(script.id, 'REJECTED')).statusCode, 200);
        const second = await request();
        assert.equal(second.statusCode, 202);
        scriptIds.push(second.json().id);
        assert.equal(second.json().version, 2);
        await generateVideoScript(prisma, second.json().id, provider, { attempt: 1, maxAttempts: 3 });
        assert.equal((await review(script.id, 'APPROVED')).statusCode, 409);
        assert.equal((await review(second.json().id, 'APPROVED')).statusCode, 200);
        assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'COMPLETED');
        assert.equal((await app.inject({ url: `/video-jobs/${job.id}/scripts`, headers })).json().scripts.length, 2);
        assert.equal((await request()).statusCode, 409);

        const dutchJob = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Dagelijks examen', language: 'nl', width: 1080, height: 1920, fps: 30 } });
        const dutch = (await app.inject({ method: 'POST', url: `/video-jobs/${dutchJob.id}/scripts/generate`, headers, payload: { requestId: randomUUID() } })).json();
        scriptIds.push(dutch.id);
        await generateVideoScript(prisma, dutch.id, provider, { attempt: 1, maxAttempts: 3 });
        assert.equal((await prisma.videoScript.findUniqueOrThrow({ where: { id: dutch.id } })).language, 'nl');

        const cancelledJob = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Cancel', language: 'fr', width: 1080, height: 1920, fps: 30 } });
        const cancelled = (await app.inject({ method: 'POST', url: `/video-jobs/${cancelledJob.id}/scripts/generate`, headers, payload: { requestId: randomUUID() } })).json();
        scriptIds.push(cancelled.id);
        await generateVideoScript(prisma, cancelled.id, { ...provider, generate: async input => {
            await app.inject({ method: 'POST', url: `/video-jobs/${cancelledJob.id}/cancel`, headers });
            return provider.generate(input);
        } }, { attempt: 1, maxAttempts: 3 });
        assert.equal((await prisma.videoScript.findUniqueOrThrow({ where: { id: cancelled.id } })).generationStatus, 'CANCELLED');
        assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: cancelledJob.id } })).status, 'CANCELLED');
    } finally {
        await worker?.close();
        for (const id of scriptIds) await (await queue.getJob(id))?.remove();
        await queue.close();
        await prisma.aIRequest.deleteMany({ where: { videoScript: { videoJob: { projectId: project.id } } } });
        await prisma.videoScript.deleteMany({ where: { videoJob: { projectId: project.id } } });
        await prisma.videoJob.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
    }
});

test('AI retries only transient failures and persists usage even for invalid output', async () => {
    const prisma = createPrismaClient();
    const app = buildApp({ prisma, scriptGenerationEnabled: true, videoScriptsToken: TOKEN });
    const project = await prisma.project.create({ data: { name: 'AI failures', ...rijPermisEditorial } });
    const job = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Daily group exam', language: 'fr', width: 1080, height: 1920, fps: 30 } });
    const provider: AIProvider = { name: 'fake', model: 'fake-model', generate: async () => { throw new AIProviderError('AI_HTTP_429', true); } };
    try {
        const script = (await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/scripts/generate`, headers, payload: { requestId: randomUUID() } })).json();
        await assert.rejects(generateVideoScript(prisma, script.id, provider, { attempt: 1, maxAttempts: 2 }), /AI_HTTP_429/);
        assert.equal((await prisma.videoScript.findUniqueOrThrow({ where: { id: script.id } })).generationStatus, 'PENDING');
        await assert.rejects(generateVideoScript(prisma, script.id, provider, { attempt: 2, maxAttempts: 2 }), UnrecoverableError);
        assert.equal((await prisma.videoScript.findUniqueOrThrow({ where: { id: script.id } })).generationStatus, 'FAILED');
        assert.equal(await prisma.aIRequest.count({ where: { videoScriptId: script.id } }), 2);
        const invalid = (await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/scripts/generate`, headers, payload: { requestId: randomUUID() } })).json();
        await assert.rejects(generateVideoScript(prisma, invalid.id, { ...provider, generate: async () => ({
            text: '{"invalid":true}', model: 'fake-model', usage: { inputTokens: 123, outputTokens: 5 }
        }) }, { attempt: 1, maxAttempts: 3 }), UnrecoverableError);
        const usage = await prisma.aIRequest.findFirstOrThrow({ where: { videoScriptId: invalid.id } });
        assert.equal(usage.errorCode, 'INVALID_SCRIPT_SCHEMA');
        assert.equal(usage.inputTokens, 123);
        assert.equal(usage.estimatedCostUsd, null);
        assert.equal((await prisma.videoScript.findUniqueOrThrow({ where: { id: invalid.id } })).attempts, 1);
        const uncertain = (await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/scripts/generate`, headers, payload: { requestId: randomUUID() } })).json();
        await prisma.videoScript.update({ where: { id: uncertain.id }, data: { generationStatus: 'PROCESSING', attempts: 1 } });
        await prisma.aIRequest.create({ data: { videoScriptId: uncertain.id, attempt: 1, provider: 'fake', model: 'fake-model', errorCode: 'IN_FLIGHT' } });
        let called = false;
        await generateVideoScript(prisma, uncertain.id, { ...provider, generate: async () => { called = true; throw new Error('Must not call again'); } }, { attempt: 2, maxAttempts: 3 });
        assert.equal(called, false);
        assert.equal((await prisma.videoScript.findUniqueOrThrow({ where: { id: uncertain.id } })).errorMessage, 'AI_OUTCOME_UNKNOWN');
    } finally {
        await prisma.aIRequest.deleteMany({ where: { videoScript: { videoJobId: job.id } } });
        await prisma.videoScript.deleteMany({ where: { videoJobId: job.id } });
        await prisma.videoJob.delete({ where: { id: job.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
    }
});
