#!/usr/bin/env bash
# Mission 15 section 7 — operational monitoring sweep for the production compose stack. Intended to
# run on a short interval (cron/systemd timer, every few minutes) and feed its exit code into whatever
# alerting channel the operator already has (mail, webhook, etc.) — this script itself sends no
# notification, it only observes and reports. Never prints a token, password or ciphertext — only ids,
# statuses, counts and bytes. Targets the Ubuntu VPS shell; if ever tried from Windows Git Bash for a
# local check, prefix with MSYS_NO_PATHCONV=1 or the disk-check section's /data argument gets mangled
# into a Windows path (a Git Bash quirk, confirmed harmless on Linux — this is not a bug in the script).
set -euo pipefail

cd "$(dirname "$0")/../.."
ENV_FILE="infrastructure/docker/.env"
COMPOSE="docker compose --env-file $ENV_FILE -f compose.production.yaml"
DISK_WARN_PERCENT="${FAKO_DISK_WARN_PERCENT:-80}"
problems=0

psql_count() {
    # $1: SQL returning a single integer (a COUNT(*)).
    $COMPOSE exec -T postgres sh -c "psql --username=\"\$POSTGRES_USER\" --dbname=\"\$POSTGRES_DB\" --tuples-only --no-align --command=\"$1\"" | tr -d '[:space:]'
}

echo "=== Fako Video Studio — supervision $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo "--- Jobs en échec (VideoJob) ---"
failed_video_jobs=$(psql_count "SELECT COUNT(*) FROM \\\"VideoJob\\\" WHERE status = 'FAILED';")
echo "VideoJob FAILED: ${failed_video_jobs}"
[ "$failed_video_jobs" -gt 0 ] && problems=1

echo "--- Vidéos en échec (QuizVideo) ---"
failed_quiz_videos=$(psql_count "SELECT COUNT(*) FROM \\\"QuizVideo\\\" WHERE status = 'FAILED';")
echo "QuizVideo FAILED: ${failed_quiz_videos}"
[ "$failed_quiz_videos" -gt 0 ] && problems=1

echo "--- Publications bloquées ---"
blocked_publications=$(psql_count "SELECT COUNT(*) FROM \\\"SocialPublication\\\" WHERE status = 'BLOCKED';")
echo "SocialPublication BLOCKED: ${blocked_publications}"
[ "$blocked_publications" -gt 0 ] && problems=1

echo "--- Résultats OUTCOME_UNKNOWN (nécessitent une décision humaine, jamais relancés automatiquement) ---"
outcome_unknown=$(psql_count "SELECT COUNT(*) FROM \\\"SocialPublication\\\" WHERE status = 'OUTCOME_UNKNOWN';")
echo "SocialPublication OUTCOME_UNKNOWN: ${outcome_unknown}"
[ "$outcome_unknown" -gt 0 ] && problems=1

echo "--- Espace disque (volumes nommés, lus via un conteneur jetable) ---"
COMPOSE_PROJECT="${FAKO_COMPOSE_PROJECT:-fako-production}"
for volume in postgres_data redis_data audio_data quiz_video_data rijpermis_media_data; do
    usage=$(docker run --rm -v "${COMPOSE_PROJECT}_${volume}:/data:ro" alpine:3 df -h /data | tail -1 | awk '{print $5}' | tr -d '%')
    echo "${volume}: ${usage}% utilisé"
    if [ "${usage:-0}" -ge "$DISK_WARN_PERCENT" ]; then
        echo "  -> ALERTE : au-delà du seuil ${DISK_WARN_PERCENT}%"
        problems=1
    fi
done

echo "=== Fin de la supervision — $([ "$problems" -eq 0 ] && echo 'rien à signaler' || echo 'au moins un point nécessite une revue') ==="
exit "$problems"
