export type VoiceSettings = { stability?: number; similarity_boost?: number; style?: number; use_speaker_boost?: boolean; speed?: number };
export type TTSInput = { text: string; language: string; voiceId: string; model: string; settings: VoiceSettings };
export type TTSOutput = { bytes: Buffer; mimeType: string; extension: 'mp3' | 'wav'; usage?: { characters?: number; requestId?: string; cacheHit?: boolean } };
export interface TTSProvider { readonly name: string; synthesize(input: TTSInput): Promise<TTSOutput> }
export class TTSError extends Error {
    constructor(public readonly code: string, public readonly retryable = false) { super(code); }
}
export class ElevenLabsProvider implements TTSProvider {
    readonly name = 'elevenlabs';
    constructor(private readonly key: string, private readonly transport: typeof fetch = fetch) {
        if (!key) throw new Error('ELEVENLABS_API_KEY required');
    }
    async synthesize(input: TTSInput): Promise<TTSOutput> {
        let response: Response;
        try {
            response = await this.transport(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`, {
                method: 'POST', headers: { 'xi-api-key': this.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
                body: JSON.stringify({ text: input.text, model_id: input.model,
                    ...(input.model === 'eleven_multilingual_v2' ? {} : { language_code: input.language }), voice_settings: input.settings }),
                signal: AbortSignal.timeout(60000)
            });
        } catch { throw new TTSError('TTS_OUTCOME_UNKNOWN'); }
        // Only a definite rate-limit rejection is automatically retried. Network/5xx outcomes may have been billed.
        if (!response.ok) throw new TTSError(`TTS_HTTP_${response.status}`, response.status === 429);
        if (!response.headers.get('content-type')?.includes('audio/')) throw new TTSError('TTS_INVALID_CONTENT');
        if (!response.body) throw new TTSError('TTS_EMPTY_AUDIO');
        const chunks: Buffer[] = []; let size = 0;
        try {
            for await (const chunk of response.body) {
                size += chunk.byteLength;
                if (size > 25 * 1024 * 1024) throw new Error('limit');
                chunks.push(Buffer.from(chunk));
            }
        } catch { throw new TTSError('TTS_AUDIO_READ_FAILED'); }
        const count = response.headers.get('character-cost');
        return { bytes: Buffer.concat(chunks), mimeType: 'audio/mpeg', extension: 'mp3', usage: {
            ...(count !== null && /^\d+$/.test(count) ? { characters: Number(count) } : {}),
            ...(response.headers.get('request-id') ? { requestId: response.headers.get('request-id')! } : {})
        } };
    }
}
export class MockTTSProvider implements TTSProvider {
    readonly name = 'mock';
    calls = 0;
    async synthesize(_input: TTSInput): Promise<TTSOutput> {
        this.calls++;
        const bytes = Buffer.alloc(44 + 16000);
        bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
        bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
        bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
        bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
        return { bytes, mimeType: 'audio/wav', extension: 'wav', usage: {} };
    }
}
