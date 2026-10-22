import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDueSlots, defaultSlots, parseSlotsFromEnv, zonedDateString, zonedTimeToUtc } from '../src/schedule.js';

const TZ = 'Europe/Brussels';

test('converts a winter (CET, UTC+1) local time to the correct UTC instant', () => {
    assert.equal(zonedTimeToUtc(2026, 1, 15, 9, 0, TZ).toISOString(), '2026-01-15T08:00:00.000Z');
});

test('converts a summer (CEST, UTC+2) local time to the correct UTC instant', () => {
    assert.equal(zonedTimeToUtc(2026, 7, 15, 9, 0, TZ).toISOString(), '2026-07-15T07:00:00.000Z');
});

test('the 6 daily slots (3 times x fr/nl) are all due once the day has fully passed', () => {
    const now = zonedTimeToUtc(2026, 1, 15, 22, 0, TZ);
    const due = computeDueSlots(now, defaultSlots, TZ, 120);
    assert.equal(due.length, 6);
    assert.deepEqual([...new Set(due.map(d => d.slotTime))].sort(), ['09:00', '16:00', '21:00']);
    assert.deepEqual([...new Set(due.map(d => d.language))].sort(), ['fr', 'nl']);
    // Only the most recent (21:00) slot is still within the grace window at 22:00; the earlier two
    // are correctly flagged missed rather than silently dispatched hours late.
    assert.equal(due.filter(d => !d.missed).length, 2);
    assert.equal(due.filter(d => d.missed).length, 4);
});

test('a slot in the future is not due yet', () => {
    const now = zonedTimeToUtc(2026, 1, 15, 8, 59, TZ);
    const due = computeDueSlots(now, [{ time: '09:00' }], TZ, 120);
    assert.equal(due.length, 0);
});

test('a slot just past its time, within the grace window, is due and not missed', () => {
    const now = new Date(zonedTimeToUtc(2026, 1, 15, 9, 0, TZ).getTime() + 10 * 60000);
    const due = computeDueSlots(now, [{ time: '09:00' }], TZ, 120);
    assert.equal(due.length, 2);
    assert.ok(due.every(d => !d.missed));
});

test('a slot well past its grace window is reported missed, never silently dispatched late', () => {
    const now = new Date(zonedTimeToUtc(2026, 1, 15, 9, 0, TZ).getTime() + 5 * 3600_000);
    const due = computeDueSlots(now, [{ time: '09:00' }], TZ, 120);
    assert.equal(due.length, 2);
    assert.ok(due.every(d => d.missed));
});

test('a slot scheduled right at the spring-forward transition still resolves to a sensible UTC instant', () => {
    // Europe/Brussels: clocks jump 02:00 -> 03:00 on the last Sunday of March.
    const before = zonedTimeToUtc(2026, 3, 28, 1, 0, TZ);
    const after = zonedTimeToUtc(2026, 3, 29, 9, 0, TZ);
    assert.ok(after.getTime() > before.getTime());
    assert.equal(zonedDateString(after, TZ), '2026-03-29');
});

test('restarting the scheduler after a long outage reports every stale slot as missed, not as dozens of new jobs', () => {
    const now = zonedTimeToUtc(2026, 1, 15, 23, 30, TZ);
    const due = computeDueSlots(now, defaultSlots, TZ, 120);
    assert.equal(due.length, 6);
    assert.ok(due.every(d => d.missed), 'every slot from the outage day should be flagged missed, not dispatched');
});

test('parseSlotsFromEnv accepts a configurable comma list and falls back to the default schedule', () => {
    assert.deepEqual(parseSlotsFromEnv(undefined), defaultSlots);
    assert.deepEqual(parseSlotsFromEnv(''), defaultSlots);
    assert.deepEqual(parseSlotsFromEnv('08:30, 12:00,  23:59'), [{ time: '08:30' }, { time: '12:00' }, { time: '23:59' }]);
    assert.throws(() => parseSlotsFromEnv('9:00'));
    assert.throws(() => parseSlotsFromEnv('25:00'));
});
