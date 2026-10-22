import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { seedRijPermis } from '../../src/seed.js';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-seed-integration-token-1234567890';
const headers = { authorization: `Bearer ${TOKEN}` };

test('RijPermis seed is concurrent-safe, idempotent and preserves existing configuration', async () => {
    const prisma = new PrismaClient();
    const app = buildApp({ prisma, projectsToken: TOKEN });
    let createdId: string | undefined;
    try {
        assert.equal(await prisma.project.count({ where: { slug: 'rijpermis' } }), 0,
            'Run this test on an isolated test database without RijPermis');
        const [first, second] = await Promise.all([seedRijPermis(prisma), seedRijPermis(prisma)]);
        createdId = first.id;
        assert.equal(first.id, second.id);
        assert.equal(await prisma.project.count({ where: { slug: 'rijpermis' } }), 1);
        assert.equal(first.name, 'RijPermis');
        assert.equal(first.website, 'https://rijpermis.be');
        assert.equal(first.category, 'éducation / permis de conduire belge');
        assert.deepEqual(first.languages, ['fr', 'nl']);
        assert.match(first.objective!, /quiz/);
        assert.equal(first.settings?.width, 1080);
        assert.equal(first.settings?.height, 1920);
        assert.equal(first.settings?.fps, 30);
        assert.equal(first.settings?.videosPerDay, 2);
        assert.equal(first.settings?.publicationEnabled, false);
        assert.equal(first.settings?.humanValidationRequired, true);
        assert.deepEqual(await seedRijPermis(prisma), first);

        const response = await app.inject({ url: `/projects/${first.id}`, headers });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().slug, 'rijpermis');
        assert.equal((await app.inject({ method: 'POST', url: '/projects', headers, payload: { name: 'Duplicate', slug: 'rijpermis' } })).statusCode, 409);
        const patch = await app.inject({ method: 'PATCH', url: `/projects/${first.id}`, headers, payload: {
            objective: 'Custom objective', languages: ['nl'], settings: { videosPerDay: 4 }
        } });
        assert.equal(patch.statusCode, 200, patch.body);
        const edited = await prisma.project.findUniqueOrThrow({ where: { id: first.id }, include: { settings: true } });
        assert.deepEqual(await seedRijPermis(prisma), edited);
    } finally {
        if (createdId) await prisma.project.delete({ where: { id: createdId } });
        await app.close();
        await prisma.$disconnect();
    }
});
