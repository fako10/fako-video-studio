import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('disabled by default: the daemon exits cleanly without connecting to anything when SCHEDULER_ENABLED is not "true"', () => {
    const tsxCli = resolve(import.meta.dirname, '../../../node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, resolve(import.meta.dirname, '../src/scheduler.ts')], {
        env: { ...process.env, SCHEDULER_ENABLED: 'false', DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid' },
        encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /disabled/i);
});
