import type { PrismaClient } from '@prisma/client';
import { checkQuestion, snapshotHash, type ContentSourceProvider, type MediaStorage, type SourceQuestion } from '@fako/content-sources';
import { AIProviderError, type ScriptContent, type ScriptInput } from './ai.js';

export type RijPermisSource = {
    sourceId: string; origin: string; question: SourceQuestion;
    imageKey?: string; imageHash?: string; imageMimeType?: string;
};

// Fetches and downloads outside of any database transaction; DB writes stay local and fast.
export async function prepareRijPermisSource(provider: ContentSourceProvider, storage: MediaStorage, questionId: string): Promise<RijPermisSource> {
    const question = await provider.getQuestion(questionId);
    const source: RijPermisSource = { sourceId: provider.sourceId, origin: provider.origin, question };
    const image = await provider.downloadImage(question);
    if (image) {
        const stored = await storage.writeImage(image.bytes, image.extension);
        source.imageKey = stored.key;
        source.imageHash = stored.hash;
        source.imageMimeType = image.mimeType;
    }
    return source;
}

// Encodes the question as an immutable, source-attributed fact. The exact wording, options and
// correct answer travel verbatim into the AI prompt; generateVideoScript still checks the output
// matches this fact exactly before accepting it (see verifySourcedQuizContent).
export function buildSourceFact(question: SourceQuestion): ScriptInput['facts'][number] {
    const id = `rijpermis-${question.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 100);
    const correct = question.options.find(option => option.id === question.correctOptionIds[0]);
    const options = question.options.map(option => `${option.id}) ${option.text}`).join(' ; ');
    return {
        id, kind: 'ROAD_RULE',
        text: `Question RijPermis officielle, à reproduire mot pour mot, sans reformulation ni traduction : "${question.question}" Propositions : ${options}. Réponse correcte : ${correct ? `${correct.id}) ${correct.text}` : question.correctOptionIds[0]}.`,
        source: `RijPermis, question ${question.externalCode ?? question.id}, statut ${question.validationStatus}, contentHash ${question.contentHash}.`
    };
}

// The AI only supplies narration and framing around a sourced question; it must never alter the
// statement, the propositions or the correct answer. Any deviation fails generation outright.
export function verifySourcedQuizContent(content: ScriptContent, source: SourceQuestion) {
    const quizScenes = content.scenes.filter(scene => scene.quiz);
    if (quizScenes.length !== 1) throw new AIProviderError('SOURCE_CONTENT_MISMATCH');
    const quiz = quizScenes[0].quiz!;
    const correctIndex = source.options.findIndex(option => option.id === source.correctOptionIds[0]);
    const choicesMatch = quiz.choices.length === source.options.length && quiz.choices.every((choice, i) => choice === source.options[i].text);
    if (quiz.question !== source.question || !choicesMatch || quiz.correctAnswerIndex !== correctIndex) {
        throw new AIProviderError('SOURCE_CONTENT_MISMATCH');
    }
}

export type PublicationCheck =
    | { status: 'NOT_SOURCED' }
    | { status: 'CURRENT'; checkedAt: string; contentHash: string }
    | { status: 'CHANGED'; checkedAt: string; contentHash: string }
    | { status: 'WITHDRAWN'; checkedAt: string };

// Re-checks a used question against the live catalogue before a video is published. Not yet wired
// into a publication flow (none exists in this codebase), but exposed as the clear interface the
// future publish step should call before allowing a sourced video out.
export async function verifySourceBeforePublication(prisma: PrismaClient, provider: ContentSourceProvider, videoScriptId: string): Promise<PublicationCheck> {
    const source = await prisma.videoScriptSource.findUnique({ where: { videoScriptId } });
    if (!source) return { status: 'NOT_SOURCED' };
    const result = await checkQuestion(provider, source.snapshot as unknown as SourceQuestion);
    await prisma.videoScriptSource.update({ where: { videoScriptId }, data: {
        checkStatus: result.status, checkedAt: new Date(result.checkedAt),
        ...(result.status !== 'WITHDRAWN' ? { contentHash: result.contentHash } : {})
    } });
    return result as PublicationCheck;
}

export function isPublicationBlocked(check: PublicationCheck): boolean {
    return check.status === 'CHANGED' || check.status === 'WITHDRAWN';
}

export { snapshotHash };
