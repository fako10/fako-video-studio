import type { Language } from '@fako/content-sources';

export type SlotConfig = { time: string };
export type DueSlot = { scheduledDate: string; slotTime: string; language: Language; scheduledAt: Date; missed: boolean };

const LANGUAGES: Language[] = ['fr', 'nl'];

function timeZoneParts(date: Date, timeZone: string) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

// No timezone library needed: Node's Intl already carries the full IANA database, including DST
// transitions. Converges in one or two passes except exactly inside a transition hour, an
// acceptably rare edge case for a scheduler that ticks every minute.
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
    let guess = desired;
    for (let i = 0; i < 3; i++) {
        const actual = timeZoneParts(new Date(guess), timeZone);
        const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
        const diff = desired - actualAsUtc;
        if (diff === 0) break;
        guess += diff;
    }
    return new Date(guess);
}

export function zonedDateString(date: Date, timeZone: string): string {
    const parts = timeZoneParts(date, timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// A slot is "due" once its local wall-clock time has passed. Past the grace window (e.g. the
// scheduler was down across it), it is reported "missed" instead of being dispatched late — the
// caller must never silently backfill a flood of overdue videos after a restart.
export function computeDueSlots(now: Date, slots: SlotConfig[], timeZone: string, graceMinutes: number): DueSlot[] {
    const scheduledDate = zonedDateString(now, timeZone);
    const [year, month, day] = scheduledDate.split('-').map(Number);
    const due: DueSlot[] = [];
    for (const slot of slots) {
        const [hour, minute] = slot.time.split(':').map(Number);
        const scheduledAt = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
        if (scheduledAt.getTime() > now.getTime()) continue;
        const lateMinutes = (now.getTime() - scheduledAt.getTime()) / 60000;
        for (const language of LANGUAGES) due.push({ scheduledDate, slotTime: slot.time, language, scheduledAt, missed: lateMinutes > graceMinutes });
    }
    return due;
}

export const defaultSlots: SlotConfig[] = [{ time: '09:00' }, { time: '16:00' }, { time: '21:00' }];

export function parseSlotsFromEnv(value: string | undefined): SlotConfig[] {
    if (!value || !value.trim()) return defaultSlots;
    const times = value.split(',').map(entry => entry.trim()).filter(Boolean);
    for (const time of times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`Invalid slot time "${time}"; expected HH:mm`);
    if (!times.length) throw new Error('No slot times configured');
    return times.map(time => ({ time }));
}
