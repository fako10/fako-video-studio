import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrismaClient } from '@fako/db';
import { LocalMediaStorage, MockContentSourceProvider, mockQuestion, type ContentSourceProvider, type SourceQuestion } from '@fako/content-sources';
import { runProgramsTick, zonedTimeToUtc, type SchedulerConfig } from '@fako/video-pipeline';
import { buildApp } from '../../src/app.js';

const TZ = 'Europe/Brussels';
const TOKEN = 'test-scheduler-token-1234567890123456789';
const headers = { authorization: `Bearer ${TOKEN}` };

function nlQuestion(id: string, category = 'Voorrang'): SourceQuestion {
    return { ...mockQuestion, id, language: 'nl', category };
}

// Deux projets d'une même marque (FR et NL), chacun avec un programme « Quiz du jour » à 09:00,
// 16:00 et 21:00, généré à l'heure du créneau (leadDays = 0).
async function fixture(slots = ['09:00', '16:00', '21:00']) {
    const prisma = createPrismaClient();
    const mediaRoot = await mkdtemp(join(tmpdir(), 'fako-sched-media-'));
    const mediaStorage = new LocalMediaStorage(mediaRoot);
    const brand = await prisma.brand.create({ data: { slug: `brand-${randomUUID()}`, name: 'Scheduler brand' } });
    const projects = [];
    for (const language of ['fr', 'nl']) {
        const project = await prisma.project.create({ data: { name: `Scheduler ${language} ${randomUUID()}`, brandId: brand.id, language, timezone: TZ, contentSource: 'rijpermis' } });
        await prisma.projectVoice.create({ data: { projectId: project.id, language, voiceId: `v-${language}`, model: 'eleven_multilingual_v2', settings: {} } });
        const program = await prisma.program.create({ data: { projectId: project.id, videoType: 'daily-quiz', name: 'Quiz du jour', enabled: true, slots, leadDays: 0 } });
        projects.push({ project, program, language });
    }
    const projectIds = projects.map(p => p.project.id);
    const config: SchedulerConfig = { graceMinutes: 120, maxPendingJobs: 10, projectIds };
    const deps = (provider: ContentSourceProvider) => ({ contentSourceFor: () => provider, mediaStorage });
    return {
        prisma, mediaStorage, projects, projectIds, config, deps,
        byLanguage: (language: string) => projects.find(p => p.language === language)!,
        cleanup: async () => {
            await prisma.scheduledSlot.deleteMany({ where: { projectId: { in: projectIds } } });
            await prisma.video.deleteMany({ where: { projectId: { in: projectIds } } });
            await prisma.program.deleteMany({ where: { projectId: { in: projectIds } } });
            await prisma.projectVoice.deleteMany({ where: { projectId: { in: projectIds } } });
            await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
            await prisma.brand.delete({ where: { id: brand.id } });
            await prisma.$disconnect();
            await rm(mediaRoot, { recursive: true, force: true });
        }
    };
}

const forDate = (date: string) => (o: { scheduledDate: string }) => o.scheduledDate === date;

test('une journée complète : 3 créneaux par projet ; seuls ceux encore dans la marge sont générés, chacun dans la langue de son projet', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        const now = zonedTimeToUtc(2026, 1, 15, 22, 0, TZ);
        const outcomes = (await runProgramsTick(f.prisma, f.deps(provider), f.config, now)).filter(forDate('2026-01-15'));
        assert.equal(outcomes.length, 6, '3 créneaux x 2 projets');
        const dispatched = outcomes.filter(o => o.status === 'DISPATCHED');
        assert.deepEqual(dispatched.map(o => o.slotTime), ['21:00', '21:00']);
        assert.equal(outcomes.filter(o => o.status === 'SKIPPED').length, 4);
        const videos = await f.prisma.video.findMany({ where: { projectId: { in: f.projectIds } } });
        assert.equal(videos.length, 2);
        for (const video of videos) {
            const owner = f.projects.find(p => p.project.id === video.projectId)!;
            assert.equal(video.language, owner.language);
            assert.equal(video.programId, owner.program.id);
            assert.equal(video.videoType, 'daily-quiz');
        }
        assert.ok(videos.every(v => v.status === 'PENDING' && v.validationStatus === 'PENDING_APPROVAL'), 'jamais validée ni publiée automatiquement');
    } finally { await f.cleanup(); }
});

test('jamais de vidéo dans une autre langue : un projet sans question échoue proprement, l\'autre n\'est pas affecté', async () => {
    const f = await fixture(['09:00']);
    const provider = new MockContentSourceProvider([mockQuestion]);
    try {
        const outcomes = (await runProgramsTick(f.prisma, f.deps(provider), f.config, zonedTimeToUtc(2026, 1, 15, 9, 5, TZ))).filter(forDate('2026-01-15'));
        assert.equal(outcomes.find(o => o.language === 'fr')!.status, 'DISPATCHED');
        const nl = outcomes.find(o => o.language === 'nl')!;
        assert.equal(nl.status, 'FAILED');
        assert.match(nl.reason!, /No RijPermis question available/);
        assert.equal(await f.prisma.video.count({ where: { projectId: f.byLanguage('nl').project.id } }), 0);
    } finally { await f.cleanup(); }
});

test('la rotation choisit une question jamais utilisée, puis la moins récemment utilisée', async () => {
    const f = await fixture(['09:00']);
    const provider = new MockContentSourceProvider([nlQuestion('nl-a'), nlQuestion('nl-b')]);
    const nl = f.byLanguage('nl');
    try {
        const first = (await runProgramsTick(f.prisma, f.deps(provider), f.config, zonedTimeToUtc(2026, 1, 15, 9, 5, TZ)))
            .find(o => o.programId === nl.program.id && o.scheduledDate === '2026-01-15')!;
        assert.equal(first.status, 'DISPATCHED');
        const second = (await runProgramsTick(f.prisma, f.deps(provider), f.config, zonedTimeToUtc(2026, 1, 16, 9, 5, TZ)))
            .find(o => o.programId === nl.program.id && o.scheduledDate === '2026-01-16')!;
        const [a, b] = await Promise.all([first, second].map(o => f.prisma.video.findUniqueOrThrow({ where: { id: o.videoId } })));
        assert.notEqual(b.questionId, a.questionId);
    } finally { await f.cleanup(); }
});

test('idempotent par (programme, date, créneau) : deux ticks au même instant ne créent aucun doublon', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        const now = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        await runProgramsTick(f.prisma, f.deps(provider), f.config, now);
        const again = await runProgramsTick(f.prisma, f.deps(provider), f.config, now);
        assert.ok(again.every(o => o.status === 'ALREADY_CLAIMED'));
        assert.equal(await f.prisma.video.count({ where: { projectId: { in: f.projectIds } } }), 2, 'seul le créneau de 09:00 est dû, pour FR et NL');
    } finally { await f.cleanup(); }
});

test('deux ticks concurrents : chaque créneau est réservé une seule fois', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        const now = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        const [a, b] = await Promise.all([runProgramsTick(f.prisma, f.deps(provider), f.config, now), runProgramsTick(f.prisma, f.deps(provider), f.config, now)]);
        assert.equal([...a, ...b].filter(o => o.status === 'DISPATCHED').length, 2);
        assert.equal(await f.prisma.video.count({ where: { projectId: { in: f.projectIds } } }), 2);
    } finally { await f.cleanup(); }
});

test('après une longue panne, les créneaux dépassés sont signalés manqués, sans rattrapage', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        const outcomes = (await runProgramsTick(f.prisma, f.deps(provider), f.config, zonedTimeToUtc(2026, 1, 15, 23, 30, TZ))).filter(forDate('2026-01-15'));
        assert.equal(outcomes.length, 6);
        assert.ok(outcomes.every(o => o.status === 'SKIPPED'));
        assert.equal(await f.prisma.video.count({ where: { projectId: { in: f.projectIds } } }), 0);
    } finally { await f.cleanup(); }
});

test('un programme générant à l\'avance prépare la vidéo de demain, avec l\'heure de publication prévue', async () => {
    const f = await fixture(['16:00']);
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        await f.prisma.program.updateMany({ where: { projectId: { in: f.projectIds } }, data: { leadDays: 1 } });
        const outcomes = await runProgramsTick(f.prisma, f.deps(provider), f.config, zonedTimeToUtc(2026, 1, 15, 16, 30, TZ));
        const tomorrow = outcomes.filter(forDate('2026-01-16'));
        assert.equal(tomorrow.filter(o => o.status === 'DISPATCHED').length, 2);
        const slot = await f.prisma.scheduledSlot.findFirstOrThrow({ where: { programId: f.byLanguage('fr').program.id, scheduledDate: new Date('2026-01-16T00:00:00.000Z') } });
        assert.equal(slot.scheduledAt.toISOString(), '2026-01-16T15:00:00.000Z');
    } finally { await f.cleanup(); }
});

test('un programme désactivé ou d\'un type inconnu ne génère rien', async () => {
    const f = await fixture(['09:00']);
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        await f.prisma.program.update({ where: { id: f.byLanguage('fr').program.id }, data: { enabled: false } });
        await f.prisma.program.update({ where: { id: f.byLanguage('nl').program.id }, data: { videoType: 'does-not-exist' } });
        const outcomes = await runProgramsTick(f.prisma, f.deps(provider), f.config, zonedTimeToUtc(2026, 1, 15, 9, 5, TZ));
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].status, 'FAILED');
        assert.match(outcomes[0].reason!, /Unknown video type/);
        assert.equal(await f.prisma.video.count({ where: { projectId: { in: f.projectIds } } }), 0);
    } finally { await f.cleanup(); }
});

test('au-delà du nombre maximum de vidéos en attente, le créneau est ignoré au lieu d\'empiler les rendus', async () => {
    const f = await fixture(['09:00']);
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    const fr = f.byLanguage('fr');
    try {
        await f.prisma.video.create({ data: {
            projectId: fr.project.id, requestId: randomUUID(), language: 'fr', status: 'PENDING',
            voiceId: 'v-fr', ttsModel: 'eleven_multilingual_v2', voiceSettings: {}
        } });
        const outcomes = await runProgramsTick(f.prisma, f.deps(provider), { ...f.config, maxPendingJobs: 1 }, zonedTimeToUtc(2026, 1, 15, 9, 5, TZ));
        const frOutcome = outcomes.find(o => o.programId === fr.program.id && o.scheduledDate === '2026-01-15')!;
        assert.equal(frOutcome.status, 'SKIPPED');
        assert.match(frOutcome.reason!, /Too many videos already pending/);
    } finally { await f.cleanup(); }
});

test('une voix manquante fait échouer le créneau clairement', async () => {
    const f = await fixture(['09:00']);
    const fr = f.byLanguage('fr');
    await f.prisma.projectVoice.deleteMany({ where: { projectId: fr.project.id } });
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        const outcomes = await runProgramsTick(f.prisma, f.deps(provider), f.config, zonedTimeToUtc(2026, 1, 15, 9, 5, TZ));
        const frOutcome = outcomes.find(o => o.programId === fr.program.id && o.scheduledDate === '2026-01-15')!;
        assert.equal(frOutcome.status, 'FAILED');
        assert.match(frOutcome.reason!, /Configure a voice/);
    } finally { await f.cleanup(); }
});

test('le rapport quotidien reflète les créneaux prévus, générés et en échec', async () => {
    const f = await fixture(['09:00']);
    const provider = new MockContentSourceProvider([mockQuestion]);
    const fr = f.byLanguage('fr');
    const app = buildApp({ prisma: f.prisma, schedulerToken: TOKEN });
    try {
        await runProgramsTick(f.prisma, f.deps(provider), f.config, zonedTimeToUtc(2026, 1, 15, 9, 5, TZ));
        const url = `/projects/${fr.project.id}/scheduler/days/2026-01-15`;
        assert.equal((await app.inject(url)).statusCode, 401);
        const report = await app.inject({ url, headers });
        assert.equal(report.statusCode, 200);
        const body = report.json();
        assert.equal(body.planned, 1);
        assert.equal(body.jobsCreated, 1);
        assert.deepEqual(body.byLanguage, { fr: 1 });
        assert.deepEqual(body.byVideoType, { 'daily-quiz': 1 });
        assert.equal(body.questionsUsed[0].questionId, mockQuestion.id);
        assert.equal(body.slots[0].programName, 'Quiz du jour');
    } finally { await app.close(); await f.cleanup(); }
});
