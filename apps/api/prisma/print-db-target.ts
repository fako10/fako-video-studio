// Runs before db:migrate/db:seed/db:editorial (see package.json "pre*" scripts) so a wrong
// DATABASE_URL — e.g. still pointing at production because of a leftover shell export — is visible
// before any schema change or write, instead of silently applying to the wrong database.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
}
let host = 'unknown host', name = 'unknown database';
try {
    const url = new URL(databaseUrl);
    host = url.hostname + (url.port ? `:${url.port}` : '');
    name = url.pathname.replace(/^\//, '') || 'unknown database';
} catch { /* fall through with the defaults above; pg_dump/prisma will report the real parse error */ }
console.error(`[db-target] about to run against database "${name}" on ${host}`);
