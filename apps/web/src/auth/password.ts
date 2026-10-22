import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

// Stored as "scrypt:<saltHex>:<hashHex>" in ADMIN_PASSWORD_HASH — generate it with
// `npm run hash-password -- "your passphrase"`, never commit the plaintext or the hash to git.
export async function hashPassword(plain: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scryptAsync(plain, salt, KEY_LENGTH)) as Buffer;
    return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, saltHex, hashHex] = parts;
    if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== KEY_LENGTH) return false;
    const derived = (await scryptAsync(plain, salt, KEY_LENGTH)) as Buffer;
    return timingSafeEqual(derived, expected);
}
