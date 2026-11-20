# Voix off — Mission 5

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

Cette étape produit uniquement un fichier audio depuis la narration d'une version de scénario explicitement approuvée. Elle ne lance aucun rendu vidéo et ne publie rien. Le pipeline OpenAI reste indépendant et `/health` est conservé.

## Installation et démarrage local (PowerShell)

Depuis la racine du dépôt :

```powershell
npm.cmd ci
docker compose up -d postgres redis
npm.cmd run build
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run dev:api
```

Dans un deuxième terminal :

```powershell
npm.cmd run dev:worker
```

Ne remplacez pas vos fichiers `.env` existants. Ajoutez les variables ci-dessous manuellement dans les fichiers ignorés par Git. La base locale reste sur `127.0.0.1:5433`. Redis reste sur `127.0.0.1:6379`. `prisma migrate deploy` ajoute uniquement les nouvelles tables/index/relations ; aucun reset n'est nécessaire.

Si Prisma signale `EPERM` sous Windows, arrêtez vos terminaux API et worker avant `build`, puis relancez-les.

## Configuration

| Variable | API (`apps/api/.env`) | Worker (`apps/worker/.env`) |
| --- | --- | --- |
| `DATABASE_URL` | Connexion PostgreSQL existante | Même base |
| `REDIS_URL` | Inutile pour les nouvelles routes (outbox SQL) | Connexion Redis existante |
| `TTS_PROVIDER` | `disabled` par défaut ; `elevenlabs` pour autoriser les demandes | `disabled` par défaut ; `elevenlabs` pour traiter |
| `AUDIO_API_TOKEN` | Secret aléatoire d'au moins 32 caractères | Inutile |
| `ELEVENLABS_API_KEY` | Ne pas renseigner | Clé ElevenLabs, uniquement si activation volontaire |
| `AUDIO_STORAGE_ROOT` | Dossier absolu partagé avec le worker | Même dossier absolu, accessible en écriture |

Si `AUDIO_STORAGE_ROOT` est vide ou absent, les deux applications utilisent `<racine-du-repo>/storage/audio`. Ce dossier est ignoré par Git et exclu du contexte Docker. Ne mettez pas de secrets dans les fichiers `.env.example`.

Générer le jeton localement, puis copier sa valeur dans le fichier API ignoré :

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Le Mock est injecté exclusivement dans les tests. Aucun mode Mock n'est activable accidentellement dans le worker de production. Sans activation explicite, aucune requête fournisseur ni consommation de crédit n'a lieu. Pour tester un vrai audio, l'activation d'ElevenLabs peut entraîner une facturation ; elle n'a pas été effectuée pendant cette mission.

## Voix par projet et langue

Toutes les nouvelles routes exigent `Authorization: Bearer <AUDIO_API_TOKEN>`. Sans jeton serveur suffisamment long : 503 ; jeton client absent ou incorrect : 401. Le jeton donne accès à tous les projets audio : c'est une protection serveur partagée, pas une gestion d'utilisateurs ou de droits par locataire. Ne l'intégrez pas dans une application publique ou dans une URL. Utilisez HTTPS pour tout accès distant.

`PUT /projects/:id/voices/:language`, avec `language` égal à `fr` ou `nl` et présent dans les langues du projet :

```json
{
  "voiceId": "IDENTIFIANT_DE_VOTRE_VOIX",
  "model": "eleven_multilingual_v2",
  "settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0,
    "use_speaker_boost": true,
    "speed": 1
  }
}
```

Les modèles acceptés sont `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_turbo_v2_5`. Les nombres sont validés (stability/similarity/style : 0–1 ; speed : 0.7–1.2). Le compte fournisseur doit avoir accès à la voix et au modèle choisis. `language_code` est envoyé pour les modèles v2.5 ; il est omis pour multilingual_v2 conformément au contrat API ElevenLabs. Pour RijPermis, configurez séparément `fr` et `nl` ; aucune voix réelle n'est choisie automatiquement.

La configuration est copiée dans l'AudioAsset lors de sa création. Un changement de voix n'altère donc pas une demande déjà enregistrée.

## Demander et écouter

1. Générez un scénario avec le pipeline existant, puis consultez-le.
2. Validez humainement sa version avec `POST /video-scripts/:id/review` et `{ "reviewedBy": "Votre nom", "decision": "APPROVED" }`.
3. Appelez `POST /video-scripts/:id/audio/generate` avec `{}` et le jeton. Résultat : 202 à la création, 200 si cette version possède déjà un AudioAsset. Le header `Location` indique son endpoint de statut.
4. Consultez `GET /audio-assets/:id` : `PENDING` → `PROCESSING` → `READY` ou `FAILED`.
5. Écoutez via `GET /audio-assets/:id/preview`, toujours avec le jeton. Exemple local PowerShell, en utilisant un nom de destination nouveau :

```powershell
$audioHeaders = @{ Authorization = "Bearer $env:AUDIO_API_TOKEN" }
Invoke-WebRequest -Uri 'http://127.0.0.1:3000/audio-assets/REMPLACER_UUID/preview' -Headers $audioHeaders -OutFile "$env:TEMP\fako-preview-$([guid]::NewGuid()).mp3"
```

La variable de terminal `AUDIO_API_TOKEN` doit contenir le même secret que le fichier API ; les fichiers `.env` ne sont pas automatiquement chargés dans PowerShell. Une simple URL dans le navigateur n'envoie pas le header d'autorisation. Aucun répertoire statique ni URL publique n'est exposé. Le cache de préécoute est désactivé et les types MIME sont explicites. L'approbation et l'absence d'annulation sont revérifiées au traitement et à la préécoute.

## Idempotence, reprise et stockage

- Un seul AudioAsset par `videoScriptId` (contrainte SQL unique), avec la version exacte et le VideoJob associés. Deux requêtes simultanées renvoient le même identifiant. Répéter la demande ne relance pas une génération échouée et ne refacture pas.
- Le pipeline existant ferme un VideoJob après approbation du scénario : cette règle est conservée. Si une nouvelle version est créée dans une évolution future, son identifiant distinct donnera un nouvel audio sans écraser l'ancien. Ce cas est couvert avec des versions explicites en intégration.
- L'outbox PostgreSQL conserve les demandes si Redis est indisponible. Le worker alimente `audio-production` toutes les deux secondes avec un `jobId` stable. Trois tentatives maximum, backoff exponentiel (2 puis 4 secondes), uniquement pour une réponse HTTP 429 certaine. Les erreurs d'authentification, de contenu, 5xx et de réseau ne sont pas rejouées automatiquement pour éviter une double facturation.
- Un verrou consultatif PostgreSQL protège le traitement même entre plusieurs workers. L'état `PROCESSING` est enregistré avant l'appel externe. Après une interruption ambiguë, la reprise marque `FAILED / TTS_OUTCOME_UNKNOWN` sans second appel. Les tâches BullMQ épuisées sont réconciliées en erreur par le dispatcher. Un opérateur doit vérifier le résultat chez le fournisseur avant toute reprise manuelle ; aucune commande de réinitialisation automatique n'est fournie.
- Les fichiers portent des UUID uniques et sont créés exclusivement (`wx`), sans écrasement. L'interface `AudioStorage` permettra un futur stockage objet. Le stockage local rejette les chemins arbitraires, traversées de répertoire et liens symboliques. Utilisez un dossier dédié, à chemin canonique, dont seuls les comptes serveur contrôlent l'accès.
- `music-metadata` mesure la durée dans les octets MP3/WAV reçus. La durée estimée du scénario n'est pas utilisée comme durée audio. Les métadonnées conservent les octets, l'identifiant fournisseur et le nombre de caractères lorsqu'ils sont fournis. Aucun tarif ni coût monétaire n'est inventé. Taille fournisseur limitée à 25 Mio, narration limitée à 10 000 caractères, timeout fournisseur de 60 secondes.
- En cas d'échec après écriture mais avant sauvegarde SQL, un fichier orphelin peut rester conservé : aucune suppression automatique ne risque d'effacer un audio existant.

## Docker et sauvegardes

`compose.production.yaml` est préparé uniquement : volume persistant `audio_data`, worker en écriture et API en lecture seule. La clé ElevenLabs est transmise uniquement au worker. Le worker a une interface réseau sortante pour joindre les fournisseurs ; PostgreSQL et Redis restent sur le réseau interne sans ports publiés. Aucun déploiement n'a été réalisé.

Sauvegardez ensemble PostgreSQL (voir la documentation existante de sauvegarde) et le contenu complet du dossier/volume audio. Pour un ensemble cohérent, arrêtez les écritures du worker durant cette sauvegarde. À la restauration, rétablissez le même contenu audio et les permissions du compte serveur, puis contrôlez les AudioAsset READY et leur préécoute. La sauvegarde PostgreSQL seule ne contient pas les MP3.

## Vérifications sans crédits

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run db:validate --workspace=@fako/api
docker compose config -q
```

La validation de `compose.production.yaml` exige les variables de production, notamment `DATABASE_URL` avec `postgres` comme hôte ; le `.env` local ne les fournit pas nécessairement. Une vérification syntaxique avec une URL factice ne nécessite ni lancement ni connexion au VPS.

Les tests d'intégration utilisent PostgreSQL et Redis réels. Exécutez-les sur des instances **de test isolées**, jamais sur une base de production ou de travail : ils créent puis nettoient uniquement leurs propres lignes et tâches.

```powershell
# Exemple : PostgreSQL de test sur 55439, Redis de test sur 56382
$env:DATABASE_URL = 'postgresql://postgres@127.0.0.1:55439/fako_test?schema=public'
$env:REDIS_URL = 'redis://127.0.0.1:56382'
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run test:integration --workspace=@fako/api
```

Les tests injectent MockTTSProvider ou un transport simulé : aucun appel ElevenLabs ou OpenAI réel. Les fichiers Mock sont des WAV valides d'une seconde dans des dossiers temporaires dédiés. Ils ne sont pas des voix réelles.

## Fichiers principaux

- `packages/ai-providers/` : contrat TTS, ElevenLabs/Mock, orchestration, stockage sécurisé et tests.
- `apps/api/prisma/schema.prisma` et `migrations/20261015040000_audio_assets/migration.sql` : ProjectVoice, AudioAsset et statuts audio.
- `apps/api/src/routes/audio.ts` et `src/app.ts` : configuration des voix, génération, statut, préécoute et contrôle d'accès.
- `apps/worker/src/audio-worker.ts` et `src/worker.ts` : file audio, dispatcher, arrêt propre.
- `apps/api/test/audio.test.ts` et `test/integration/audio.test.ts` : validations, approbation, idempotence, concurrence, retries, erreurs et accès protégé.
- Manifests npm/lockfile, `.gitignore`, exemples d'environnement, Dockerfile et Compose production : intégration au monorepo et persistance privée.
