import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProgramOccurrences, isoDayOfWeek, isValidSlotTime, zonedDateString, zonedTimeToUtc } from '../src/schedule.js';

const TZ = 'Europe/Brussels';
const everyDay = [1, 2, 3, 4, 5, 6, 7];

test('converts a winter (CET, UTC+1) local time to the correct UTC instant', () => {
    assert.equal(zonedTimeToUtc(2026, 1, 15, 9, 0, TZ).toISOString(), '2026-01-15T08:00:00.000Z');
});

test('converts a summer (CEST, UTC+2) local time to the correct UTC instant', () => {
    assert.equal(zonedTimeToUtc(2026, 7, 15, 9, 0, TZ).toISOString(), '2026-07-15T07:00:00.000Z');
});

test('a slot scheduled right at the spring-forward transition still resolves to a sensible UTC instant', () => {
    // Europe/Brussels: clocks jump 02:00 -> 03:00 on the last Sunday of March.
    const before = zonedTimeToUtc(2026, 3, 28, 1, 0, TZ);
    const after = zonedTimeToUtc(2026, 3, 29, 9, 0, TZ);
    assert.ok(after.getTime() > before.getTime());
    assert.equal(zonedDateString(after, TZ), '2026-03-29');
});

test('isoDayOfWeek suit la norme ISO (lundi = 1, dimanche = 7)', () => {
    assert.equal(isoDayOfWeek('2026-11-16'), 1);
    assert.equal(isoDayOfWeek('2026-11-22'), 7);
});

test('isValidSlotTime n\'accepte que HH:mm', () => {
    assert.ok(isValidSlotTime('09:00'));
    assert.ok(isValidSlotTime('23:59'));
    assert.ok(!isValidSlotTime('9:00'));
    assert.ok(!isValidSlotTime('25:00'));
});

test('sans avance (leadDays = 0), un créneau futur n\'est pas encore à traiter', () => {
    const now = zonedTimeToUtc(2026, 1, 15, 8, 59, TZ);
    assert.equal(computeProgramOccurrences(now, { slots: ['09:00'], daysOfWeek: everyDay, leadDays: 0 }, TZ, 120).filter(o => o.scheduledDate === '2026-01-15').length, 0);
});

test('sans avance, un créneau juste passé est à traiter, puis signalé manqué après la marge', () => {
    const schedule = { slots: ['09:00'], daysOfWeek: everyDay, leadDays: 0 };
    const justAfter = new Date(zonedTimeToUtc(2026, 1, 15, 9, 0, TZ).getTime() + 10 * 60000);
    const late = new Date(zonedTimeToUtc(2026, 1, 15, 9, 0, TZ).getTime() + 5 * 3600_000);
    const today = (now: Date) => computeProgramOccurrences(now, schedule, TZ, 120).filter(o => o.scheduledDate === '2026-01-15');
    assert.deepEqual(today(justAfter).map(o => o.missed), [false]);
    assert.deepEqual(today(late).map(o => o.missed), [true]);
});

test('avec un jour d\'avance, le créneau de demain est généré dès aujourd\'hui à la même heure', () => {
    const schedule = { slots: ['16:00'], daysOfWeek: everyDay, leadDays: 1 };
    const before = zonedTimeToUtc(2026, 1, 15, 15, 59, TZ);
    const after = zonedTimeToUtc(2026, 1, 15, 16, 0, TZ);
    assert.ok(!computeProgramOccurrences(before, schedule, TZ, 120).some(o => o.scheduledDate === '2026-01-16'));
    const occurrence = computeProgramOccurrences(after, schedule, TZ, 120).find(o => o.scheduledDate === '2026-01-16');
    assert.ok(occurrence);
    assert.equal(occurrence.missed, false);
    assert.equal(occurrence.scheduledAt.toISOString(), '2026-01-16T15:00:00.000Z', 'heure de publication prévue, pas heure de génération');
});

test('les jours désactivés ne produisent aucun créneau (vidéo hebdomadaire du dimanche)', () => {
    const schedule = { slots: ['18:00'], daysOfWeek: [7], leadDays: 1 };
    // Samedi 21/11/2026 à 20:00 : le créneau du dimanche 22 est à générer, rien d'autre.
    const occurrences = computeProgramOccurrences(zonedTimeToUtc(2026, 11, 21, 20, 0, TZ), schedule, TZ, 120);
    assert.deepEqual(occurrences.map(o => `${o.scheduledDate} ${o.slotTime}`), ['2026-11-22 18:00']);
});

test('après une longue panne, les créneaux dépassés sont signalés manqués au lieu d\'être produits en masse', () => {
    const schedule = { slots: ['09:00', '16:00', '21:00'], daysOfWeek: everyDay, leadDays: 0 };
    const occurrences = computeProgramOccurrences(zonedTimeToUtc(2026, 1, 15, 23, 30, TZ), schedule, TZ, 120);
    const today = occurrences.filter(o => o.scheduledDate === '2026-01-15');
    assert.equal(today.length, 3);
    assert.ok(today.every(o => o.missed));
});
