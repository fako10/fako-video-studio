import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateOAuthState, generatePkcePair } from '../src/state.js';

test('generateOAuthState produces high-entropy, URL-safe, unique values', () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    assert.notEqual(a, b);
    assert.ok(a.length >= 40);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('generatePkcePair derives a valid S256 challenge from the verifier', () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    assert.match(codeVerifier, /^[A-Za-z0-9_-]{43,}$/);
    const expected = createHash('sha256').update(codeVerifier).digest('base64url');
    assert.equal(codeChallenge, expected);
});

test('generatePkcePair produces a different verifier every call', () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    assert.notEqual(a.codeVerifier, b.codeVerifier);
});
