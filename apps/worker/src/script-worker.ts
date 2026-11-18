import type { PrismaClient } from '@prisma/client';
import { Worker } from '@fako/jobs';
import { createScriptQueue, dispatchScripts, generateVideoScript, OpenAIProvider, scriptQueueName, type Pricing } from '@fako/video-jobs';
import { logger } from './logger.js';

export function startScriptWorker(prisma: PrismaClient) {
    const providerName = process.env.AI_PROVIDER ?? 'disabled';
    if (providerName === 'disabled') return { close: async () => {} };
    if (providerName !== 'openai') throw new Error('Unsupported AI_PROVIDER');
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    const timeout = Number(process.env.OPENAI_TIMEOUT_MS ?? 45000);
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('Invalid OPENAI_TIMEOUT_MS');
    const provider = new OpenAIProvider(process.env.OPENAI_API_KEY ?? '', model, timeout);
    let pricing: Pricing | undefined;
    if (process.env.OPENAI_INPUT_USD_PER_MILLION && process.env.OPENAI_OUTPUT_USD_PER_MILLION && process.env.OPENAI_PRICE_MODEL) {
        pricing = {
            model: process.env.OPENAI_PRICE_MODEL,
            inputPerMillion: Number(process.env.OPENAI_INPUT_USD_PER_MILLION),
            outputPerMillion: Number(process.env.OPENAI_OUTPUT_USD_PER_MILLION),
            ...(process.env.OPENAI_CACHED_INPUT_USD_PER_MILLION ? { cachedInputPerMillion: Number(process.env.OPENAI_CACHED_INPUT_USD_PER_MILLION) } : {})
        };
        if ([pricing.inputPerMillion, pricing.outputPerMillion, pricing.cachedInputPerMillion ?? 0].some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid OpenAI pricing configuration');
    }
    const queue = createScriptQueue();
    const worker = new Worker<{ scriptId: string }>(scriptQueueName, job => generateVideoScript(prisma, job.data.scriptId, provider, {
        attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 3, pricing
    }), { concurrency: 1 });
    worker.on('error', error => logger.error({ queue: scriptQueueName, err: error.message }, 'Script worker connection error'));
    worker.on('failed', (job, error) => logger.warn({ queue: scriptQueueName, jobId: job?.id, scriptId: job?.data.scriptId, attemptsMade: job?.attemptsMade, err: error?.message }, 'Script generation attempt failed; see persisted error code'));
    queue.on('error', error => logger.error({ queue: scriptQueueName, err: error.message }, 'Script queue connection error'));
    let pending: Promise<void> | undefined;
    let stopping = false;
    function dispatch() {
        if (pending || stopping) return;
        pending = dispatchScripts(prisma, queue).catch(() => logger.error({ queue: scriptQueueName }, 'Script dispatch unavailable; requests retained')).finally(() => { pending = undefined; });
    }
    const timer = setInterval(dispatch, 2000);
    dispatch();
    return { close: async () => {
        stopping = true;
        clearInterval(timer);
        await worker.close();
        await pending;
        await queue.close();
    } };
}
