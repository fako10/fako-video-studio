import { createHash, randomBytes } from 'node:crypto';

// Random, unguessable, bound to a single project+platform by the caller (SocialOAuthState row) and
// to a short lifetime (mission 13 section 7: "state aléatoire, lié à la session et à durée
// limitée"). 32 bytes of entropy, base64url so it is URL-safe when echoed back as a query param.
export function generateOAuthState(): string {
    return randomBytes(32).toString('base64url');
}

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// PKCE (RFC 7636, S256) — required by TikTok for non-web client types, unused by Meta's OAuth
// implementations (not documented as supported). Kept here, not in the TikTok adapter, so any
// future connector needing PKCE reuses the same primitive rather than re-deriving it.
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(64).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
}
