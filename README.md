# Fako Video Studio

La V1 du moteur vidéo simulé, ses endpoints, variables et commandes sont décrits
dans [docs/video-engine.md](docs/video-engine.md).
La génération de scénarios OpenAI, désactivée par défaut et soumise à validation
humaine, est décrite dans [docs/video-scripts.md](docs/video-scripts.md).
Le connecteur de contenu RijPermis (Mission 7), désactivé par défaut, est décrit
dans [docs/rijpermis-content.md](docs/rijpermis-content.md).
Le template vidéo Remotion « Quiz du jour » (Mission 8) est décrit dans
[docs/rijpermis-video-template.md](docs/rijpermis-video-template.md).
La voix off ElevenLabs et la synchronisation audio/vidéo (Mission 9) sont décrites dans
[docs/rijpermis-narration.md](docs/rijpermis-narration.md).
Le pipeline automatisé VideoJob → MP4 narré (Mission 10) est décrit dans
[docs/rijpermis-quiz-pipeline.md](docs/rijpermis-quiz-pipeline.md).
Le scheduler quotidien et la rotation des questions (Mission 11) sont décrits dans
[docs/rijpermis-scheduler.md](docs/rijpermis-scheduler.md).
L'interface d'administration et de validation des vidéos (Mission 12) est décrite dans
[docs/rijpermis-admin.md](docs/rijpermis-admin.md).

Monorepo npm (`apps/*`, `packages/*`). L'API utilise Fastify 5, TypeScript ESM
et le port 3000. Node.js >= 22.12 et PostgreSQL >= 16 sont requis. **Docker et
Redis ne sont plus utilisés** : la file de tâches (`packages/jobs`, basée sur
pg-boss) est stockée dans PostgreSQL, schéma `pgboss`, et le client Prisma
fonctionne sans moteur natif (`packages/db`, adaptateur `pg`).

## Démarrage local (PowerShell, depuis la racine)

PostgreSQL doit être installé localement, avec une base `fako` et un
utilisateur dédié (par exemple via pgAdmin).

```powershell
npm.cmd ci
Copy-Item .env.example .env
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/worker/.env.example apps/worker/.env
# Adapter DATABASE_URL dans chaque fichier .env (hôte 127.0.0.1, port 5432 par défaut).
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run build
npm.cmd run dev:api
```

Les fichiers `.env` sont ignorés par Git. Les exemples contiennent uniquement
des valeurs de remplacement. Le déploiement sur le VPS (systemd + Nginx, sans
Docker) est préparé dans `infrastructure/vps/`.

## API

| Méthode | Route | Résultat |
| --- | --- | --- |
| GET | `/health` | État historique de l'API (sans requête SQL) |
| GET | `/projects?offset=0&limit=20` | `{ projects, total }`, limite 1–100 |
| POST | `/projects` | Création, 201 et en-tête Location |
| GET | `/projects/:id` | Projet avec ses paramètres |
| PATCH | `/projects/:id` | Modification partielle et atomique |
| DELETE | `/projects/:id` | Suppression et cascade des paramètres, 204 |

Exemple de corps pour POST (seul `name` est obligatoire) :

```json
{
  "name": "Ma vidéo",
  "description": "Présentation",
  "settings": { "width": 1920, "height": 1080, "fps": 30 }
}
```

Chaque projet créé reçoit des paramètres indépendants. Les paramètres omis
prennent les valeurs 1920×1080 à 30 images/seconde. PATCH préserve les champs
omis ; `description: null` efface la description. Nom : 1–200 caractères,
non blanc ; description : 5000 caractères maximum ; dimensions : entiers
1–16384 ; fps : entier 1–240. UUID invalides, propriétés inconnues et corps
invalides donnent 400 ; projet absent : 404 ; erreur interne : 500 sans détail
de connexion. La liste est triée par date décroissante puis identifiant.

Toutes les routes ci-dessus (et `/video-jobs`, `/video-scripts`, `/rijpermis`)
exigent un en-tête `Authorization: Bearer <jeton>` depuis la mission 15, selon
le même mécanisme que `/quiz-videos`, `/scheduler` et `/social-*` : jeton partagé
`QUIZ_VIDEO_API_TOKEN` (ou une variable dédiée par groupe de routes via les
options de `buildApp`), comparaison en temps constant, 503 si non configuré.
Il s'agit d'un unique secret partagé « admin » : il n'existe pas de modèle
multi-utilisateur, et un même jeton donne accès à tous les projets (pas
d'isolation par jeton entre projets). Tant qu'un seul projet existe (RijPermis),
ce n'est pas un risque pratique ; en cas de vrai besoin multi-tenant, prévoir une
autorisation par projet avant d'en créer un second côté administration.

## Vérifications et migrations

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run db:validate --workspace=@fako/api
npm.cmd audit
# Utiliser une base de test dédiée, migrée via db:migrate :
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5433/fako_test?schema=public'
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run test:integration --workspace=@fako/api
```

Les tests unitaires utilisent `Fastify.inject` sans base. Le test d'intégration
nécessite PostgreSQL, vérifie le CRUD, la persistance, les valeurs par défaut,
l'indépendance des paramètres et la cascade ; il nettoie uniquement ses projets.
`db:migrate` applique les migrations versionnées. Pour une évolution du schéma,
utiliser `npm.cmd run db:migrate:dev --workspace=@fako/api -- --name nom` sur une
base de développement. Le client Prisma est généré pendant le build.

## Configuration de production et sauvegardes

Le fichier autonome `compose.production.yaml` prépare, pour Ubuntu, l'API, le
worker (rendu Remotion), les deux schedulers (génération et publication),
l'interface d'administration et PostgreSQL/Redis, sans publier le port
PostgreSQL. Toutes les images sont définies dans
`infrastructure/docker/app.Dockerfile` (un seul fichier multi-stage). Les
variables attendues et les procédures de build, migration, sauvegarde et
restauration sont décrites dans
[infrastructure/docker/README.md](infrastructure/docker/README.md), qui inclut
aussi un relevé réel de ressources (temps de rendu, mémoire, taille d'image)
mesuré le 2026-10-21. Cette configuration n'a pas été déployée sur un VPS.

## Premier projet RijPermis

Avec PostgreSQL local démarré et `apps/api/.env` configuré pour le port `5433` :

```powershell
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run build
npm.cmd run db:seed --workspace=@fako/api
npm.cmd run dev:api
```

Le seed crée `RijPermis` uniquement si le slug unique `rijpermis` est absent.
Les exécutions suivantes préservent tous les champs, les paramètres et les dates
du projet existant, même après modification manuelle. Il ne s'exécute pas
automatiquement au démarrage et n'effectue aucune publication.

Configuration initiale : site `https://rijpermis.be`, catégorie
« éducation / permis de conduire belge », langues `fr` et `nl`, objectif de
vidéos courtes éducatives, quiz et promotion de l'application. Paramètres :
1080×1920, 30 fps, `videosPerDay: 2`, `publicationEnabled: false` et
`humanValidationRequired: true`. Ces champs décrivent la configuration ; aucun
planificateur de production ou moteur de publication n'est implémenté.

Le UUID technique `id` reste utilisé dans `/projects/:id` ; `slug` est un
identifiant métier distinct. La migration additive conserve les anciens projets :
slug, site, catégorie et objectif sont facultatifs ; langues vides par défaut.
Les paramètres existants reçoivent une cadence de 0, publication désactivée et
validation humaine requise. Les routes POST/PATCH acceptent ces nouveaux champs ;
un slug déjà utilisé renvoie 409. Les langues utilisent des codes comme `fr`,
`nl` ou `fr-BE`, et le site doit être une URL HTTP(S).

Le test d'intégration du seed nécessite une base de test isolée sans projet
`rijpermis`. Ne pas exécuter les tests d'intégration sur la base de travail.

Voix off ElevenLabs (Mission 5) : [configuration, endpoints et tests](docs/audio-generation.md).
