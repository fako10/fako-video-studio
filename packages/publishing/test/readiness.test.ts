import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicationReadiness, type SocialAccountReadinessInput } from '../src/readiness.js';
import type { QuizVideoReadinessInput } from '../src/types.js';

function account(overrides: Partial<SocialAccountReadinessInput> = {}): SocialAccountReadinessInput {
    return {
        platform: 'TIKTOK', status: 'CONNECTED', languages: ['fr', 'nl'],
        grantedScopes: ['user.info.basic', 'video.publish'], tokenExpiresAt: new Date(Date.now() + 3600_000),
        ...overrides
    };
}

function quizVideo(overrides: Partial<QuizVideoReadinessInput> = {}): QuizVideoReadinessInput {
    return { status: 'COMPLETED', validationStatus: 'APPROVED', checkStatus: 'CURRENT', checkedAt: new Date(), contentHash: 'hash-1', ...overrides };
}

test('a fully connected, approved, in-language video is ready', () => {
    const result = validatePublicationReadiness({ account: account(), quizVideo: quizVideo(), language: 'fr' });
    assert.deepEqual(result, { ready: true, reasons: [] });
});

test('a non-approved video is never ready, regardless of connection state', () => {
    const result = validatePublicationReadiness({ account: account(), quizVideo: quizVideo({ validationStatus: 'PENDING_APPROVAL' }), language: 'fr' });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => r.includes('approuvée')));
});

test('a rejected video is never ready', () => {
    const result = validatePublicationReadiness({ account: account(), quizVideo: quizVideo({ validationStatus: 'REJECTED' }), language: 'fr' });
    assert.equal(result.ready, false);
});

test('an unconnected account is not ready', () => {
    const result = validatePublicationReadiness({ account: account({ status: 'DISCONNECTED' }), quizVideo: quizVideo(), language: 'fr' });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => r.includes('non connecté')));
});

test('an expired token is not ready', () => {
    const result = validatePublicationReadiness({ account: account({ tokenExpiresAt: new Date(Date.now() - 1000) }), quizVideo: quizVideo(), language: 'fr' });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => r.includes('expiré')));
});

test('missing the publish scope is not ready, even though the account is connected', () => {
    const result = validatePublicationReadiness({ account: account({ grantedScopes: ['user.info.basic'] }), quizVideo: quizVideo(), language: 'fr' });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => r.includes('Permission de publication manquante')));
});

test('a language not configured on the destination is not ready', () => {
    const result = validatePublicationReadiness({ account: account({ languages: ['nl'] }), quizVideo: quizVideo(), language: 'fr' });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => r.includes('non autorisée')));
});

test('a withdrawn/changed RijPermis source blocks publication (reuses isPublicationBlocked)', () => {
    const withdrawn = validatePublicationReadiness({ account: account(), quizVideo: quizVideo({ checkStatus: 'WITHDRAWN' }), language: 'fr' });
    assert.equal(withdrawn.ready, false);
    assert.ok(withdrawn.reasons.some(r => r.includes('traçabilité')));

    const changed = validatePublicationReadiness({ account: account(), quizVideo: quizVideo({ checkStatus: 'CHANGED' }), language: 'fr' });
    assert.equal(changed.ready, false);
});

test('an unchecked source does not block publication by itself', () => {
    const result = validatePublicationReadiness({ account: account(), quizVideo: quizVideo({ checkStatus: 'UNCHECKED', checkedAt: null }), language: 'fr' });
    assert.equal(result.ready, true);
});

test('multiple failing conditions are all reported, not just the first', () => {
    const result = validatePublicationReadiness({
        account: account({ status: 'DISCONNECTED', grantedScopes: [] }),
        quizVideo: quizVideo({ validationStatus: 'PENDING_APPROVAL', status: 'WAITING_APPROVAL' }),
        language: 'fr'
    });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.length >= 4);
});
