import type { ContentSourceProvider, Language, SourceQuestion } from '@fako/content-sources';
import { QuizVideoRequestError } from '../errors.js';
import type { UsageStats } from './rotation.js';

export type SelectQuestionOptions = { questionId?: string; usage?: UsageStats };

// A safety cap, not an expected size: real catalogues are not expected to need more than this many
// pages, and an unbounded loop must never be possible regardless of what a provider returns.
const MAX_CATALOGUE_PAGES = 10;

async function listFullCatalogue(provider: ContentSourceProvider, language: Language): Promise<SourceQuestion[]> {
    const all: SourceQuestion[] = [];
    for (let page = 0; page < MAX_CATALOGUE_PAGES; page++) {
        const result = await provider.listQuestions({ language, page, size: 100 });
        all.push(...result.items);
        if (!result.page.hasNext) break;
    }
    return all;
}

// An explicit questionId always wins. Otherwise: never-used questions first; among equally-used
// ones, the least recently used; and as a final tie-break, whichever theme/category has gone
// longest without appearing, for diversity. Strictly scoped to `language` — this never falls back
// across languages to pad out a quota, and never fabricates a question when the catalogue is empty.
export async function selectRijPermisQuestion(provider: ContentSourceProvider, language: Language, options: SelectQuestionOptions = {}): Promise<SourceQuestion> {
    if (options.questionId) return provider.getQuestion(options.questionId);
    const catalogue = await listFullCatalogue(provider, language);
    if (!catalogue.length) throw new QuizVideoRequestError(409, `No RijPermis question available for language "${language}"`);

    const byQuestion = options.usage?.byQuestion ?? new Map();
    const byCategory = options.usage?.byCategory ?? new Map();
    const scored = catalogue.map(question => {
        const usage = byQuestion.get(question.id);
        return {
            question,
            count: usage?.count ?? 0,
            lastUsedAt: usage?.lastUsedAt.getTime() ?? 0,
            categoryLastUsedAt: byCategory.get(question.category)?.getTime() ?? 0
        };
    });
    scored.sort((a, b) => a.count - b.count || a.lastUsedAt - b.lastUsedAt || a.categoryLastUsedAt - b.categoryLastUsedAt);
    return scored[0].question;
}
