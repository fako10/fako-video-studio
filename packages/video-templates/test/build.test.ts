import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceQuestion } from '@fako/content-sources';
import { buildQuizVideoProps, QuizTemplateError, totalDurationInFrames } from '../src/index.js';
import { question } from './helpers.js';

test('builds video props from an approved three-option question, preserving identifiers and contentHash verbatim', () => {
    const q = question();
    const props = buildQuizVideoProps(q);
    assert.equal(props.question, q.question);
    assert.deepEqual(props.options.map(o => o.text), q.options.map(o => o.text));
    assert.equal(props.correctOptionId, 'B');
    assert.equal(props.source.questionId, q.id);
    assert.equal(props.source.contentHash, q.contentHash);
    assert.equal(props.source.category, q.category);
    assert.equal(props.language, 'fr');
});

test('a question with four options builds without assuming exactly three', () => {
    const q = question({
        options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }, { id: 'C', text: 'C' }, { id: 'D', text: 'D' }],
        correctOptionIds: ['D']
    });
    const props = buildQuizVideoProps(q);
    assert.equal(props.options.length, 4);
    assert.equal(props.correctOptionId, 'D');
});

test('a Dutch question keeps its own language and does not get translated', () => {
    const q = question({ language: 'nl', question: 'Wie heeft hier voorrang?' });
    assert.equal(buildQuizVideoProps(q).language, 'nl');
    assert.equal(buildQuizVideoProps(q).question, 'Wie heeft hier voorrang?');
});

test('an approved explanation is carried over verbatim, with a non-zero scene duration', () => {
    const props = buildQuizVideoProps(question());
    assert.equal(props.explanation, "La priorité de droite s'applique en l'absence de signalisation.");
    assert.ok(props.durations.explanationSeconds > 0);
});

test('a pending, rejected, or missing explanation never surfaces and never invents one', () => {
    for (const explanation of [null, { text: 'En cours de relecture', status: 'PENDING' as const }, { text: 'Erronée', status: 'REJECTED' as const }]) {
        const props = buildQuizVideoProps(question({ explanation }));
        assert.equal(props.explanation, null);
        assert.equal(props.durations.explanationSeconds, 0);
    }
});

test('a question without an image stays usable and never renders one, even if a stray file name is passed', () => {
    const props = buildQuizVideoProps(question({ image: null }), { imageFileName: 'should-be-ignored.jpg' });
    assert.equal(props.imageFileName, null);
});

test('a question with an image only renders it once it has actually been staged locally', () => {
    const q = question({ image: { filename: '917000.jpg', url: '/api/images/917000.jpg' } });
    assert.equal(buildQuizVideoProps(q).imageFileName, null, 'no staged file provided yet: stay text-only');
    assert.equal(buildQuizVideoProps(q, { imageFileName: 'sha256-abc.jpg' }).imageFileName, 'sha256-abc.jpg');
});

test('refuses a question that is not technically APPROVED, without judging its pedagogy', () => {
    const notApproved = { ...question(), validationStatus: 'PENDING' } as unknown as SourceQuestion;
    assert.throws(() => buildQuizVideoProps(notApproved), (e: unknown) => e instanceof QuizTemplateError && e.code === 'QUESTION_NOT_APPROVED');
});

test('refuses an answer type other than SINGLE_CHOICE instead of guessing how to render it', () => {
    const multi = { ...question(), answerType: 'MULTI_CHOICE' } as unknown as SourceQuestion;
    assert.throws(() => buildQuizVideoProps(multi), (e: unknown) => e instanceof QuizTemplateError && e.code === 'UNSUPPORTED_ANSWER_TYPE');
});

test('refuses a correct answer that does not match any proposition', () => {
    const broken = { ...question(), correctOptionIds: ['Z'] } as unknown as SourceQuestion;
    assert.throws(() => buildQuizVideoProps(broken), (e: unknown) => e instanceof QuizTemplateError && e.code === 'CORRECT_OPTION_NOT_FOUND');
});

test('custom durations, fps and resolution are honored and sum correctly into frames', () => {
    const props = buildQuizVideoProps(question({ explanation: null }), { durations: { introSeconds: 2, questionSeconds: 4, countdownSeconds: 3, revealSeconds: 2, outroSeconds: 2 }, fps: 25, width: 1080, height: 1920 });
    assert.equal(props.fps, 25);
    assert.equal(totalDurationInFrames(props.durations, props.fps), (2 + 4 + 3 + 2 + 0 + 2) * 25);
});

test('rendering defaults target the required vertical 1080x1920 @ 30fps format', () => {
    const props = buildQuizVideoProps(question());
    assert.equal(props.fps, 30);
    assert.equal(props.width, 1080);
    assert.equal(props.height, 1920);
});
