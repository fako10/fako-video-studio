import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIProviderError } from '../src/ai.js';
import { buildSourceFact, isPublicationBlocked, verifySourcedQuizContent } from '../src/rijpermis.js';

const sourceQuestion = {
    id: '6337', externalCode: 'N-3502-505-2473001', language: 'fr' as const, category: 'Voorrang', question: 'Qui a la priorité ici ?',
    answerType: 'SINGLE_CHOICE' as const, options: [{ id: 'A', text: 'Réponse A' }, { id: 'B', text: 'Réponse B' }, { id: 'C', text: 'Réponse C' }],
    correctOptionIds: ['B'], explanation: null, image: null, regulatoryReferences: [], validationStatus: 'APPROVED' as const, contentHash: `sha256:${'a'.repeat(64)}`
};

function sourcedQuizScript(overrides: Record<string, unknown> = {}) {
    return {
        language: 'fr', title: 'Quiz', hook: 'Prêt ?', narration: 'Un quiz du code de la route.',
        scenes: [{ duration: 20, narration: 'Un quiz du code de la route.', visualDescription: 'Intersection', onScreenText: 'Quiz',
            factIds: [buildSourceFact(sourceQuestion).id],
            quiz: { question: sourceQuestion.question, choices: sourceQuestion.options.map(o => o.text), correctAnswerIndex: 1, explanation: 'Explication rédigée par l\'IA', roadRuleFactIds: [buildSourceFact(sourceQuestion).id] }
        }], onScreenTexts: ['Quiz'], estimatedDuration: 20, ...overrides
    } as never;
}

test('buildSourceFact embeds the exact question, options and correct answer, tagged as a road rule', () => {
    const fact = buildSourceFact(sourceQuestion);
    assert.equal(fact.kind, 'ROAD_RULE');
    assert.match(fact.id, /^[a-z0-9-]+$/);
    assert.match(fact.text, /Qui a la priorité ici \?/);
    assert.match(fact.text, /B\) Réponse B/);
    assert.match(fact.source, /contentHash sha256:a{64}/);
});

test('buildSourceFact sanitizes ids that are not already lowercase kebab-case', () => {
    const fact = buildSourceFact({ ...sourceQuestion, id: 'N_3502-505' });
    assert.match(fact.id, /^[a-z0-9-]+$/);
});

test('verifySourcedQuizContent accepts an exact reproduction of the source question', () => {
    assert.doesNotThrow(() => verifySourcedQuizContent(sourcedQuizScript(), sourceQuestion));
});

test('verifySourcedQuizContent rejects a reworded question, altered options or a changed answer', () => {
    const base = sourcedQuizScript();
    const reworded = { ...base, scenes: [{ ...base.scenes[0], quiz: { ...base.scenes[0].quiz, question: 'Une autre question ?' } }] };
    assert.throws(() => verifySourcedQuizContent(reworded, sourceQuestion), AIProviderError);
    const reordered = { ...base, scenes: [{ ...base.scenes[0], quiz: { ...base.scenes[0].quiz, choices: ['Réponse B', 'Réponse A', 'Réponse C'], correctAnswerIndex: 0 } }] };
    assert.throws(() => verifySourcedQuizContent(reordered, sourceQuestion), AIProviderError);
    const wrongAnswer = { ...base, scenes: [{ ...base.scenes[0], quiz: { ...base.scenes[0].quiz, correctAnswerIndex: 0 } }] };
    assert.throws(() => verifySourcedQuizContent(wrongAnswer, sourceQuestion), AIProviderError);
});

test('verifySourcedQuizContent requires exactly one quiz scene for a sourced question', () => {
    const base = sourcedQuizScript();
    assert.throws(() => verifySourcedQuizContent({ ...base, scenes: [{ ...base.scenes[0], quiz: null }] }, sourceQuestion), AIProviderError);
    assert.throws(() => verifySourcedQuizContent({ ...base, scenes: [...base.scenes, base.scenes[0]] }, sourceQuestion), AIProviderError);
});

test('isPublicationBlocked flags only CHANGED and WITHDRAWN, never a merely unsourced or current script', () => {
    assert.equal(isPublicationBlocked({ status: 'NOT_SOURCED' }), false);
    assert.equal(isPublicationBlocked({ status: 'CURRENT', checkedAt: new Date().toISOString(), contentHash: 'sha256:x' }), false);
    assert.equal(isPublicationBlocked({ status: 'CHANGED', checkedAt: new Date().toISOString(), contentHash: 'sha256:y' }), true);
    assert.equal(isPublicationBlocked({ status: 'WITHDRAWN', checkedAt: new Date().toISOString() }), true);
});
