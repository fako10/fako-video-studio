import { Ajv } from 'ajv';
export type Language = 'fr' | 'nl';
export type SourceQuestion = {
    id: string; externalCode?: string | null; language: Language; category: string; question: string;
    answerType: 'SINGLE_CHOICE'; options: { id: string; text: string }[]; correctOptionIds: string[];
    explanation?: { text: string; status: 'APPROVED' | 'PENDING' | 'REJECTED' } | null;
    image?: { filename: string; url: string } | null;
    regulatoryReferences: { articleRef: string; sourceUrlFr?: string | null; sourceUrlNl?: string | null }[];
    validationStatus: 'APPROVED'; contentHash: string;
};
export type QuestionQuery = { language?: Language; category?: string; page?: number; size?: number };
export type QuestionPage = { schemaVersion: '1'; items: SourceQuestion[]; page: { number: number; size: number; hasNext: boolean } };
export type ThemeList = { schemaVersion: '1'; items: { category: string; count: number }[] };
export class ContentSourceError extends Error {
    constructor(public readonly statusCode: number, public readonly code: string, public readonly retryAfter?: number) { super(code); }
}
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
export const questionSchema = {
    type: 'object', additionalProperties: false,
    required: ['id', 'language', 'category', 'question', 'answerType', 'options', 'correctOptionIds', 'regulatoryReferences', 'validationStatus', 'contentHash'],
    properties: {
        id: { ...text(100), pattern: '^[A-Za-z0-9_-]+$' }, externalCode: nullable(text(200)), language: { enum: ['fr', 'nl'] }, category: text(300), question: text(10000),
        answerType: { const: 'SINGLE_CHOICE' }, options: { type: 'array', minItems: 2, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { ...text(100), pattern: '^[A-Za-z0-9_-]+$' }, text: text(5000) } } },
        correctOptionIds: { type: 'array', minItems: 1, maxItems: 1, items: text(100) },
        explanation: nullable({ type: 'object', additionalProperties: false, required: ['text', 'status'], properties: { text: text(10000), status: { enum: ['APPROVED', 'PENDING', 'REJECTED'] } } }),
        image: nullable({ type: 'object', additionalProperties: false, required: ['filename', 'url'], properties: { filename: text(300), url: text(2048) } }),
        regulatoryReferences: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['articleRef'], properties: { articleRef: text(2000), sourceUrlFr: nullable(text(2048)), sourceUrlNl: nullable(text(2048)) } } },
        validationStatus: { const: 'APPROVED' }, contentHash: { type: 'string', pattern: '^sha256:[a-fA-F0-9]{64}$' }
    }
};
const ajv = new Ajv({ strict: true });
const validateQuestion = ajv.compile(questionSchema);
const validatePage = ajv.compile({ type: 'object', additionalProperties: false, required: ['schemaVersion', 'items', 'page'], properties: {
    schemaVersion: { const: '1' }, items: { type: 'array', maxItems: 100, items: questionSchema }, page: { type: 'object', additionalProperties: false, required: ['number', 'size', 'hasNext'], properties: { number: { type: 'integer', minimum: 0 }, size: { type: 'integer', minimum: 1, maximum: 100 }, hasNext: { type: 'boolean' } } }
} });
const validateThemes = ajv.compile({ type: 'object', additionalProperties: false, required: ['schemaVersion', 'items'], properties: { schemaVersion: { const: '1' }, items: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['category', 'count'], properties: { category: text(300), count: { type: 'integer', minimum: 0 } } } } } });
function invalid(): never { throw new ContentSourceError(502, 'RIJPERMIS_INVALID_RESPONSE'); }
export function parseQuestion(value: unknown): SourceQuestion {
    if (!validateQuestion(value)) return invalid();
    const q = value as SourceQuestion;
    if (new Set(q.options.map(o => o.id)).size !== q.options.length || !q.options.some(o => o.id === q.correctOptionIds[0])) return invalid();
    for (const ref of q.regulatoryReferences) for (const url of [ref.sourceUrlFr, ref.sourceUrlNl]) {
        if (url) { try { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password) return invalid(); } catch { return invalid(); } }
    }
    return structuredClone(q);
}
export function parsePage(value: unknown, query: QuestionQuery): QuestionPage {
    if (!validatePage(value)) return invalid();
    const page = value as QuestionPage;
    if (page.page.number !== (query.page ?? 0) || page.page.size !== (query.size ?? 20) || page.items.length > page.page.size || new Set(page.items.map(q => q.id)).size !== page.items.length) return invalid();
    page.items = page.items.map(parseQuestion);
    if (page.items.some(q => q.language !== (query.language ?? 'fr') || (query.category !== undefined && q.category !== query.category))) return invalid();
    return page;
}
export function parseThemes(value: unknown): ThemeList {
    if (!validateThemes(value)) return invalid();
    const themes = value as ThemeList;
    if (new Set(themes.items.map(t => t.category)).size !== themes.items.length) return invalid();
    return structuredClone(themes);
}
