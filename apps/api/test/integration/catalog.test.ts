import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '@fako/db';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-catalog-integration-token-12345678';
const headers = { authorization: `Bearer ${TOKEN}` };

test('catalogue : types de vidéos, marques et programmes, avec validation des paramètres propres au type', async () => {
    const prisma = createPrismaClient();
    const app = buildApp({ prisma, projectsToken: TOKEN });
    const slug = `brand-${randomUUID().slice(0, 8)}`;
    let projectId: string | undefined;
    try {
        assert.equal((await app.inject('/video-types')).statusCode, 401);
        const types = (await app.inject({ url: '/video-types', headers })).json().videoTypes;
        assert.ok(types.some((t: { id: string }) => t.id === 'daily-quiz'));

        const brand = await app.inject({ method: 'POST', url: '/brands', headers, payload: {
            slug, name: 'Marque test', websiteUrl: 'https://exemple.be', colors: { primary: '#112233' }
        } });
        assert.equal(brand.statusCode, 201, brand.body);
        assert.equal((await app.inject({ method: 'POST', url: '/brands', headers, payload: { slug, name: 'Doublon' } })).statusCode, 409);
        assert.equal((await app.inject({ method: 'PATCH', url: `/brands/${brand.json().id}`, headers, payload: { colors: { primary: 'rouge' } } })).statusCode, 400);

        const project = await app.inject({ method: 'POST', url: '/projects', headers, payload: {
            name: 'Projet test', brandId: brand.json().id, language: 'fr', timezone: 'Europe/Brussels', contentSource: 'rijpermis'
        } });
        assert.equal(project.statusCode, 201, project.body);
        projectId = project.json().id;

        const unknownType = await app.inject({ method: 'POST', url: `/projects/${projectId}/programs`, headers, payload: { videoType: 'inconnu', name: 'X' } });
        assert.equal(unknownType.statusCode, 422);
        const badParams = await app.inject({ method: 'POST', url: `/projects/${projectId}/programs`, headers, payload: {
            videoType: 'daily-quiz', name: 'Quiz', params: { hashtags: 'pas-une-liste' }
        } });
        assert.equal(badParams.statusCode, 400);

        const created = await app.inject({ method: 'POST', url: `/projects/${projectId}/programs`, headers, payload: {
            videoType: 'daily-quiz', name: 'Quiz', slots: ['16:00'], platforms: ['TIKTOK', 'YOUTUBE'], params: { hashtags: ['permis'] }
        } });
        assert.equal(created.statusCode, 201, created.body);
        const program = created.json();
        assert.equal(program.enabled, false);
        assert.equal(program.minDurationSeconds, 30);
        assert.equal(program.maxDurationSeconds, 60);
        assert.deepEqual(program.params, { hashtags: ['permis'], captionIntro: '' }, 'valeurs par défaut du type complétées');

        assert.equal((await app.inject({ method: 'PATCH', url: `/programs/${program.id}`, headers, payload: { slots: ['25:00'] } })).statusCode, 400);
        assert.equal((await app.inject({ method: 'PATCH', url: `/programs/${program.id}`, headers, payload: { minDurationSeconds: 120 } })).statusCode, 400);
        const enabled = await app.inject({ method: 'PATCH', url: `/programs/${program.id}`, headers, payload: { enabled: true, daysOfWeek: [1, 3, 5] } });
        assert.equal(enabled.statusCode, 200, enabled.body);
        assert.equal(enabled.json().enabled, true);
        assert.deepEqual(enabled.json().daysOfWeek, [1, 3, 5]);

        const list = (await app.inject({ url: `/projects/${projectId}/programs`, headers })).json().programs;
        assert.equal(list.length, 1);
    } finally {
        if (projectId) {
            await prisma.program.deleteMany({ where: { projectId } });
            await prisma.projectSettings.deleteMany({ where: { projectId } });
            await prisma.project.delete({ where: { id: projectId } });
        }
        await prisma.brand.deleteMany({ where: { slug } });
        await app.close();
        await prisma.$disconnect();
    }
});
