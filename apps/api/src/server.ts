import { buildApp } from './app.js';

const app = buildApp({ logger: true });

const start = async () => {
    try {
        await app.listen({
            port: Number(process.env.PORT ?? 3000),
            host: process.env.HOST ?? '127.0.0.1'
        });
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
};

start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
        await app.close();
    });
}
