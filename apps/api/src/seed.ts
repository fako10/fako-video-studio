import { Prisma, type PrismaClient, type SocialPlatform } from '@prisma/client';
import { rijPermisEditorial } from '@fako/video-jobs';

// Configuration de départ de l'usine à vidéos : 2 marques, 3 projets et un programme « Quiz du jour »
// par projet. Ne modifie jamais un élément existant (même lancé plusieurs fois en parallèle) :
// une fois créée, la configuration se gère depuis l'admin.

const ALL_PLATFORMS: SocialPlatform[] = ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'YOUTUBE', 'SNAPCHAT'];

export const factorySeed = {
    brands: [
        {
            slug: 'rijpermis', name: 'RijPermis', websiteUrl: 'https://rijpermis.be', logoKey: 'rijpermis/logo.jpg',
            colors: { primary: '#1e6fe8', secondary: '#0a1540', accent: '#ff5a1f', background: '#ffffff', text: '#0a1540' }
        },
        {
            slug: 'monpermisenpoche', name: 'MonPermisEnPoche', websiteUrl: 'https://monpermisenpoche.fr', logoKey: 'monpermisenpoche/logo.png',
            colors: { primary: '#2970f3', secondary: '#1a3e8a', accent: '#3cc47c', background: '#ffffff', text: '#1a3e8a' }
        }
    ],
    projects: [
        { slug: 'rijpermis-fr', brand: 'rijpermis', name: 'RijPermis FR', language: 'fr', contentSource: 'rijpermis', website: 'https://rijpermis.be' },
        { slug: 'rijpermis-nl', brand: 'rijpermis', name: 'RijPermis NL', language: 'nl', contentSource: 'rijpermis', website: 'https://rijpermis.be' },
        // L'API de questions MonPermisEnPoche est en cours de création (étape 7).
        { slug: 'monpermisenpoche-fr', brand: 'monpermisenpoche', name: 'MonPermisEnPoche FR', language: 'fr', contentSource: 'monpermisenpoche', website: 'https://monpermisenpoche.fr' }
    ]
} as const;

async function createOnce<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
    const existing = await find();
    if (existing) return existing;
    try {
        return await create();
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const raced = await find();
            if (raced) return raced;
        }
        throw error;
    }
}

export async function seedFactory(prisma: PrismaClient) {
    const brands = new Map<string, string>();
    for (const brand of factorySeed.brands) {
        const row = await createOnce(() => prisma.brand.findUnique({ where: { slug: brand.slug } }), () => prisma.brand.create({ data: brand }));
        brands.set(brand.slug, row.id);
    }
    const projects = [];
    for (const { brand, ...project } of factorySeed.projects) {
        const row = await createOnce(
            () => prisma.project.findUnique({ where: { slug: project.slug } }),
            () => prisma.project.create({ data: {
                ...rijPermisEditorial, ...project, brandId: brands.get(brand)!, languages: [project.language], timezone: 'Europe/Brussels',
                category: 'éducation / permis de conduire',
                objective: "Vidéos courtes éducatives, quiz et promotion de l'application",
                settings: { create: { width: 1080, height: 1920, fps: 30, publicationEnabled: false, humanValidationRequired: true } }
            } })
        );
        // Désactivé par défaut : à activer depuis l'admin une fois la voix du projet configurée.
        await createOnce(
            () => prisma.program.findUnique({ where: { projectId_name: { projectId: row.id, name: 'Quiz du jour' } } }),
            () => prisma.program.create({ data: {
                projectId: row.id, videoType: 'daily-quiz', name: 'Quiz du jour', enabled: false,
                slots: ['16:00'], minDurationSeconds: 30, maxDurationSeconds: 60, leadDays: 1, platforms: ALL_PLATFORMS,
                params: { hashtags: ['permis', 'codedelaroute', 'quiz'], captionIntro: '' }
            } })
        );
        projects.push(row);
    }
    return projects;
}
