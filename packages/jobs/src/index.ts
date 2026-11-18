// File de tâches durable stockée dans PostgreSQL (pg-boss), en remplacement de BullMQ + Redis.
//
// L'API exposée reprend volontairement le sous-ensemble de BullMQ réellement utilisé par le projet
// (Queue.add/getJob/close, Worker + événement « failed », UnrecoverableError, job.attemptsMade,
// job.opts.attempts, job.getState()) : les pipelines existants changent seulement leur import.
// Les lignes métier en base restent la source de vérité (« outbox ») ; la file ne fait que
// déclencher le traitement et gérer les nouvelles tentatives.
import { EventEmitter } from 'node:events';
import { PgBoss, type JobWithMetadata } from 'pg-boss';

export class UnrecoverableError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'UnrecoverableError';
    }
}

export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
export type BackoffOptions = { type: 'exponential' | 'fixed'; delay: number };
export type JobOptions = {
    /** Nombre total de tentatives (première exécution comprise), comme BullMQ. */
    attempts?: number;
    backoff?: BackoffOptions;
    /** Durée maximale d'une tentative avant d'être considérée comme bloquée puis relancée. */
    expireInSeconds?: number;
};
export type QueueOptions = { defaultJobOptions?: JobOptions };
export type WorkerOptions = { concurrency?: number; pollingIntervalSeconds?: number; defaultJobOptions?: JobOptions };

export interface Job<T> {
    id: string;
    data: T;
    /** Nombre de tentatives déjà effectuées avant celle-ci (0 à la première exécution). */
    attemptsMade: number;
    opts: { attempts: number };
    getState(): Promise<JobState>;
    /** Supprime le job de la file (disponible sur les jobs obtenus via Queue.getJob). */
    remove?(): Promise<void>;
}

export const DEFAULT_EXPIRE_IN_SECONDS = 3600;

export function jobsConnectionString(value = process.env.DATABASE_URL) {
    if (!value) throw new Error('DATABASE_URL is required for the job queue');
    const url = new URL(value);
    // Paramètre propre à Prisma, inconnu du pilote pg.
    url.searchParams.delete('schema');
    return url.toString();
}

export function retryOptions(options: JobOptions = {}) {
    const attempts = options.attempts ?? 1;
    if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('Invalid job attempts');
    const delayMs = options.backoff?.delay ?? 0;
    return {
        retryLimit: attempts - 1,
        retryDelay: Math.max(delayMs > 0 ? 1 : 0, Math.ceil(delayMs / 1000)),
        retryBackoff: options.backoff?.type === 'exponential',
        expireInSeconds: options.expireInSeconds ?? DEFAULT_EXPIRE_IN_SECONDS
    };
}

// Une seule connexion pg-boss par processus, partagée par toutes les files et tous les workers.
let shared: Promise<PgBoss> | undefined;
let references = 0;
const knownQueues = new Map<string, Promise<void>>();
const errorBus = new EventEmitter();

async function acquire(): Promise<PgBoss> {
    references += 1;
    if (!shared) {
        shared = (async () => {
            const boss = new PgBoss({ connectionString: jobsConnectionString(), schema: process.env.JOBS_SCHEMA || 'pgboss' });
            boss.on('error', error => errorBus.emit('error', error));
            await boss.start();
            return boss;
        })();
        shared.catch(() => { shared = undefined; knownQueues.clear(); });
    }
    try {
        return await shared;
    } catch (error) {
        references -= 1;
        throw error;
    }
}

async function release() {
    references = Math.max(0, references - 1);
    if (references > 0 || !shared) return;
    const pending = shared;
    shared = undefined;
    knownQueues.clear();
    const boss = await pending.catch(() => undefined);
    await boss?.stop({ graceful: true });
}

async function ensureQueue(boss: PgBoss, name: string, options?: JobOptions) {
    let ready = knownQueues.get(name);
    if (!ready) {
        ready = (async () => {
            if (await boss.getQueue(name)) return;
            await boss.createQueue(name, retryOptions(options));
        })();
        ready.catch(() => knownQueues.delete(name));
        knownQueues.set(name, ready);
    }
    await ready;
}

function isUnrecoverable(error: unknown) {
    return error instanceof UnrecoverableError || (error instanceof Error && error.name === 'UnrecoverableError');
}

export class Queue<T extends object> extends EventEmitter {
    #boss: Promise<PgBoss> | undefined;
    #closed = false;

    constructor(readonly name: string, readonly options: QueueOptions = {}) {
        super();
        errorBus.on('error', this.#forward);
    }

    #forward = (error: Error) => { if (this.listenerCount('error')) this.emit('error', error); };

    async #ready() {
        if (this.#closed) throw new Error(`Queue ${this.name} is closed`);
        this.#boss ??= acquire().catch(error => { this.#boss = undefined; throw error; });
        const boss = await this.#boss;
        await ensureQueue(boss, this.name, this.options.defaultJobOptions);
        return boss;
    }

    /** Ajoute un job ; un `jobId` déjà présent n'est pas dupliqué (même comportement que BullMQ). */
    async add(_jobName: string, data: T, options: JobOptions & { jobId?: string } = {}) {
        const boss = await this.#ready();
        const { jobId, ...overrides } = options;
        const id = await boss.send(this.name, data, { ...(jobId ? { id: jobId } : {}), ...retryOptions({ ...this.options.defaultJobOptions, ...overrides }) });
        return { id: id ?? jobId };
    }

    async getJob(id: string): Promise<Job<T> | undefined> {
        const boss = await this.#ready();
        const [found] = await boss.findJobs<T>(this.name, { id });
        if (!found) return undefined;
        return {
            id: found.id, data: found.data, attemptsMade: found.retryCount, opts: { attempts: found.retryLimit + 1 },
            getState: async () => found.state,
            remove: async () => { await boss.deleteJob(this.name, found.id); }
        };
    }

    async close() {
        if (this.#closed) return;
        this.#closed = true;
        errorBus.off('error', this.#forward);
        if (this.#boss) {
            this.#boss = undefined;
            await release();
        }
    }
}

export class Worker<T extends object> extends EventEmitter {
    #boss: PgBoss | undefined;
    #started: Promise<void>;
    #closed = false;

    constructor(readonly name: string, processor: (job: Job<T>) => Promise<unknown>, options: WorkerOptions = {}) {
        super();
        const concurrency = options.concurrency ?? 1;
        if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid worker concurrency');
        errorBus.on('error', this.#forward);
        this.#started = this.#start(processor, concurrency, options).catch(error => {
            if (this.listenerCount('error')) this.emit('error', error);
        });
    }

    #forward = (error: Error) => { if (this.listenerCount('error')) this.emit('error', error); };

    async #start(processor: (job: Job<T>) => Promise<unknown>, concurrency: number, options: WorkerOptions) {
        const boss = await acquire();
        this.#boss = boss;
        await ensureQueue(boss, this.name, options.defaultJobOptions);
        if (this.#closed) return;
        const workOptions = {
            batchSize: 1, localConcurrency: concurrency, includeMetadata: true, perJobResults: true,
            pollingIntervalSeconds: options.pollingIntervalSeconds ?? 1
        } as const;
        await boss.work<T, unknown, typeof workOptions>(this.name, workOptions, async (jobs: JobWithMetadata<T>[]) => Promise.all(jobs.map(async raw => {
            const job: Job<T> = {
                id: raw.id, data: raw.data, attemptsMade: raw.retryCount, opts: { attempts: raw.retryLimit + 1 },
                getState: async () => (await boss.findJobs<T>(this.name, { id: raw.id }))[0]?.state ?? 'active'
            };
            try {
                const output = await processor(job);
                this.emit('completed', job, output);
                return { id: raw.id, status: 'completed' as const, output };
            } catch (caught) {
                const error = caught instanceof Error ? caught : new Error(String(caught));
                const unrecoverable = isUnrecoverable(error);
                const settled: JobState = unrecoverable || raw.retryCount >= raw.retryLimit ? 'failed' : 'retry';
                this.emit('failed', { ...job, getState: async () => settled }, error);
                // « deadletter » = échec définitif sans nouvelle tentative (équivalent d'UnrecoverableError).
                return { id: raw.id, status: unrecoverable ? 'deadletter' as const : 'failed' as const, output: { message: error.message } };
            }
        })));
    }

    async close() {
        if (this.#closed) return;
        this.#closed = true;
        errorBus.off('error', this.#forward);
        await this.#started;
        const boss = this.#boss;
        if (!boss) return;
        await boss.offWork(this.name, { wait: true }).catch(() => {});
        this.#boss = undefined;
        await release();
    }
}

/** Ferme la connexion partagée (tests et arrêt du processus). */
export async function closeJobs() {
    references = 1;
    await release();
}
