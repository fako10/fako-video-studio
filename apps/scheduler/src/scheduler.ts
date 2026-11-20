import { createPrismaClient } from '@fako/db';
import { runProgramsTick } from '@fako/video-pipeline';
import { loadRequestDeps, loadSchedulerConfig } from './config.js';
import { logger } from './logger.js';

if ((process.env.SCHEDULER_ENABLED ?? 'false') !== 'true') {
    logger.info('Scheduler disabled (SCHEDULER_ENABLED is not "true"); exiting.');
    process.exit(0);
}

const config = loadSchedulerConfig();
const deps = loadRequestDeps();
const prisma = createPrismaClient();

let ticking = false;
async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const outcomes = await runProgramsTick(prisma, deps, config);
        for (const outcome of outcomes) {
            const context = { programId: outcome.programId, videoType: outcome.videoType, scheduledDate: outcome.scheduledDate, slotTime: outcome.slotTime, language: outcome.language };
            if (outcome.status === 'FAILED') logger.error({ ...context, reason: outcome.reason }, 'Scheduler slot failed');
            else if (outcome.status === 'SKIPPED') logger.warn({ ...context, reason: outcome.reason }, 'Scheduler slot skipped');
            else if (outcome.status === 'DISPATCHED') logger.info({ ...context, videoId: outcome.videoId }, 'Scheduler slot dispatched');
        }
    } catch (error) {
        logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Scheduler tick failed; will retry on the next tick');
    } finally {
        ticking = false;
    }
}

const intervalMs = Number(process.env.SCHEDULER_TICK_INTERVAL_MS ?? 60000);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('Invalid SCHEDULER_TICK_INTERVAL_MS');
const timer = setInterval(() => void tick(), intervalMs);
void tick();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
        if (stopping) return;
        stopping = true;
        clearInterval(timer);
        await prisma.$disconnect();
    });
}
