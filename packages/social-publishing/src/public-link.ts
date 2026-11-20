import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

// Instagram's Content Publishing API has no authenticated-upload path (unlike TikTok/Facebook):
// it requires a public HTTPS `video_url` that Meta's own servers fetch from, without presenting
// any credential of ours. A capability URL — an unguessable, single-resource, short-lived token —
// is the standard way to expose exactly one file without exposing the admin Bearer token or the
// rest of the video library. Only the token's SHA-256 hash is ever stored: a database leak alone
// never yields a usable link, mirroring how this repo never stores OAuth tokens in cleartext either.
export const DEFAULT_PUBLIC_VIDEO_LINK_TTL_MS = 2 * 60 * 60 * 1000; // 2h: generous vs. Meta's typical
// processing time (seconds to a few minutes) while staying far under the 24h container expiry —
// the token only needs to survive until Meta's initial fetch, not the whole async publish window.

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export async function createPublicVideoLink(
    prisma: PrismaClient, videoId: string, baseUrl: string, ttlMs: number = DEFAULT_PUBLIC_VIDEO_LINK_TTL_MS
): Promise<string> {
    const token = randomBytes(32).toString('base64url'); // 256 bits, URL-safe, never persisted raw
    await prisma.videoPublicLink.create({
        data: { videoId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) }
    });
    return `${baseUrl.replace(/\/+$/, '')}/public/quiz-video-links/${token}`;
}

export type ResolvedPublicVideoLink = { id: string; videoId: string };

// Returns null for "not found", "expired" and "revoked" alike — the caller (the HTTP route) must
// respond identically (a generic 404) in every case, so a probing request never learns which one it
// hit.
export async function resolvePublicVideoLink(prisma: PrismaClient, token: string): Promise<ResolvedPublicVideoLink | null> {
    const link = await prisma.videoPublicLink.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now()) return null;
    return { id: link.id, videoId: link.videoId };
}

// `updateMany` + a `consumedAt: null` guard (not `update`) so a second fetch (Meta is documented to
// retry transient failures) never overwrites the first successful-serve timestamp.
export async function markPublicVideoLinkConsumed(prisma: PrismaClient, id: string): Promise<void> {
    await prisma.videoPublicLink.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
}

// Called once the engine knows Meta either already fetched the video or never will need to again:
// the publication reached a terminal status (PUBLISHED/FAILED) or was cancelled by an admin. Safe to
// revoke every outstanding link for the video at that point — never while a publish attempt is still
// genuinely in flight (PENDING/PUBLISHING), since Meta may not have fetched it yet.
export async function revokePublicVideoLinksForQuizVideo(prisma: PrismaClient, videoId: string): Promise<void> {
    await prisma.videoPublicLink.updateMany({ where: { videoId, revokedAt: null }, data: { revokedAt: new Date() } });
}
