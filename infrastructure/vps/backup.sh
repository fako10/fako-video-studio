#!/usr/bin/env bash
# Automated PostgreSQL + media volume backup for the production compose stack.
# Intended to run on the VPS via cron/systemd timer (see fako-backup.timer in this directory).
# Never logs secrets: only paths, sizes and exit codes.
set -euo pipefail
umask 077

cd "$(dirname "$0")/../.."  # repo root, so compose.production.yaml and infrastructure/docker/.env resolve
ENV_FILE="infrastructure/docker/.env"
COMPOSE="docker compose --env-file $ENV_FILE -f compose.production.yaml"
RETENTION_DAYS="${FAKO_BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
DB_BACKUP="backups/fako-${STAMP}.dump"
LOG() { printf '%s [fako-backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

LOG "starting database dump -> ${DB_BACKUP}"
$COMPOSE exec -T postgres sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' > "$DB_BACKUP"
if [ ! -s "$DB_BACKUP" ]; then
    LOG "FAILED: ${DB_BACKUP} is empty"
    rm -f "$DB_BACKUP"
    exit 1
fi
LOG "database dump ok, size=$(stat -c%s "$DB_BACKUP" 2>/dev/null || stat -f%z "$DB_BACKUP") bytes"

# Generated MP4/audio/image files referenced by QuizVideo.fileKey / AudioAsset.imageKey / etc. — a DB
# restore without these leaves such references pointing at nothing. Archived directly from each named
# Docker volume (no bind mount on this host), so this never depends on the API/worker container being
# up. Volume names are prefixed with the compose project name ("fako-production", set via `name:` in
# compose.production.yaml), not the checkout directory — adjust FAKO_COMPOSE_PROJECT if that changes.
COMPOSE_PROJECT="${FAKO_COMPOSE_PROJECT:-fako-production}"
for volume in audio_data quiz_video_data rijpermis_media_data; do
    archive="backups/fako-${volume}-${STAMP}.tar.gz"
    LOG "starting ${volume} volume archive -> ${archive}"
    # chown+chmod happen inside the container (still root there, so it may set ownership to any
    # host UID) — the host's fako user never owns this file otherwise (created by the container's
    # root, UID 0 on the host too) and so could not fix it up itself. Without this, the archive
    # lands root-owned and world-readable (022 umask) regardless of this script's own `umask 077`,
    # which only governs the host bash process — found during mission 16's real backup test.
    docker run --rm \
        -v "${COMPOSE_PROJECT}_${volume}:/data:ro" \
        -v "$(pwd)/backups:/backup" \
        alpine:3 sh -c "tar czf /backup/$(basename "$archive") -C /data . && chown $(id -u):$(id -g) /backup/$(basename "$archive") && chmod 600 /backup/$(basename "$archive")"
    if [ ! -s "$archive" ]; then
        LOG "FAILED: ${archive} is empty"
        rm -f "$archive"
        exit 1
    fi
    LOG "${volume} archive ok, size=$(stat -c%s "$archive" 2>/dev/null || stat -f%z "$archive") bytes"
done

LOG "pruning backups older than ${RETENTION_DAYS} days"
find backups -maxdepth 1 -type f \( -name 'fako-*.dump' -o -name 'fako-*_data-*.tar.gz' \) -mtime "+${RETENTION_DAYS}" -print -delete

LOG "done"
