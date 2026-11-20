# Moteur vidéo V1 (simulation)

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

Une étape de génération de scénarios optionnelle est maintenant disponible :
voir [video-scripts.md](video-scripts.md). Elle n'active aucun audio, rendu ou
publication et ne s'exécute qu'après une demande explicite.

Cette version ne génère aucun fichier vidéo et n'appelle ni OpenAI, ni ElevenLabs,
ni un moteur de rendu. Elle ne publie rien. Les paramètres de cadence des projets
restent descriptifs : aucun ordonnanceur ne crée automatiquement des vidéos.

## Démarrage local

Depuis la racine, conserver les `.env` existants. Pour une première installation,
copier les exemples racine/API et `apps/worker/.env.example` vers les `.env`
correspondants. Reporter les mêmes identifiants PostgreSQL dans l'API et le worker.
Ne jamais versionner ces fichiers.

```powershell
npm.cmd ci
docker compose up -d --wait postgres redis
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run build
# Facultatif, crée RijPermis uniquement s'il est absent :
npm.cmd run db:seed --workspace=@fako/api
# Terminal 1
npm.cmd run dev:api
# Terminal 2
npm.cmd run dev:worker
```

Après compilation, le worker peut aussi démarrer avec
`npm.cmd run start --workspace=@fako/worker`. Recompiler le package partagé après
une modification de son code. Le client Prisma est généré à la racine pour que
l'API et le worker partagent exactement les mêmes modèles.
Sous Windows, arrêter l'API et le worker avant de régénérer Prisma si le moteur
est verrouillé (`EPERM`), puis les relancer après la compilation.

| Variable | Utilisation | Valeur locale |
| --- | --- | --- |
| `DATABASE_URL` | API et worker ; base PostgreSQL migrée | `postgresql://USER:PASSWORD@127.0.0.1:5433/fako?schema=public` |
| `REDIS_PORT` | Port publié par Compose local | `6379` |
| `REDIS_URL` | Worker et tests BullMQ ; accepte `rediss://` | `redis://127.0.0.1:6379` |
| `WORKER_CONCURRENCY` | Nombre de traitements simultanés par worker | `2` |
| `DISPATCH_INTERVAL_MS` | Intervalle de lecture de l'outbox PostgreSQL | `2000` |
| `SIMULATION_STEP_MS` | Délai entre étapes simulées | `300` |

Les trois paramètres numériques du worker doivent être des entiers strictement
positifs. Redis utilise un volume persistant et AOF (`appendfsync everysec`), avec
politique `noeviction`. Le port local est lié uniquement à `127.0.0.1`.

## Endpoints

| Méthode | Route | Comportement |
| --- | --- | --- |
| POST | `/projects/:projectId/video-jobs` | Crée une tâche durable, 201 et Location |
| GET | `/projects/:projectId/video-jobs` | Liste `{ videoJobs, total }`, filtres `status`, `offset`, `limit` (1–100) |
| GET | `/video-jobs/:id` | État détaillé et progression |
| POST | `/video-jobs/:id/cancel` | Annulation ; répétable sur une tâche déjà annulée |
| POST | `/video-jobs/:id/approve` | Validation explicite d'une tâche en attente |

Les routes `/health` et CRUD `/projects` restent disponibles. Les paramètres
projet sont copiés lors de la création : une modification ultérieure du projet
ne change pas le format d'une tâche existante. Les dimensions et fps sont copiés
du projet si `format` est omis ; un format explicite utilise 1080×1920,
1920×1080 ou 1080×1080. La langue doit appartenir aux langues du projet si cette
liste n'est pas vide. Sujet obligatoire non blanc (500 caractères maximum),
durée cible entière 1–600 secondes, langues comme `fr`, `nl` ou `fr-BE`.

```json
{
  "subject": "Quiz : la priorité de droite en Belgique",
  "language": "fr",
  "format": "VERTICAL",
  "targetDuration": 30,
  "metadata": { "contentType": "quiz" }
}
```

Exemple PowerShell, avec le UUID RijPermis obtenu via `GET /projects` :

```powershell
$projectId = 'REMPLACER-PAR-UUID'
$job = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/projects/$projectId/video-jobs" -ContentType 'application/json' -Body '{"subject":"Priorité de droite","language":"fr","targetDuration":30}'
Invoke-RestMethod "http://127.0.0.1:3000/video-jobs/$($job.id)"
# Quand le statut est WAITING_APPROVAL, après contrôle humain :
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/video-jobs/$($job.id)/approve" -ContentType 'application/json' -Body '{"approvedBy":"Mon nom"}'
```

`approvedBy` est une trace déclarative, pas une identité authentifiée. L'API n'a
pas encore d'authentification : garder son accès local ou protégé. L'approbation
signifie ici la validation de la simulation, jamais une publication.

Validation invalide : 400 ; projet/tâche absent : 404 ; transition interdite :
409. Un projet contenant des VideoJobs ne peut pas être supprimé (409), afin de
conserver l'historique. Les tests nettoient uniquement leurs propres tâches.

## États, reprise et limites

```text
PENDING -> QUEUED -> PROCESSING -> WAITING_APPROVAL -> COMPLETED
                      |   ^
                      v   |
                    QUEUED       (nouvelle tentative)
                      |
                    FAILED       (tentatives épuisées)
PENDING / QUEUED / PROCESSING / WAITING_APPROVAL -> CANCELLED
```

PostgreSQL est la source de vérité. L'API n'a pas besoin de Redis pour créer une
tâche. Le worker parcourt les tâches actives et les envoie à BullMQ avec le UUID
comme identifiant stable. L'ajout en file est réessayé après indisponibilité de
Redis. Les entrées BullMQ ne sont pas supprimées automatiquement : elles assurent
la déduplication. Une politique d'archivage/nettoyage sera nécessaire à plus grande
échelle, et ne doit retirer que des tâches terminales correspondantes en base.

BullMQ effectue trois tentatives, avec délais exponentiels à partir de 1 seconde.
Les étapes mettent à jour la progression (20, 50, 80, 100). Une reprise recommence
la simulation et incrémente `attempts`, sans produire d'effet externe. BullMQ
récupère les tâches bloquées après perte du verrou d'un worker. La réconciliation
reporte également les échecs de file dans PostgreSQL. Si Redis perd ses données,
les tâches encore actives en base sont remises en file ; les tâches terminales
ne sont jamais relancées automatiquement. L'AOF everysec peut perdre environ une
seconde d'écritures lors d'un arrêt brutal ; ce mécanisme complète la persistance.

L'annulation est enregistrée immédiatement en base ; le worker la vérifie entre
les étapes. Les mises à jour conditionnelles empêchent qu'il remplace CANCELLED
par un succès ou un échec. `WAITING_APPROVAL` ne passe jamais automatiquement à
`COMPLETED`, même si les paramètres du projet désactivent la validation humaine.
`startedAt`, `finishedAt`, `cancelledAt`, `approvedAt`, `approvedBy`, `attempts`,
`errorMessage` et les métadonnées permettent le suivi. Aucun fichier de sortie
n'est revendiqué dans cette V1.

Un futur rendu avec effets externes devra rendre chaque étape idempotente et
prévoir le stockage des artefacts ; BullMQ fournit une livraison au moins une fois,
pas une garantie d'exécution unique des effets externes.

## Vérifications

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run db:validate --workspace=@fako/api
npm.cmd audit
# Uniquement sur PostgreSQL ET Redis de test isolés, sans worker concurrent :
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:55436/fako_test?schema=public'
$env:REDIS_URL = 'redis://127.0.0.1:56379'
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run test:integration --workspace=@fako/api
```

Ne pas exécuter les tests d'intégration sur la base de travail ou sur Redis de
production. Ils couvrent notamment les transitions, les annulations pendant le
traitement, les erreurs, la reprise et la déduplication avec un vrai Redis.

## Production préparée uniquement

`compose.production.yaml` inclut le worker et Redis sur le réseau interne, sans
aucun port Redis publié. Le worker utilise `redis://redis:6379`. Appliquer les
migrations avant de démarrer API et worker. Le Dockerfile prend en compte tous
les workspaces et compile le package partagé avant ses consommateurs.
Les procédures PostgreSQL restent dans `infrastructure/docker/README.md`.
Ne pas supprimer les volumes. Aucun déploiement VPS n'a été effectué.
