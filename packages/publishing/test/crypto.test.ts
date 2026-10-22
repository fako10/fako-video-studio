import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, DecryptionError, encryptSecret, EncryptionKeyError, loadEncryptionKeyFromEnv, loadPreviousEncryptionKeyFromEnv } from '../src/crypto.js';

const key = randomBytes(32);

test('encrypt/decrypt round trip recovers the original secret', () => {
    const ciphertext = encryptSecret('super-secret-access-token', key);
    assert.notEqual(ciphertext, 'super-secret-access-token');
    assert.equal(decryptSecret(ciphertext, key), 'super-secret-access-token');
});

test('ciphertext never contains the plaintext token', () => {
    const ciphertext = encryptSecret('tiktok-access-abc123', key);
    assert.equal(ciphertext.includes('tiktok-access-abc123'), false);
});

test('two encryptions of the same plaintext produce different ciphertexts (random IV)', () => {
    const a = encryptSecret('same-value', key);
    const b = encryptSecret('same-value', key);
    assert.notEqual(a, b);
});

test('decrypting with the wrong key fails authentication', () => {
    const ciphertext = encryptSecret('secret', key);
    assert.throws(() => decryptSecret(ciphertext, randomBytes(32)), DecryptionError);
});

test('tampering with the ciphertext is detected', () => {
    const ciphertext = encryptSecret('secret', key);
    const parts = ciphertext.split(':');
    parts[3] = parts[3].slice(0, -2) + (parts[3].slice(-2) === '00' ? '11' : '00');
    assert.throws(() => decryptSecret(parts.join(':'), key), DecryptionError);
});

test('malformed ciphertext is rejected', () => {
    assert.throws(() => decryptSecret('not-a-valid-format', key), DecryptionError);
    assert.throws(() => decryptSecret('v2:aa:bb:cc', key), DecryptionError);
});

test('loadEncryptionKeyFromEnv requires 64 hex characters', () => {
    assert.throws(() => loadEncryptionKeyFromEnv({}), EncryptionKeyError);
    assert.throws(() => loadEncryptionKeyFromEnv({ SOCIAL_TOKEN_ENCRYPTION_KEY: 'too-short' }), EncryptionKeyError);
    const valid = randomBytes(32).toString('hex');
    assert.equal(loadEncryptionKeyFromEnv({ SOCIAL_TOKEN_ENCRYPTION_KEY: valid }).length, 32);
});

// Mission 15 section 6: rotation support — a ciphertext from before a key rotation must keep
// decrypting via the previous key, without that previous key ever being tried for ciphertexts the
// current key already handles (so a wrong/missing previous key never breaks already-current data).
test('loadPreviousEncryptionKeyFromEnv is optional, absent by default', () => {
    assert.equal(loadPreviousEncryptionKeyFromEnv({}), undefined);
    assert.throws(() => loadPreviousEncryptionKeyFromEnv({ SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS: 'too-short' }), EncryptionKeyError);
    const valid = randomBytes(32).toString('hex');
    assert.equal(loadPreviousEncryptionKeyFromEnv({ SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS: valid })?.length, 32);
});

test('key rotation: a ciphertext from the old key decrypts via the previous-key fallback', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const ciphertext = encryptSecret('rotated-secret', oldKey);
    assert.equal(decryptSecret(ciphertext, newKey, oldKey), 'rotated-secret');
});

test('key rotation: a ciphertext already under the current key never needs the previous key', () => {
    const currentKey = randomBytes(32);
    const unrelatedPreviousKey = randomBytes(32);
    const ciphertext = encryptSecret('already-current', currentKey);
    assert.equal(decryptSecret(ciphertext, currentKey, unrelatedPreviousKey), 'already-current');
});

test('key rotation: neither key matching still throws DecryptionError, never silently returns garbage', () => {
    const ciphertext = encryptSecret('secret', randomBytes(32));
    assert.throws(() => decryptSecret(ciphertext, randomBytes(32), randomBytes(32)), DecryptionError);
});

test('key rotation: a tampered ciphertext is still rejected even with an (unrelated) previous key configured', () => {
    // GCM's auth tag cannot tell "wrong key" from "tampered data" apart, so the previous-key retry
    // does happen here too — but since the data was never encrypted with previousKey either, that
    // retry fails exactly the same way, so the end result is unchanged: a thrown DecryptionError.
    const key = randomBytes(32);
    const previousKey = randomBytes(32);
    const ciphertext = encryptSecret('secret', key);
    const parts = ciphertext.split(':');
    parts[3] = parts[3].slice(0, -2) + (parts[3].slice(-2) === '00' ? '11' : '00');
    assert.throws(() => decryptSecret(parts.join(':'), key, previousKey), DecryptionError);
});

test('key rotation: a malformed ciphertext never retries with the previous key (no format fix is possible)', () => {
    assert.throws(() => decryptSecret('not-a-valid-format', randomBytes(32), randomBytes(32)), DecryptionError);
});
