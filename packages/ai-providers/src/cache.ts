import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TTSInput, TTSOutput, TTSProvider } from './tts.js';

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

// Identical text + language + voice + model + settings always produce the same narration: no need
// to pay for it twice. Deliberately excludes nothing from the provider's own billing inputs.
export function ttsCacheKey(input: TTSInput): string {
    return createHash('sha256').update(canonical({
        text: input.text, language: input.language, voiceId: input.voiceId, model: input.model, settings: input.settings
    })).digest('hex');
}

export interface AudioCacheStore {
    get(key: string): Promise<TTSOutput | null>;
    put(key: string, output: TTSOutput): Promise<void>;
}

export class LocalAudioCacheStore implements AudioCacheStore {
    private readonly root: string;
    constructor(root: string) { this.root = root; }
    private path(key: string, extension: 'mp3' | 'wav') {
        if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid cache key');
        return join(this.root, `${key}.${extension}`);
    }
    async get(key: string): Promise<TTSOutput | null> {
        for (const extension of ['mp3', 'wav'] as const) {
            try {
                const bytes = await readFile(this.path(key, extension));
                return { bytes, mimeType: extension === 'mp3' ? 'audio/mpeg' : 'audio/wav', extension, usage: { cacheHit: true } };
            } catch { /* try the other extension */ }
        }
        return null;
    }
    async put(key: string, output: TTSOutput): Promise<void> {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await writeFile(this.path(key, output.extension), output.bytes, { mode: 0o600 });
    }
}

// Wraps any TTSProvider (ElevenLabs or the mock) with a cache lookup, with zero change to callers.
export class CachingTTSProvider implements TTSProvider {
    readonly name: string;
    constructor(private readonly inner: TTSProvider, private readonly cache: AudioCacheStore) { this.name = inner.name; }
    async synthesize(input: TTSInput): Promise<TTSOutput> {
        const key = ttsCacheKey(input);
        const cached = await this.cache.get(key);
        if (cached) return cached;
        const output = await this.inner.synthesize(input);
        await this.cache.put(key, output);
        return output;
    }
}
