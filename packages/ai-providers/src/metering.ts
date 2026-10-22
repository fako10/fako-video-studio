import type { TTSInput, TTSOutput, TTSProvider } from './tts.js';

export type TTSUsageTotals = { characters: number | null; cacheHits: number; calls: number };

// Wraps any TTSProvider (typically already wrapped in CachingTTSProvider) and accumulates usage
// across every call, so an orchestrator can persist one summary without threading counters through
// each synthesize() call site itself.
export class MeteringTTSProvider implements TTSProvider {
    readonly name: string;
    private characters = 0;
    private hasCharacterData = false;
    private cacheHits = 0;
    private calls = 0;

    constructor(private readonly inner: TTSProvider) { this.name = inner.name; }

    async synthesize(input: TTSInput): Promise<TTSOutput> {
        const output = await this.inner.synthesize(input);
        this.calls++;
        if (output.usage?.cacheHit) this.cacheHits++;
        if (typeof output.usage?.characters === 'number') { this.characters += output.usage.characters; this.hasCharacterData = true; }
        return output;
    }

    get usage(): TTSUsageTotals {
        return { characters: this.hasCharacterData ? this.characters : null, cacheHits: this.cacheHits, calls: this.calls };
    }
}
