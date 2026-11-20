import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockContentSourceProvider, mockQuestion, type SourceQuestion } from '@fako/content-sources';
import { QuizVideoRequestError } from '../src/errors.js';
import { selectRijPermisQuestion } from '../src/daily-quiz/select.js';
import type { UsageStats } from '../src/rotation.js';

const other: SourceQuestion = { ...mockQuestion, id: 'mock-2' };

function usage(byQuestion: [string, { count: number; lastUsedAt: Date }][] = [], byCategory: [string, Date][] = []): UsageStats {
    return { byQuestion: new Map(byQuestion), byCategory: new Map(byCategory) };
}

test('an explicit questionId is fetched directly, bypassing selection', async () => {
    const provider = new MockContentSourceProvider([mockQuestion, other]);
    const question = await selectRijPermisQuestion(provider, 'fr', { questionId: 'mock-2' });
    assert.equal(question.id, 'mock-2');
});

test('without usage history, a never-used question is picked over one already used', async () => {
    const provider = new MockContentSourceProvider([mockQuestion, other]);
    const question = await selectRijPermisQuestion(provider, 'fr', { usage: usage([[mockQuestion.id, { count: 1, lastUsedAt: new Date() }]]) });
    assert.equal(question.id, 'mock-2');
});

test('among equally-used questions, the least recently used wins', async () => {
    const provider = new MockContentSourceProvider([mockQuestion, other]);
    const question = await selectRijPermisQuestion(provider, 'fr', { usage: usage([
        [mockQuestion.id, { count: 1, lastUsedAt: new Date('2026-01-01') }],
        [other.id, { count: 1, lastUsedAt: new Date('2026-06-01') }]
    ]) });
    assert.equal(question.id, mockQuestion.id, 'used longer ago, so picked first');
});

test('as a tie-break between equally fresh never-used questions, prefers the less recently used theme', async () => {
    const a: SourceQuestion = { ...mockQuestion, id: 'a', category: 'Priorité' };
    const b: SourceQuestion = { ...mockQuestion, id: 'b', category: 'Signalisation' };
    const provider = new MockContentSourceProvider([a, b]);
    const question = await selectRijPermisQuestion(provider, 'fr', { usage: usage([], [
        ['Priorité', new Date('2026-06-01')], ['Signalisation', new Date('2026-01-01')]
    ]) });
    assert.equal(question.id, 'b', 'Signalisation has gone longer without appearing');
});

test('still returns a question (reuse) when every candidate has already been used, rather than failing', async () => {
    const provider = new MockContentSourceProvider([mockQuestion, other]);
    const question = await selectRijPermisQuestion(provider, 'fr', { usage: usage([
        [mockQuestion.id, { count: 3, lastUsedAt: new Date('2026-01-01') }],
        [other.id, { count: 5, lastUsedAt: new Date('2026-01-01') }]
    ]) });
    assert.equal(question.id, mockQuestion.id, 'fewer uses wins even when nothing is unused');
});

test('paginates through the full catalogue rather than only scoring the first page', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ ...mockQuestion, id: `q-${i}` }));
    const provider = new MockContentSourceProvider(many);
    const question = await selectRijPermisQuestion(provider, 'fr', { usage: usage(many.slice(0, 149).map(q => [q.id, { count: 1, lastUsedAt: new Date() }])) });
    assert.equal(question.id, 'q-149', 'the only never-used question happens to be on the second page');
});

test('refuses when no question at all is available for the language, rather than failing silently', async () => {
    const provider = new MockContentSourceProvider([]);
    await assert.rejects(selectRijPermisQuestion(provider, 'fr'), (e: unknown) => e instanceof QuizVideoRequestError && e.statusCode === 409);
});

test('never selects a question the API refuses to export', async () => {
    const provider = new MockContentSourceProvider([mockQuestion]);
    await assert.rejects(selectRijPermisQuestion(provider, 'fr', { questionId: 'does-not-exist' }),
        (e: unknown) => (e as { statusCode?: number }).statusCode === 404);
});

test('never falls back to another language to pad out a quota', async () => {
    const frOnly: SourceQuestion = { ...mockQuestion, id: 'fr-1', language: 'fr' };
    const provider = new MockContentSourceProvider([frOnly]);
    await assert.rejects(selectRijPermisQuestion(provider, 'nl'), QuizVideoRequestError);
});
