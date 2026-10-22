import { PrismaClient } from '@prisma/client';
import { rijPermisEditorial } from '@fako/video-jobs';

const prisma = new PrismaClient();
try {
    const project = await prisma.project.findUnique({ where: { slug: 'rijpermis' } });
    if (!project) throw new Error('Run db:seed first');
    await prisma.project.updateMany({ where: { id: project.id, editorialInstructions: '' }, data: { editorialInstructions: rijPermisEditorial.editorialInstructions } });
    await prisma.project.updateMany({ where: { id: project.id, verifiedFacts: { equals: [] } }, data: { verifiedFacts: rijPermisEditorial.verifiedFacts } });
    console.log('Configuration éditoriale RijPermis disponible ; les valeurs existantes ont été conservées.');
} catch {
    console.error('Configuration éditoriale impossible : vérifier les migrations et exécuter db:seed.');
    process.exitCode = 1;
} finally { await prisma.$disconnect(); }
