import { createPrismaClient } from '@fako/db';
import { computeProgramOccurrences } from '@fako/video-pipeline';
import { loadSchedulerConfig } from './config.js';

// Lecture seule : affiche, pour chaque programme actif, les créneaux qui seraient traités à l'instant
// donné, sans jamais créer de ScheduledSlot ni de Video. Sans risque sur une vraie base.
const config = loadSchedulerConfig();
const prisma = createPrismaClient();
try {
    const now = process.env.SCHEDULER_SIMULATE_NOW ? new Date(process.env.SCHEDULER_SIMULATE_NOW) : new Date();
    console.log(`Simulation à ${now.toISOString()}\n`);
    const programs = await prisma.program.findMany({ where: { enabled: true }, include: { project: true }, orderBy: { createdAt: 'asc' } });
    if (!programs.length) console.log('Aucun programme actif.');
    for (const program of programs) {
        const occurrences = computeProgramOccurrences(now, program, program.project.timezone, config.graceMinutes);
        console.log(`${program.project.name} · ${program.name} (${program.videoType}) : ${occurrences.length} créneau(x)`);
        for (const slot of occurrences) {
            const existing = await prisma.scheduledSlot.findUnique({ where: { programId_scheduledDate_slotTime: {
                programId: program.id, scheduledDate: new Date(`${slot.scheduledDate}T00:00:00.000Z`), slotTime: slot.slotTime } } });
            const state = existing ? `déjà traité (${existing.status})` : slot.missed ? 'manqué, serait ignoré' : 'serait généré';
            console.log(`  ${slot.scheduledDate} ${slot.slotTime} -> ${state}`);
        }
    }
} finally {
    await prisma.$disconnect();
}
