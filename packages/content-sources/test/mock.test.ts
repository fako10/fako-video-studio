import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentSourceError } from '../src/schema.js';
import { contentSourceFromEnv, MockContentSourceProvider, mockQuestion } from '../src/mock.js';
import { question } from './helpers.js';

test('mock provider paginates, filters by language and category, and lists themes without any network access', async () => {
    const mock = new MockContentSourceProvider([
        mockQuestion,
        question({ id: 'q-nl-1', language: 'nl', category: 'Snelheid' }) as never,
        question({ id: 'q-fr-2', category: 'Autre' }) as never
    ]);
    const frPage = await mock.listQuestions({ language: 'fr', size: 1 });
    assert.equal(frPage.items.length, 1);
    assert.equal(frPage.page.hasNext, true);
    const nextPage = await mock.listQuestions({ language: 'fr', size: 1, page: 1 });
    assert.equal(nextPage.items.length, 1);
    assert.equal(nextPage.page.hasNext, false);
    const category = await mock.listQuestions({ language: 'fr', category: 'Démonstration' });
    assert.equal(category.items.length, 1);
    const themes = await mock.listThemes('nl');
    assert.deepEqual(themes.items, [{ category: 'Snelheid', count: 1 }]);
});

test('mock provider exposes a question with no image and no explanation', async () => {
    const mock = new MockContentSourceProvider();
    const q = await mock.getQuestion(mockQuestion.id);
    assert.equal(q.image, null);
    assert.equal(q.explanation, null);
    assert.equal(await mock.downloadImage(q), null);
});

test('mock provider returns 404-style errors for unknown or withdrawn questions', async () => {
    const mock = new MockContentSourceProvider();
    await assert.rejects(mock.getQuestion('missing'), (e: unknown) => e instanceof ContentSourceError && e.statusCode === 404);
});

test('an empty mock catalogue is a valid result, not a failure', async () => {
    const mock = new MockContentSourceProvider([]);
    assert.deepEqual((await mock.listQuestions()).items, []);
    assert.deepEqual((await mock.listThemes()).items, []);
});

test('contentSourceFromEnv is disabled by default and never activates mock mode accidentally', () => {
    assert.equal(contentSourceFromEnv({}), undefined);
    assert.equal(contentSourceFromEnv({ RIJPERMIS_API_ENABLED: 'false' }), undefined);
});

test('contentSourceFromEnv returns the mock provider only outside production', () => {
    const mock = contentSourceFromEnv({ RIJPERMIS_MOCK_MODE: 'true', NODE_ENV: 'test' });
    assert.ok(mock instanceof MockContentSourceProvider);
    assert.ok(contentSourceFromEnv({ RIJPERMIS_MOCK_MODE: 'true', NODE_ENV: 'development' }) instanceof MockContentSourceProvider);
});

test('contentSourceFromEnv refuses mock mode in production even if explicitly requested', () => {
    assert.throws(() => contentSourceFromEnv({ RIJPERMIS_MOCK_MODE: 'true', NODE_ENV: 'production' }), /RIJPERMIS_MOCK_MODE_FORBIDDEN_IN_PRODUCTION/);
});

// Mission 16: a staging deployment needs NODE_ENV=production (secure cookies) while staying mock-only
// — FAKO_ALLOW_MOCK_IN_PRODUCTION is the explicit, separate opt-in that lifts this one guard, nothing else.
test('contentSourceFromEnv allows mock mode in production only with the explicit FAKO_ALLOW_MOCK_IN_PRODUCTION opt-in', () => {
    assert.ok(contentSourceFromEnv({ RIJPERMIS_MOCK_MODE: 'true', NODE_ENV: 'production', FAKO_ALLOW_MOCK_IN_PRODUCTION: 'true' }) instanceof MockContentSourceProvider);
    assert.throws(() => contentSourceFromEnv({ RIJPERMIS_MOCK_MODE: 'true', NODE_ENV: 'production', FAKO_ALLOW_MOCK_IN_PRODUCTION: 'false' }), /RIJPERMIS_MOCK_MODE_FORBIDDEN_IN_PRODUCTION/);
});

test('contentSourceFromEnv builds the real connector when enabled and not in mock mode', () => {
    const real = contentSourceFromEnv({ RIJPERMIS_API_ENABLED: 'true', RIJPERMIS_API_BASE_URL: 'https://rijpermis.example', RIJPERMIS_API_KEY: 'k' });
    assert.equal(real?.sourceId, 'rijpermis');
    assert.throws(() => contentSourceFromEnv({ RIJPERMIS_API_ENABLED: 'true' }), ContentSourceError);
});
