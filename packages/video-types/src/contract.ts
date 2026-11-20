// Contrat commun à tous les types de vidéos.
//
// Le reste du système (planificateur, worker, admin, publication) ne connaît jamais le détail d'un
// type : il manipule des lignes `Video` génériques et délègue à un module pour
//   1. préparer le contenu (choix de la question, du concept, du message…),
//   2. produire le MP4 (narration + rendu),
//   3. proposer la légende et les hashtags de publication.
// Ajouter un type = écrire un module qui respecte ce contrat, puis l'enregistrer dans le registre.
import type { Prisma, PrismaClient, Program, Project, Video } from '@prisma/client';
import type { TTSProvider } from '@fako/ai-providers';
import type { ContentSourceProvider, MediaStorage } from '@fako/content-sources';
import type { VoiceConfig } from '@fako/media-engine';

export type BrandColors = { primary: string; secondary: string; accent: string; background: string; text: string };

/** Identité visuelle effective d'un projet : celle de sa marque, avec les surcharges du projet. */
export type BrandIdentity = {
    slug: string;
    name: string;
    websiteUrl?: string;
    /** Chemin absolu du fichier logo, s'il existe. */
    logoPath?: string;
    colors: BrandColors;
};

export type PrepareContext<P> = {
    prisma: PrismaClient;
    project: Project;
    program: Program | null;
    brand: BrandIdentity;
    language: string;
    params: P;
    /** Identifiant de question imposé (demande manuelle), pour les types basés sur une question. */
    questionId?: string;
};

export type PrepareDeps = {
    /** Source de contenu du projet (API RijPermis, API MonPermisEnPoche, mock…), si le type en a besoin. */
    contentSource?: ContentSourceProvider;
    /** Stockage des images téléchargées depuis la source de contenu. */
    mediaStorage?: MediaStorage;
};

/** Traçabilité d'une vidéo construite à partir d'une question de la source de contenu. */
export type PreparedSource = {
    sourceId: string; origin: string; questionId: string; contentHash: string; snapshotHash: string;
    category: string; snapshot: Prisma.InputJsonObject; fetchedAt: Date;
    imageKey?: string; imageHash?: string; imageMimeType?: string;
};

export type PreparedVideo = {
    title?: string;
    /** Contenu propre au type, conservé tel quel sur la ligne Video et relu au moment du rendu. */
    content: Prisma.InputJsonObject;
    source?: PreparedSource;
};

/** Rendu Remotion remplaçable (les tests injectent un faux rendu rapide). */
export type RenderAndMeasure = (props: unknown, outputPath: string, publicDir: string) => Promise<{ durationInSeconds: number }>;

export type RenderDeps = {
    ttsProvider: TTSProvider;
    /** Dossier public de Remotion où sont déposés images et fichiers audio avant rendu. */
    publicDir: string;
    /** Racine des images téléchargées depuis la source de contenu. */
    mediaRoot: string;
    renderAndMeasure?: RenderAndMeasure;
};

export type RenderInput = {
    video: Video;
    program: Program | null;
    brand: BrandIdentity;
    voice: VoiceConfig;
};

export type RenderOutput = { durationSeconds: number; ttsUsage?: unknown };

export type Caption = { caption: string; hashtags: string[] };

export interface VideoTypeModule<P extends object = Record<string, unknown>> {
    /** Identifiant stable, stocké sur Program.videoType et Video.videoType (ex. « daily-quiz »). */
    readonly id: string;
    readonly label: string;
    readonly description: string;
    /** Schéma JSON des paramètres propres au type ; l'admin en dérive le formulaire. */
    readonly paramsSchema: Record<string, unknown>;
    readonly defaultParams: P;
    readonly defaultDuration: { minSeconds: number; maxSeconds: number };
    /** Vrai si le type a besoin de la source de contenu du projet pour préparer une vidéo. */
    readonly requiresContentSource: boolean;

    prepare(context: PrepareContext<P>, deps: PrepareDeps): Promise<PreparedVideo>;
    render(input: RenderInput, deps: RenderDeps, outputPath: string): Promise<RenderOutput>;
    /** Légende et hashtags proposés à la validation (modifiables avant programmation). */
    caption(video: Video, brand: BrandIdentity, params: P): Caption;
}
