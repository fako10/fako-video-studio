import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { createPrismaClient } from '@fako/db';
import { factorySeed, seedFactory } from '../../src/seed.js';

const slugs = factorySeed.projects.map(p => p.slug);
const brandSlugs = factorySeed.brands.map(b => b.slug);

async function cleanup(prisma: ReturnType<typeof createPrismaClient>) {
    const projects = await prisma.project.findMany({ where: { slug: { in: slugs } }, select: { id: true } });
    const ids = projects.map(p => p.id);
    await prisma.program.deleteMany({ where: { projectId: { in: ids } } });
    await prisma.project.deleteMany({ where: { id: { in: ids } } });
    await prisma.brand.deleteMany({ where: { slug: { in: brandSlugs } } });
}

test('le seed crée 2 marques, 3 projets et un programme Quiz du jour par projet, sans jamais écraser une configuration existante', async () => {
    const prisma = createPrismaClient();
    try {
        assert.equal(await prisma.project.count({ where: { slug: { in: slugs } } }), 0, 'à lancer sur une base de test isolée');
        const [first, second] = await Promise.all([seedFactory(prisma), seedFactory(prisma)]);
        assert.deepEqual(first.map(p => p.id), second.map(p => p.id), 'deux seeds concurrents convergent');

        const projects = await prisma.project.findMany({ where: { slug: { in: slugs } }, include: { brand: true, programs: true, settings: true }, orderBy: { slug: 'asc' } });
        assert.deepEqual(projects.map(p => [p.slug, p.language, p.brand?.slug, p.contentSource]), [
            ['monpermisenpoche-fr', 'fr', 'monpermisenpoche', 'monpermisenpoche'],
            ['rijpermis-fr', 'fr', 'rijpermis', 'rijpermis'],
            ['rijpermis-nl', 'nl', 'rijpermis', 'rijpermis']
        ]);
        for (const project of projects) {
            assert.equal(project.settings?.width, 1080);
            assert.equal(project.settings?.height, 1920);
            assert.equal(project.programs.length, 1);
            const [program] = project.programs;
            assert.equal(program.videoType, 'daily-quiz');
            assert.equal(program.enabled, false, 'à activer après configuration de la voix');
            assert.deepEqual(program.platforms, ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'YOUTUBE', 'SNAPCHAT']);
        }
        assert.equal(projects[0].brand?.websiteUrl, 'https://monpermisenpoche.fr');
        assert.equal(projects[1].brand?.websiteUrl, 'https://rijpermis.be');

        // Une configuration modifiée n'est jamais écrasée par un nouveau seed.
        await prisma.program.updateMany({ where: { projectId: projects[1].id }, data: { slots: ['09:00'], enabled: true } });
        await seedFactory(prisma);
        const program = await prisma.program.findFirstOrThrow({ where: { projectId: projects[1].id } });
        assert.deepEqual(program.slots, ['09:00']);
        assert.equal(program.enabled, true);
        assert.equal(await prisma.program.count({ where: { projectId: projects[1].id } }), 1);
    } finally {
        await cleanup(prisma);
        await prisma.$disconnect();
    }
});
