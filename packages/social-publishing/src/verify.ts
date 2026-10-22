import type { PrismaClient, SocialPublication } from '@prisma/client';
import { isPublicationBlocked, verifyQuizVideoBeforePublication } from '@fako/quiz-pipeline';
import { decryptSecret, PUBLISH_SCOPE_BY_PLATFORM, validatePublicationReadiness, type MediaDescriptor } from '@fako/publishing';
import type { PublicationEngineDeps, VerificationResult } from './types.js';

// Mission 14 section 4, run again live immediately before every send attempt — never short-circuited
// by a cached result. Every independent reason is collected (mirrors validatePublicationReadiness's
// own philosophy): an admin fixing a BLOCKED publication should see every problem at once, not one
// at a time. IO (reading the video file) only happens once every non-IO check has already passed,
// so a publication blocked for an obvious reason (e.g. not approved) never pays for a wasted read.
export async function verifyBeforeSend(prisma: PrismaClient, publication: SocialPublication, deps: PublicationEngineDeps): Promise<VerificationResult> {
    const reasons: string[] = [];

    const [quizVideo, account, settings] = await Promise.all([
        prisma.quizVideo.findUnique({ where: { id: publication.quizVideoId } }),
        prisma.socialAccount.findUnique({ where: { id: publication.socialAccountId } }),
        prisma.projectSettings.findUnique({ where: { projectId: publication.projectId } })
    ]);
    if (!quizVideo) return { ok: false, reasons: ['Vidéo introuvable'] };
    if (!account) return { ok: false, reasons: ['Compte social introuvable'] };
    if (!settings) return { ok: false, reasons: ['Paramètres du projet introuvables'] };

    // 1) Approval + 5) permissions/token + 4) language + cached traceability, all in one shared check.
    const readiness = validatePublicationReadiness({ account, quizVideo, language: publication.language });
    reasons.push(...readiness.reasons);

    if (account.platform !== publication.platform) reasons.push('Incohérence de plateforme entre le compte et la publication');

    // 2/3) Live RijPermis re-check — never trust the last-known checkStatus/contentHash on its own;
    // this call re-verifies against the real catalogue right now and refreshes QuizVideo's own
    // checkStatus/checkedAt/contentHash as a side effect.
    if (quizVideo.status === 'COMPLETED') {
        const liveCheck = await verifyQuizVideoBeforePublication(prisma, deps.provider, quizVideo.id);
        if (isPublicationBlocked(liveCheck)) {
            reasons.push(`Vérification de traçabilité RijPermis bloquante en direct (statut : ${liveCheck.status})`);
        }
    }

    // 5b) getCapabilities factors in platform-specific gates (e.g. TikTok's unaudited-app
    // private-only restriction) that validatePublicationReadiness deliberately does not — it only
    // checks the scope string is present, not whether the platform actually allows acting on it.
    const connector = deps.connectors[account.platform];
    const capabilities = connector.getCapabilities({
        grantedScopes: account.grantedScopes, tokenExpiresAt: account.tokenExpiresAt ?? undefined,
        appAudited: deps.appAuditedByPlatform?.[account.platform] ?? false
    });
    if (!capabilities.canPublishDirectly) {
        reasons.push(`Publication directe non autorisée par la plateforme${capabilities.notes.length ? ` (${capabilities.notes.join(' ; ')})` : ''}`);
    }

    // 8) Dedup — never publish the same video twice to the exact same destination.
    const alreadyPublished = await prisma.socialPublication.findFirst({
        where: { quizVideoId: publication.quizVideoId, socialAccountId: publication.socialAccountId, status: 'PUBLISHED', NOT: { id: publication.id } }
    });
    if (alreadyPublished) reasons.push('Cette vidéo est déjà publiée avec succès sur cette destination (doublon évité)');

    if (reasons.length > 0) return { ok: false, reasons };

    // 7) MP4 format — only read the file once every logical check above has passed.
    if (!quizVideo.fileKey || !quizVideo.durationSeconds) return { ok: false, reasons: ['Fichier vidéo ou durée manquants'] };
    let videoBytes: Buffer;
    try {
        videoBytes = await deps.videoStorage.read(quizVideo.fileKey);
    } catch {
        return { ok: false, reasons: ['Fichier vidéo illisible depuis le stockage'] };
    }
    const media: MediaDescriptor = {
        widthPx: settings.width, heightPx: settings.height, durationSeconds: quizVideo.durationSeconds,
        fileSizeBytes: videoBytes.length, container: 'mp4'
    };
    const mediaValidation = connector.validateMediaRequirements(media);
    if (!mediaValidation.ok) return { ok: false, reasons: mediaValidation.errors.map(error => `${error.message} (${error.code})`) };

    if (!account.accessTokenCiphertext) return { ok: false, reasons: [`Jeton d'accès manquant (permission ${PUBLISH_SCOPE_BY_PLATFORM[account.platform]})`] };
    const accessToken = decryptSecret(account.accessTokenCiphertext, deps.encryptionKey, deps.previousEncryptionKey);

    return { ok: true, accessToken, videoBytes, media, accountMetadata: account.metadata as Record<string, unknown> | undefined };
}
