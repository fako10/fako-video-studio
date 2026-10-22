import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { ContentSourceError, parsePage, parseQuestion, parseThemes, type Language, type QuestionPage, type QuestionQuery, type SourceQuestion, type ThemeList } from './schema.js';
export interface ContentSourceProvider {
    readonly sourceId: string;
    readonly origin: string;
    listQuestions(query?: QuestionQuery): Promise<QuestionPage>;
    getQuestion(id: string): Promise<SourceQuestion>;
    listThemes(language?: Language): Promise<ThemeList>;
    downloadImage(question: SourceQuestion): Promise<{ bytes: Buffer; mimeType: string; extension: 'jpg' | 'png' | 'webp' } | null>;
}
type Options = { baseUrl: string; apiKey: string; environment?: string; timeoutMs?: number; attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<unknown> };
export function imageUrl(origin: string, relative: string): URL {
    // Only the API's image namespace on the configured origin. No arbitrary fetch destination, redirects or credentials.
    if (!/^\/api\/images\/[A-Za-z0-9_.-]+$/.test(relative) || relative.includes('..')) throw new ContentSourceError(502, 'RIJPERMIS_UNSAFE_IMAGE_URL');
    const url = new URL(relative, origin);
    if (url.origin !== origin) throw new ContentSourceError(502, 'RIJPERMIS_UNSAFE_IMAGE_URL');
    return url;
}
export function imageType(bytes: Buffer, contentType: string) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (mime === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return { mimeType: mime, extension: 'jpg' as const };
    if (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: mime, extension: 'png' as const };
    if (mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { mimeType: mime, extension: 'webp' as const };
    throw new ContentSourceError(502, 'RIJPERMIS_INVALID_IMAGE');
}
export class RijPermisContentProvider implements ContentSourceProvider {
    readonly sourceId = 'rijpermis';
    readonly origin: string;
    private readonly options: Required<Omit<Options, 'environment'>>;
    private nextAt = 0;
    private tail: Promise<unknown> = Promise.resolve();
    constructor(options: Options) {
        let url: URL;
        try { url = new URL(options.baseUrl); } catch { throw new ContentSourceError(503, 'RIJPERMIS_INVALID_CONFIGURATION'); }
        const local = ['test', 'development'].includes(options.environment ?? '') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new ContentSourceError(503, 'RIJPERMIS_INVALID_CONFIGURATION');
        this.origin = url.origin;
        this.options = { baseUrl: url.origin, apiKey: options.apiKey, timeoutMs: options.timeoutMs ?? 10000, attempts: options.attempts ?? 3, intervalMs: options.intervalMs ?? 1050, sleep: options.sleep ?? delay };
        if (![this.options.timeoutMs, this.options.attempts, this.options.intervalMs].every(Number.isSafeInteger) || this.options.timeoutMs < 1 || this.options.attempts < 1 || this.options.attempts > 3 || this.options.intervalMs < 0) throw new ContentSourceError(503, 'RIJPERMIS_INVALID_CONFIGURATION');
    }
    private async bytes(path: string, image = false): Promise<{ bytes: Buffer; contentType: string }> {
        const task = this.tail.then(async () => {
            for (let attempt = 0; attempt < this.options.attempts; attempt++) {
                await this.options.sleep(Math.max(0, this.nextAt - Date.now()));
                this.nextAt = Date.now() + this.options.intervalMs;
                let retryMs = 200 * 2 ** attempt;
                let failure = new ContentSourceError(502, 'RIJPERMIS_NETWORK_OR_TIMEOUT');
                try {
                    const response = await fetch(new URL(path, this.origin), {
                        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(this.options.timeoutMs),
                        headers: image ? { Accept: 'image/jpeg,image/png,image/webp' } : { Accept: 'application/json', 'X-Fako-Api-Key': this.options.apiKey }
                    });
                    if (response.ok) {
                        const contentType = response.headers.get('content-type') ?? '';
                        if (!image && !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(contentType)) throw new ContentSourceError(502, 'RIJPERMIS_INVALID_RESPONSE');
                        const limit = image ? 5 * 1024 * 1024 : 2 * 1024 * 1024;
                        if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new ContentSourceError(502, 'RIJPERMIS_RESPONSE_TOO_LARGE'); }
                        if (!response.body) throw new ContentSourceError(502, 'RIJPERMIS_EMPTY_RESPONSE');
                        const chunks: Buffer[] = []; let size = 0;
                        for await (const chunk of response.body) { size += chunk.byteLength; if (size > limit) throw new ContentSourceError(502, 'RIJPERMIS_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
                        return { bytes: Buffer.concat(chunks), contentType };
                    }
                    await response.body?.cancel();
                    if (response.status === 429) {
                        const raw = response.headers.get('retry-after');
                        if (raw !== null) {
                            const seconds = /^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
                            if (Number.isFinite(seconds)) retryMs = Math.max(retryMs, Math.ceil(Math.max(0, seconds) * 1000));
                        }
                        failure = new ContentSourceError(429, 'RIJPERMIS_RATE_LIMITED', Math.ceil(retryMs / 1000));
                        this.nextAt = Math.max(this.nextAt, Date.now() + retryMs);
                    } else if (response.status === 404) throw new ContentSourceError(404, 'RIJPERMIS_NOT_EXPORTABLE');
                    else if (response.status === 401) throw new ContentSourceError(502, 'RIJPERMIS_AUTHENTICATION_FAILED');
                    else if (response.status >= 500 || response.status === 408) failure = new ContentSourceError(502, 'RIJPERMIS_TEMPORARILY_UNAVAILABLE');
                    else throw new ContentSourceError(502, 'RIJPERMIS_HTTP_REJECTED');
                } catch (error) {
                    if (error instanceof ContentSourceError) throw error;
                }
                // Do not retry earlier than Retry-After, or block a request for an unbounded duration.
                if (attempt === this.options.attempts - 1 || retryMs > 30000) throw failure;
                await this.options.sleep(retryMs);
            }
            throw new ContentSourceError(502, 'RIJPERMIS_UNAVAILABLE');
        });
        this.tail = task.catch(() => {});
        return task;
    }
    private async json(path: string): Promise<unknown> {
        const result = await this.bytes(path);
        try { return JSON.parse(result.bytes.toString('utf8')); } catch { throw new ContentSourceError(502, 'RIJPERMIS_INVALID_JSON'); }
    }
    async listQuestions(query: QuestionQuery = {}) {
        const params = new URLSearchParams({ language: query.language ?? 'fr', page: String(query.page ?? 0), size: String(query.size ?? 20) });
        if (!['fr', 'nl'].includes(params.get('language')!) || !Number.isSafeInteger(query.page ?? 0) || (query.page ?? 0) < 0 || !Number.isSafeInteger(query.size ?? 20) || (query.size ?? 20) < 1 || (query.size ?? 20) > 100 || (query.category !== undefined && (!query.category.trim() || query.category.length > 300))) throw new ContentSourceError(400, 'INVALID_QUESTION_QUERY');
        if (query.category !== undefined) params.set('category', query.category);
        const result = parsePage(await this.json(`/api/integrations/fako/v1/questions?${params}`), query);
        for (const q of result.items) if (q.image) imageUrl(this.origin, q.image.url);
        return result;
    }
    async getQuestion(id: string) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new ContentSourceError(400, 'INVALID_QUESTION_ID');
        const q = parseQuestion(await this.json(`/api/integrations/fako/v1/questions/${encodeURIComponent(id)}`));
        if (q.id !== id) throw new ContentSourceError(502, 'RIJPERMIS_QUESTION_ID_MISMATCH');
        if (q.image) imageUrl(this.origin, q.image.url);
        return q;
    }
    async listThemes(language: Language = 'fr') {
        if (!['fr', 'nl'].includes(language)) throw new ContentSourceError(400, 'INVALID_LANGUAGE');
        return parseThemes(await this.json(`/api/integrations/fako/v1/themes?language=${language}`));
    }
    async downloadImage(question: SourceQuestion) {
        const q = parseQuestion(question);
        if (!q.image) return null;
        const url = imageUrl(this.origin, q.image.url);
        const result = await this.bytes(url.pathname, true);
        return { bytes: result.bytes, ...imageType(result.bytes, result.contentType) };
    }
}
export function contentProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ContentSourceProvider | undefined {
    if ((env.RIJPERMIS_API_ENABLED ?? 'false') === 'false') return undefined;
    if (env.RIJPERMIS_API_ENABLED !== 'true') throw new ContentSourceError(503, 'RIJPERMIS_INVALID_CONFIGURATION');
    return new RijPermisContentProvider({ baseUrl: env.RIJPERMIS_API_BASE_URL ?? '', apiKey: env.RIJPERMIS_API_KEY ?? '', environment: env.NODE_ENV });
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    return JSON.stringify(value);
}
export function snapshotHash(question: SourceQuestion): string { return createHash('sha256').update(canonical(question)).digest('hex'); }
export async function checkQuestion(provider: ContentSourceProvider, snapshot: SourceQuestion) {
    try {
        const fresh = await provider.getQuestion(snapshot.id);
        return { status: fresh.contentHash === snapshot.contentHash && snapshotHash(fresh) === snapshotHash(snapshot) ? 'CURRENT' as const : 'CHANGED' as const, checkedAt: new Date().toISOString(), contentHash: fresh.contentHash };
    } catch (error) {
        if (error instanceof ContentSourceError && error.statusCode === 404) return { status: 'WITHDRAWN' as const, checkedAt: new Date().toISOString() };
        throw error;
    }
}
