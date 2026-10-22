# Connecteur de contenu RijPermis (Mission 7)

## Architecture

`packages/content-sources` expose `RijPermisContentProvider`, un client HTTP pour
l'API de consultation Spring Boot de RijPermis (`GET /api/integrations/fako/v1/...`),
indépendante du backend RijPermis lui-même : aucune écriture, aucun accès direct à
sa base PostgreSQL. L'authentification se fait par l'en-tête `X-Fako-Api-Key`,
jamais journalisé. HTTPS est obligatoire sauf en environnement `test`/`development`
contre `127.0.0.1`/`localhost`. Le client limite son débit (espacement des requêtes),
retente au maximum 3 fois avec backoff exponentiel sur 5xx/408, respecte un
`Retry-After` numérique ou au format date pour les 429, et ne retente jamais une 401
(configuration invalide) ni une 404 (question absente ou non exportable).

Les réponses sont validées strictement (`packages/content-sources/src/schema.ts`,
Ajv) : `schemaVersion` supporté, identifiant non vide, énoncé non vide, au moins une
proposition, identifiants de propositions uniques, réponse correcte existante,
statut `APPROVED`, `contentHash` au format `sha256:...`. Le nombre de propositions
n'est jamais supposé égal à trois. Une liste vide est un résultat valide, pas une
panne. Les images ne sont jamais reconstruites à partir de l'identifiant de la
question : seul `image.url`, résolu contre l'origine configurée et limité à
`/api/images/...`, est utilisé ; le type MIME réel et la taille sont vérifiés avant
stockage via `LocalMediaStorage`.

`MockContentSourceProvider` fournit un jeu de questions fictif pour développer sans
réseau. `contentSourceFromEnv()` (`packages/content-sources/src/mock.ts`) choisit
entre connecteur réel, mock ou désactivé, et refuse explicitly le mode mock si
`NODE_ENV=production`.

## Configuration

Dans `apps/api/.env` (jamais commité avec une vraie clé) :

```dotenv
RIJPERMIS_API_ENABLED=false
RIJPERMIS_API_BASE_URL=
RIJPERMIS_API_KEY=
RIJPERMIS_MOCK_MODE=false
RIJPERMIS_MEDIA_ROOT=
```

Le connecteur tourne dans le processus API (pas le worker) : récupérer une question
ne coûte rien et ne nécessite pas d'attendre BullMQ. `RIJPERMIS_API_ENABLED=false`
est le défaut ; les routes RijPermis renvoient 503 tant qu'aucune des deux options
(connecteur réel ou mock) n'est activée. `RIJPERMIS_MOCK_MODE=true` active des
questions fictives sans réseau, utile en développement local ; il est automatiquement
refusé si `NODE_ENV=production`, quelle que soit sa valeur. `RIJPERMIS_API_KEY` n'est
jamais exposée au navigateur, seulement utilisée côté serveur.

## Endpoints

| Méthode | Route | Résultat |
| --- | --- | --- |
| GET | `/rijpermis/themes?language=fr\|nl` | Catégories ayant des questions approuvées |
| GET | `/rijpermis/questions?language=&category=&page=&size=` | Page de questions validées |
| GET | `/rijpermis/questions/:id` | Une question ; 404 si absente ou non exportable |
| POST | `/video-jobs/:id/scripts/generate-from-rijpermis` | Génère un quiz sourcé (202/200) |
| POST | `/video-scripts/:id/verify-source` | Re-vérifie la question source avant publication |

Toutes renvoient 503 si le connecteur est désactivé. Le corps de génération est :

```json
{ "requestId": "UUID-GENERE-PAR-LE-CLIENT", "questionId": "6337" }
```

La langue de la question doit correspondre à celle du `VideoJob` (409 sinon) ; le
contenu généré est toujours de type `QUIZ`. L'idempotence par `requestId` suit le
même contrat que `/video-jobs/:id/scripts/generate`.

## Traçabilité

Chaque script généré à partir d'une question RijPermis crée une ligne
`VideoScriptSource` (migration `20261017223649_rijpermis_traceability`, un-à-un avec
`VideoScript`) : projet via le `VideoJob`, fournisseur (`rijpermis`), origine,
identifiant de question stable, `contentHash` et hash de snapshot au moment de la
récupération, langue, catégorie, snapshot complet de la question, date de
récupération, et éventuellement clé/hash/type MIME de l'image stockée. Rien n'est
dupliqué dans `VideoScript` : l'énoncé, les propositions et la réponse voyagent dans
`editorialSnapshot.facts` sous forme d'un fait `ROAD_RULE` immuable
(`buildSourceFact`), à reproduire mot pour mot par le modèle.

Après génération, `verifySourcedQuizContent` compare la sortie IA à la question
source : une seule scène de quiz, énoncé identique, propositions identiques dans le
même ordre, index de bonne réponse correspondant. Tout écart échoue immédiatement
la génération (`SOURCE_CONTENT_MISMATCH`, non réessayée) plutôt que de laisser
passer une reformulation ou une réponse inventée. L'explication reste rédigée par
l'IA et n'est jamais présentée comme officiellement validée ; la revue humaine
existante (`/video-scripts/:id/review`) reste obligatoire avant toute utilisation.

### Détection des modifications avant publication

`verifySourceBeforePublication` (exportée par `@fako/video-jobs`, utilisée par
`POST /video-scripts/:id/verify-source`) relit la question source en direct et
compare son `contentHash` à celui enregistré. Résultat `CURRENT`, `CHANGED` ou
`WITHDRAWN`, persisté sur `VideoScriptSource.checkStatus`/`checkedAt`.
`isPublicationBlocked()` indique s'il faut bloquer la publication et redemander une
validation humaine. Aucun moteur de publication n'existe encore dans ce dépôt ; cette
fonction est l'interface prête à être appelée par la future étape de publication.

## Tests

```powershell
npm.cmd run build
npm.cmd test
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5433/fako_test?schema=public'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run test:integration --workspace=@fako/api
```

`packages/content-sources/test` couvre la validation de schéma, la configuration du
connecteur, l'en-tête d'authentification (jamais journalié), la pagination et les
filtres, une liste vide, 3 et 4 propositions, les réponses incohérentes, les erreurs
401/404/429/5xx, le respect de `Retry-After`, les timeouts, les images absentes ou
invalides, et `checkQuestion`. `packages/video-jobs/test/rijpermis.test.ts` couvre la
construction du fait source et le rejet d'un quiz reformulé ou dont la réponse a été
modifiée. `apps/api/test/integration/rijpermis.test.ts` couvre la traçabilité en
PostgreSQL, le rejet pour langue incompatible, l'idempotence, le rejet effectif d'une
génération infidèle à la source, la détection `CURRENT`/`CHANGED`/`WITHDRAWN`, la
désactivation par défaut, et la non-régression du parcours de script non sourcé.
Aucun test n'appelle RijPermis, OpenAI ou ElevenLabs réellement.
