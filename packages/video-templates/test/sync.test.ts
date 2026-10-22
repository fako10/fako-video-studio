import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuizVideoProps, resolveSceneDurations, totalDurationInFrames, type QuizNarration } from '../src/index.js';
import { question } from './helpers.js';

function narrationWith(overrides: Partial<QuizNarration['scenes']>): QuizNarration {
    return { volume: 1, scenes: { intro: null, question: null, countdown: null, reveal: null, explanation: null, outro: null, ...overrides } };
}

test('without narration, resolved durations are byte-for-byte identical to the configured ones (mission 8 stays unchanged)', () => {
    const props = buildQuizVideoProps(question());
    assert.deepEqual(resolveSceneDurations(props), props.durations);
});

test('a narration clip longer than the configured scene extends that scene instead of being cut off', () => {
    const props = buildQuizVideoProps(question({ explanation: null }), { durations: { introSeconds: 1 } });
    const resolved = resolveSceneDurations({ ...props, narration: narrationWith({ intro: { fileName: 'a.mp3', durationSeconds: 4 } }), interSceneSilenceSeconds: 0.35 });
    assert.ok(resolved.introSeconds >= 4.3, `expected the intro to grow to fit a 4s clip, got ${resolved.introSeconds}`);
});

test('a narration clip shorter than the configured scene never shrinks it', () => {
    const props = buildQuizVideoProps(question({ explanation: null }));
    const resolved = resolveSceneDurations({ ...props, narration: narrationWith({ intro: { fileName: 'a.mp3', durationSeconds: 0.2 } }) });
    assert.equal(resolved.introSeconds, props.durations.introSeconds);
});

test('the countdown always completes: its narration can extend it but never shortens it below the configured reflection time', () => {
    const props = buildQuizVideoProps(question({ explanation: null }), { durations: { countdownSeconds: 5 } });
    const resolved = resolveSceneDurations({ ...props, narration: narrationWith({ countdown: { fileName: 'a.mp3', durationSeconds: 1 } }) });
    assert.ok(resolved.countdownSeconds >= 5);
});

test('a short silence is inserted between scenes, but not after the final outro', () => {
    const props = buildQuizVideoProps(question({ explanation: null }));
    const silent = resolveSceneDurations(props);
    const withGap = resolveSceneDurations({ ...props, narration: narrationWith({}), interSceneSilenceSeconds: 0.5 });
    assert.equal(withGap.introSeconds, silent.introSeconds + 0.5);
    assert.equal(withGap.questionSeconds, silent.questionSeconds + 0.5);
    assert.equal(withGap.outroSeconds, silent.outroSeconds, 'no trailing silence after the last scene');
});

test('an absent explanation gets no silence padding of its own even when narration is present', () => {
    const props = buildQuizVideoProps(question({ explanation: null }));
    const resolved = resolveSceneDurations({ ...props, narration: narrationWith({}), interSceneSilenceSeconds: 0.5 });
    assert.equal(resolved.explanationSeconds, 0);
});

test('an existing explanation scene does receive its own padding, matching the other non-final scenes', () => {
    const props = buildQuizVideoProps(question());
    const resolved = resolveSceneDurations({ ...props, narration: narrationWith({ explanation: { fileName: 'e.mp3', durationSeconds: 1 } }), interSceneSilenceSeconds: 0.5 });
    assert.equal(resolved.explanationSeconds, props.durations.explanationSeconds + 0.5);
});

test('totalDurationInFrames composes correctly with the resolved (extended) durations', () => {
    const props = buildQuizVideoProps(question({ explanation: null }), { durations: { introSeconds: 1 }, fps: 25 });
    const withAudio = { ...props, narration: narrationWith({ intro: { fileName: 'a.mp3', durationSeconds: 4 } }), interSceneSilenceSeconds: 0.2 };
    const resolved = resolveSceneDurations(withAudio);
    assert.equal(totalDurationInFrames(resolved, 25), Math.round((resolved.introSeconds + resolved.questionSeconds + resolved.countdownSeconds + resolved.revealSeconds + resolved.explanationSeconds + resolved.outroSeconds) * 25));
    assert.ok(resolved.introSeconds > props.durations.introSeconds);
});
