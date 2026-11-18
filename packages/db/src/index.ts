// Point d'entrée unique pour créer un client Prisma.
//
// Le client est généré en mode « engineType = client » : aucune bibliothèque native Rust n'est
// téléchargée ni livrée, les requêtes passent par le pilote Node `pg` via @prisma/adapter-pg.
// Cela simplifie l'installation sur le VPS (pas de binaire dépendant de la plateforme).
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export function databaseUrl(value = process.env.DATABASE_URL) {
    if (!value) throw new Error('DATABASE_URL is required');
    return value;
}

export function createPrismaClient(url = databaseUrl()) {
    const parsed = new URL(url);
    const schema = parsed.searchParams.get('schema') ?? undefined;
    parsed.searchParams.delete('schema');
    const adapter = new PrismaPg({ connectionString: parsed.toString() }, schema ? { schema } : undefined);
    return new PrismaClient({ adapter });
}
