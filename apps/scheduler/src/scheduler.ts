import { PrismaClient } from '@prisma/client';
import { runSchedulerTick } from '@fako/quiz-pipeline';
import { loadProviderAndStorage, loadSchedulerConfig, projectSlug } from './config.js';
import { logger } from './logger.js';

if ((process.env.SCHEDULER_ENABLED ?? 'false') !== 'true') {
    logger.info('Scheduler disabled (SCHEDULER_ENABLED is not "true"); exiting.');
    process.exit(0);
}

const config = loadSchedulerConfig();
const { provider, mediaStorage } = loadProviderAndStorage();
if (!provider) throw new Error('Scheduler enabled but no RijPermis content source is configured (RIJPERMIS_API_ENABLED / RIJPERMIS_MOCK_MODE)');

const prisma = new PrismaClient();
const project = await prisma.project.findUnique({ where: { slug: projectSlug } });
if (!project) throw new Error(`Project with slug "${projectSlug}" not found; run db:seed first`);

let ticking = false;
async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        // Validated once at startup, above; this closure just can't see that narrowing.
        const outcomes = await runSchedulerTick(prisma, provider!, mediaStorage, project!.id, config);
        for (const outcome of outcomes) {
            const context = { scheduledDate: outcome.scheduledDate, slotTime: outcome.slotTime, language: outcome.language };
            if (outcome.status === 'FAILED') logger.error({ ...context, reason: outcome.reason }, 'Scheduler slot failed');
            else if (outcome.status === 'SKIPPED') logger.warn({ ...context, reason: outcome.reason }, 'Scheduler slot skipped');
            else if (outcome.status === 'DISPATCHED') logger.info({ ...context, quizVideoId: outcome.quizVideoId }, 'Scheduler slot dispatched');
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
