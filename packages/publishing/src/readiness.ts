import type { SocialAccount } from '@prisma/client';
import { isPublicationBlocked, type PublicationCheck } from '@fako/video-jobs';
import { PUBLISH_SCOPE_BY_PLATFORM } from './connector.js';
import type { QuizVideoReadinessInput, ReadinessResult } from './types.js';

export type SocialAccountReadinessInput = Pick<SocialAccount, 'platform' | 'status' | 'languages' | 'grantedScopes' | 'tokenExpiresAt'>;

// "Connexion réussie ≠ autorisation de publier" (mission 13 section 12), made concrete: every
// condition below is checked independently and *all* reasons are collected, not just the first —
// an admin UI can show the whole list rather than making someone fix issues one at a time.
//
// Reuses isPublicationBlocked from @fako/video-jobs (mission 7's RijPermis traceability check)
// against QuizVideo's own last-known checkStatus/checkedAt/contentHash. This does not re-run that
// check against the live RijPermis catalogue — it only respects whatever the pipeline already
// recorded (via verifyQuizVideoBeforePublication). Invoking the live re-check is mission 14's job,
// immediately before an actual publish call.
export function validatePublicationReadiness(params: {
    account: SocialAccountReadinessInput;
    quizVideo: QuizVideoReadinessInput;
    language: string;
}): ReadinessResult {
    const { account, quizVideo, language } = params;
    const reasons: string[] = [];

    if (account.status !== 'CONNECTED') reasons.push(`Compte non connecté (statut actuel : ${account.status})`);
    if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= Date.now()) reasons.push('Jeton d\'accès expiré');

    const publishScope = PUBLISH_SCOPE_BY_PLATFORM[account.platform];
    if (!account.grantedScopes.includes(publishScope)) reasons.push(`Permission de publication manquante (${publishScope})`);

    if (!account.languages.includes(language)) reasons.push(`Langue "${language}" non autorisée pour cette destination`);

    if (quizVideo.validationStatus !== 'APPROVED') reasons.push('Vidéo non approuvée par un réviseur humain');
    if (quizVideo.status !== 'COMPLETED') reasons.push('Vidéo pas encore générée (statut non COMPLETED)');

    const check = {
        status: quizVideo.checkStatus, checkedAt: quizVideo.checkedAt?.toISOString() ?? '', contentHash: quizVideo.contentHash
    } as unknown as PublicationCheck;
    if (isPublicationBlocked(check)) reasons.push(`Vérification de traçabilité RijPermis bloquante (statut : ${quizVideo.checkStatus})`);

    return { ready: reasons.length === 0, reasons };
}
