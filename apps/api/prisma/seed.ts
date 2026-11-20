import { createPrismaClient } from '@fako/db';
import { seedFactory } from '../src/seed.js';

const prisma = createPrismaClient();
try {
    for (const project of await seedFactory(prisma)) console.log(`Projet disponible : ${project.name} (${project.slug}), UUID ${project.id}`);
} catch {
    console.error('Seed échoué. Vérifier la connexion et appliquer les migrations avant de réessayer.');
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
