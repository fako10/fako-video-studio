import { resolve } from 'node:path';
import { CachingTTSProvider, LocalAudioCacheStore, MockTTSProvider } from '@fako/ai-providers';
import { MockContentSourceProvider, mockQuestion, type SourceQuestion } from '@fako/content-sources';
import { attachNarration, buildQuizVideoProps } from '@fako/video-templates';
import { renderQuizVideo, defaultPublicDir } from './render.js';
import { synthesizeQuizNarration, type VoicesByLanguage } from './narrate.js';

// Mock content and mock voices only — no ElevenLabs or OpenAI call is made. See mission 7's mode mock.
const dutchMockQuestion: SourceQuestion = {
    ...mockQuestion, id: 'mock-2', externalCode: 'MOCK-NL', language: 'nl', category: 'Demonstratie',
    question: 'Welke optie is in deze fictieve dataset als correct gemarkeerd?',
    options: [{ id: 'A', text: 'Fictieve optie A' }, { id: 'B', text: 'Fictieve optie B' }, { id: 'C', text: 'Fictieve optie C' }],
    correctOptionIds: ['C'], explanation: { text: 'Demonstratieve, niet-officiële uitleg voor deze mock-vraag.', status: 'APPROVED' }
};

const provider = new MockContentSourceProvider([mockQuestion, dutchMockQuestion]);
const outputDir = resolve(import.meta.dirname, '../../../storage/videos');
const cacheDir = resolve(import.meta.dirname, '../../../storage/audio-cache');
const tts = new CachingTTSProvider(new MockTTSProvider(), new LocalAudioCacheStore(cacheDir));
const voices: VoicesByLanguage = {
    fr: { voiceId: 'mock-fr-voice', model: 'eleven_multilingual_v2' },
    nl: { voiceId: 'mock-nl-voice', model: 'eleven_multilingual_v2' }
};

async function renderDemo(questionId: string, fileName: string) {
    const question = await provider.getQuestion(questionId);
    const silent = buildQuizVideoProps(question);
    const narration = await synthesizeQuizNarration(silent, tts, voices, defaultPublicDir);
    const narrated = attachNarration(silent, narration);
    const { outputPath } = await renderQuizVideo(narrated, { outputPath: resolve(outputDir, fileName) });
    console.log(`[${narrated.language}] ${outputPath}`);
}

await renderDemo(mockQuestion.id, 'quiz-du-jour-narrated-fr.mp4');
await renderDemo(dutchMockQuestion.id, 'quiz-du-jour-narrated-nl.mp4');
