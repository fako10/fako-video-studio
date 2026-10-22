import { resolve } from 'node:path';
import { contentSourceFromEnv, LocalMediaStorage } from '@fako/content-sources';
import { parseSlotsFromEnv, type SchedulerConfig } from '@fako/quiz-pipeline';

function positiveInteger(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    return value;
}

export function loadSchedulerConfig(): SchedulerConfig {
    return {
        slots: parseSlotsFromEnv(process.env.SCHEDULER_SLOTS),
        timeZone: process.env.SCHEDULER_TIMEZONE || 'Europe/Brussels',
        graceMinutes: positiveInteger('SCHEDULER_GRACE_MINUTES', 120),
        maxPendingJobs: positiveInteger('SCHEDULER_MAX_PENDING_JOBS', 10)
    };
}

export function loadProviderAndStorage() {
    const provider = contentSourceFromEnv(process.env);
    const mediaStorage = new LocalMediaStorage(process.env.RIJPERMIS_MEDIA_ROOT || resolve(import.meta.dirname, '../../../storage/rijpermis-images'));
    return { provider, mediaStorage };
}

export const projectSlug = process.env.SCHEDULER_PROJECT_SLUG || 'rijpermis';
