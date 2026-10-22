import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachNarration, buildQuizVideoProps, QuizTemplateError, validateQuizVideoProps, type QuizNarration } from '../src/index.js';
import { question } from './helpers.js';

function validProps() { return buildQuizVideoProps(question()); }
function silentNarration(overrides: Partial<QuizNarration['scenes']> = {}): QuizNarration {
    return { volume: 1, scenes: { intro: null, question: null, countdown: null, reveal: null, explanation: null, outro: null, ...overrides } };
}

test('a well-formed props object round-trips through validation unchanged', () => {
    const props = validProps();
    assert.deepEqual(validateQuizVideoProps(props), props);
});

test('rejects duplicate option ids even if they slipped past the content source', () => {
    const props = validProps();
    const broken = { ...props, options: [props.options[0], { ...props.options[0] }] };
    assert.throws(() => validateQuizVideoProps(broken), (e: unknown) => e instanceof QuizTemplateError && e.code === 'DUPLICATE_OPTION_IDS');
});

test('rejects a correct option id that matches nothing in the options list', () => {
    const props = validProps();
    assert.throws(() => validateQuizVideoProps({ ...props, correctOptionId: 'does-not-exist' }),
        (e: unknown) => e instanceof QuizTemplateError && e.code === 'CORRECT_OPTION_NOT_FOUND');
});

test('rejects an explanation scene with no text to show', () => {
    const props = buildQuizVideoProps(question({ explanation: null }));
    assert.throws(() => validateQuizVideoProps({ ...props, durations: { ...props.durations, explanationSeconds: 4 } }),
        (e: unknown) => e instanceof QuizTemplateError && e.code === 'INCONSISTENT_EXPLANATION_DURATION');
});

test('rejects a present explanation with a zero-length scene', () => {
    const props = validProps();
    assert.throws(() => validateQuizVideoProps({ ...props, durations: { ...props.durations, explanationSeconds: 0 } }),
        (e: unknown) => e instanceof QuizTemplateError && e.code === 'INCONSISTENT_EXPLANATION_DURATION');
});

test('rejects a single-option question, never assuming at least three propositions but still requiring a real choice', () => {
    const props = validProps();
    assert.throws(() => validateQuizVideoProps({ ...props, options: [props.options[0]], correctOptionId: props.options[0].id }));
});

test('rejects an unsupported schema version', () => {
    const props = validProps();
    assert.throws(() => validateQuizVideoProps({ ...props, schemaVersion: 2 }), QuizTemplateError);
});

test('rejects an unknown extra field', () => {
    const props = validProps();
    assert.throws(() => validateQuizVideoProps({ ...props, extra: true }), QuizTemplateError);
});

test('rejects a negative or zero duration for a mandatory scene', () => {
    const props = validProps();
    for (const key of ['introSeconds', 'questionSeconds', 'countdownSeconds', 'revealSeconds', 'outroSeconds'] as const) {
        assert.throws(() => validateQuizVideoProps({ ...props, durations: { ...props.durations, [key]: 0 } }), QuizTemplateError);
    }
});

test('rejects a non-sha256 contentHash on the traced source', () => {
    const props = validProps();
    assert.throws(() => validateQuizVideoProps({ ...props, source: { ...props.source, contentHash: 'not-a-hash' } }), QuizTemplateError);
});

test('attachNarration accepts a fully silent narration object and defaults a short inter-scene silence', () => {
    const quiz = attachNarration(buildQuizVideoProps(question({ explanation: null })), silentNarration());
    assert.equal(quiz.narration?.volume, 1);
    assert.ok(quiz.interSceneSilenceSeconds > 0);
    assert.equal(quiz.backgroundMusic, null);
});

test('rejects narration audio for an explanation the question does not have', () => {
    const props = buildQuizVideoProps(question({ explanation: null }));
    assert.throws(() => attachNarration(props, silentNarration({ explanation: { fileName: 'x.mp3', durationSeconds: 1 } })),
        (e: unknown) => e instanceof QuizTemplateError && e.code === 'INCONSISTENT_NARRATION_EXPLANATION');
});

test('rejects a missing explanation narration when the question does have an approved explanation', () => {
    const props = validProps();
    assert.throws(() => attachNarration(props, silentNarration()),
        (e: unknown) => e instanceof QuizTemplateError && e.code === 'INCONSISTENT_NARRATION_EXPLANATION');
});

test('accepts explicit optional background music with its own independent volume', () => {
    const props = buildQuizVideoProps(question({ explanation: null }));
    const quiz = attachNarration(props, silentNarration(), { backgroundMusic: { fileName: 'track.mp3', volume: 0.1 } });
    assert.deepEqual(quiz.backgroundMusic, { fileName: 'track.mp3', volume: 0.1 });
});
