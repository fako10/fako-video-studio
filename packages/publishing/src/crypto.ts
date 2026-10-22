import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const VERSION = 'v1';

export class EncryptionKeyError extends Error {}
export class DecryptionError extends Error {}

// SOCIAL_TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes) — generate with
// `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, never commit it.
export function loadEncryptionKeyFromEnv(env: NodeJS.ProcessEnv, name = 'SOCIAL_TOKEN_ENCRYPTION_KEY'): Buffer {
    const value = env[name];
    if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
        throw new EncryptionKeyError(`${name} must be set to 64 hex characters (32 bytes)`);
    }
    return Buffer.from(value, 'hex');
}

// Mission 15 section 6: rotating SOCIAL_TOKEN_ENCRYPTION_KEY naively — just swapping the value — makes
// every already-stored ciphertext permanently undecryptable the instant the new key is deployed (every
// connected social account would need reconnecting). Optional and unset by default: during a rotation
// window only, set this to the *previous* key so decryptSecret() (below) can still read old ciphertexts
// while every new encryptSecret() call already uses the new current key. See
// infrastructure/docker/README.md's "Rotation des clés" section for the full procedure, and
// apps/api/prisma/reencrypt-social-tokens.ts for the script that retires this once rotation is done.
export function loadPreviousEncryptionKeyFromEnv(env: NodeJS.ProcessEnv, name = 'SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS'): Buffer | undefined {
    const value = env[name];
    if (!value) return undefined;
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new EncryptionKeyError(`${name} must be set to 64 hex characters (32 bytes)`);
    return Buffer.from(value, 'hex');
}

// Reversible, unlike apps/web's password hashing (mission 13 needs to decrypt tokens later to
// refresh/revoke them). Format "v1:<ivHex>:<tagHex>:<cipherHex>" — the version prefix exists so a
// future key rotation can support decrypting both old and new ciphertexts during migration.
export function encryptSecret(plain: string, key: Buffer): string {
    if (key.length !== KEY_LENGTH) throw new EncryptionKeyError(`Encryption key must be ${KEY_LENGTH} bytes`);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptWithKey(stored: string, key: Buffer): string {
    if (key.length !== KEY_LENGTH) throw new EncryptionKeyError(`Encryption key must be ${KEY_LENGTH} bytes`);
    const parts = stored.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new DecryptionError('Unrecognized ciphertext format');
    const [, ivHex, tagHex, cipherHex] = parts;
    if (![ivHex, tagHex, cipherHex].every(part => /^[0-9a-f]+$/i.test(part))) {
        throw new DecryptionError('Malformed ciphertext');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');
    if (iv.length !== IV_LENGTH) throw new DecryptionError('Malformed ciphertext');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        throw new DecryptionError('Ciphertext failed authentication (wrong key or tampered data)');
    }
}

// `previousKey` is only ever used as a fallback, during a key-rotation window — see
// loadPreviousEncryptionKeyFromEnv above. Only an auth-tag failure on `key` retries with
// `previousKey` — GCM's auth tag cannot distinguish "wrong key" from "tampered ciphertext" (both fail
// identically), so a rotation retry is attempted either way, but a genuinely tampered ciphertext still
// fails the retry too and surfaces as DecryptionError. A malformed-format error (bad version prefix,
// non-hex parts, wrong IV length) never retries: no key, right or wrong, can fix a parsing failure.
export function decryptSecret(stored: string, key: Buffer, previousKey?: Buffer): string {
    try {
        return decryptWithKey(stored, key);
    } catch (error) {
        if (!previousKey || !(error instanceof DecryptionError) || error.message !== 'Ciphertext failed authentication (wrong key or tampered data)') throw error;
        return decryptWithKey(stored, previousKey);
    }
}
