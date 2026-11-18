import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrismaClient } from '@fako/db';
import { LocalMediaStorage, MockContentSourceProvider, type SourceQuestion } from '@fako/content-sources';
import { generateVideoScript, type AIProvider, type ScriptInput } from '@fako/video-jobs';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-rijpermis-integration-token-1234567890';
const headers = { authorization: `Bearer ${TOKEN}` };

function sourceQuestion(overrides: Partial<SourceQuestion> = {}): SourceQuestion {
    return {
        id: `mock-${randomUUID()}`, externalCode: 'N-TEST-1', language: 'fr', category: 'Priorité',
        question: 'Qui a la priorité à ce carrefour ?', answerType: 'SINGLE_CHOICE',
        options: [{ id: 'A', text: 'Le véhicule de gauche' }, { id: 'B', text: 'Le véhicule de droite' }, { id: 'C', text: 'Aucun, il faut s\'arrêter' }],
        correctOptionIds: ['B'], explanation: { text: 'Priorité à droite.', status: 'APPROVED' }, image: null, regulatoryReferences: [],
        validationStatus: 'APPROVED', contentHash: `sha256:${'1'.repeat(64)}`, ...overrides
    };
}

function exactAnswer(question: SourceQuestion, input: ScriptInput) {
    const correctIndex = question.options.findIndex(o => o.id === question.correctOptionIds[0]);
    const narration = 'Un quiz sur une règle de priorité.';
    return JSON.stringify({
        language: input.language, title: 'Quiz priorité', hook: 'Prêt ?', narration,
        scenes: [{ duration: input.targetDuration, narration, visualDescription: 'Carrefour', onScreenText: 'Quiz',
            factIds: input.facts.filter(f => f.kind === 'ROAD_RULE').map(f => f.id),
            quiz: { question: question.question, choices: question.options.map(o => o.text), correctAnswerIndex: correctIndex,
                explanation: 'Explication rédigée automatiquement, à valider humainement.', roadRuleFactIds: input.facts.filter(f => f.kind === 'ROAD_RULE').map(f => f.id) } }],
        onScreenTexts: ['Quiz'], estimatedDuration: input.targetDuration
    });
}

test('RijPermis-sourced quiz generation: traceability, verbatim enforcement, publication check, and disabled-by-default', async () => {
    const prisma = createPrismaClient();
    const storage = new LocalMediaStorage(await mkdtemp(join(tmpdir(), 'fako-rijpermis-integration-')));
    const questions: SourceQuestion[] = [sourceQuestion()];
    const provider = new MockContentSourceProvider(questions);
    const app = buildApp({ prisma, scriptGenerationEnabled: true, rijPermisProvider: provider, rijPermisStorage: storage, rijPermisToken: TOKEN, videoScriptsToken: TOKEN });
    const project = await prisma.project.create({ data: { name: 'RijPermis integration', languages: ['fr', 'nl'],
        editorialInstructions: 'Rester factuel.', verifiedFacts: [{ id: 'business-fact', text: 'Faux fait métier', source: 'Test' }] } });
    const scriptIds: string[] = [];
    try {
        assert.equal((await app.inject({ url: '/rijpermis/themes', headers })).statusCode, 200);
        assert.equal((await app.inject({ url: '/rijpermis/questions', headers })).json().items[0].id, questions[0].id);
        assert.equal((await app.inject({ url: `/rijpermis/questions/${questions[0].id}`, headers })).json().id, questions[0].id);

        const frJob = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Priorité à droite', language: 'fr', width: 1080, height: 1920, fps: 30 } });
        const generate = (jobId: string, requestId: string, questionId: string) => app.inject({ method: 'POST', url: `/video-jobs/${jobId}/scripts/generate-from-rijpermis`, headers, payload: { requestId, questionId } });

        const nlJob = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Mismatch', language: 'nl', width: 1080, height: 1920, fps: 30 } });
        assert.equal((await generate(nlJob.id, randomUUID(), questions[0].id)).statusCode, 409);

        const requestId = randomUUID();
        const first = await generate(frJob.id, requestId, questions[0].id);
        assert.equal(first.statusCode, 202);
        const script = first.json();
        scriptIds.push(script.id);
        const replay = await generate(frJob.id, requestId, questions[0].id);
        assert.equal(replay.statusCode, 200);
        assert.equal(replay.json().id, script.id);

        const source = await prisma.videoScriptSource.findUniqueOrThrow({ where: { videoScriptId: script.id } });
        assert.equal(source.sourceId, 'rijpermis');
        assert.equal(source.questionId, questions[0].id);
        assert.equal(source.contentHash, questions[0].contentHash);
        assert.equal(source.language, 'fr');
        assert.equal(source.category, 'Priorité');
        assert.equal((source.snapshot as unknown as SourceQuestion).question, questions[0].question);
        assert.equal(source.checkStatus, 'UNCHECKED');
        assert.equal(await prisma.videoScriptSource.count({ where: { videoScriptId: script.id } }), 1);

        const faithfulProvider: AIProvider = { name: 'fake', model: 'test-model', generate: async i => ({ text: exactAnswer(questions[0], i), model: 'test-model' }) };
        await generateVideoScript(prisma, script.id, faithfulProvider, { attempt: 1, maxAttempts: 1 });
        const generated = await prisma.videoScript.findUniqueOrThrow({ where: { id: script.id } });
        assert.equal(generated.generationStatus, 'GENERATED');
        assert.equal(generated.validationStatus, 'PENDING_APPROVAL');

        const tamperedRequestId = randomUUID();
        const tamperedJob = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Altered answer', language: 'fr', width: 1080, height: 1920, fps: 30 } });
        const tampered = (await generate(tamperedJob.id, tamperedRequestId, questions[0].id)).json();
        scriptIds.push(tampered.id);
        const deceitfulProvider: AIProvider = { name: 'fake', model: 'test-model', generate: async i => {
            const parsed = JSON.parse(exactAnswer(questions[0], i));
            parsed.scenes[0].quiz.correctAnswerIndex = (parsed.scenes[0].quiz.correctAnswerIndex + 1) % questions[0].options.length;
            return { text: JSON.stringify(parsed), model: 'test-model' };
        } };
        await assert.rejects(generateVideoScript(prisma, tampered.id, deceitfulProvider, { attempt: 1, maxAttempts: 1 }));
        const failed = await prisma.videoScript.findUniqueOrThrow({ where: { id: tampered.id } });
        assert.equal(failed.generationStatus, 'FAILED');
        assert.equal(failed.errorMessage, 'SOURCE_CONTENT_MISMATCH');

        const verify = () => app.inject({ method: 'POST', url: `/video-scripts/${script.id}/verify-source`, headers });
        const current = (await verify()).json();
        assert.equal(current.status, 'CURRENT');
        assert.equal(current.publicationBlocked, false);
        assert.equal((await prisma.videoScriptSource.findUniqueOrThrow({ where: { videoScriptId: script.id } })).checkStatus, 'CURRENT');

        questions[0] = { ...questions[0], contentHash: `sha256:${'2'.repeat(64)}` };
        const changed = (await verify()).json();
        assert.equal(changed.status, 'CHANGED');
        assert.equal(changed.publicationBlocked, true);

        questions.length = 0;
        const withdrawn = (await verify()).json();
        assert.equal(withdrawn.status, 'WITHDRAWN');
        assert.equal(withdrawn.publicationBlocked, true);

        const savedMock = process.env.RIJPERMIS_MOCK_MODE;
        const savedEnabled = process.env.RIJPERMIS_API_ENABLED;
        delete process.env.RIJPERMIS_MOCK_MODE;
        delete process.env.RIJPERMIS_API_ENABLED;
        try {
            const disabledApp = buildApp({ prisma, rijPermisToken: TOKEN });
            assert.equal((await disabledApp.inject({ url: '/rijpermis/themes', headers })).statusCode, 503);
            await disabledApp.close();
        } finally {
            if (savedMock !== undefined) process.env.RIJPERMIS_MOCK_MODE = savedMock; else delete process.env.RIJPERMIS_MOCK_MODE;
            if (savedEnabled !== undefined) process.env.RIJPERMIS_API_ENABLED = savedEnabled; else delete process.env.RIJPERMIS_API_ENABLED;
        }
    } finally {
        await prisma.aIRequest.deleteMany({ where: { videoScript: { videoJob: { projectId: project.id } } } });
        await prisma.videoScriptSource.deleteMany({ where: { videoScript: { videoJob: { projectId: project.id } } } });
        await prisma.videoScript.deleteMany({ where: { videoJob: { projectId: project.id } } });
        await prisma.videoJob.deleteMany({ where: { projectId: project.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
    }
});

test('a non-sourced script request still works unchanged and creates no VideoScriptSource row', async () => {
    const prisma = createPrismaClient();
    const app = buildApp({ prisma, scriptGenerationEnabled: true, videoScriptsToken: TOKEN });
    const project = await prisma.project.create({ data: { name: 'Regression check', languages: ['fr'],
        editorialInstructions: 'Rester factuel.', verifiedFacts: [{ id: 'business-fact', text: 'Faux fait métier', source: 'Test' }] } });
    const job = await prisma.videoJob.create({ data: { projectId: project.id, subject: 'Promo classique', language: 'fr', width: 1080, height: 1920, fps: 30 } });
    try {
        const response = await app.inject({ method: 'POST', url: `/video-jobs/${job.id}/scripts/generate`, headers, payload: { requestId: randomUUID() } });
        assert.equal(response.statusCode, 202);
        assert.equal(await prisma.videoScriptSource.count({ where: { videoScript: { videoJobId: job.id } } }), 0);
    } finally {
        await prisma.videoScript.deleteMany({ where: { videoJobId: job.id } });
        await prisma.videoJob.delete({ where: { id: job.id } });
        await prisma.project.delete({ where: { id: project.id } });
        await app.close();
        await prisma.$disconnect();
    }
});
