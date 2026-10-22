import { test } from 'node:test';
import './_test-env.js';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/app.js';

const TOKEN = 'test-projects-integration-token-1234567890';
const headers = { authorization: `Bearer ${TOKEN}` };

test('PostgreSQL CRUD, defaults, isolation, persistence and cascading deletion', async () => {
    const prisma = new PrismaClient();
    const app = buildApp({ prisma, projectsToken: TOKEN });
    const ids: string[] = [];
    try {
        for (const name of [' First project ', 'Second project']) {
            const response = await app.inject({ method: 'POST', url: '/projects', headers, payload: { name } });
            assert.equal(response.statusCode, 201, response.body);
            const project = response.json();
            ids.push(project.id);
            assert.equal(response.headers.location, `/projects/${project.id}`);
            assert.equal(project.name, name.trim());
            assert.equal(project.settings.width, 1920);
            assert.equal(project.settings.height, 1080);
            assert.equal(project.settings.fps, 30);
        }
        const url = `/projects/${ids[0]}`;
        const custom = await app.inject({ method: 'POST', url: '/projects', headers, payload: {
            name: 'Custom settings', settings: { width: 720, height: 1280, fps: 24 }
        } });
        assert.equal(custom.statusCode, 201, custom.body);
        ids.push(custom.json().id);
        assert.equal(custom.json().settings.width, 720);
        assert.equal(custom.json().settings.height, 1280);
        assert.equal(custom.json().settings.fps, 24);
        // SQL constraints also protect callers that bypass HTTP validation.
        await assert.rejects(prisma.projectSettings.create({ data: { projectId: ids[0] } }));
        const rejectedName = `rollback-${ids[0]}`;
        await assert.rejects(prisma.project.create({ data: {
            name: rejectedName, settings: { create: { width: 0 } }
        } }));
        assert.equal(await prisma.project.count({ where: { name: rejectedName } }), 0);
        const updated = await app.inject({ method: 'PATCH', url, headers, payload: { name: 'Updated', description: 'Description', settings: { width: 1280, fps: 60 } } });
        assert.equal(updated.statusCode, 200, updated.body);
        assert.equal(updated.json().settings.height, 1080);
        assert.equal(updated.json().settings.fps, 60);
        assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: ids[0] }, include: { settings: true } })).settings?.width, 1280);
        assert.equal((await app.inject({ url: `/projects/${ids[1]}`, headers })).json().settings.fps, 30);
        const list = await app.inject({ url: '/projects?limit=1&offset=0', headers });
        assert.equal(list.statusCode, 200);
        assert.equal(list.json().projects.length, 1);
        assert.ok(list.json().total >= 2);
        assert.equal((await app.inject({ method: 'PATCH', url, headers, payload: { description: null } })).json().description, null);
        assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 204);
        assert.equal(await prisma.projectSettings.count({ where: { projectId: ids[0] } }), 0);
        assert.equal((await app.inject({ url, headers })).statusCode, 404);
        assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 404);
        assert.equal((await app.inject({ url: `/projects/${ids[1]}`, headers })).statusCode, 200);
    } finally {
        await prisma.project.deleteMany({ where: { id: { in: ids } } });
        await app.close();
        await prisma.$disconnect();
    }
});
