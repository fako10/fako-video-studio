# Scheduler quotidien et rotation des questions (Mission 11)

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

## Architecture

`apps/scheduler` est une application autonome, volontairement légère : elle ne dépend ni
d'`@fako/ai-providers`, ni d'`@fako/media-engine`, ni de Remotion. Elle n'appelle jamais
`generateQuizVideo` — uniquement `requestQuizVideo` (mission 10), l'étape gratuite et rapide. Le
rendu réel reste entièrement la responsabilité du worker existant et de son dispatcher outbox,
inchangés. Cette séparation est structurelle, pas seulement documentée.

La logique réutilisable vit dans `packages/quiz-pipeline`, aux côtés du reste du pipeline :

- `schedule.ts` — calcul pur, sans dépendance, des créneaux dus à un instant donné, avec la bonne
  heure Europe/Brussels (via `Intl`, donc le passage heure d'été/hiver est géré automatiquement, sans
  nouvelle dépendance de fuseau horaire).
- `rotation.ts` — statistiques d'usage par question et par thème, dérivées des lignes `QuizVideo`
  déjà existantes (mission 10) : aucune table d'historique séparée n'a été créée.
- `select.ts` — sélection enrichie : jamais utilisée d'abord, puis la moins récemment utilisée,
  puis diversité de thème en départage. Toujours strictement limitée à la langue demandée.
- `scheduler.ts` — `runSchedulerTick()`, le seul point de jonction entre planification et exécution.

## Fiabilité

- **Idempotence et protection multi-instances** : une contrainte unique PostgreSQL
  `(projectId, scheduledDate, slotTime, language)` sur `ScheduledQuizSlot` est le verrou. Deux ticks
  (ou deux instances du scheduler) qui tentent de réclamer le même créneau au même instant : un seul
  réussit, l'autre reçoit une violation de contrainte et passe simplement son tour.
- **Reprise après redémarrage sans rattrapage en masse** : un créneau dont l'heure est dépassée de
  plus de `SCHEDULER_GRACE_MINUTES` (2 h par défaut) est enregistré `SKIPPED` avec une raison claire,
  jamais généré en retard. Un redémarrage après une longue coupure ne produit donc jamais une
  dizaine de vidéos d'un coup.
- **Limitation de la file** : si le nombre de `QuizVideo` déjà en attente (`PENDING`/`QUEUED`/
  `PROCESSING`) atteint `SCHEDULER_MAX_PENDING_JOBS`, le créneau est reporté (`SKIPPED`, nouvelle
  tentative au prochain tick) plutôt que d'empiler davantage de rendus.
- **Jamais de double appel payant** : la mise en cache TTS (mission 9) et le garde-fou
  `QUIZ_VIDEO_OUTCOME_UNKNOWN` (mission 10) s'appliquent sans changement ; le scheduler n'introduit
  aucun nouveau chemin de facturation.
- **Séparation planification/exécution** : `runSchedulerTick` ne fait jamais de rendu ; il crée au
  plus une ligne `QuizVideo` par créneau dû, que le worker existant traite ensuite à son rythme.

## Rotation des questions

`selectRijPermisQuestion` parcourt désormais tout le catalogue disponible pour la langue (pagination
bornée), puis trie par : nombre d'utilisations croissant → date de dernière utilisation la plus
ancienne → thème le moins récemment représenté. Une question jamais utilisée passe toujours avant
une question déjà utilisée, quelle que soit son ancienneté. Aucune question d'une autre langue n'est
jamais choisie pour combler un quota. Si le catalogue d'une langue est vide, le créneau concerné
échoue clairement (`FAILED`, raison explicite) — rien n'est fabriqué.

## Configuration

`apps/scheduler/.env` (voir `.env.example`) :

```dotenv
SCHEDULER_ENABLED=false
SCHEDULER_PROJECT_SLUG=rijpermis
SCHEDULER_TIMEZONE=Europe/Brussels
SCHEDULER_SLOTS=09:00,16:00,21:00
SCHEDULER_GRACE_MINUTES=120
SCHEDULER_MAX_PENDING_JOBS=10
SCHEDULER_TICK_INTERVAL_MS=60000
```

Désactivé par défaut (`SCHEDULER_ENABLED=false` sort immédiatement, sans se connecter à rien).
`SCHEDULER_SLOTS` accepte toute liste d'horaires `HH:mm` séparés par des virgules — modifiable sans
toucher au code. Réutilise les variables RijPermis déjà existantes (`RIJPERMIS_API_ENABLED`,
`RIJPERMIS_MOCK_MODE`, `RIJPERMIS_API_BASE_URL`, `RIJPERMIS_API_KEY`, `RIJPERMIS_MEDIA_ROOT`).

## Suivi de production

`GET /projects/:id/scheduler/days/:date` (authentification `Bearer QUIZ_VIDEO_API_TOKEN`, même
jeton que les routes vidéo de la mission 10) renvoie :

```json
{
  "date": "2026-01-15", "planned": 6, "jobsCreated": 5, "generated": 3,
  "waitingApproval": 2, "approved": 1, "rejected": 0,
  "generationFailures": 0, "schedulingFailures": 1, "skipped": 0,
  "byLanguage": { "fr": 3, "nl": 3 },
  "questionsUsed": [{ "language": "fr", "questionId": "6337", "category": "Priorité" }],
  "slots": [{ "slotTime": "09:00", "language": "fr", "status": "DISPATCHED", "quizVideoId": "..." }]
}
```

Aucun champ de publication : une vidéo générée reste `WAITING_APPROVAL` jusqu'à
`POST /quiz-videos/:id/review` (mission 10) ; rien dans ce rapport ne déclenche ni ne suppose une
publication sur TikTok, Instagram ou Facebook — ces connecteurs restent hors du périmètre de cette
mission.

## Simulation (aucune écriture)

```powershell
npm.cmd run build
npm.cmd run simulate --workspace=@fako/scheduler
```

Affiche, pour chaque créneau dû à l'instant présent (ou à `SCHEDULER_SIMULATE_NOW` si défini), la
question qui serait choisie et pourquoi (jamais utilisée / réutilisée, avec compteur), sans jamais
créer de `ScheduledQuizSlot`, de `QuizVideo`, ni appeler `requestQuizVideo`. Vérifié pendant cette
mission : zéro ligne créée en base après exécution.

## Démarrage local

```powershell
npm.cmd run build
docker compose up -d --wait postgres redis
npm.cmd run db:migrate --workspace=@fako/api
```

Dans `apps/scheduler/.env` : `SCHEDULER_ENABLED=true`, `RIJPERMIS_MOCK_MODE=true` (catalogue
fictif, aucun appel réel). Dans `apps/api/.env` et `apps/worker/.env` : la configuration de la
mission 10 (`QUIZ_VIDEO_ENABLED=true`, `QUIZ_VIDEO_TTS_PROVIDER=mock`), inchangée.

```powershell
npm.cmd run dev:scheduler   # nouveau terminal
```

Le scheduler ne crée des `QuizVideo` que pour les créneaux réellement dus ; le worker existant les
traite ensuite. Consultez `GET /projects/:id/scheduler/days/:date` pour suivre la journée.

## Environnements

En local, le catalogue mock ne contient que des questions par défaut en français
(`@fako/content-sources`'s `mockQuestion`) ; une demande `nl` échoue donc proprement avec « No
RijPermis question available for language "nl" » — vérifié par un test dédié, qui confirme que le
créneau `fr` n'est pas affecté. En production future, RijPermis fournira les deux langues.

## Tests

```powershell
npm.cmd run build
npm.cmd test
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5433/fako_test?schema=public'
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run test:integration --workspace=@fako/api
npm.cmd run test --workspace=@fako/scheduler
```

`packages/quiz-pipeline/test/schedule.test.ts` couvre la conversion de fuseau horaire (hiver, été,
passage à l'heure d'été), les 6 créneaux quotidiens, la fenêtre de grâce et le non-rattrapage après
coupure. `select.test.ts` couvre la rotation (jamais utilisée d'abord, puis la plus ancienne, puis
diversité de thème), la pagination du catalogue et l'absence de repli inter-langues.
`apps/api/test/integration/scheduler.test.ts` couvre, avec une vraie base PostgreSQL : la séparation
FR/NL, l'absence de questions dans une langue, l'idempotence, les exécutions concurrentes, la
reprise après coupure, la limite de file d'attente, la configuration de voix manquante, et le
rapport de production via la route authentifiée. `apps/scheduler/test/disabled.test.ts` vérifie que
le démon s'arrête proprement, sans se connecter à rien, quand `SCHEDULER_ENABLED` n'est pas `true`.
Aucun test n'appelle ElevenLabs, OpenAI ou RijPermis réellement.
