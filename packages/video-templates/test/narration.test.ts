import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuizNarration, buildQuizVideoProps } from '../src/index.js';
import { question } from './helpers.js';

test('French narration reads the category, question, options and answer verbatim', () => {
    const q = question();
    const texts = buildQuizNarration(buildQuizVideoProps(q));
    assert.match(texts.question, /Priorité/);
    assert.match(texts.question, new RegExp(q.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(texts.question, /Le véhicule de droite/);
    assert.match(texts.reveal, /La bonne réponse est B : Le véhicule de droite/);
    assert.match(texts.outro, /rijpermis\.be/);
});

test('Dutch narration uses Dutch phrasing, never French, and keeps the Dutch question verbatim', () => {
    const q = question({ language: 'nl', question: 'Wie heeft hier voorrang?', category: 'Voorrang' });
    const texts = buildQuizNarration(buildQuizVideoProps(q));
    assert.match(texts.intro, /quiz van de dag/);
    assert.match(texts.question, /Wie heeft hier voorrang\?/);
    assert.match(texts.countdown, /seconden/);
    assert.doesNotMatch(texts.countdown, /secondes/);
    assert.match(texts.reveal, /Het juiste antwoord is/);
    assert.match(texts.outro, /Oefen verder op/);
});

test('narration never invents an explanation when none was approved', () => {
    const texts = buildQuizNarration(buildQuizVideoProps(question({ explanation: null })));
    assert.equal(texts.explanation, null);
});

test('narration reuses the approved explanation text verbatim', () => {
    const q = question();
    const texts = buildQuizNarration(buildQuizVideoProps(q));
    assert.equal(texts.explanation, q.explanation!.text);
});

test('the spoken countdown number matches the configured countdown duration', () => {
    const texts = buildQuizNarration(buildQuizVideoProps(question(), { durations: { countdownSeconds: 5 } }));
    assert.match(texts.countdown, /5 secondes/);
});
