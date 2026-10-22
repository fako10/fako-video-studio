import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialPublicationQueue, socialPublicationQueueName } from '../src/queue.js';
import { SocialPublicationRequestError } from '../src/errors.js';

test('the publication queue uses the documented, stable queue name', async () => {
    const queue = createSocialPublicationQueue();
    try {
        assert.equal(queue.name, socialPublicationQueueName);
        assert.equal(socialPublicationQueueName, 'social-publications');
    } finally { await queue.close(); }
});

test('SocialPublicationRequestError carries the intended HTTP status code', () => {
    const error = new SocialPublicationRequestError(409, 'Only a publication that has not started can be cancelled');
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, 'Only a publication that has not started can be cancelled');
    assert.ok(error instanceof Error);
});
