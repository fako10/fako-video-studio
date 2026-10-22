import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIProviderError, estimatedCost, OpenAIProvider, parseScript, type ScriptInput } from '../src/ai.js';

const input: ScriptInput = {
    projectName: 'RijPermis', instructions: 'Use verified facts', facts: [{ id: 'daily', text: 'Daily group exam', source: 'Owner' }],
    subject: 'Daily exam', language: 'fr', targetDuration: 30, format: 'VERTICAL', contentType: 'PROMOTION'
};
function content() { return { language: 'fr', title: 'Examen du jour', hook: 'Prêt ?', narration: 'Un examen commun.',
    scenes: [{ duration: 30, narration: 'Un examen commun.', visualDescription: 'Groupe', onScreenText: 'Ensemble', factIds: ['daily'], quiz: null }],
    onScreenTexts: ['Ensemble'], estimatedDuration: 30 }; }

test('structured scripts validate language, duration, scene consistency and verified references', () => {
    assert.equal(parseScript(JSON.stringify(content()), input).estimatedDuration, 30);
    for (const invalid of [
        { ...content(), language: 'nl' }, { ...content(), estimatedDuration: 40 },
        { ...content(), narration: 'Different narration' }, { ...content(), onScreenTexts: ['Different'] },
        { ...content(), unexpected: true }, { ...content(), scenes: [{ ...content().scenes[0], factIds: ['invented'] }] }
    ]) assert.throws(() => parseScript(JSON.stringify(invalid), input), AIProviderError);
    assert.throws(() => parseScript('not JSON', input), /INVALID_JSON/);
});

test('OpenAI transport uses strict Responses JSON schema, no storage, and exposes usage', async () => {
    let calls = 0;
    const transport = (async (url: string | URL | Request, options?: RequestInit) => {
        calls++;
        assert.equal(url, 'https://api.openai.com/v1/responses');
        const body = JSON.parse(options!.body as string);
        assert.equal(body.text.format.strict, true);
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.store, false);
        assert.equal(body.tools, undefined);
        assert.match(body.instructions, /Never invent/);
        return new Response(JSON.stringify({ id: 'resp_mock', model: 'test-model', status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(content()) }] }],
            usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20 } }
        }));
    }) as typeof fetch;
    const provider = new OpenAIProvider('fake-test-key', 'test-model', 1000, transport);
    const result = await provider.generate(input);
    assert.equal(result.usage?.cachedInputTokens, 20);
    assert.equal(result.responseId, 'resp_mock');
    assert.equal(parseScript(result.text, input).title, 'Examen du jour');
    assert.equal(calls, 1);
});

test('transient HTTP failures may retry; authentication errors and refusals do not', async () => {
    for (const status of [401, 429, 500]) {
        const provider = new OpenAIProvider('fake', 'test', 1000, (async () => new Response('{}', { status })) as typeof fetch);
        await assert.rejects(provider.generate(input), (error: unknown) => error instanceof AIProviderError && error.retryable === (status !== 401));
    }
    const provider = new OpenAIProvider('fake', 'test', 1000, (async () => new Response(JSON.stringify({
        status: 'completed', model: 'test', usage: { input_tokens: 10, output_tokens: 2 },
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Unsupported topic' }] }]
    }))) as typeof fetch);
    await assert.rejects(provider.generate(input), (error: unknown) => error instanceof AIProviderError && error.code === 'AI_REFUSAL' && error.result?.usage?.inputTokens === 10);
});

test('cost remains unknown without matching configured prices and token counts', () => {
    assert.equal(estimatedCost({ inputTokens: 100, outputTokens: 20 }, 'model'), null);
    const prices = { model: 'model', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 1 };
    assert.equal(estimatedCost({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 20 }, 'model', prices), 0.00038);
    assert.equal(estimatedCost({ inputTokens: 100, outputTokens: 20 }, 'different-model', prices), null);
});

test('quiz answers require explicit road-rule sources and a valid answer index', () => {
    const quiz = { ...content(), scenes: [{ ...content().scenes[0], factIds: ['test-rule'], quiz: {
        question: 'Question fictive de test ?', choices: ['A', 'B'], correctAnswerIndex: 0,
        explanation: 'Donnée fictive de test', roadRuleFactIds: ['test-rule']
    } }] };
    const quizInput: ScriptInput = { ...input, contentType: 'QUIZ', facts: [{ id: 'test-rule', text: 'Fixture only', source: 'Test fixture', kind: 'ROAD_RULE' }] };
    assert.equal(parseScript(JSON.stringify(quiz), quizInput).scenes[0].quiz?.correctAnswerIndex, 0);
    assert.throws(() => parseScript(JSON.stringify(quiz), { ...quizInput, facts: [{ ...quizInput.facts[0], kind: 'BUSINESS' }] }), /INVALID_OR_UNSOURCED_QUIZ/);
    quiz.scenes[0].quiz.correctAnswerIndex = 3;
    assert.throws(() => parseScript(JSON.stringify(quiz), quizInput), /INVALID_OR_UNSOURCED_QUIZ/);
});

test('transport timeout never automatically retries a potentially billed request', async () => {
    const provider = new OpenAIProvider('fake', 'test', 1000, (async () => { throw new Error('timeout'); }) as typeof fetch);
    await assert.rejects(provider.generate(input), (error: unknown) => error instanceof AIProviderError && !error.retryable && error.code === 'AI_CONNECTION_OR_TIMEOUT');
});
