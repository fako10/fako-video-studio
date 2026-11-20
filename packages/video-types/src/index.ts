export * from './contract.js';
export * from './errors.js';
export * from './registry.js';
export * from './brand.js';
export * from './daily-quiz/index.js';

import { VideoTypeRegistry } from './registry.js';
import { dailyQuiz } from './daily-quiz/index.js';

/** Registre contenant tous les types de vidéos livrés avec l'application. */
export function createDefaultRegistry() {
    return new VideoTypeRegistry().register(dailyQuiz);
}
