#!/usr/bin/env bash
# Restores a PostgreSQL dump into a throwaway database for verification. Never touches the live
# `fako` database. Fails if the target database already exists, so it can never be pointed at a
# database that already has real data by mistake.
#
# Usage: infrastructure/docker/restore-check.sh backups/fako-YYYYMMDDTHHMMSSZ.dump [target_db]
set -euo pipefail

BACKUP="${1:?Usage: restore-check.sh <backup.dump> [target_db]}"
TARGET_DB="${2:-fako_restore_check}"
[ -s "$BACKUP" ] || { echo "Backup file is missing or empty: $BACKUP" >&2; exit 1; }

cd "$(dirname "$0")/../.."
COMPOSE="docker compose --env-file infrastructure/docker/.env -f compose.production.yaml"
LOG() { printf '%s [fako-restore-check] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

LOG "creating throwaway database ${TARGET_DB} (fails if it already exists)"
$COMPOSE exec -T postgres sh -c "createdb --username=\"\$POSTGRES_USER\" ${TARGET_DB}"

LOG "restoring ${BACKUP} into ${TARGET_DB}"
$COMPOSE exec -T postgres sh -c "pg_restore --username=\"\$POSTGRES_USER\" --dbname=${TARGET_DB} --no-owner --no-privileges --exit-on-error --single-transaction" < "$BACKUP"

LOG "row counts in ${TARGET_DB}:"
$COMPOSE exec -T postgres sh -c "psql --username=\"\$POSTGRES_USER\" --dbname=${TARGET_DB} --command=\"SELECT 'Project' AS table, count(*) FROM \\\"Project\\\" UNION ALL SELECT 'QuizVideo', count(*) FROM \\\"QuizVideo\\\" UNION ALL SELECT 'SocialPublication', count(*) FROM \\\"SocialPublication\\\";\""

LOG "verification database ${TARGET_DB} is ready for manual inspection."
LOG "drop it when done: docker compose --env-file infrastructure/docker/.env -f compose.production.yaml exec -T postgres sh -c \"dropdb --username=\\\"\\\$POSTGRES_USER\\\" ${TARGET_DB}\""
