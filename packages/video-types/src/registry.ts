import { Ajv, type ValidateFunction } from 'ajv';
import type { VideoTypeModule } from './contract.js';
import { VideoRequestError } from './errors.js';

/** Registre des types de vidéos disponibles. Un seul registre par processus (voir defaultRegistry). */
export class VideoTypeRegistry {
    readonly #modules = new Map<string, VideoTypeModule<object>>();
    readonly #validators = new Map<string, ValidateFunction>();
    readonly #ajv = new Ajv({ allErrors: true, useDefaults: true });

    register(module: VideoTypeModule<any>) {
        if (!/^[a-z][a-z0-9-]{1,49}$/.test(module.id)) throw new Error(`Invalid video type id "${module.id}"`);
        if (this.#modules.has(module.id)) throw new Error(`Video type "${module.id}" already registered`);
        this.#modules.set(module.id, module);
        this.#validators.set(module.id, this.#ajv.compile(module.paramsSchema));
        return this;
    }

    has(id: string) { return this.#modules.has(id); }

    get(id: string): VideoTypeModule<object> {
        const module = this.#modules.get(id);
        if (!module) throw new VideoRequestError(422, `Unknown video type "${id}"`);
        return module;
    }

    list() { return [...this.#modules.values()]; }

    /** Valide les paramètres d'un programme et complète les valeurs par défaut. */
    resolveParams(id: string, params: unknown): object {
        const module = this.get(id);
        const merged = { ...structuredClone(module.defaultParams), ...(params && typeof params === 'object' ? params : {}) };
        const validate = this.#validators.get(id)!;
        if (!validate(merged)) {
            const detail = (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
            throw new VideoRequestError(400, `Invalid parameters for video type "${id}": ${detail}`);
        }
        return merged;
    }
}
