import { Prisma, type PrismaClient, type SocialPublication } from '@prisma/client';
import { SocialPublicationRequestError } from './errors.js';
import type { SchedulePublicationInput, UpdatePublicationScheduleInput } from './types.js';

const MAX_CAPTION_LENGTH = 2200;
const CANCELLABLE_STATUSES = ['DRAFT', 'SCHEDULED', 'READY', 'BLOCKED'] as const;
const EDITABLE_STATUSES = ['DRAFT', 'SCHEDULED'] as const;

function isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// "Ne jamais permettre de publier une vidéo rejetée ou non approuvée" (mission 14 section 8) is
// enforced here, at creation time, not only at send time — there is no DRAFT loophole for an
// unapproved video. requestId is the idempotency key (same contract as requestQuizVideo): a retried
// identical call returns the existing row rather than creating a duplicate.
export async function schedulePublication(prisma: PrismaClient, input: SchedulePublicationInput): Promise<{ publication: SocialPublication; created: boolean }> {
    const existing = await prisma.socialPublication.findUnique({ where: { requestId: input.requestId } });
    if (existing) return { publication: existing, created: false };

    const caption = input.caption.trim();
    if (!caption || caption.length > MAX_CAPTION_LENGTH) throw new SocialPublicationRequestError(400, `La légende doit faire entre 1 et ${MAX_CAPTION_LENGTH} caractères`);

    const quizVideo = await prisma.quizVideo.findUnique({ where: { id: input.quizVideoId } });
    if (!quizVideo || quizVideo.projectId !== input.projectId) throw new SocialPublicationRequestError(404, 'Vidéo introuvable pour ce projet');
    if (quizVideo.validationStatus !== 'APPROVED' || quizVideo.status !== 'COMPLETED') {
        throw new SocialPublicationRequestError(409, 'Seule une vidéo approuvée et générée peut être programmée pour publication');
    }

    const account = await prisma.socialAccount.findUnique({ where: { id: input.socialAccountId } });
    if (!account || account.projectId !== input.projectId) throw new SocialPublicationRequestError(404, 'Compte social introuvable pour ce projet');
    if (!account.languages.includes(input.language)) throw new SocialPublicationRequestError(400, `Langue "${input.language}" non autorisée pour ce compte`);

    try {
        const publication = await prisma.socialPublication.create({ data: {
            projectId: input.projectId, requestId: input.requestId, quizVideoId: input.quizVideoId, socialAccountId: input.socialAccountId,
            platform: account.platform, language: input.language, caption, hashtags: input.hashtags ?? [],
            status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT', scheduledAt: input.scheduledAt ?? null, createdBy: input.createdBy
        } });
        return { publication, created: true };
    } catch (error) {
        if (isUniqueConstraintViolation(error)) {
            const raced = await prisma.socialPublication.findUnique({ where: { requestId: input.requestId } });
            if (raced) return { publication: raced, created: false };
        }
        throw error;
    }
}

export async function updatePublicationSchedule(prisma: PrismaClient, id: string, input: UpdatePublicationScheduleInput): Promise<SocialPublication> {
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "SocialPublication" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const publication = await tx.socialPublication.findUnique({ where: { id } });
        if (!publication) throw new SocialPublicationRequestError(404, 'Publication introuvable');
        if (!(EDITABLE_STATUSES as readonly string[]).includes(publication.status)) {
            throw new SocialPublicationRequestError(409, 'Seule une publication non encore programmée/due peut être modifiée');
        }
        const caption = input.caption?.trim();
        if (caption !== undefined && (!caption || caption.length > MAX_CAPTION_LENGTH)) {
            throw new SocialPublicationRequestError(400, `La légende doit faire entre 1 et ${MAX_CAPTION_LENGTH} caractères`);
        }
        const scheduledAt = input.scheduledAt === undefined ? publication.scheduledAt : input.scheduledAt;
        return tx.socialPublication.update({ where: { id }, data: {
            ...(caption !== undefined ? { caption } : {}),
            ...(input.hashtags !== undefined ? { hashtags: input.hashtags } : {}),
            ...(input.scheduledAt !== undefined ? { scheduledAt } : {}),
            status: scheduledAt ? 'SCHEDULED' : 'DRAFT'
        } });
    });
}

// "Annuler une publication non commencée" (mission 14 section 8) — never from PUBLISHING (in
// flight), PUBLISHED, CANCELLED or OUTCOME_UNKNOWN (ambiguous; must be reconciled first, not
// cancelled out from under a possibly-already-sent request).
export async function cancelPublication(prisma: PrismaClient, id: string, cancelledBy: string): Promise<SocialPublication> {
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "SocialPublication" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const publication = await tx.socialPublication.findUnique({ where: { id } });
        if (!publication) throw new SocialPublicationRequestError(404, 'Publication introuvable');
        if (!(CANCELLABLE_STATUSES as readonly string[]).includes(publication.status)) {
            throw new SocialPublicationRequestError(409, 'Seule une publication non encore commencée peut être annulée');
        }
        return tx.socialPublication.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy } });
    });
}

// "Relancer manuellement uniquement lorsque cette action est sûre" (mission 14 sections 7/8): only
// ever from BLOCKED or a confirmed FAILED — never from OUTCOME_UNKNOWN, which must first be
// resolved to a confirmed FAILED by reconciliation (see reconcile.ts) before a human can retry it.
export async function retryPublication(prisma: PrismaClient, id: string): Promise<SocialPublication> {
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "SocialPublication" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const publication = await tx.socialPublication.findUnique({ where: { id } });
        if (!publication) throw new SocialPublicationRequestError(404, 'Publication introuvable');
        if (publication.status !== 'BLOCKED' && publication.status !== 'FAILED') {
            throw new SocialPublicationRequestError(409, 'Seule une publication bloquée ou en échec confirmé peut être relancée manuellement');
        }
        return tx.socialPublication.update({ where: { id }, data: { status: 'READY', lastError: null } });
    });
}
