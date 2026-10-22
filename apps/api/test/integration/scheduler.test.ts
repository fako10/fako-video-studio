import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { LocalMediaStorage, MockContentSourceProvider, mockQuestion, type SourceQuestion } from '@fako/content-sources';
import { runSchedulerTick, zonedTimeToUtc, type SchedulerConfig } from '@fako/quiz-pipeline';
import { buildApp } from '../../src/app.js';

const TZ = 'Europe/Brussels';
const TOKEN = 'test-scheduler-token-1234567890123456789';
const headers = { authorization: `Bearer ${TOKEN}` };

function nlQuestion(id: string, category = 'Voorrang'): SourceQuestion {
    return { ...mockQuestion, id, language: 'nl', category };
}

async function fixture() {
    const prisma = new PrismaClient();
    const mediaRoot = await mkdtemp(join(tmpdir(), 'fako-sched-media-'));
    const mediaStorage = new LocalMediaStorage(mediaRoot);
    const project = await prisma.project.create({ data: { name: `Scheduler ${randomUUID()}`, languages: ['fr', 'nl'] } });
    await prisma.projectVoice.create({ data: { projectId: project.id, language: 'fr', voiceId: 'v-fr', model: 'eleven_multilingual_v2', settings: {} } });
    await prisma.projectVoice.create({ data: { projectId: project.id, language: 'nl', voiceId: 'v-nl', model: 'eleven_multilingual_v2', settings: {} } });
    const config: SchedulerConfig = { slots: [{ time: '09:00' }, { time: '16:00' }, { time: '21:00' }], timeZone: TZ, graceMinutes: 120, maxPendingJobs: 10 };
    return {
        prisma, mediaStorage, project, config,
        cleanup: async () => {
            await prisma.scheduledQuizSlot.deleteMany({ where: { projectId: project.id } });
            await prisma.quizVideo.deleteMany({ where: { projectId: project.id } });
            await prisma.projectVoice.deleteMany({ where: { projectId: project.id } });
            await prisma.project.delete({ where: { id: project.id } });
            await prisma.$disconnect();
            await rm(mediaRoot, { recursive: true, force: true });
        }
    };
}

test('a full day yields exactly 6 slots (3 times x fr/nl); each still-fresh one dispatches to its own language', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        // Just after the 21:00 slot: it is still within the 120-minute grace window, but 09:00 and
        // 16:00 are hours stale and must be reported missed, not dispatched late.
        const now = zonedTimeToUtc(2026, 1, 15, 22, 0, TZ);
        const outcomes = await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, f.config, now);
        assert.equal(outcomes.length, 6, 'all 3 times x fr/nl are accounted for, dispatched or not');
        const dispatched = outcomes.filter(o => o.status === 'DISPATCHED');
        assert.equal(dispatched.length, 2);
        assert.deepEqual(dispatched.map(o => o.slotTime).sort(), ['21:00', '21:00']);
        assert.equal(outcomes.filter(o => o.status === 'SKIPPED').length, 4);
        const videos = await f.prisma.quizVideo.findMany({ where: { projectId: f.project.id } });
        assert.equal(videos.length, 2);
        assert.ok(videos.every(v => v.status === 'PENDING' && v.validationStatus === 'PENDING_APPROVAL'), 'never auto-approved or published');
    } finally { await f.cleanup(); }
});

test('never fabricates a video in another language: a slot with no eligible question fails cleanly and the other language is unaffected', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion]); // fr only, as in a local catalogue missing nl (or vice versa)
    try {
        const now = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        const outcomes = await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, f.config, now);
        const fr = outcomes.find(o => o.language === 'fr')!;
        const nl = outcomes.find(o => o.language === 'nl')!;
        assert.equal(fr.status, 'DISPATCHED');
        assert.equal(nl.status, 'FAILED');
        assert.match(nl.reason!, /No RijPermis question available/);
        assert.equal(await f.prisma.quizVideo.count({ where: { projectId: f.project.id, language: 'nl' } }), 0);
    } finally { await f.cleanup(); }
});

test('rotation prefers a never-used question, then the least recently used, across repeated ticks', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([nlQuestion('nl-a'), nlQuestion('nl-b')]);
    const singleSlot: SchedulerConfig = { ...f.config, slots: [{ time: '09:00' }] };
    try {
        const day1 = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        const first = await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, singleSlot, day1);
        const firstNl = first.find(o => o.language === 'nl')!;
        assert.equal(firstNl.status, 'DISPATCHED');
        const firstVideo = await f.prisma.quizVideo.findUniqueOrThrow({ where: { id: firstNl.quizVideoId } });

        const day2 = zonedTimeToUtc(2026, 1, 16, 9, 5, TZ);
        const second = await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, singleSlot, day2);
        const secondNl = second.find(o => o.language === 'nl')!;
        const secondVideo = await f.prisma.quizVideo.findUniqueOrThrow({ where: { id: secondNl.quizVideoId } });
        assert.notEqual(secondVideo.questionId, firstVideo.questionId, 'the never-used question should be picked next, not a repeat');
    } finally { await f.cleanup(); }
});

test('idempotent per (date, slot, language): ticking twice for the same instant never creates a duplicate', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        const now = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, f.config, now);
        const again = await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, f.config, now);
        assert.ok(again.every(o => o.status === 'ALREADY_CLAIMED'));
        assert.equal(await f.prisma.scheduledQuizSlot.count({ where: { projectId: f.project.id } }), 2, 'only the 09:00 slot (fr+nl) is due at this instant');
        assert.equal(await f.prisma.quizVideo.count({ where: { projectId: f.project.id } }), 2);
    } finally { await f.cleanup(); }
});

test('two concurrent ticks for the same instant race safely: each slot is claimed exactly once', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        const now = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        const [a, b] = await Promise.all([
            runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, f.config, now),
            runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, f.config, now)
        ]);
        const dispatchedCount = [...a, ...b].filter(o => o.status === 'DISPATCHED').length;
        assert.equal(dispatchedCount, 2, 'exactly one dispatch per slot across both racing ticks');
        assert.equal(await f.prisma.scheduledQuizSlot.count({ where: { projectId: f.project.id } }), 2);
    } finally { await f.cleanup(); }
});

test('restarting after a long outage reports stale slots as missed instead of producing a backlog', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    try {
        const restartTime = zonedTimeToUtc(2026, 1, 15, 23, 30, TZ);
        const outcomes = await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, f.config, restartTime);
        assert.equal(outcomes.length, 6);
        assert.ok(outcomes.every(o => o.status === 'SKIPPED'), 'every slot is far past its grace window by 23:30');
        assert.equal(await f.prisma.quizVideo.count({ where: { projectId: f.project.id } }), 0, 'no catch-up videos were produced');
    } finally { await f.cleanup(); }
});

test('a backlog at or above the pending-job limit defers dispatch instead of piling on more renders', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    const tightConfig: SchedulerConfig = { ...f.config, slots: [{ time: '09:00' }], maxPendingJobs: 1 };
    try {
        await f.prisma.quizVideo.create({ data: {
            projectId: f.project.id, requestId: randomUUID(), language: 'fr', status: 'PENDING',
            sourceId: 'rijpermis', origin: 'https://mock.invalid', questionId: 'existing', contentHash: `sha256:${'0'.repeat(64)}`,
            snapshotHash: 'x'.repeat(64), category: 'Existing', snapshot: {}, fetchedAt: new Date(),
            voiceId: 'v-fr', ttsModel: 'eleven_multilingual_v2', voiceSettings: {}
        } });
        const now = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        const outcomes = await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, tightConfig, now);
        assert.ok(outcomes.every(o => o.status === 'SKIPPED'));
        assert.ok(outcomes.every(o => o.reason?.includes('Too many quiz videos already pending')));
    } finally { await f.cleanup(); }
});

test('a missing voice configuration fails the slot clearly, preserving mission 10 protections', async () => {
    const f = await fixture();
    await f.prisma.projectVoice.deleteMany({ where: { projectId: f.project.id, language: 'fr' } });
    const provider = new MockContentSourceProvider([mockQuestion, nlQuestion('nl-1')]);
    const oneSlot: SchedulerConfig = { ...f.config, slots: [{ time: '09:00' }] };
    try {
        const now = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        const outcomes = await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, oneSlot, now);
        const fr = outcomes.find(o => o.language === 'fr')!;
        assert.equal(fr.status, 'FAILED');
        assert.match(fr.reason!, /Configure a voice/);
    } finally { await f.cleanup(); }
});

test('the daily production report reflects planned, dispatched and skipped slots over the authenticated route', async () => {
    const f = await fixture();
    const provider = new MockContentSourceProvider([mockQuestion]);
    const app = buildApp({ prisma: f.prisma, schedulerToken: TOKEN });
    try {
        const now = zonedTimeToUtc(2026, 1, 15, 9, 5, TZ);
        await runSchedulerTick(f.prisma, provider, f.mediaStorage, f.project.id, { ...f.config, slots: [{ time: '09:00' }] }, now);

        assert.equal((await app.inject(`/projects/${f.project.id}/scheduler/days/2026-01-15`)).statusCode, 401);
        const report = await app.inject({ url: `/projects/${f.project.id}/scheduler/days/2026-01-15`, headers });
        assert.equal(report.statusCode, 200);
        const body = report.json();
        assert.equal(body.planned, 2);
        assert.equal(body.jobsCreated, 1, 'only fr had an eligible question');
        assert.equal(body.schedulingFailures, 1);
        assert.equal(body.byLanguage.fr, 1);
        assert.equal(body.byLanguage.nl, 1);
        assert.equal(body.questionsUsed.length, 1);
        assert.equal(body.questionsUsed[0].questionId, mockQuestion.id);
    } finally { await app.close(); await f.cleanup(); }
});
