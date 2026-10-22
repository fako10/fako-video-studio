import { PrismaClient } from '@prisma/client';
import { seedRijPermis } from '../src/seed.js';

const prisma = new PrismaClient();
try {
    const project = await seedRijPermis(prisma);
    console.log(`Projet disponible : ${project.name} (${project.slug}), UUID ${project.id}`);
} catch {
    console.error('Seed échoué. Vérifier la connexion et appliquer les migrations avant de réessayer.');
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
