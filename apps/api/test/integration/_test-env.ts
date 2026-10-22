// Imported for side effect by every file in test/integration/*.test.ts, before any PrismaClient
// touches the database. Node's `--env-file-if-exists=.env.test` never overwrites a DATABASE_URL
// already present in the environment (shell session, CI), so a stray exported DATABASE_URL from
// dev work silently redirects integration tests — including their cleanup `deleteMany` calls —
// at the dev/prod database instead of .env.test's. This guard turns that into a loud failure
// instead of a silent one (this is how a QuizVideo row was previously deleted by mistake).
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error(
        'DATABASE_URL_INTEGRATION_GUARD: DATABASE_URL is not set. Integration tests must run with ' +
        '--env-file-if-exists=.env.test pointing at a dedicated test database (see apps/api/.env.test.example).'
    );
}

if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL_INTEGRATION_GUARD: refusing to run integration tests with NODE_ENV=production.');
}

let databaseName: string;
try {
    databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
} catch {
    throw new Error(`DATABASE_URL_INTEGRATION_GUARD: DATABASE_URL is not a valid connection URL (${databaseUrl}).`);
}

if (!/test/i.test(databaseName)) {
    throw new Error(
        `DATABASE_URL_INTEGRATION_GUARD: refusing to run integration tests against database "${databaseName}" — ` +
        'its name must contain "test" (e.g. fako_test), never the dev or production database. ' +
        'If you did not set DATABASE_URL yourself, check for a leftover export in your shell or CI environment: ' +
        '--env-file-if-exists=.env.test cannot override a variable that already exists in the process environment.'
    );
}
