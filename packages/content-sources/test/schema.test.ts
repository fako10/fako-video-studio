import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentSourceError, parsePage, parseQuestion, parseThemes } from '../src/schema.js';
import { page, question } from './helpers.js';

test('a well-formed approved question with three options parses unchanged', () => {
    const parsed = parseQuestion(question());
    assert.equal(parsed.id, '6337');
    assert.equal(parsed.correctOptionIds[0], 'B');
    assert.equal(parsed.options.length, 3);
});

test('a well-formed question with four options also parses; exact option count is never assumed', () => {
    const q = question({ options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }, { id: 'C', text: 'C' }, { id: 'D', text: 'D' }], correctOptionIds: ['D'] });
    assert.equal(parseQuestion(q).options.length, 4);
});

test('a question without explanation or image is valid', () => {
    const parsed = parseQuestion(question({ explanation: null, image: null }));
    assert.equal(parsed.explanation, null);
    assert.equal(parsed.image, null);
});

for (const [label, overrides] of [
    ['missing id', { id: undefined }],
    ['empty question text', { question: '' }],
    ['no options', { options: [] }],
    ['duplicate option ids', { options: [{ id: 'A', text: 'x' }, { id: 'A', text: 'y' }], correctOptionIds: ['A'] }],
    ['correct answer referencing no option', { correctOptionIds: ['Z'] }],
    ['validationStatus not APPROVED', { validationStatus: 'PENDING' }],
    ['missing contentHash', { contentHash: undefined }],
    ['malformed contentHash', { contentHash: 'not-a-hash' }],
    ['unsupported answerType', { answerType: 'MULTI_CHOICE' }],
    ['unknown extra field', { extra: 'nope' }],
    ['insecure regulatory reference URL', { regulatoryReferences: [{ articleRef: 'Art. 1', sourceUrlFr: 'http://insecure.example/x' }] }]
] as const) {
    test(`rejects: ${label}`, () => {
        assert.throws(() => parseQuestion(question(overrides as Record<string, unknown>)), ContentSourceError);
    });
}

test('an empty page of results is a valid, non-error outcome', () => {
    const parsed = parsePage(page([]), {});
    assert.deepEqual(parsed.items, []);
});

test('rejects an unsupported schemaVersion', () => {
    assert.throws(() => parsePage({ ...page(), schemaVersion: '2' }, {}), ContentSourceError);
});

test('rejects invalid JSON-shaped payloads (not an object, arrays, null)', () => {
    for (const value of [null, 'string', 42, [], undefined]) assert.throws(() => parsePage(value, {}), ContentSourceError);
});

test('a page must echo back the requested paging, language and category', () => {
    assert.throws(() => parsePage(page([question()], { page: { number: 1 } }), { page: 0 }), ContentSourceError);
    assert.throws(() => parsePage(page([question({ language: 'nl' })]), { language: 'fr' }), ContentSourceError);
    assert.throws(() => parsePage(page([question({ category: 'Autre' })]), { category: 'Voorrang' }), ContentSourceError);
});

test('rejects duplicate question ids within a page', () => {
    assert.throws(() => parsePage(page([question(), question()]), {}), ContentSourceError);
});

test('themes list parses and rejects duplicate categories', () => {
    const themes = parseThemes({ schemaVersion: '1', items: [{ category: 'Voorrang', count: 3 }] });
    assert.equal(themes.items[0].count, 3);
    assert.throws(() => parseThemes({ schemaVersion: '1', items: [{ category: 'A', count: 1 }, { category: 'A', count: 2 }] }), ContentSourceError);
});
