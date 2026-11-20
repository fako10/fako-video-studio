import { resolve } from 'node:path';
import { contentSourceFromEnv, LocalMediaStorage } from '@fako/content-sources';
import { contentSourcesByKey, type RequestDeps, type SchedulerConfig } from '@fako/video-pipeline';

function positiveInteger(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
    return value;
}

// Les créneaux, jours et fuseaux sont désormais définis par programme et par projet, en base.
export function loadSchedulerConfig(): SchedulerConfig {
    return {
        graceMinutes: positiveInteger('SCHEDULER_GRACE_MINUTES', 120),
        maxPendingJobs: positiveInteger('SCHEDULER_MAX_PENDING_JOBS', 10)
    };
}

export function loadRequestDeps(): RequestDeps {
    const rijpermis = contentSourceFromEnv(process.env);
    return {
        contentSourceFor: contentSourcesByKey({ rijpermis }),
        mediaStorage: new LocalMediaStorage(process.env.RIJPERMIS_MEDIA_ROOT || resolve(import.meta.dirname, '../../../storage/rijpermis-images')),
        brandAssetsRoot: process.env.BRAND_ASSETS_ROOT || resolve(import.meta.dirname, '../../../assets/brands')
    };
}
