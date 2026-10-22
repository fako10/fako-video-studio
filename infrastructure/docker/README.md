# Préparation pour Ubuntu VPS

Ces fichiers sont préparés uniquement : aucun déploiement n'a été effectué, et
aucune connexion à un VPS réel n'a eu lieu. En revanche, tous les éléments
ci-dessous (builds d'images, démarrage de la stack complète, migrations, rendu
vidéo réel) ont été testés le 2026-10-21 sur une machine locale, dans des
projets Docker Compose isolés et jetables (préfixe `fako-audit-test`/
`fako-prod-smoke`, jamais le projet `fako-video-studio` de développement),
systématiquement détruits ensuite. Docker Engine et le plugin Docker Compose v2
sont nécessaires. Depuis la racine du dépôt, le fichier de production doit
toujours être utilisé seul avec `-f` : ne pas le fusionner avec `compose.yaml`,
qui publie le port de la base locale.

Copier `infrastructure/docker/.env.example` vers `infrastructure/docker/.env`,
choisir un mot de passe fort et reporter sa version encodée pour une URL dans
`DATABASE_URL`. Utiliser `postgres` comme hôte. Protéger le fichier avec
`chmod 600 infrastructure/docker/.env`. Ne pas transmettre les secrets au build.

## Préparation du VPS Contabo (avant tout déploiement)

Étapes de préparation du serveur lui-même, distinctes du déploiement de la
stack (non exécutées par ce dépôt — aucune connexion SSH n'a eu lieu) :

1. Ubuntu LTS à jour (`apt update && apt upgrade`), fuseau horaire UTC.
2. Installer Docker Engine + le plugin Docker Compose v2 (dépôt officiel
   Docker, pas le paquet `docker.io` d'Ubuntu, souvent trop ancien).
3. Pare-feu (`ufw` ou équivalent) : autoriser seulement 22 (SSH), 80 et 443
   (une fois `proxy` prêt à démarrer) ; tout le reste du trafic entrant refusé
   — `api`/`postgres`/`redis` ne doivent jamais être joignables depuis
   l'extérieur, seulement via les réseaux Docker internes (déjà garanti par
   `compose.production.yaml`, le pare-feu est une seconde ligne de défense).
4. Accès SSH par clé uniquement, mot de passe désactivé.
5. Créer l'utilisateur non-root qui fera tourner Docker ; cloner ce dépôt dans
   `/opt/fako-video-studio` (chemin attendu par les fichiers `.service`
   fournis) et copier les `.env.example` vers `.env` comme décrit ci-dessus.
6. Vérifier l'espace disque disponible (voir section Ports et ressources).
7. Parcourir `infrastructure/docker/SECURITY-CHECKLIST.md` avant la première
   mise en service.

## Services

Un seul fichier multi-stage, `infrastructure/docker/app.Dockerfile`, construit
toutes les images ci-dessous (voir ses commentaires pour le détail des stages) :

| Service | Image / target | Rôle | Réseaux |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | Base de données, aucun port publié | `database` |
| `redis` | `redis:7-alpine` | File BullMQ, aucun port publié | `database` |
| `api` | `app.Dockerfile` cible `runtime` | API Fastify, routes protégées par jeton Bearer + une route publique (voir plus bas) | `database`, `application` |
| `worker` | `app.Dockerfile` cible `worker-runtime` | Jobs BullMQ (vidéo, audio, script, publication, **rendu Remotion/Chromium**) | `database`, `application` |
| `scheduler-generation` | `app.Dockerfile` cible `runtime` | Planification quotidienne des quiz (mission 11), jamais de rendu | `database`, `application` |
| `scheduler-publication` | `app.Dockerfile` cible `runtime` | Sweep des publications dues (mission 14), jamais de rendu | `database`, `application` |
| `web` | `app.Dockerfile` cible `web-runtime` | Interface d'administration (BFF), aucun accès direct à PostgreSQL/Redis | `application` uniquement |
| `proxy` | `caddy:2-alpine` | Reverse proxy HTTPS — **préparé, non démarré par défaut** (voir plus bas) | `application` |
| `migrate` | `app.Dockerfile` cible `migration` | `prisma migrate deploy`, profil `tools`, jamais lancé automatiquement | `database` |

`worker-runtime` est la seule image contenant les bibliothèques système
Chromium nécessaires à Remotion ; les autres restent volontairement légères
(voir « Rendu vidéo — mesures réelles » plus bas).

## Procédure de déploiement

Commandes de référence pour un futur lancement explicitement autorisé
(chaque étape dépend de la précédente) :

```bash
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml build
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml up -d --wait postgres redis
# Sauvegarder une base existante avant toute nouvelle migration.
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml run --rm migrate
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml up -d --wait api worker scheduler-generation scheduler-publication web
# Une fois $ADMIN_DOMAIN réellement configuré en DNS vers ce VPS (pas avant) :
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml up -d proxy
```

PostgreSQL n'a aucun port publié et utilise un réseau Docker interne et un volume
persistant. Redis partage le réseau interne, sans port publié, et possède son
propre volume AOF. PostgreSQL utilise également un volume
persistant. L'API écoute seulement sur `127.0.0.1:3000` côté hôte : le reverse
proxy y accède via le réseau Docker `application`, pas via ce port hôte. Toutes
les routes exigent un jeton Bearer (`QUIZ_VIDEO_API_TOKEN` par défaut) depuis la
mission 15, sauf `/public/quiz-video-links/:token` (mission 15 section 4,
volontairement non authentifiée — voir docs/social-publishing.md) ; le bind
`127.0.0.1` reste la première ligne de défense, l'authentification applicative
la seconde. Son healthcheck `/health`
vérifie le processus HTTP, pas la connexion SQL. Les migrations sont explicites,
jamais exécutées automatiquement au démarrage de chaque instance API.

## Reverse proxy HTTPS (Caddy) — préparé, non activé

Le service `proxy` (Caddy, `infrastructure/docker/Caddyfile`) route
`/public/quiz-video-links/*` vers `api` (le seul chemin public de toute la
stack — nécessaire à Instagram, voir docs/social-publishing.md) et tout le
reste vers `web`. Caddy obtient et renouvelle automatiquement un certificat
Let's Encrypt pour `$ADMIN_DOMAIN` dès son premier démarrage, **à condition que
le DNS de ce domaine pointe déjà vers ce VPS et que les ports 80/443 soient
accessibles depuis l'extérieur** — ni l'un ni l'autre n'est vrai tant que ce
service n'est pas explicitement démarré avec un domaine réel configuré. Ne pas
démarrer `proxy` avant cette étape : il échouera simplement à obtenir un
certificat, sans rien exposer d'incorrect.

## Ports et ressources (section 9 — VPS Contabo)

| Port | Service | Exposition |
|---|---|---|
| 80, 443 | `proxy` (Caddy) | Publique (une fois `$ADMIN_DOMAIN` configuré) |
| 127.0.0.1:3000 | `api` | Hôte uniquement, jamais publique |
| — | `web`, `scheduler-*`, `worker` | Aucun port publié, réseau Docker interne |
| — | `postgres`, `redis` | Aucun port publié, réseau `database` (`internal: true`) |

Dimensionnement VPS minimal recommandé (mesures réelles ci-dessous, cadence
`videosPerDay: 2` du projet RijPermis) : **2 vCPU, 4 Go RAM, 20 Go disque**
pour commencer — confirmé fonctionnel à 2 vCPU/2 Go RAM en conteneur contraint
(voir mesures), mais 4 Go laisse de la marge pour PostgreSQL + Redis + API +
plusieurs workers tournant simultanément sur le même hôte. Prévoir davantage de
disque si `videosPerDay` augmente significativement (rétention des MP4, voir
section 7 à venir).

## Rendu vidéo — mesures réelles (2026-10-21)

Mesuré en construisant l'image `worker` réelle (`docker compose build worker`)
et en exécutant `node packages/media-engine/dist/demo.js` dedans (rendu
Remotion complet, deux vidéos de démonstration fr/nl, contenu mock uniquement —
aucun appel réseau hors le téléchargement ponctuel de Chromium déjà inclus dans
l'image) :

| Mesure | Valeur observée |
|---|---|
| Image `worker` (avec Chromium) | 1,85 Go |
| Image `api`/`scheduler-*` (sans Chromium) | 1,09 Go |
| Image `web` | 1,08 Go |
| Temps de rendu, 2 vidéos, non contraint | 2 min 33 s (≈ 76 s/vidéo) |
| Temps de rendu, 2 vidéos, conteneur limité à 2 vCPU / 2 Go RAM | 1 min 55 s (≈ 57 s/vidéo) |
| Mémoire observée pendant un rendu | ≈ 636 Mo (pic), largement sous 2 Go |
| Taille d'un MP4 de démonstration | 728–800 Ko (vidéo courte, contenu mock) |
| Code de sortie | 0 (succès) dans les deux cas |

Deux bugs réels corrigés grâce à ce test (aucun des deux n'était visible à la
seule lecture du code) :
1. Le Dockerfile du worker ne copiait pas tous les packages workspace dont
   `apps/worker` dépend réellement (`@fako/content-sources`, `@fako/media-engine`,
   `@fako/quiz-pipeline`, `@fako/publishing`, `@fako/social-publishing`) —
   l'image précédente n'aurait pas pu démarrer.
2. Remotion compile la composition vidéo depuis les **sources TypeScript**
   (`packages/video-templates/src`), jamais depuis son `dist/` compilé — cette
   source n'était pas copiée dans l'image, provoquant un échec immédiat
   (`ENOENT`) au premier rendu réel.

`QUIZ_VIDEO_WORKER_CONCURRENCY` (nombre de vidéos rendues en parallèle) et
`QUIZ_VIDEO_RENDER_CONCURRENCY` (threads/onglets Chromium *au sein* d'un même
rendu, voir `packages/media-engine/src/render.ts`) valent tous les deux `1` par
défaut dans `compose.production.yaml` — délibérément conservateur pour un VPS
modeste ; les deux mesures ci-dessus utilisent déjà ces valeurs par défaut.
Augmenter l'un ou l'autre seulement après avoir reproduit ce même test avec la
charge réelle visée et confirmé la marge CPU/RAM disponible.

## Secrets — inventaire, rotation et sauvegarde (mission 15 section 6)

### Inventaire

Toutes les valeurs ci-dessous vivent uniquement dans des fichiers `.env`
ignorés par Git (jamais dans un commit, jamais affichées dans un rapport ou un
log) : PostgreSQL (`POSTGRES_PASSWORD`/`DATABASE_URL`), Redis (`REDIS_URL`,
pas de mot de passe par défaut — à ajouter si Redis est jamais exposé
au-delà du réseau Docker interne), le connecteur RijPermis
(`RIJPERMIS_API_KEY`), OpenAI (`OPENAI_API_KEY`), ElevenLabs
(`ELEVENLABS_API_KEY`), TikTok/Instagram/Facebook (`*_CLIENT_KEY`/`*_SECRET`/
`*_APP_ID`/`*_APP_SECRET`), le chiffrement des tokens sociaux
(`SOCIAL_TOKEN_ENCRYPTION_KEY`), le jeton admin partagé de l'API
(`QUIZ_VIDEO_API_TOKEN`), et la session administrateur
(`ADMIN_SESSION_KEY`, `ADMIN_PASSWORD_HASH`). La liste exhaustive avec
commentaires est dans chaque `.env.example` (`apps/api`, `apps/worker`,
`apps/scheduler`, `apps/web`, `infrastructure/docker`).

### Sauvegarde sécurisée des secrets

Les fichiers `.env` eux-mêmes ne sont **pas** inclus dans `backup.sh` (ce
serait sauvegarder des secrets en clair à côté des données qu'ils protègent).
Les conserver dans un coffre dédié (gestionnaire de mots de passe d'équipe,
Vault, ou a minima une archive chiffrée hors du VPS) — en particulier
`SOCIAL_TOKEN_ENCRYPTION_KEY` : sa perte rend **tous** les tokens OAuth déjà
stockés définitivement indéchiffrables (chaque compte social connecté devrait
être reconnecté manuellement). `ADMIN_SESSION_KEY` perdu invalide seulement les
sessions actives (pas de perte de données, juste une reconnexion admin).

### Rotation des clés — `SOCIAL_TOKEN_ENCRYPTION_KEY`

Le format de chiffrement (`packages/publishing/src/crypto.ts`) supporte
nativement une fenêtre de rotation à deux clés, pour qu'une rotation ne rende
jamais aucun token illisible, même temporairement. Testé de bout en bout le
2026-10-21 sur une base PostgreSQL jetable (chiffrement sous une ancienne clé,
réexécution du script avec les deux clés, vérification que la nouvelle clé
seule suffit ensuite, et que le script est idempotent et signale clairement un
compte irrécupérable sans jamais logguer de valeur de token) :

```bash
# 1. Générer la nouvelle clé.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Dans infrastructure/docker/.env : déplacer la valeur actuelle de
#    SOCIAL_TOKEN_ENCRYPTION_KEY vers SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS,
#    puis mettre la nouvelle clé générée dans SOCIAL_TOKEN_ENCRYPTION_KEY.

# 3. Redéployer api et worker avec les deux variables (les nouveaux tokens
#    chiffrés utilisent déjà la nouvelle clé ; les anciens restent lisibles
#    via la clé précédente pendant cette fenêtre).
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml up -d api worker

# 4. Réencoder tous les tokens existants sous la nouvelle clé (idempotent,
#    sans appel réseau, sans jamais afficher de valeur de token). Utilise la
#    cible `migrate` (pas `api`/`worker`, dont l'image allégée ne conserve pas
#    tsx) — qui dispose déjà de DATABASE_URL ; les clés de chiffrement sont
#    ajoutées ponctuellement via `-e`.
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml run --rm \
  -e SOCIAL_TOKEN_ENCRYPTION_KEY -e SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS \
  migrate npm run db:reencrypt-social-tokens --workspace=@fako/api

# 5. Vérifier la sortie : "skipped=0" attendu. Un compte "skipped" signifie
#    qu'aucune des deux clés ne déchiffre son token — il devra être reconnecté
#    manuellement depuis l'interface d'administration.

# 6. Seulement une fois skipped=0 confirmé : retirer
#    SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS de infrastructure/docker/.env et
#    redéployer une dernière fois.
```

Ne jamais supprimer l'ancienne clé avant l'étape 6 : tant qu'un compte n'a pas
été confirmé réencodé, elle reste le seul moyen de récupérer son token.

## Sauvegarde PostgreSQL (shell Bash Ubuntu)

`infrastructure/docker/backup.sh` automatise ce qui suit : dump `pg_dump` au
format custom, archive du volume `audio_data` (fichiers audio/MP4 référencés par
`fileKey` — un restore de la base sans ce volume laisse des références orphelines),
vérification que les deux fichiers produits ne sont pas vides (échec sinon), et
purge des sauvegardes de plus de `FAKO_BACKUP_RETENTION_DAYS` jours (14 par défaut).
Équivalent manuel du dump seul, pour référence :

```bash
set -euo pipefail
umask 077
mkdir -p backups
backup="backups/fako-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml exec -T postgres \
  sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' > "$backup"
test -s "$backup"
```

Le format custom permet une restauration avec `pg_restore`. Les sauvegardes
contiennent les données métier ; elles sont ignorées par Git (`backups/` et
`*.dump` dans `.gitignore`). Les chiffrer et les copier hors VPS (ex. `rclone`/
`restic` vers un stockage distant — non fourni ici, à brancher derrière
`backup.sh`). Le volume Docker seul n'est pas une sauvegarde. Les rôles et
privilèges globaux ne sont pas inclus par `pg_dump` : les recréer séparément si
l'installation utilise des rôles supplémentaires.

### Automatisation (systemd timer)

`fako-backup.service` et `fako-backup.timer` dans ce répertoire déclenchent
`backup.sh` chaque jour à 03h30 UTC (± 10 min). Installation sur le VPS :

```bash
sudo cp infrastructure/docker/fako-backup.service infrastructure/docker/fako-backup.timer /etc/systemd/system/
# Adapter WorkingDirectory dans le .service au chemin réel du checkout.
sudo systemctl daemon-reload
sudo systemctl enable --now fako-backup.timer
systemctl list-timers fako-backup.timer   # prochaine exécution planifiée
```

`backup.sh` termine avec un code non nul si le dump ou l'archive est vide —
surveiller les échecs avec `systemctl --failed` ou un unit `OnFailure=` qui
notifie (mail, webhook). Ne jamais se fier uniquement à la lecture manuelle des
journaux.

## Restauration vers une nouvelle base

`infrastructure/docker/restore-check.sh <fichier.dump> [nom_base]` automatise la
procédure ci-dessous : il échoue si la base cible existe déjà (jamais d'écrasement
possible) et affiche un comptage de lignes sur quelques tables clés après restauration.

```bash
infrastructure/docker/restore-check.sh backups/fako-YYYYMMDDTHHMMSSZ.dump
```

Équivalent manuel, pour référence — toujours vers une base nouvelle nommée
`fako_restore_check` ; la création échoue si elle existe déjà :

```bash
set -euo pipefail
backup='backups/fako-YYYYMMDDTHHMMSSZ.dump'
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml exec -T postgres \
  sh -c 'createdb --username="$POSTGRES_USER" fako_restore_check'
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml exec -T postgres \
  sh -c 'pg_restore --username="$POSTGRES_USER" --dbname=fako_restore_check --no-owner --no-privileges --exit-on-error --single-transaction' < "$backup"
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml exec -T postgres \
  sh -c 'psql --username="$POSTGRES_USER" --dbname=fako_restore_check --command="SELECT count(*) FROM \"Project\";"'
```

Valider les données et l'application sur cette base isolée avant de prévoir une
bascule. Une restauration conserve l'historique `_prisma_migrations` : appliquer
ensuite uniquement les migrations manquantes avec `prisma migrate deploy`, après
validation et sauvegarde. Ne pas utiliser `migrate reset` en production.

Pour une base locale, ces procédures s'adaptent en remplaçant le préfixe Compose
par `docker compose` (sans `--env-file` ni `-f`). Les redirections de sauvegardes
binaires ci-dessus doivent être exécutées dans Bash, WSL ou un shell préservant
les octets, pas dans Windows PowerShell 5.1.

### Restauration chirurgicale d'une ligne unique

Scénario : une ligne a été supprimée par erreur sur la base courante (ex. un
`QuizVideo`) et seul cet enregistrement doit être récupéré, sans toucher au
reste de la base courante ni revenir entièrement à l'état de la dernière
sauvegarde. Étapes :

`pg_dump` has no row-level filter (no `--where`) — row-level extraction goes
through `psql \copy` with an explicit `SELECT ... WHERE id = ...`, always by
exact id, never a date range or name filter:

```bash
# 1. Restaurer la dernière sauvegarde utile dans une base de vérification isolée.
infrastructure/docker/restore-check.sh backups/fako-YYYYMMDDTHHMMSSZ.dump fako_restore_check

# 2. Exporter uniquement la ligne concernée depuis la base de vérification, par id exact.
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml exec -T postgres \
  sh -c "psql --username=\"\$POSTGRES_USER\" --dbname=fako_restore_check --command=\"\\copy (SELECT * FROM \\\"QuizVideo\\\" WHERE id = '<uuid-exact>') TO '/tmp/quizvideo-row.csv' WITH CSV\""

# 3. Importer cette ligne unique dans la base courante (fako). Une ligne de même id déjà
#    présente fait échouer l'import (contrainte de clé primaire) au lieu de l'écraser.
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml exec -T postgres \
  sh -c "psql --username=\"\$POSTGRES_USER\" --dbname=\"\$POSTGRES_DB\" --command=\"\\copy \\\"QuizVideo\\\" FROM '/tmp/quizvideo-row.csv' WITH CSV\""

# 4. Nettoyer la base de vérification et le fichier CSV temporaire dans le conteneur.
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml exec -T postgres \
  sh -c 'dropdb --username="$POSTGRES_USER" fako_restore_check && rm -f /tmp/quizvideo-row.csv'
```

Vérifier manuellement la ligne réimportée (clés étrangères, `fileKey` toujours
présent dans le volume média) avant de considérer l'incident clos. Testé de bout
en bout le 2026-10-21 sur une base PostgreSQL jetable locale (projet Compose
isolé, identifiants et port dédiés, détruite après le test) : insertion d'un
`Project`/`ProjectSettings`/`QuizVideo` factices, `pg_dump`, suppression simulée
de la ligne `QuizVideo`, restauration dans `fako_restore_check`, export `\copy`
puis réimport dans la base "courante" — la ligne récupérée correspond exactement
à l'originale et la base de vérification n'affecte jamais la base source. Cette
procédure n'a volontairement jamais été utilisée pour recréer la ligne
`QuizVideo` réellement perdue lors d'un incident précédent, le contenu exact
n'étant plus connu avec certitude ; elle est documentée et vérifiée ici pour un
prochain incident de même nature.

## Surveillance et exploitation (mission 15 section 7)

### Health checks

`postgres`, `redis`, `api` et `web` ont un healthcheck Docker natif
(`docker compose ps` affiche leur état). `worker`, `scheduler-generation` et
`scheduler-publication` n'ont délibérément **pas** de healthcheck HTTP : ce
sont des processus BullMQ/tick sans port d'écoute naturel, et un faux
healthcheck (ex. simple vérification que le process répond) n'aurait rien
détecté de réellement significatif. Leur supervision repose sur trois
mécanismes combinés : `restart: unless-stopped` (relance en cas de crash),
les journaux structurés ci-dessous, et `monitor.sh` (jobs/publications en
échec visibles côté base de données, indépendamment de l'état du process).

### Journalisation structurée

`apps/worker` et `apps/scheduler` utilisent désormais un logger JSON structuré
(`pino`, voir `apps/*/src/logger.ts`) au lieu de `console.log`/`console.error` —
chaque ligne porte des champs exploitables (`queue`, `jobId`, `quizVideoId`,
`publicationId`, `err`, etc.), jamais de valeur secrète. Niveau contrôlé par
`LOG_LEVEL` (`info` par défaut). `apps/api`/`apps/web` utilisent déjà le logger
intégré de Fastify (pino également) quand `logger: true`.

### Suivi des jobs en échec, publications bloquées et `OUTCOME_UNKNOWN`

`infrastructure/docker/monitor.sh` interroge directement PostgreSQL (pas besoin
que l'API soit up) pour : `VideoJob`/`QuizVideo` en statut `FAILED`,
`SocialPublication` en `BLOCKED` ou `OUTCOME_UNKNOWN`, et l'espace disque de
chaque volume nommé. Code de sortie non nul dès qu'un point mérite une revue —
à brancher sur l'alerting déjà en place (mail, webhook), ce script ne notifie
personne lui-même. `fako-monitor.service`/`.timer` l'exécutent toutes les 5
minutes. Testé de bout en bout le 2026-10-21 avec des données factices (un
`VideoJob` `FAILED`, une publication `BLOCKED`, une `OUTCOME_UNKNOWN`) sur une
base PostgreSQL jetable : les quatre compteurs remontent exactement les bonnes
valeurs, et le calcul d'espace disque a été vérifié séparément (fonctionne sur
Linux ; un artefact de conversion de chemin Git Bash sous Windows, sans rapport
avec la cible réelle Ubuntu, a été identifié et documenté dans le script).
`OUTCOME_UNKNOWN` est également logué en `error` directement par le worker
(`social-publication-worker.ts`) dès que la réconciliation le détecte, sans
attendre le prochain passage de `monitor.sh`.

```bash
infrastructure/docker/monitor.sh
```

### Rétention des vidéos

`apps/api/prisma/prune-old-quiz-videos.ts` (exécuté via
`infrastructure/docker/prune-videos.sh`) supprime uniquement le **fichier**
d'un `QuizVideo` (jamais la ligne en base) quand il a plus de
`QUIZ_VIDEO_RETENTION_DAYS` jours (90 par défaut) **et** qu'aucune publication
sociale associée n'est encore active ou non résolue (`DRAFT`/`SCHEDULED`/
`READY`/`PUBLISHING`/`OUTCOME_UNKNOWN`). Mode simulation par défaut (n'affiche
que ce qui serait supprimé) ; `--confirm` déclenche la suppression réelle. Un
fichier manquant est déjà géré proprement partout où il est lu (404, jamais un
plantage). Testé de bout en bout le 2026-10-21 avec trois scénarios réels
(fichier réellement sur disque + ligne en base) : une vidéo ancienne sans
publication active → supprimée ; une vidéo ancienne mais avec une publication
`READY` → conservée ; une vidéo récente → conservée. Les trois résultats
correspondaient exactement à la politique attendue.

```bash
# Toujours lancer sans --confirm d'abord et lire la sortie.
FAKO_PRUNE_CONFIRM= infrastructure/docker/prune-videos.sh
# Une fois la liste vérifiée :
infrastructure/docker/prune-videos.sh
```

`fako-prune-videos.service`/`.timer` l'exécutent (avec `--confirm`) chaque
semaine — vérifier manuellement en mode simulation après tout changement de
`QUIZ_VIDEO_RETENTION_DAYS` avant de faire confiance à l'exécution automatique.

### Procédure de redémarrage

```bash
# Redémarrer un service précis sans toucher aux autres.
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml restart worker

# Redémarrage complet (ordre non significatif, depends_on/healthcheck gèrent les dépendances) :
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml up -d
```

Après un redémarrage du `worker` : vérifier `monitor.sh` (une publication en
`PUBLISHING` sans `remotePostId` au moment du crash passe automatiquement en
`OUTCOME_UNKNOWN` à la reprise — comportement voulu, voir
`packages/social-publishing/src/engine.ts`, jamais une relance silencieuse).

**Test réel effectué le 2026-10-22** (conteneur `worker`, projet Compose
jetable) : un job encore `PENDING` au moment d'un `docker kill -SIGKILL` sur le
conteneur a été repris et mené à terme sans aucune intervention manuelle une
fois le conteneur relancé (`PENDING` → `PROCESSING` → `WAITING_APPROVAL` en
quelques secondes), et aucun job n'est resté bloqué en état transitoire après
coup. **Point d'attention :** sur cette machine de test (Docker Desktop pour
Windows), `restart: unless-stopped` ne relance **pas** automatiquement un
conteneur après un `docker kill` — vérifié y compris sur un conteneur Alpine
isolé, hors de toute configuration de ce dépôt, donc un comportement de la
plateforme Docker locale, pas un bug de `compose.production.yaml`. Sur Ubuntu
(la cible réelle), `dockerd` applique normalement cette politique dans ce cas ;
**à revérifier explicitement lors du premier déploiement réel** (`docker kill`
un conteneur puis confirmer qu'il redémarre seul avant de s'y fier en
production).

### Procédure de rollback

Ce dépôt n'a pas encore de registre d'images versionné (toutes les images sont
construites localement par `docker compose build`, taguées `latest`). Pour
revenir à une version antérieure du code :

```bash
# 1. Identifier le commit à restaurer, puis :
git checkout <commit-ou-tag-précédent>

# 2. Sauvegarder la base avant toute action (voir section Sauvegarde ci-dessus).
infrastructure/docker/backup.sh

# 3. Reconstruire et redéployer depuis ce commit.
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml build
docker compose --env-file infrastructure/docker/.env -f compose.production.yaml up -d

# 4. Si le rollback doit aussi annuler une migration de schéma : restaurer plutôt
#    la sauvegarde PostgreSQL prise juste avant cette migration (section
#    "Restauration vers une nouvelle base" ci-dessus), jamais `prisma migrate reset`.
```

Un rollback de code sans rollback de schéma n'est sûr que si aucune migration
n'a été appliquée entre les deux versions — vérifier `prisma/migrations/` avant
de l'assumer. Prévoir, pour une maturité ultérieure, un registre d'images
versionné (tag par commit SHA) afin de revenir à une image précise sans
reconstruire depuis les sources.
