


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

const SLOT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidSlotTime(value: string) { return SLOT_TIME.test(value); }

function addDays(date: string, days: number) {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

/** Jour ISO de la semaine (1 = lundi … 7 = dimanche) d'une date calendaire AAAA-MM-JJ. */
export function isoDayOfWeek(date: string) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return day === 0 ? 7 : day;
}

export type ProgramSchedule = { slots: string[]; daysOfWeek: number[]; leadDays: number };
export type SlotOccurrence = { scheduledDate: string; slotTime: string; scheduledAt: Date; missed: boolean };

// Occurrences d'un programme à traiter maintenant. Chaque créneau (date, heure locale) devient
// « à générer » `leadDays` jours avant son heure de publication, pour laisser le temps de valider.
// Un créneau dont l'heure est dépassée de plus de `graceMinutes` est signalé « manqué » au lieu
// d'être généré en retard : un redémarrage après une panne ne doit jamais créer une avalanche de vidéos.
export function computeProgramOccurrences(now: Date, schedule: ProgramSchedule, timeZone: string, graceMinutes: number): SlotOccurrence[] {
    const today = zonedDateString(now, timeZone);
    const leadMs = schedule.leadDays * 24 * 3600 * 1000;
    const occurrences: SlotOccurrence[] = [];
    for (let offset = -1; offset <= schedule.leadDays; offset++) {
        const scheduledDate = addDays(today, offset);
        if (!schedule.daysOfWeek.includes(isoDayOfWeek(scheduledDate))) continue;
        const [year, month, day] = scheduledDate.split('-').map(Number);
        for (const slotTime of schedule.slots) {
            if (!isValidSlotTime(slotTime)) continue;
            const [hour, minute] = slotTime.split(':').map(Number);
            const scheduledAt = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
            if (scheduledAt.getTime() - leadMs > now.getTime()) continue;
            const lateMinutes = (now.getTime() - scheduledAt.getTime()) / 60000;
            occurrences.push({ scheduledDate, slotTime, scheduledAt, missed: lateMinutes > graceMinutes });
        }
    }
    return occurrences;
}
