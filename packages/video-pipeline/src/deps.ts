import type { Project } from '@prisma/client';
import type { ContentSourceProvider, MediaStorage } from '@fako/content-sources';
import { createDefaultRegistry, type RenderAndMeasure, type VideoTypeRegistry } from '@fako/video-types';
import type { TTSProvider } from '@fako/ai-providers';
import type { VideoStorage } from '@fako/media-engine';

/** Dépendances nécessaires pour préparer une vidéo (planificateur, API). */
export type RequestDeps = {
    registry?: VideoTypeRegistry;
    /** Source de contenu à utiliser pour un projet (selon Project.contentSource). */
    contentSourceFor: (project: Project) => ContentSourceProvider | undefined;
    mediaStorage?: MediaStorage;
    brandAssetsRoot?: string;
};

/** Dépendances nécessaires pour produire le MP4 (worker). */
export type RenderPipelineDeps = {
    registry?: VideoTypeRegistry;
    ttsProvider: TTSProvider;
    videoStorage: VideoStorage;
    publicDir: string;
    mediaRoot: string;
    brandAssetsRoot?: string;
    renderAndMeasure?: RenderAndMeasure;
};

let fallbackRegistry: VideoTypeRegistry | undefined;
export function registryOf(deps: { registry?: VideoTypeRegistry }) {
    return deps.registry ?? (fallbackRegistry ??= createDefaultRegistry());
}

/**
 * Sources de contenu disponibles, par clé de Project.contentSource. RijPermis (ou son mock local)
 * est la seule pour l'instant ; l'API MonPermisEnPoche s'ajoutera ici (étape 7).
 */
export function contentSourcesByKey(sources: Record<string, ContentSourceProvider | undefined>) {
    return (project: Project) => (project.contentSource ? sources[project.contentSource] : undefined);
}
