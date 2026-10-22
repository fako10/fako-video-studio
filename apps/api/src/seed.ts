import { Prisma, type PrismaClient } from '@prisma/client';
import { rijPermisEditorial } from '@fako/video-jobs';

// Never update an existing project's configuration, even when seeds run concurrently.
export async function seedRijPermis(prisma: PrismaClient) {
    const where = { slug: 'rijpermis' };
    const existing = await prisma.project.findUnique({ where, include: { settings: true } });
    if (existing) return existing;
    try {
        return await prisma.project.create({
            data: {
                ...rijPermisEditorial,
                slug: 'rijpermis', name: 'RijPermis', website: 'https://rijpermis.be',
                category: 'éducation / permis de conduire belge', languages: ['fr', 'nl'],
                objective: "Vidéos courtes éducatives, quiz et promotion de l'application",
                settings: { create: {
                    width: 1080, height: 1920, fps: 30, videosPerDay: 2,
                    publicationEnabled: false, humanValidationRequired: true
                } }
            },
            include: { settings: true }
        });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const project = await prisma.project.findUnique({ where, include: { settings: true } });
            if (project) return project;
        }
        throw error;
    }
}
