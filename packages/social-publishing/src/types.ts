import type { ContentSourceProvider } from '@fako/content-sources';
import type { MediaDescriptor, SocialPlatform, SocialPlatformConnector } from '@fako/publishing';

// Structurally identical to @fako/media-engine's VideoStorage, duck-typed on purpose so this
// package never needs a hard dependency on media-engine just for one method's shape — apps/api and
// apps/worker pass their existing LocalVideoStorage instance straight through.
export interface VideoBytesReader {
    read(key: string): Promise<Buffer>;
}

export type SchedulePublicationInput = {
    projectId: string;
    quizVideoId: string;
    socialAccountId: string;
    language: string;
    caption: string;
    hashtags?: string[];
    scheduledAt?: Date;
    requestId: string;
    createdBy: string;
};

export type UpdatePublicationScheduleInput = {
    caption?: string;
    hashtags?: string[];
    scheduledAt?: Date | null;
};

// Everything the engine needs to actually verify and send a publication. `appAuditedByPlatform`
// lets an operator declare (via env, never guessed) that a given platform app has passed that
// platform's own audit/App Review — absent or false is always the safe default (mission 13's
// "unaudited apps are private-only" restriction stays in force until explicitly configured).
export type PublicationEngineDeps = {
    connectors: Record<SocialPlatform, SocialPlatformConnector>;
    provider: ContentSourceProvider;
    encryptionKey: Buffer;
    // Mission 15 section 6: set only during a SOCIAL_TOKEN_ENCRYPTION_KEY rotation window, so tokens
    // encrypted under the previous key keep decrypting until apps/api/prisma/reencrypt-social-tokens.ts
    // has re-encrypted them all under the new `encryptionKey`. See @fako/publishing's decryptSecret.
    previousEncryptionKey?: Buffer;
    videoStorage: VideoBytesReader;
    appAuditedByPlatform?: Partial<Record<SocialPlatform, boolean>>;
    now?: () => Date;
    reconcileGraceMs?: number;
    // Mission 15 section 4: the public HTTPS base URL Instagram's video_url is built from (e.g.
    // https://admin.example.com). Required only for INSTAGRAM publications — absent (the default,
    // no deployment) makes the engine block them with a clear reason instead of letting Meta's own
    // API reject a missing/placeholder URL as an ambiguous remote error.
    publicLinkBaseUrl?: string;
    publicVideoLinkTtlMs?: number;
};

export type VerificationResult =
    | { ok: true; accessToken: string; videoBytes: Buffer; media: MediaDescriptor; accountMetadata?: Record<string, unknown> }
    | { ok: false; reasons: string[] };
