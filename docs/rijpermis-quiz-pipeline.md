# Pipeline automatisé VideoJob → MP4 narré (Mission 10)

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

## Architecture

Un nouveau package, `packages/quiz-pipeline`, relie ce qui existait déjà sans le réécrire :

- `@fako/content-sources` (mission 7) — sélection et récupération de la question.
- `@fako/ai-providers` (missions 5 et 9) — `TTSProvider`, `CachingTTSProvider`, et le nouveau
  `MeteringTTSProvider` (comptage des caractères/réutilisations de cache pour la traçabilité).
- `@fako/video-templates` (mission 8) — `buildQuizVideoProps`, `attachNarration`.
- `@fako/media-engine` (missions 8 et 9) — `synthesizeQuizNarration`, `renderQuizVideo`, et le
  nouveau `LocalVideoStorage` (stockage sécurisé du MP4, calqué sur `LocalAudioStorage`).

Volontairement **indépendant** de `VideoJob`/`VideoScript` : la narration y est un gabarit
déterministe, pas un scénario OpenAI, et forcer ce contenu dans ces tables aurait dupliqué du sens
plutôt que des données. Une nouvelle table `QuizVideo` (une ligne par vidéo, pas de notion de
version) porte l'état du job, la traçabilité de la source et le résultat du rendu — suivant
exactement le même schéma « outbox PostgreSQL + file BullMQ + verrou consultatif » que les
pipelines scénario (mission 6) et audio (mission 5).

## Pipeline

1. `POST /projects/:id/quiz-videos` (API, rapide, gratuit) — `requestQuizVideo()` : vérifie la
   langue et la voix configurées, sélectionne ou récupère une question RijPermis éligible
   (`selectRijPermisQuestion`, jamais une question refusée à l'export), télécharge son image si
   elle existe, et enregistre son identifiant, son snapshot complet et son `contentHash`.
2. La file `quiz-videos` (BullMQ/Redis) alimentée par `dispatchQuizVideos` (outbox, identique au
   pattern des missions 5/6) déclenche le worker.
3. `generateQuizVideo()` (worker, coûteux) : construit les props du gabarit, synthétise la
   narration (fournisseur TTS mis en cache **et** mesuré), rend le MP4 avec Remotion, mesure sa
   durée réelle et l'enregistre dans le stockage vidéo local.
4. Le résultat passe en `WAITING_APPROVAL` — jamais `COMPLETED` automatiquement.
5. `POST /quiz-videos/:id/review` approuve ou rejette ; seule l'approbation humaine fait passer le
   statut à `COMPLETED`.

## Protections conservées

- **Jamais de question refusée à l'export** : `selectRijPermisQuestion` ne fait que relayer
  `listQuestions`/`getQuestion`, qui ne renvoient que des questions `APPROVED` (mission 7).
- **Idempotence** : `requestId` unique ; une même demande renvoie toujours la même ligne, verrouillée
  au niveau du projet (`SELECT ... FOR UPDATE`) pour éviter la course entre deux requêtes concurrentes.
- **Pas de double facturation sur retry** : un job retrouvé à `PROCESSING` (crash pendant un appel
  potentiellement déjà facturé) passe directement en `FAILED` avec `QUIZ_VIDEO_OUTCOME_UNKNOWN`,
  jamais rejoué automatiquement. Seules les erreurs TTS explicitement marquées réessayables
  (ex. 429) déclenchent un nouveau essai, dans la limite de 3 tentatives.
- **Cache audio** : `CachingTTSProvider` (mission 9) réutilise une narration déjà synthétisée pour
  un texte, une voix et des réglages identiques — vérifié par un test consommant la même question
  deux fois sans second appel au fournisseur.
- **Concurrence de rendu limitée** : `QUIZ_VIDEO_WORKER_CONCURRENCY` (défaut `1`) protège les
  ressources serveur, le rendu Remotion étant la partie la plus coûteuse en CPU/mémoire.
- **Validation humaine obligatoire** : `verifyQuizVideoBeforePublication` + `isPublicationBlocked`
  (mission 7, réutilisés tels quels) restent l'interface prête pour un futur moteur de publication,
  non implémenté ici.

## Configuration

Déjà existant, réutilisé sans modification : `RIJPERMIS_API_ENABLED`/`RIJPERMIS_MOCK_MODE`/
`RIJPERMIS_API_BASE_URL`/`RIJPERMIS_API_KEY`/`RIJPERMIS_MEDIA_ROOT` (mission 7), `ELEVENLABS_API_KEY`
(mission 5), voix par projet/langue via `PUT /projects/:id/voices/:language` (mission 5).

Nouveau, dans `apps/api/.env` :

```dotenv
QUIZ_VIDEO_ENABLED=false
QUIZ_VIDEO_API_TOKEN=
QUIZ_VIDEO_STORAGE_ROOT=
```

Nouveau, dans `apps/worker/.env` :

```dotenv
QUIZ_VIDEO_ENABLED=false
# disabled | mock | elevenlabs — "mock" est refusé automatiquement si NODE_ENV=production.
QUIZ_VIDEO_TTS_PROVIDER=disabled
QUIZ_VIDEO_STORAGE_ROOT=
QUIZ_VIDEO_AUDIO_CACHE_ROOT=
QUIZ_VIDEO_PUBLIC_DIR=
QUIZ_VIDEO_WORKER_CONCURRENCY=1
```

En développement, `QUIZ_VIDEO_TTS_PROVIDER=mock` permet de produire de vraies vidéos MP4 localement
sans jamais appeler ElevenLabs. En production future, seul `elevenlabs` (avec une clé configurée
explicitement) est accepté par le worker ; l'API n'a jamais besoin de cette clé.

## API

| Méthode | Route | Résultat |
| --- | --- | --- |
| POST | `/projects/:id/quiz-videos` | 202 (créé) ou 200 (requestId déjà connu) |
| GET | `/quiz-videos/:id` | Métadonnées (statut, langue, contentHash, durée, fournisseur TTS, usage...) |
| GET | `/quiz-videos/:id/preview` | Le MP4, dès qu'il existe (avant même l'approbation, pour le relecteur) |
| POST | `/quiz-videos/:id/review` | Approuve ou rejette la vidéo générée |

Toutes les routes exigent `Authorization: Bearer <QUIZ_VIDEO_API_TOKEN>` (même protection que les
routes audio de la mission 5 : 503 si le jeton serveur n'est pas configuré, 401 sinon incorrect).

Corps de création :

```json
{ "requestId": "UUID-GENERE-PAR-LE-CLIENT", "language": "fr", "questionId": "6337" }
```

`questionId` est facultatif : omis, une question éligible non récemment utilisée pour ce projet et
cette langue est sélectionnée automatiquement. Cette sélection reste un choix simple (la première
disponible, best-effort anti-répétition) — la vraie rotation pour atteindre 6 vidéos/jour (3 fr +
3 nl) revient au scheduler de la mission 11, pas à cette mission.

## Démonstration locale complète

```powershell
npm.cmd run build
docker compose up -d --wait postgres redis
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run db:seed --workspace=@fako/api
```

Dans `apps/api/.env` : `QUIZ_VIDEO_ENABLED=true`, `QUIZ_VIDEO_API_TOKEN=<secret d'au moins 32
caractères>`, `RIJPERMIS_MOCK_MODE=true`. Dans `apps/worker/.env` : les mêmes valeurs plus
`QUIZ_VIDEO_TTS_PROVIDER=mock`.

```powershell
npm.cmd run dev:api      # terminal 1
npm.cmd run dev:worker   # terminal 2
```

```powershell
$token = 'VOTRE_QUIZ_VIDEO_API_TOKEN'
$headers = @{ Authorization = "Bearer $token" }
$projectId = (Invoke-RestMethod http://127.0.0.1:3000/projects).projects | Where-Object slug -eq 'rijpermis' | Select-Object -ExpandProperty id
Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:3000/projects/$projectId/voices/fr" -Headers $headers -ContentType 'application/json' -Body '{"voiceId":"mock-fr","model":"eleven_multilingual_v2"}'
$requestId = [guid]::NewGuid().ToString()
$quizVideo = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/projects/$projectId/quiz-videos" -Headers $headers -ContentType 'application/json' -Body (@{ requestId = $requestId; language = 'fr' } | ConvertTo-Json)
# Attendre quelques secondes que le worker traite le rendu, puis :
Invoke-RestMethod -Uri "http://127.0.0.1:3000/quiz-videos/$($quizVideo.id)" -Headers $headers
Invoke-WebRequest -Uri "http://127.0.0.1:3000/quiz-videos/$($quizVideo.id)/preview" -Headers $headers -OutFile "$env:TEMP\quiz-video-demo.mp4"
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/quiz-videos/$($quizVideo.id)/review" -Headers $headers -ContentType 'application/json' -Body '{"reviewedBy":"Votre nom","decision":"APPROVED"}'
```

Aucun appel à ElevenLabs ou OpenAI n'a lieu avec cette configuration mock.

## Tests

```powershell
npm.cmd run build
npm.cmd test
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5433/fako_test?schema=public'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run test:integration --workspace=@fako/api
# Rendu MP4 réel optionnel (télécharge Chrome Headless Shell au premier lancement) :
$env:MEDIA_ENGINE_RENDER_TESTS = 'true'
npm.cmd run test:integration --workspace=@fako/api
```

`apps/api/test/integration/quiz-videos.test.ts` couvre : succès FR, absence de voix configurée,
absence de question disponible, question non éligible refusée, échec TTS non réessayable vs
réessayable, échec de rendu, reprise après crash (`QUIZ_VIDEO_OUTCOME_UNKNOWN`, jamais rejouée),
réutilisation du cache audio entre deux générations, isolation des fichiers (401/404), désactivation
par défaut, dispatcher outbox, et un test complet avec PostgreSQL, Redis et un rendu MP4 réel
(gated). Le fournisseur TTS mock est utilisé partout sauf dans ce dernier test, qui utilise
également le mock (jamais ElevenLabs) tout en exerçant le vrai moteur Remotion.
