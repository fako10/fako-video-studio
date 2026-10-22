import { buildApp } from './app.js';
import { loadWebConfig } from './config.js';

const config = loadWebConfig();
const app = buildApp({
    logger: true, adminUsername: config.adminUsername, adminPasswordHash: config.adminPasswordHash,
    sessionKey: config.sessionKey, secureCookies: config.secureCookies,
    apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, projectSlug: config.projectSlug,
    publicBaseUrl: config.publicBaseUrl
});

try {
    await app.listen({ port: Number(process.env.PORT ?? 3100), host: process.env.HOST ?? '127.0.0.1' });
} catch (error) {
    app.log.error(error);
    process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => { await app.close(); });
}
