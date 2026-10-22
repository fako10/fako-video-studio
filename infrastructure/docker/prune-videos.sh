#!/usr/bin/env bash
# Mission 15 section 7 — wrapper that runs apps/api/prisma/prune-old-quiz-videos.ts inside the
# `migrate` image (the only one that still has tsx — see app.Dockerfile's `runtime` vs `migration`
# targets), against the real production database and quiz_video_data volume (both already wired into
# the `migrate` service in compose.production.yaml). Defaults to --confirm for the scheduled timer
# (fako-prune-videos.timer) — run once with FAKO_PRUNE_CONFIRM= (empty, i.e. dry-run) after any
# retention policy change and review the output before trusting the automated run.
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE="infrastructure/docker/.env"
CONFIRM_FLAG="${FAKO_PRUNE_CONFIRM---confirm}"
docker compose --env-file "$ENV_FILE" -f compose.production.yaml run --rm \
    migrate npm run db:prune-old-quiz-videos --workspace=@fako/api -- $CONFIRM_FLAG
