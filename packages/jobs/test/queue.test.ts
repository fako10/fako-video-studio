// Test d'intégration : nécessite DATABASE_URL vers une base PostgreSQL de test (ignoré sinon).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Queue, UnrecoverableError, Worker, closeJobs, retryOptions, type Job } from '../src/index.js';

const enabled = Boolean(process.env.DATABASE_URL);
after(async () => { if (enabled) await closeJobs(); });

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 20000) {
    const started = Date.now();
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() - started > timeoutMs) throw new Error('Timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

test('retryOptions traduit les options BullMQ', () => {
    assert.deepEqual(retryOptions({ attempts: 3, backoff: { type: 'exponential', delay: 2000 } }),
        { retryLimit: 2, retryDelay: 2, retryBackoff: true, expireInSeconds: 3600 });
    assert.deepEqual(retryOptions({ attempts: 1, backoff: { type: 'fixed', delay: 300 } }),
        { retryLimit: 0, retryDelay: 1, retryBackoff: false, expireInSeconds: 3600 });
    assert.throws(() => retryOptions({ attempts: 0 }));
});

test('un job est traité, relancé après échec, et dédoublonné par jobId', { skip: !enabled }, async () => {
    const name = `test-retry-${randomUUID()}`;
    const queue = new Queue<{ value: number }>(name, { defaultJobOptions: { attempts: 3 } });
    const seen: number[] = [];
    const failures: Array<{ attemptsMade: number; state: string }> = [];
    const worker = new Worker<{ value: number }>(name, async (job: Job<{ value: number }>) => {
        seen.push(job.attemptsMade);
        assert.equal(job.opts.attempts, 3);
        if (job.attemptsMade === 0) throw new Error('transient');
        return { ok: job.data.value };
    }, { pollingIntervalSeconds: 0.5 });
    worker.on('failed', async (job, error) => failures.push({ attemptsMade: job.attemptsMade, state: await job.getState() }));

    const id = randomUUID();
    await queue.add('run', { value: 7 }, { jobId: id });
    await queue.add('run', { value: 7 }, { jobId: id });
    const done = await waitFor(async () => {
        const job = await queue.getJob(id);
        return job && await job.getState() === 'completed' ? job : undefined;
    });
    assert.equal(done.attemptsMade, 1);
    assert.deepEqual(seen, [0, 1]);
    assert.deepEqual(failures, [{ attemptsMade: 0, state: 'retry' }]);
    assert.equal(await queue.getJob(randomUUID()), undefined);
    await worker.close();
    await queue.close();
});

test('UnrecoverableError échoue définitivement sans nouvelle tentative', { skip: !enabled }, async () => {
    const name = `test-unrecoverable-${randomUUID()}`;
    const queue = new Queue<{ value: number }>(name, { defaultJobOptions: { attempts: 5 } });
    let calls = 0;
    const worker = new Worker<{ value: number }>(name, async () => {
        calls += 1;
        throw new UnrecoverableError('BLOCKED');
    }, { pollingIntervalSeconds: 0.5 });
    const failedStates: string[] = [];
    worker.on('failed', async job => failedStates.push(await job.getState()));
    const id = randomUUID();
    await queue.add('run', { value: 1 }, { jobId: id });
    await waitFor(async () => {
        const job = await queue.getJob(id);
        return job && await job.getState() === 'failed' ? job : undefined;
    });
    assert.equal(calls, 1);
    assert.deepEqual(failedStates, ['failed']);
    await worker.close();
    await queue.close();
});
