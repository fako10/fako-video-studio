import { resolve } from 'node:path';
import { MockContentSourceProvider, mockQuestion, type SourceQuestion } from '@fako/content-sources';
import { buildQuizVideoProps } from '@fako/video-templates';
import { renderQuizVideo } from './render.js';

// Clearly-fictional mock data only (see mission 7's mode mock) — no real RijPermis question is
// fetched here, and no ElevenLabs/OpenAI call is made.
const dutchMockQuestion: SourceQuestion = {
    ...mockQuestion, id: 'mock-2', externalCode: 'MOCK-NL', language: 'nl', category: 'Demonstratie',
    question: 'Welke optie is in deze fictieve dataset als correct gemarkeerd?',
    options: [{ id: 'A', text: 'Fictieve optie A' }, { id: 'B', text: 'Fictieve optie B' }, { id: 'C', text: 'Fictieve optie C' }],
    correctOptionIds: ['C'], explanation: { text: 'Demonstratieve, niet-officiële uitleg voor deze mock-vraag.', status: 'APPROVED' }
};

const provider = new MockContentSourceProvider([mockQuestion, dutchMockQuestion]);
const outputDir = resolve(import.meta.dirname, '../../../storage/videos');

async function renderDemo(questionId: string, fileName: string) {
    const question = await provider.getQuestion(questionId);
    const props = buildQuizVideoProps(question);
    const { outputPath } = await renderQuizVideo(props, { outputPath: resolve(outputDir, fileName) });
    console.log(`[${props.language}] ${outputPath}`);
}

await renderDemo(mockQuestion.id, 'quiz-du-jour-demo-fr.mp4');
await renderDemo(dutchMockQuestion.id, 'quiz-du-jour-demo-nl.mp4');
