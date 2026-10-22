# One multi-stage file for every production service (api, worker, scheduler, web): the single `build`
# stage compiles the whole monorepo exactly like `npm run build` does locally, and each runtime target
# below copies only the dist/package.json pairs (and, for the worker, the Chromium runtime) it actually
# needs. Mission 15 section 3 fix: the previous version of this file only copied apps/api, apps/worker,
# packages/video-jobs and packages/ai-providers — the `worker` image it produced could not actually
# have built (apps/worker also depends on @fako/content-sources, @fako/media-engine,
# @fako/quiz-pipeline, @fako/publishing, @fako/social-publishing, none of which were copied in), and
# had no Chromium system libraries for Remotion at all. Copying every workspace here, always, is
# slightly more than any single service strictly needs, but it is correct by construction: a new
# package added to an existing service's dependency graph can never again be silently missing from
# this file the way it was before.
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/scheduler/package.json ./apps/scheduler/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/ai-providers/package.json ./packages/ai-providers/package.json
COPY packages/content-sources/package.json ./packages/content-sources/package.json
COPY packages/media-engine/package.json ./packages/media-engine/package.json
COPY packages/publishing/package.json ./packages/publishing/package.json
COPY packages/quiz-pipeline/package.json ./packages/quiz-pipeline/package.json
COPY packages/social-publishing/package.json ./packages/social-publishing/package.json
COPY packages/video-jobs/package.json ./packages/video-jobs/package.json
COPY packages/video-templates/package.json ./packages/video-templates/package.json
RUN npm ci
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY apps/scheduler ./apps/scheduler
COPY apps/web ./apps/web
COPY packages/ai-providers ./packages/ai-providers
COPY packages/content-sources ./packages/content-sources
COPY packages/media-engine ./packages/media-engine
COPY packages/publishing ./packages/publishing
COPY packages/quiz-pipeline ./packages/quiz-pipeline
COPY packages/social-publishing ./packages/social-publishing
COPY packages/video-jobs ./packages/video-jobs
COPY packages/video-templates ./packages/video-templates
RUN npm run build

# Retains the Prisma CLI (a dev dependency) — used only to run migrations, never to serve traffic.
FROM build AS migration
USER node
CMD ["npm", "run", "db:migrate", "--workspace=@fako/api"]

FROM build AS production-dependencies
RUN npm prune --omit=dev

# --- api / scheduler: no Chromium needed, kept lean ---------------------------------------------
FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/scheduler/package.json ./apps/scheduler/package.json
COPY --from=build /app/apps/scheduler/dist ./apps/scheduler/dist
COPY --from=build /app/packages/ai-providers/package.json ./packages/ai-providers/package.json
COPY --from=build /app/packages/ai-providers/dist ./packages/ai-providers/dist
COPY --from=build /app/packages/content-sources/package.json ./packages/content-sources/package.json
COPY --from=build /app/packages/content-sources/dist ./packages/content-sources/dist
COPY --from=build /app/packages/media-engine/package.json ./packages/media-engine/package.json
COPY --from=build /app/packages/media-engine/dist ./packages/media-engine/dist
COPY --from=build /app/packages/publishing/package.json ./packages/publishing/package.json
COPY --from=build /app/packages/publishing/dist ./packages/publishing/dist
COPY --from=build /app/packages/quiz-pipeline/package.json ./packages/quiz-pipeline/package.json
COPY --from=build /app/packages/quiz-pipeline/dist ./packages/quiz-pipeline/dist
COPY --from=build /app/packages/social-publishing/package.json ./packages/social-publishing/package.json
COPY --from=build /app/packages/social-publishing/dist ./packages/social-publishing/dist
COPY --from=build /app/packages/video-jobs/package.json ./packages/video-jobs/package.json
COPY --from=build /app/packages/video-jobs/dist ./packages/video-jobs/dist
COPY --from=build /app/packages/video-templates/package.json ./packages/video-templates/package.json
COPY --from=build /app/packages/video-templates/dist ./packages/video-templates/dist
COPY --from=build /app/packages/video-templates/public ./packages/video-templates/public
RUN mkdir -p /app/storage/audio /app/storage/quiz-videos && chown -R node:node /app/storage
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]

# --- worker: same files as `runtime`, plus Chromium's system libraries for Remotion --------------
# apt package list per Remotion's own documented self-hosted Docker requirements
# (https://www.remotion.dev/docs/miscellaneous/docker) for a Debian/Ubuntu base image.
FROM runtime AS worker-runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev \
    libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
# Remotion's bundler compiles the composition from TypeScript SOURCE at render time (its own
# webpack/esbuild step, not tsc) — packages/media-engine/src/render.ts's entry point points at
# video-templates/src/entry.ts, never its compiled dist/. Confirmed by actually running a render
# inside this image (infrastructure/docker/README.md's benchmark): omitting this directory fails
# immediately with ENOENT on that file, every other service never needs it.
COPY --from=build /app/packages/video-templates/src ./packages/video-templates/src
COPY --from=build /app/packages/video-templates/tsconfig.remotion.json ./packages/video-templates/tsconfig.remotion.json
# webpack's own persistent cache (packages/video-templates/node_modules/.cache) needs to create that
# directory at render time, as the `node` user — confirmed by actually running a render inside this
# image: without this, every render silently re-bundles from scratch (a logged warning, not a
# failure, but a real slowdown across repeated renders).
RUN mkdir -p /app/packages/video-templates/node_modules && chown -R node:node /app/packages/video-templates/node_modules
# Bakes Remotion's headless Chrome binary into the image at build time (cwd=/app, same as the CMD
# below, so this hits the exact cache path — node_modules/.remotion — the real render will use;
# see packages/media-engine/src/render.ts) instead of downloading it on the first real render.
RUN node -e "require('@remotion/renderer').ensureBrowser().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })"
RUN chown -R node:node /app/node_modules/.remotion
USER node
CMD ["node", "apps/worker/dist/worker.js"]

# --- web (admin BFF): no workspace dependency at all, smallest image -----------------------------
FROM node:24-bookworm-slim AS web-runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3100
CMD ["node", "apps/web/dist/server.js"]
