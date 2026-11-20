# Scénarios vidéo avec OpenAI

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

## Architecture et garde-fous

L'API crée une demande durable `VideoScript`, puis le worker la traite via la file
BullMQ `video-scripts`. La file de simulation vidéo existante reste disponible ;
une tâche qui demande un scénario en est exclue, y compris si une simulation était
déjà en cours. Aucun audio, fichier vidéo ni publication n'est déclenché.

`AIProvider` est une interface serveur dans `packages/video-jobs/src/ai.ts`.
`OpenAIProvider` utilise l'API Responses via `fetch`, sans SDK effectuant des
retries supplémentaires. Les tests injectent un fournisseur simulé ou un transport
HTTP simulé ; ils ne lisent pas de clé réelle et ne consomment aucun crédit.

L'intégration suit la [documentation officielle OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) :
`text.format` avec `type: json_schema`, `strict: true`, et `store: false`.
Cela ne garantit pas la véracité du texte : une seconde validation serveur et une
revue humaine restent obligatoires. Aucun outil de navigation ou d'exécution n'est
donné au modèle. Les demandes et réponses ne sont pas journalisées.

La génération n'est activée que par une demande explicite. Un VideoJob créé seul
continue à être simulé ; il ne déclenche pas d'appel OpenAI. La cadence du projet
ne crée aucune demande automatique. La clé n'est utilisée que par le worker.

## Configuration locale

Arrêter API et worker avant le build sous Windows pour éviter le verrouillage
du moteur Prisma. Conserver les fichiers `.env` existants, ne pas les écraser.
Pour une première installation, copier les exemples racine, API et worker.

```powershell
npm.cmd ci
docker compose up -d --wait postgres redis
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run build
npm.cmd run db:seed --workspace=@fako/api
npm.cmd run db:editorial --workspace=@fako/api
```

La migration ajoute des colonnes et tables, sans reset ni suppression. Le seed
préserve RijPermis s'il existe ; `db:editorial` remplit seulement les consignes
vides et la liste de faits vide. Une configuration personnalisée n'est pas écrasée.

Dans `apps/api/.env`, ajouter `AI_PROVIDER=openai` pour activer l'endpoint.
L'API n'a pas besoin de la clé. Dans `apps/worker/.env`, configurer :

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=remplacer-localement
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_MS=45000
```

Le modèle est configurable ; son accès dépend du compte OpenAI et il doit prendre
en charge Responses et Structured Outputs. Aucun appel payant n'a été exécuté
pour valider cette implémentation. Ne pas placer la clé dans le navigateur, un
corps de requête API, un Dockerfile ou un fichier versionné. Sans activation
explicite, `AI_PROVIDER=disabled` est le défaut ; l'endpoint renvoie 503.

API et worker utilisent la même `DATABASE_URL` PostgreSQL locale sur `5433`.
Le worker utilise aussi `REDIS_URL=redis://127.0.0.1:6379`.
Le délai OpenAI doit être compris entre 1000 et 120000 ms ; la sortie est plafonnée
à 6000 tokens par appel et le worker de scénarios traite un appel à la fois.

```powershell
# Terminal 1
npm.cmd run dev:api
# Terminal 2
npm.cmd run dev:worker
```

Le Compose de production est seulement préparé : `AI_PROVIDER` active les deux
services, et `OPENAI_API_KEY` est transmis uniquement au worker depuis l'environnement
d'exécution. Redis et PostgreSQL gardent leurs ports privés. Aucun déploiement
VPS n'est effectué.

## Consignes et faits métier par projet

Les routes CRUD projets acceptent :

```json
{
  "editorialInstructions": "Ton pédagogique, langue de la tâche, ne pas inventer de fonctions.",
  "verifiedFacts": [
    {
      "id": "daily-group-exam",
      "text": "Les membres d'un groupe disposent d'un examen quotidien commun.",
      "source": "Informations métier validées par le propriétaire du projet.",
      "kind": "BUSINESS"
    }
  ]
}
```

PATCH remplace la liste si elle est fournie : conserver les autres faits souhaités.
Chaque fait a un identifiant unique, un texte et sa provenance. Ce registre est
validé par le responsable du projet, pas vérifié automatiquement sur Internet.
Il ne faut y saisir que des informations réellement confirmées.

RijPermis reçoit des consignes français/néerlandais et trois faits fournis par le
propriétaire : quiz pour préparer le permis belge, examen quotidien commun aux
membres d'un groupe et suivi des progrès. Aucune autre fonctionnalité n'est
présumée (tarifs, classements, notifications, réussite garantie, etc.).

Pour `contentType: QUIZ`, ajouter au moins un fait `kind: ROAD_RULE`, contenant
la règle précise et une source officielle vérifiée par un humain. Aucun fait de
circulation n'est prérempli. Sans cette source, la demande est refusée avec 409
avant tout appel payant. Le quiz généré contient question, choix, index de la
bonne réponse, explication et références aux faits ROAD_RULE. La validation
contrôle ces références et l'index, mais un humain doit vérifier que la règle est
correctement interprétée et applicable au contexte belge.

## Endpoints et versionnement

| Méthode | Route | Résultat |
| --- | --- | --- |
| POST | `/video-jobs/:id/scripts/generate` | 202, demande mise en attente ; 200 si même requestId |
| GET | `/video-jobs/:id/scripts` | Versions du scénario, plus récente en premier |
| GET | `/video-scripts/:id` | Scénario et historique d'appels/tokens/coût |
| POST | `/video-scripts/:id/review` | Approbation ou rejet de la dernière version |

Le corps de génération est :

```json
{ "requestId": "UUID-GENERE-PAR-LE-CLIENT", "contentType": "PROMOTION" }
```

`contentType` accepte `PROMOTION`, `EDUCATIONAL` (défaut) ou `QUIZ`. Un identifiant
de requête est obligatoire. Réutiliser le même en cas de répétition réseau : cela
renvoie la demande existante sans nouvel appel ni version. Pour régénérer après
échec ou rejet, utiliser un nouveau UUID. Une seule demande peut être active par
VideoJob ; sa création est sérialisée en PostgreSQL. Les tâches annulées ou déjà
terminées ne sont pas régénérées : créer un autre VideoJob.

Exemple PowerShell, après création d'un VideoJob via les routes existantes :

```powershell
$jobId = 'REMPLACER-PAR-UUID-VIDEOJOB'
$requestId = [guid]::NewGuid().ToString()
$body = @{ requestId = $requestId; contentType = 'PROMOTION' } | ConvertTo-Json
$script = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/video-jobs/$jobId/scripts/generate" -ContentType 'application/json' -Body $body
Invoke-RestMethod "http://127.0.0.1:3000/video-scripts/$($script.id)"
```

Un VideoScript suit `PENDING → PROCESSING → GENERATED` ou `FAILED/CANCELLED`.
Sa validation suit `PENDING_APPROVAL → APPROVED/REJECTED`. Le JSON doit fournir
langue, titre, accroche, narration, scènes, textes à l'écran et durée estimée.
Le serveur vérifie le schéma, la langue, les références de faits, la cohérence de
la narration/textes avec les scènes et la somme des durées (tolérance de 20 % ou
3 secondes par rapport à la cible). Chaque version conserve les données
éditoriales utilisées ; une modification ultérieure du projet ne change pas
les anciennes versions.

Après `GENERATED`, contrôler la source de chaque affirmation, le français ou le
néerlandais, les réponses du quiz, les promesses marketing et la durée. Puis :

```powershell
$review = @{ reviewedBy = 'Nom du validateur'; decision = 'APPROVED'; comment = 'Faits et formulation vérifiés' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/video-scripts/$($script.id)/review" -ContentType 'application/json' -Body $review
```

Utiliser `REJECTED` pour rejeter. Seule la dernière version générée en attente peut
être approuvée. L'ancien endpoint `/video-jobs/:id/approve` ne permet pas de
contourner cette étape. L'approbation marque cette tâche terminée, sans démarrer
aucune génération audio/vidéo. `reviewedBy` reste déclaratif tant que l'API n'a
pas d'authentification : garder l'accès local ou protégé.

## Erreurs, reprises et coût

HTTP 429, 408 et 5xx autorisent au maximum trois tentatives via BullMQ, avec
délais exponentiels de 2 puis 4 secondes. Pas de retry automatique pour erreur
d'authentification, refus, JSON invalide, mauvaise langue ou faits inconnus.
Un timeout/une coupure sans réponse est ambigu et ne déclenche pas de nouvel
appel automatique. Un arrêt du worker pendant un appel laisse une trace
`IN_FLIGHT` ; la reprise passe en `AI_OUTCOME_UNKNOWN` plutôt que de potentiellement
facturer un second appel. Vérifier l'utilisation côté fournisseur avant de
demander manuellement une nouvelle version.

Chaque appel est enregistré dans `AIRequest` avec fournisseur, modèle, tentative,
identifiant de réponse, tokens disponibles et code d'erreur expurgé. Même une
réponse invalide/refusée conserve ses tokens si le fournisseur les transmet.
Les tokens et coûts restent `null` lorsqu'ils sont inconnus ; ils ne sont jamais
présumés nuls. L'annulation empêche la validation du résultat mais ne rembourse
pas un appel déjà envoyé.

Pour une estimation facultative, définir dans le worker :

```dotenv
OPENAI_PRICE_MODEL=identifiant-exact-renvoye-par-le-fournisseur
OPENAI_INPUT_USD_PER_MILLION=tarif-verifie
OPENAI_OUTPUT_USD_PER_MILLION=tarif-verifie
OPENAI_CACHED_INPUT_USD_PER_MILLION=tarif-verifie-facultatif
```

Utiliser des nombres décimaux et les tarifs vérifiés du modèle. Aucune grille de
prix n'est codée en dur. L'estimation n'est calculée que si le modèle renvoyé
correspond exactement au tarif configuré ; le tarif est conservé avec l'appel.
Le total réel facturé doit être contrôlé côté fournisseur. Cette V1 n'implémente
pas de budget financier global : limiter les demandes et la clé côté fournisseur.

## Tests sans crédit OpenAI

```powershell
npm.cmd run build
npm.cmd test
# Bases et Redis de test isolés, jamais les services de travail :
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:55437/fako_test?schema=public'
$env:REDIS_URL = 'redis://127.0.0.1:56380'
npm.cmd run db:migrate --workspace=@fako/api
npm.cmd run test:integration --workspace=@fako/api
```

Ces tests vérifient les scénarios français/néerlandais, la file réelle avec un
fournisseur simulé, l'idempotence, le versionnement, l'approbation, l'annulation,
les échecs, les reprises, les compteurs de tokens et la tarification facultative.
Le transport OpenAI est simulé pour vérifier le contrat HTTP sans requête réseau.
