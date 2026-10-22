import { ContentSourceError, parseQuestion, type Language, type QuestionQuery, type SourceQuestion } from './schema.js';
import { contentProviderFromEnv, type ContentSourceProvider } from './provider.js';
export const mockQuestion: SourceQuestion = {
    id: 'mock-1', externalCode: 'MOCK', language: 'fr', category: 'Démonstration', question: 'Quelle proposition est indiquée comme correcte dans ce jeu fictif ?',
    answerType: 'SINGLE_CHOICE', options: [{ id: 'A', text: 'Proposition fictive A' }, { id: 'B', text: 'Proposition fictive B' }, { id: 'C', text: 'Proposition fictive C' }],
    correctOptionIds: ['B'], explanation: null, image: null, regulatoryReferences: [], validationStatus: 'APPROVED', contentHash: `sha256:${'0'.repeat(64)}`
};
export class MockContentSourceProvider implements ContentSourceProvider {
    readonly sourceId = 'rijpermis';
    readonly origin = 'https://mock.invalid';
    constructor(private readonly questions: SourceQuestion[] = [mockQuestion]) {}
    async listQuestions(query: QuestionQuery = {}) {
        const questions = this.questions.map(parseQuestion).filter(q => q.language === (query.language ?? 'fr') && (query.category === undefined || q.category === query.category));
        const page = query.page ?? 0, size = query.size ?? 20;
        return { schemaVersion: '1' as const, items: questions.slice(page * size, (page + 1) * size), page: { number: page, size, hasNext: (page + 1) * size < questions.length } };
    }
    async getQuestion(id: string) {
        const q = this.questions.find(q => q.id === id);
        if (!q) throw new ContentSourceError(404, 'RIJPERMIS_NOT_EXPORTABLE');
        return parseQuestion(q);
    }
    async listThemes(language: Language = 'fr') {
        const counts = new Map<string, number>();
        for (const q of this.questions.map(parseQuestion).filter(q => q.language === language)) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
        return { schemaVersion: '1' as const, items: [...counts].map(([category, count]) => ({ category, count })) };
    }
    async downloadImage(_question: SourceQuestion): Promise<null> { return null; }
}

// Fake questions only; refused in production unless FAKO_ALLOW_MOCK_IN_PRODUCTION=true is ALSO set —
// mission 16's deliberate, explicit double opt-in for a staging deployment that must run under
// NODE_ENV=production (for secure cookies etc.) while still using only mock data. Absent/false is the
// safe default; a real production deployment should never set this.
export function contentSourceFromEnv(env: NodeJS.ProcessEnv = process.env): ContentSourceProvider | undefined {
    if ((env.RIJPERMIS_MOCK_MODE ?? 'false') === 'true') {
        if (env.NODE_ENV === 'production' && env.FAKO_ALLOW_MOCK_IN_PRODUCTION !== 'true') throw new ContentSourceError(503, 'RIJPERMIS_MOCK_MODE_FORBIDDEN_IN_PRODUCTION');
        return new MockContentSourceProvider();
    }
    return contentProviderFromEnv(env);
}
