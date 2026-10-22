import { PrismaClient } from '@prisma/client';
import { runSocialPublicationSchedulerTick } from '@fako/social-publishing';
import { logger } from './logger.js';

// Mission 14 section 6: a scheduler distinct from the generation scheduler (scheduler.ts/mission
// 11) — no fixed daily slots, it simply promotes whichever SocialPublication rows are individually
// due (scheduledAt <= now) to READY, capacity-bounded so a burst can never flood the worker's queue.
if ((process.env.SOCIAL_PUBLISHING_ENABLED ?? 'false') !== 'true') {
    logger.info('Social publication scheduler disabled (SOCIAL_PUBLISHING_ENABLED is not "true"); exiting.');
    process.exit(0);
}

const prisma = new PrismaClient();

function positiveInteger(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    return value;
}

const maxInFlight = positiveInteger('SOCIAL_PUBLISHING_MAX_IN_FLIGHT', 20);

let ticking = false;
async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const outcome = await runSocialPublicationSchedulerTick(prisma, { maxInFlight });
        if (outcome.promoted > 0) logger.info({ promoted: outcome.promoted }, 'Social publication scheduler promoted publication(s) to READY');
        if (outcome.skippedCapacity) logger.warn({ maxInFlight }, 'Social publication scheduler at capacity; will retry on the next tick');
    } catch (error) {
        logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Social publication scheduler tick failed; will retry on the next tick');
    } finally {
        ticking = false;
    }
}

const intervalMs = positiveInteger('SOCIAL_PUBLISHING_SCHEDULER_TICK_INTERVAL_MS', 30_000);
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
