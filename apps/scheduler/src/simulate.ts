import { createPrismaClient } from '@fako/db';
import { computeDueSlots, getQuestionUsageStats, selectRijPermisQuestion } from '@fako/quiz-pipeline';
import { loadProviderAndStorage, loadSchedulerConfig, projectSlug } from './config.js';

// Read-only: shows which slots are due and which question each would pick, without ever creating a
// ScheduledQuizSlot, a QuizVideo, or calling requestQuizVideo. Safe to run against a real database.
const config = loadSchedulerConfig();
const { provider } = loadProviderAndStorage();
if (!provider) throw new Error('No RijPermis content source is configured (RIJPERMIS_API_ENABLED / RIJPERMIS_MOCK_MODE)');

const prisma = createPrismaClient();
try {
    const project = await prisma.project.findUnique({ where: { slug: projectSlug } });
    if (!project) throw new Error(`Project with slug "${projectSlug}" not found; run db:seed first`);

    const now = process.env.SCHEDULER_SIMULATE_NOW ? new Date(process.env.SCHEDULER_SIMULATE_NOW) : new Date();
    console.log(`Simulating at ${now.toISOString()} (${config.timeZone}), slots: ${config.slots.map(s => s.time).join(', ')}\n`);

    const due = computeDueSlots(now, config.slots, config.timeZone, config.graceMinutes);
    if (!due.length) { console.log('No slot is due right now.'); process.exit(0); }

    for (const slot of due) {
        const label = `${slot.scheduledDate} ${slot.slotTime} ${slot.language}`;
        if (slot.missed) { console.log(`${label} -> MISSED (past the ${config.graceMinutes}-minute grace window, would be skipped, not backfilled)`); continue; }
        try {
            const usage = await getQuestionUsageStats(prisma, project.id, slot.language);
            const question = await selectRijPermisQuestion(provider, slot.language, { usage });
            const stats = usage.byQuestion.get(question.id);
            const status = stats ? `reused, used ${stats.count}x, last on ${stats.lastUsedAt.toISOString().slice(0, 10)}` : 'never used before';
            console.log(`${label} -> ${question.id} [${question.category}] (${status})`);
        } catch (error) {
            console.log(`${label} -> would fail: ${error instanceof Error ? error.message : error}`);
        }
    }
} finally {
    await prisma.$disconnect();
}
