import { resolve } from 'node:path';
import helmet from '@fastify/helmet';
import { LocalAudioStorage, type AudioStorage } from '@fako/ai-providers';
import { contentSourceFromEnv, LocalMediaStorage, type ContentSourceProvider, type MediaStorage } from '@fako/content-sources';
import { LocalVideoStorage, type VideoStorage } from '@fako/media-engine';
import { loadEncryptionKeyFromEnv, loadPreviousEncryptionKeyFromEnv, socialConnectorsFromEnv, type SocialPlatformConnector } from '@fako/publishing';
import { audioRoutes } from './routes/audio.js';
import Fastify, { type FastifyError } from 'fastify';
import { Prisma, PrismaClient, type SocialPlatform } from '@prisma/client';
import { createPrismaClient } from '@fako/db';
import { projectRoutes } from './routes/projects.js';
import { catalogRoutes } from './routes/catalog.js';
import { createDefaultRegistry } from '@fako/video-types';
import { publicQuizVideoRoutes } from './routes/public-quiz-videos.js';
import { rijPermisRoutes } from './routes/rijpermis.js';
import { quizVideoRoutes } from './routes/quiz-videos.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { socialAccountRoutes } from './routes/social-accounts.js';
import { socialPublicationRoutes } from './routes/social-publications.js';
import { videoJobRoutes } from './routes/video-jobs.js';
import { videoScriptRoutes } from './routes/video-scripts.js';

export function buildApp(options: {
    prisma?: PrismaClient; logger?: boolean; scriptGenerationEnabled?: boolean; audioGenerationEnabled?: boolean; audioToken?: string; audioStorage?: AudioStorage;
    rijPermisProvider?: ContentSourceProvider; rijPermisStorage?: MediaStorage; rijPermisToken?: string;
    projectsToken?: string; videoJobsToken?: string; videoScriptsToken?: string;
    quizVideoEnabled?: boolean; quizVideoToken?: string; quizVideoStorage?: VideoStorage;
    schedulerToken?: string;
    socialAccountsEnabled?: boolean; socialAccountsToken?: string; socialEncryptionKey?: Buffer; socialPreviousEncryptionKey?: Buffer; socialConnectors?: Record<SocialPlatform, SocialPlatformConnector>;
    socialPublishingEnabled?: boolean; socialPublishingToken?: string;
} = {}) {
    // Mission 15: /public/quiz-video-links/:token is the one route in this API with a secret in its
    // URL rather than a header — Fastify's default access-log serializer would otherwise print that
    // token in cleartext on every request. Redacted here, once, for every logger-enabled deployment,
    // rather than relying on each operator to remember a pino redact rule.
    const logger = options.logger ? {
        serializers: { req: (request: { method: string; url: string }) => ({
            method: request.method,
            url: request.url.startsWith('/public/quiz-video-links/') ? '/public/quiz-video-links/[redacted]' : request.url
        }) }
    } : false;
    const app = Fastify({ logger, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
    // A JSON/binary API, never HTML — CSP is meaningless here (no page for it to protect), but the
    // rest of helmet's defaults (nosniff, frameguard, hidePoweredBy, hsts, etc.) are free, standard
    // hardening with no behavior to break.
    app.register(helmet, { contentSecurityPolicy: false });
    const prisma = options.prisma ?? createPrismaClient();

    if (!options.prisma) app.addHook('onClose', async () => prisma.$disconnect());

    app.setErrorHandler<FastifyError>((error, request, reply) => {
        if (error.validation) return reply.code(400).send({ error: 'Invalid request', details: error.validation });
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
            return reply.code(409).send({ error: 'Project has video jobs or no longer exists' });
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return reply.code(409).send({ error: 'Project identifier already exists' });
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
            return reply.code(404).send({ error: 'Project not found' });
        }
        if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
            return reply.code(error.statusCode).send({ error: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ error: 'Internal server error' });
    });

    app.get('/health', async () => ({
        status: 'UP', application: 'Fako Video Studio', service: 'API', timestamp: new Date().toISOString()
    }));
    // Mission 15: these three route groups previously had no trust boundary at all (every other
    // group below already required a Bearer token). Same shared-secret convention as the rest of
    // this API: defaults to QUIZ_VIDEO_API_TOKEN, overridable per group like quizVideoToken/schedulerToken.
    app.register(projectRoutes, { prisma, token: options.projectsToken ?? process.env.QUIZ_VIDEO_API_TOKEN });
    app.register(catalogRoutes, { prisma, token: options.projectsToken ?? process.env.QUIZ_VIDEO_API_TOKEN, registry: createDefaultRegistry() });
    app.register(videoJobRoutes, { prisma, token: options.videoJobsToken ?? process.env.QUIZ_VIDEO_API_TOKEN });
    app.register(videoScriptRoutes, {
        prisma, enabled: options.scriptGenerationEnabled ?? process.env.AI_PROVIDER === 'openai',
        token: options.videoScriptsToken ?? process.env.QUIZ_VIDEO_API_TOKEN
    });
    app.register(audioRoutes, { prisma, enabled: options.audioGenerationEnabled ?? process.env.TTS_PROVIDER === 'elevenlabs', token: options.audioToken ?? process.env.AUDIO_API_TOKEN, storage: options.audioStorage ?? new LocalAudioStorage(process.env.AUDIO_STORAGE_ROOT || resolve(import.meta.dirname, '../../../storage/audio')) });
    const rijPermisProvider = options.rijPermisProvider ?? contentSourceFromEnv(process.env);
    const rijPermisStorage = options.rijPermisStorage ?? new LocalMediaStorage(process.env.RIJPERMIS_MEDIA_ROOT || resolve(import.meta.dirname, '../../../storage/rijpermis-images'));
    app.register(rijPermisRoutes, { prisma, provider: rijPermisProvider, storage: rijPermisStorage, token: options.rijPermisToken ?? process.env.QUIZ_VIDEO_API_TOKEN });
    const quizVideoEnabled = options.quizVideoEnabled ?? process.env.QUIZ_VIDEO_ENABLED === 'true';
    const quizVideoStorage = options.quizVideoStorage ?? new LocalVideoStorage(process.env.QUIZ_VIDEO_STORAGE_ROOT || resolve(import.meta.dirname, '../../../storage/quiz-videos'));
    app.register(quizVideoRoutes, {
        prisma, enabled: quizVideoEnabled, token: options.quizVideoToken ?? process.env.QUIZ_VIDEO_API_TOKEN,
        provider: rijPermisProvider, mediaStorage: rijPermisStorage, videoStorage: quizVideoStorage
    });
    // Mission 15 section 4: unauthenticated by design (see the route file) — this is the capability-
    // URL counterpart to quizVideoRoutes' Bearer-protected /quiz-videos/:id/preview above, used only
    // by Instagram's own video_url fetch. Gated by the same QUIZ_VIDEO_ENABLED flag, since there is
    // nothing to serve through it when quiz videos are disabled.
    app.register(publicQuizVideoRoutes, { prisma, videoStorage: quizVideoStorage, enabled: quizVideoEnabled });
    app.register(schedulerRoutes, { prisma, token: options.schedulerToken ?? process.env.QUIZ_VIDEO_API_TOKEN });

    // Mission 13: opt-in and disabled by default, same trust boundary as the quiz-video/scheduler
    // routes above. Real adapters are only ever constructed here (never in tests); they stay inert
    // unless their own developer credentials are present (isConfigured() on each).
    const socialAccountsEnabled = options.socialAccountsEnabled ?? process.env.SOCIAL_ACCOUNTS_ENABLED === 'true';
    // SOCIAL_MOCK_MODE lets a real browser exercise the full OAuth round trip against
    // apps/web without any developer credentials — mirrors RIJPERMIS_MOCK_MODE's contract
    // exactly (fake data only, hard-refused in production regardless of other configuration).
    const socialConnectors = options.socialConnectors ?? socialConnectorsFromEnv(process.env);
    const socialEncryptionKey = options.socialEncryptionKey ?? (socialAccountsEnabled ? loadEncryptionKeyFromEnv(process.env) : undefined);
    const socialPreviousEncryptionKey = options.socialPreviousEncryptionKey ?? (socialAccountsEnabled ? loadPreviousEncryptionKeyFromEnv(process.env) : undefined);
    app.register(socialAccountRoutes, {
        prisma, enabled: socialAccountsEnabled, token: options.socialAccountsToken ?? process.env.QUIZ_VIDEO_API_TOKEN,
        encryptionKey: socialEncryptionKey, previousEncryptionKey: socialPreviousEncryptionKey, connectors: socialConnectors
    });

    // Mission 14: same opt-in/disabled-by-default/Bearer-trust-boundary conventions as every route
    // above. The actual send logic (and the server-side SOCIAL_PUBLISHING_ENABLED gate that keeps
    // real publication off unless this process is also the worker/scheduler) lives in
    // @fako/social-publishing, consumed by apps/worker and apps/scheduler — this route only ever
    // schedules/lists/cancels rows, it never calls a connector's publishVideo itself.
    app.register(socialPublicationRoutes, {
        prisma, enabled: options.socialPublishingEnabled ?? process.env.SOCIAL_PUBLISHING_ENABLED === 'true',
        token: options.socialPublishingToken ?? process.env.QUIZ_VIDEO_API_TOKEN
    });
    return app;
}
