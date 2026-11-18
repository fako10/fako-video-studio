import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { createPrismaClient } from '@fako/db';
import { Worker } from '@fako/jobs';
import { createVideoQueue, dispatchPending, queueName, simulateVideoJob } from '@fako/video-jobs';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-video-jobs-integration-token-1234567890';
const headers = { authorization: `Bearer ${TOKEN}` };

test('video job routes, project isolation, approval, cancellation, failures and retries', async () => {
    const prisma = createPrismaClient();
    const app = buildApp({ prisma, videoJobsToken: TOKEN, projectsToken: TOKEN });
    const project = await prisma.project.create({ data: { name: 'Job tests', languages: ['fr', 'nl'], settings: { create: { width: 1080, height: 1920, fps: 30 } } } });
    const other = await prisma.project.create({ data: { name: 'Other job tests' } });
    try {
        const url = `/projects/${project.id}/video-jobs`;
        const payload = { subject: 'Priorité de droite', language: 'fr', metadata: { simulated: false, label: 'quiz' } };
        const response = await app.inject({ method: 'POST', url, headers, payload });
        assert.equal(response.statusCode, 201, response.body);
        const job = response.json();
        assert.equal(response.headers.location, `/video-jobs/${job.id}`);
        assert.equal(job.status, 'PENDING');
        assert.equal(job.format, 'VERTICAL');
        assert.equal(job.height, 1920);
        assert.equal(job.metadata.simulated, true);
        assert.equal(job.metadata.humanApprovalRequired, true);
        assert.equal((await app.inject({ url: `/video-jobs/${job.id}`, headers })).json().projectId, project.id);
        assert.equal((await app.inject({ url: `/projects/${other.id}/video-jobs`, headers })).json().total, 0);
        assert.equal((await app.inject({ url, headers })).json().total, 1);
        assert.equal((await app.inject({ url: `${url}?status=COMPLETED`, headers })).json().total, 0);
        assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, language: 'de' } })).statusCode, 400);
        assert.equal((await app.inject({ method: 'POST', url: `/projects/00000000-0000-4000-8000-000000000001/video-jobs`, headers, payload })).statusCode, 404);
        assert.equal((await app.inject({ url: '/projects/00000000-0000-4000-8000-000000000001/video-jobs', headers })).statusCode, 404);
        assert.equal((await app.inject({ url: '/video-jobs/00000000-0000-4000-8000-000000000001', headers })).statusCode, 404);
        assert.equal((await app.inject({ method: 'DELETE', url: `/projects/${project.id}`, headers })).statusCode, 409);
        assert.equal((await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/approve`, headers, payload: { approvedBy: 'Reviewer' } })).statusCode, 409);

        const observed: number[] = [];
        await simulateVideoJob(prisma, job.id, { attempt: 1, maxAttempts: 3, stepDelayMs: 1, step: async progress => {
            assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'PROCESSING');
            observed.push(progress);
        } });
        assert.deepEqual(observed, [20, 50, 80, 100]);
        const waiting = (await app.inject({ url: `/video-jobs/${job.id}`, headers })).json();
        assert.equal(waiting.status, 'WAITING_APPROVAL');
        assert.equal(waiting.progress, 100);
        assert.equal(waiting.approvedAt, null);
        const approval = await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/approve`, headers, payload: { approvedBy: 'Human reviewer' } });
        assert.equal(approval.statusCode, 200);
        assert.equal(approval.json().status, 'COMPLETED');
        assert.equal(approval.json().approvedBy, 'Human reviewer');
        assert.ok(approval.json().approvedAt);
        assert.equal((await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/cancel`, headers })).statusCode, 409);

        const cancelled = (await app.inject({ method: 'POST', url, headers, payload })).json();
        const cancel = () => app.inject({ method: 'POST', url: `/video-jobs/${cancelled.id}/cancel`, headers });
        assert.equal((await cancel()).json().status, 'CANCELLED');
        assert.equal((await cancel()).statusCode, 200);
        await simulateVideoJob(prisma, cancelled.id, { attempt: 1, maxAttempts: 3, stepDelayMs: 1 });
        assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: cancelled.id } })).attempts, 0);

        const during = (await app.inject({ method: 'POST', url, headers, payload })).json();
        await simulateVideoJob(prisma, during.id, { attempt: 1, maxAttempts: 3, stepDelayMs: 1, step: async () => {
            await app.inject({ method: 'POST', url: `/video-jobs/${during.id}/cancel`, headers });
        } });
        assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: during.id } })).status, 'CANCELLED');

        const failed = (await app.inject({ method: 'POST', url, headers, payload })).json();
        const fail = async () => { throw new Error('Private failure details'); };
        await assert.rejects(simulateVideoJob(prisma, failed.id, { attempt: 1, maxAttempts: 2, stepDelayMs: 1, step: fail }));
        assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: failed.id } })).status, 'QUEUED');
        await assert.rejects(simulateVideoJob(prisma, failed.id, { attempt: 2, maxAttempts: 2, stepDelayMs: 1, step: fail }));
        const terminal = await prisma.videoJob.findUniqueOrThrow({ where: { id: failed.id } });
        assert.equal(terminal.status, 'FAILED');
        assert.equal(terminal.attempts, 2);
        assert.equal(terminal.errorMessage, 'Simulated processing failed');
        assert.ok(terminal.finishedAt);
    } finally {
        await prisma.videoJob.deleteMany({ where: { projectId: { in: [project.id, other.id] } } });
        await prisma.project.deleteMany({ where: { id: { in: [project.id, other.id] } } });
        await app.close();
        await prisma.$disconnect();
    }
});

test('Queue dispatch is recoverable and deduplicated; failed attempts retry then await approval', async () => {
    const prisma = createPrismaClient();
    const queue = createVideoQueue();
    const project = await prisma.project.create({ data: { name: 'Queue integration' } });
    const job = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Queue test', language: 'fr', width: 1080, height: 1920, fps: 30 } });
    let worker: Worker | undefined;
    try {
        await assert.rejects(dispatchPending(prisma, {
            getJob: async () => undefined,
            add: async () => { throw new Error('Queue temporarily offline'); }
        }));
        assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'QUEUED');
        await dispatchPending(prisma, queue);
        await dispatchPending(prisma, queue);
        assert.equal(await (await queue.getJob(job.id))?.getState(), 'created');
        worker = new Worker(queueName, async item => {
            await simulateVideoJob(prisma, item.data.videoJobId, {
                attempt: item.attemptsMade + 1, maxAttempts: item.opts.attempts ?? 3, stepDelayMs: 1,
                step: async () => { if (item.attemptsMade === 0) throw new Error('Transient error'); }
            });
        }, { pollingIntervalSeconds: 0.5 });
        const deadline = Date.now() + 15000;
        let result = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
        while (result.status !== 'WAITING_APPROVAL' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
            result = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
        }
        assert.equal(result.status, 'WAITING_APPROVAL');
        assert.equal(result.attempts, 2);
        assert.equal(result.errorMessage, null);
        assert.equal(result.progress, 100);
        assert.equal(result.approvedAt, null);
    } finally {
        await worker?.close();
        await queue.close();
        await prisma.videoJob.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await prisma.$disconnect();
    }
});
