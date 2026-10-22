import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quizTranslations } from '../src/index.js';

test('French and Dutch UI chrome are both fully translated with no empty or shared-by-accident strings', () => {
    const keys = Object.keys(quizTranslations.fr) as (keyof typeof quizTranslations.fr)[];
    assert.deepEqual(keys.sort(), Object.keys(quizTranslations.nl).sort());
    for (const key of keys) {
        assert.ok(quizTranslations.fr[key].length > 0, `fr.${key} must not be empty`);
        assert.ok(quizTranslations.nl[key].length > 0, `nl.${key} must not be empty`);
        assert.notEqual(quizTranslations.fr[key], quizTranslations.nl[key], `nl.${key} should not silently reuse the French copy`);
    }
});
