import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redisConnection } from '../src/index.js';

test('Redis URL supports credentials, TLS and database selection', () => {
    const connection = redisConnection('rediss://worker:pass%40word@redis.internal:6380/2');
    assert.equal(connection.host, 'redis.internal');
    assert.equal(connection.port, 6380);
    assert.equal(connection.password, 'pass@word');
    assert.equal(connection.db, 2);
    assert.deepEqual(connection.tls, {});
    assert.equal(connection.maxRetriesPerRequest, null);
    assert.throws(() => redisConnection('http://redis:6379'));
});
