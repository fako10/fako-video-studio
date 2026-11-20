import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry, dailyQuiz, VideoRequestError, VideoTypeRegistry, type VideoTypeModule } from '../src/index.js';

test('le registre par défaut contient le Quiz du jour', () => {
    const registry = createDefaultRegistry();
    assert.ok(registry.has('daily-quiz'));
    assert.equal(registry.get('daily-quiz'), dailyQuiz);
});

test('un type inconnu est refusé avec une erreur 422', () => {
    assert.throws(() => createDefaultRegistry().get('nope'), (error: unknown) => error instanceof VideoRequestError && error.statusCode === 422);
});

test('les paramètres sont complétés par les valeurs par défaut puis validés', () => {
    const registry = createDefaultRegistry();
    assert.deepEqual(registry.resolveParams('daily-quiz', {}), { hashtags: [], captionIntro: '' });
    assert.deepEqual(registry.resolveParams('daily-quiz', { hashtags: ['permis'] }), { hashtags: ['permis'], captionIntro: '' });
    assert.throws(() => registry.resolveParams('daily-quiz', { inconnu: true }), (error: unknown) => error instanceof VideoRequestError && error.statusCode === 400);
});

test('un nouveau type s\'enregistre sans rien modifier d\'autre, et un identifiant ne peut pas être enregistré deux fois', () => {
    const custom: VideoTypeModule<{ message: string }> = {
        id: 'invitation-test', label: 'Test', description: 'Test', requiresContentSource: false,
        paramsSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
        defaultParams: { message: 'Bonjour' }, defaultDuration: { minSeconds: 20, maxSeconds: 40 },
        prepare: async () => ({ content: {} }), render: async () => ({ durationSeconds: 1 }), caption: () => ({ caption: '', hashtags: [] })
    };
    const registry = new VideoTypeRegistry().register(custom);
    assert.deepEqual(registry.resolveParams('invitation-test', {}), { message: 'Bonjour' });
    assert.throws(() => registry.register(custom));
    assert.throws(() => new VideoTypeRegistry().register({ ...custom, id: 'Bad Id' }));
});

test('la légende du quiz reprend l\'accroche, la question, le site de la marque et les hashtags', () => {
    const caption = dailyQuiz.caption(
        { snapshot: { question: 'Qui a la priorité ?' } } as never,
        { slug: 'rijpermis', name: 'RijPermis', websiteUrl: 'https://rijpermis.be', colors: {} as never },
        { hashtags: ['permis', '#quiz'], captionIntro: 'Quiz du jour !' }
    );
    assert.equal(caption.caption, 'Quiz du jour !\n\nQui a la priorité ?\n\nhttps://rijpermis.be');
    assert.deepEqual(caption.hashtags, ['#permis', '#quiz']);
});
