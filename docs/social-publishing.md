# Moteur de publication programmée — TikTok, Instagram, Facebook (Mission 14)

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

Cette mission construit le moteur qui publie réellement une vidéo RijPermis approuvée sur TikTok,
Instagram ou une Page Facebook, à une date programmée, avec vérification en direct juste avant
l'envoi. **Aucune publication réelle n'a été effectuée** dans le cadre de cette mission — tout a été
exercé en mode mock/dry-run, conformément à la consigne.

## Audit préalable

- `@fako/publishing` (mission 13) exposait déjà les connecteurs OAuth, `validatePublicationReadiness`
  et `validateMediaRequirements`, mais **aucune méthode de publication réelle** — confirmé avant tout
  développement. Étendu plutôt que réécrit : `SocialPlatformConnector` gagne `publishVideo()` et
  `getPublicationStatus()`, implémentées dans les trois adaptateurs existants.
- `verifyQuizVideoBeforePublication` et `isPublicationBlocked` (missions 7/10, `@fako/video-jobs` /
  `@fako/video-pipeline`) existaient déjà, prêts à être appelés par un futur moteur — c'est exactement
  ce que fait `verifyBeforeSend` (`@fako/social-publishing/verify.ts`), en direct, jamais en se fiant
  au `checkStatus` déjà enregistré.
- Le scheduler de génération (mission 11, `packages/quiz-pipeline/src/scheduler.ts`) fournissait le
  patron exact réutilisé ici : verrou d'idempotence (contrainte unique / `SELECT...FOR UPDATE`),
  détection de redémarrage par statut `PROCESSING` non résolu, dispatch outbox vers BullMQ
  (`jobId = id de ligne`). Le scheduler et le worker de publication sont des fichiers **distincts**
  (`apps/scheduler/src/social-publication-scheduler.ts`, `apps/worker/src/social-publication-worker.ts`)
  — aucun fichier de la mission 11 n'a été modifié.
- `apps/web` n'avait aucune notion de publication — ajoutée sans toucher aux pages existantes
  (tableau de bord, vidéos, réseaux sociaux restent inchangés, seule `quiz-video-detail.ts` gagne un
  lien « Programmer une publication » conditionné à `status === 'COMPLETED'`).

## Architecture

```
apps/web (admin, session)
   │  POST /admin/publications/new  (scheduledAtLocal = "YYYY-MM-DDTHH:mm", wall-clock Brussels)
   ▼
apps/api  src/routes/social-publications.ts  (Bearer QUIZ_VIDEO_API_TOKEN, même frontière que les autres routes)
   │  convertit scheduledAtLocal → UTC via zonedTimeToUtc('Europe/Brussels') — DST-safe, mission 11
   ▼
@fako/social-publishing (schedule.ts / engine.ts / reconcile.ts / scheduler-tick.ts / queue.ts)
   │
   ├── apps/scheduler/src/social-publication-scheduler.ts  (tick indépendant : SCHEDULED → READY si dû)
   └── apps/worker/src/social-publication-worker.ts         (BullMQ "social-publications" : READY → envoi réel)
            │
            ▼
   @fako/publishing (adaptateurs TikTok / Instagram / Facebook + mocks)
```

## Modèle de données (migration additive `20261020194550_add_social_publications`)

`SocialPublication` : une ligne par couple (vidéo, destination) — une même vidéo approuvée peut donc
être publiée sur plusieurs plateformes sans être rendue plusieurs fois, chaque destination ayant son
propre statut, historique et identifiant distant. `SocialPublicationAttempt` : une ligne par tentative
d'envoi (début, fin, issue, code/erreur) — l'historique des tentatives exigé par la mission, distinct
des compteurs de résumé (`attempts`, `lastError`) portés par la ligne parente.

### Cycle de vie (`SocialPublicationStatus`)

| Statut | Signification |
|---|---|
| `DRAFT` | Préparée (vidéo + destination + légende) mais aucune date programmée. |
| `SCHEDULED` | Date programmée (`scheduledAt`, UTC), en attente de son échéance. |
| `READY` | Due, en attente d'être réclamée par le worker (ou retentée après échec transitoire). |
| `PUBLISHING` | Tentative en vol — le statut sentinelle de détection de crash. |
| `PUBLISHED` | Confirmé par la plateforme. |
| `FAILED` | Échec confirmé par la plateforme (terminal, retries épuisés ou non rejouable). |
| `CANCELLED` | Annulée par un administrateur avant tout envoi. |
| `BLOCKED` | La vérification préalable (section suivante) a échoué — jamais envoyée. |
| `OUTCOME_UNKNOWN` | Issue ambiguë (timeout, exception réseau) — jamais retentée automatiquement. |

**Règle impérative respectée** (`@fako/social-publishing/engine.ts`) : une exception levée par
`connector.publishVideo()` ne résout **jamais** en `FAILED` — uniquement un retour explicite et
confirmé de la plateforme peut le faire. Une exception résout toujours en `OUTCOME_UNKNOWN`, jamais
renvoyée automatiquement. Un redémarrage qui retrouve une ligne `PUBLISHING` sans `remotePostId`
(aucun accusé de réception de la plateforme) bascule immédiatement en `OUTCOME_UNKNOWN` — exactement
le traitement que `generateQuizVideo` applique déjà à `QuizVideo.status = PROCESSING` (mission 10).

## Vérification obligatoire avant chaque envoi (`verifyBeforeSend`)

Exécutée en direct à **chaque** tentative, jamais mise en cache :

1. Vidéo approuvée (`validationStatus = APPROVED`, `status = COMPLETED`) — `validatePublicationReadiness`.
2. **Revérification RijPermis en direct** : `verifyQuizVideoBeforePublication` est rappelée ici, pas
   seulement lue depuis le dernier `checkStatus` connu — un retrait ou changement de question entre
   l'approbation et l'envoi bloque la publication avec un diagnostic explicite.
3. `contentHash` cohérent (même appel que ci-dessus, `isPublicationBlocked`).
4. Langue de la vidéo autorisée sur le compte destination.
5. Permissions de publication (`getCapabilities().canPublishDirectly` — distinct du simple scope
   accordé, intègre les restrictions plateforme comme TikTok non audité).
6. Jeton d'accès non expiré.
7. Spécifications MP4 (résolution/durée/taille, `validateMediaRequirements`) — lues sur le fichier
   réel, une seule fois toutes les vérifications logiques passées (évite une IO inutile).
8. Déduplication : aucune publication déjà `PUBLISHED` vers cette même destination pour cette vidéo.

Toutes les raisons d'échec sont collectées ensemble (pas seulement la première) et stockées dans
`lastError` — un administrateur voit tous les problèmes d'un coup.

## Adaptateurs de publication — ce qui est implémenté et contre quelle source

| Plateforme | Méthode d'envoi retenue | Pourquoi |
|---|---|---|
| TikTok | Upload direct (`FILE_UPLOAD`, chunké) via `/v2/post/publish/video/init/` puis `PUT` vers l'`upload_url` retourné | Aucune URL publique requise — fonctionne sans déploiement |
| Facebook Pages | Upload resumable local (`video_reels` : `start` → transfert `rupload.facebook.com` → `finish`) | Idem — upload direct, pas d'URL publique |
| Instagram | Création de conteneur (`media_type=REELS`, `video_url=...`) | **Nécessite une URL HTTPS publique** — fournie par le mécanisme d'URL signée temporaire (mission 15 section 4, voir plus bas) |

**Mission 15 section 4** : le mécanisme d'URL signée temporaire est maintenant implémenté —
`@fako/social-publishing`'s `createPublicVideoLink`/`resolvePublicVideoLink`/
`revokePublicVideoLinksForQuizVideo` (`packages/social-publishing/src/public-link.ts`) et la route
`GET /public/quiz-video-links/:token` (`apps/api/src/routes/public-quiz-videos.ts`). L'engine mint un
lien juste avant d'appeler le connecteur Instagram (jamais pour TikTok/Facebook) ; le token (256 bits,
jamais stocké en clair — seul son hash SHA-256 l'est) est scopé à une seule vidéo, expire après
`PUBLIC_VIDEO_LINK_TTL_MS` (2h par défaut) et est révoqué dès qu'un résultat terminal est connu
(`PUBLISHED`/`FAILED` côté engine ou reconciliation). Reste une exigence de déploiement, pas de code :
`PUBLIC_VIDEO_BASE_URL` doit être l'origine HTTPS publique réellement joignable par Meta (jamais une
adresse de bind comme `127.0.0.1`) ; tant qu'elle n'est pas configurée, Instagram reste bloqué
(`BLOCKED`, `INSTAGRAM_PUBLIC_URL_NOT_CONFIGURED`) au lieu d'échouer silencieusement. Testé de bout en
bout le 2026-10-21 avec un faux client Meta (`apps/api/test/integration/public-quiz-video-links.test.ts`) :
fetch non authentifié réussi, bytes identiques à l'original, tokens inconnus/malformés/expirés/révoqués
tous rejetés en 404 générique, flag `QUIZ_VIDEO_ENABLED` coupant toute la route.

Statut TikTok : appel préalable à `creator_info/query` pour connaître les `privacy_level_options` du
compte ; `SELF_ONLY` est toujours préféré quand disponible (toute app non auditée y est de toute façon
restreinte par la plateforme elle-même, confirmé par la recherche officielle).

Chaque adaptateur distingue explicitement, par construction :
- Échec confirmé (`FAILED`, avec `retryable` selon que l'erreur est clairement transitoire — rate
  limit, 5xx — ou définitive).
- Traitement asynchrone (`PENDING` + référence), résolu ensuite par `getPublicationStatus`.
- Toute erreur réseau/HTTP inattendue : l'exception remonte sans interprétation (jamais convertie en
  `FAILED` localement).

### Recherche officielle — ce qui est confirmé vs non vérifiable

- **TikTok** : endpoints, scopes, specs vidéo (360–4096px, ≤10 min, ≤4 Go), limites de débit
  (6 req/min init, 30 req/min statut) et restriction `SELF_ONLY` pour app non auditée — tous
  confirmés sur des pages officielles developers.tiktok.com. Durée minimale non confirmée
  officiellement — non codée en dur.
- **Instagram** : endpoints et `instagram_business_content_publish` confirmés. Le quota de publication
  par 24h est **contradictoire dans la documentation Meta elle-même** (100 vs 50 selon la page) — en
  conséquence, aucun chiffre n'est codé en dur ; une future mission devrait interroger
  `content_publishing_limit` en direct plutôt que de supposer un nombre.
- **Facebook** : `video_reels` documente `upload_phase` comme `{START, FINISH}`, mais le guide
  `reels-publishing` décrit un flux à 3 étapes avec transfert intermédiaire — **incohérence connue
  entre deux pages officielles Meta**, résolue en retenant le flux à 3 étapes (le seul qui permette un
  upload local sans URL publique). Taille de fichier maximale non confirmée officiellement.

## Scheduler et worker

- **Scheduler** (`apps/scheduler/src/social-publication-scheduler.ts`) : tick indépendant (défaut
  30s), promeut les lignes `SCHEDULED` dont `scheduledAt <= maintenant` vers `READY`, borné par
  `SOCIAL_PUBLISHING_MAX_IN_FLIGHT` (défaut 20) pour empêcher toute accumulation incontrôlée.
- **Worker** (`apps/worker/src/social-publication-worker.ts`) : file BullMQ dédiée `social-publications`
  (`dispatchSocialPublications`, même patron outbox que la génération), plus une **boucle de
  réconciliation** périodique (`reconcileInFlightPublications`, défaut 60s) qui interroge le statut
  distant des publications `PUBLISHING` asynchrones et résout `OUTCOME_UNKNOWN` celles qui dépassent
  `SOCIAL_PUBLISHING_RECONCILE_GRACE_MS` (défaut 15 min) sans confirmation.
- Concurrence multi-instance : verrou par ligne (`SELECT...FOR UPDATE`) identique au patron mission 10 ;
  deux instances ne peuvent jamais réclamer la même publication.

## Interface d'administration (`apps/web`)

| Route | Contenu |
|---|---|
| `/admin/publications` | Liste filtrable (statut, plateforme), plateforme/compte/vidéo/dates/lien distant |
| `/admin/publications/new` | Formulaire : vidéo **COMPLETED uniquement**, compte **CONNECTED uniquement**, langue, légende, hashtags, date (`datetime-local`, Europe/Brussels) |
| `/admin/publications/:id` | Détail, historique des tentatives, erreur si bloquée/échouée, actions |
| `/admin/publications/:id/schedule` | Modifier la programmation (uniquement avant échéance) |
| `/admin/publications/:id/cancel` | Annuler (uniquement si non commencée) |
| `/admin/publications/:id/retry` | Relance manuelle (uniquement depuis `BLOCKED` ou `FAILED` confirmé — jamais `OUTCOME_UNKNOWN`) |

`apps/web` ne possède **aucune méthode « publier maintenant »** — vérifié par un test dédié qui
inspecte les méthodes réellement exposées sur le client API, exactement comme la mission 12 l'avait
fait pour l'approbation. La conversion de date locale → UTC (`Europe/Brussels`, DST-safe) se fait
côté `apps/api` (`zonedTimeToUtc`, réutilisé de la mission 11) — `apps/web` ne transporte qu'une
chaîne `datetime-local` brute, sans aucune dépendance à la logique métier.

## Mode simulation (dry-run)

`SOCIAL_PUBLISHING_ENABLED=false` par défaut (interrupteur serveur, jamais lisible/modifiable depuis
le navigateur) — gate les routes API **et** le scheduler **et** le worker. Avec
`SOCIAL_MOCK_MODE=true`, les trois connecteurs sont remplacés par `MockSocialConnector`
(`@fako/publishing/mocks.ts`), dont le scénario de publication (`MockPublishScenario`) simule :

| Scénario | Comportement simulé |
|---|---|
| `SUCCESS` | Publication confirmée immédiatement |
| `PENDING_THEN_SUCCESS` | Traitement asynchrone — `PENDING` puis confirmé au premier sondage |
| `RATE_LIMITED` | Échec confirmé, `retryable: true` |
| `PERMANENT_FAILURE` | Échec confirmé, `retryable: false` |
| `TIMEOUT` | Exception (issue ambiguë) — jamais convertie en échec confirmé |

Zéro appel réseau réel, zéro média envoyé, zéro crédit IA consommé dans ce mode — vérifié par un test
dédié qui intercepte `fetch` et constate qu'il n'est jamais appelé.

## Variables d'environnement (`apps/api/.env.example`)

```dotenv
SOCIAL_PUBLISHING_ENABLED=false                    # interrupteur serveur, jamais activé automatiquement
SOCIAL_PUBLISHING_MAX_IN_FLIGHT=20                  # borne l'accumulation de jobs
SOCIAL_PUBLISHING_SCHEDULER_TICK_INTERVAL_MS=30000
SOCIAL_PUBLISHING_RECONCILE_GRACE_MS=900000         # 15 min avant OUTCOME_UNKNOWN
SOCIAL_PUBLISHING_RECONCILE_INTERVAL_MS=60000
SOCIAL_PUBLISHING_WORKER_CONCURRENCY=1
TIKTOK_APP_AUDITED=false                            # jamais deviné, jamais vrai par défaut
INSTAGRAM_APP_AUDITED=false
FACEBOOK_APP_AUDITED=false
```

Réutilise `QUIZ_VIDEO_API_TOKEN` (même frontière de confiance), `SOCIAL_MOCK_MODE` et
`SOCIAL_TOKEN_ENCRYPTION_KEY` (mission 13).

## Prérequis pour activer chaque plateforme réellement (hors code, hors mission 14)

- **TikTok** : app auditée (`TIKTOK_APP_AUDITED=true` seulement après l'audit TikTok réel), domaine
  vérifié si `PULL_FROM_URL` est utilisé un jour (non utilisé ici).
- **Instagram** : Advanced Access (App Review + Business Verification Meta) **et** une URL publique
  pour servir la vidéo — aucune des deux n'est en place.
- **Facebook Pages** : Advanced Access Meta pour publier sur des Pages tierces ; `pages_manage_posts`
  déjà demandé en OAuth (mission 13).

## Tests

```powershell
npm.cmd run build
npm.cmd test                                                  # suite complète, tous workspaces
npm.cmd run test:integration --workspace=@fako/api            # isolé, fako_test (voir docs/rijpermis-admin.md)
```

Couverture notable des tests d'intégration (`apps/api/test/integration/social-publications.test.ts`,
contre Postgres réel) : approbation obligatoire, revérification RijPermis en direct (vidéo retirée
entre approbation et envoi), correspondance de langue (y compris révoquée après programmation),
permissions insuffisantes, programmation DST-safe (conversion hiver **et** été vérifiée contre les
bons décalages UTC), publication multi-destinations, idempotence (`requestId`), capacité bornée du
scheduler, dispatch BullMQ idempotent, retry après échec confirmé transitoire vs terminal, issue
ambiguë → `OUTCOME_UNKNOWN` jamais retentée automatiquement, redémarrage worker, réconciliation
(asynchrone résolu, et bascule en `OUTCOME_UNKNOWN` après le délai de grâce), annulation/relance
restreintes aux statuts sûrs, et absence totale d'appel réseau réel en mode mock.

## Limites et ce qui reste bloqué

- Aucun des trois adaptateurs réels n'a été exercé contre une vraie plateforme (aucun identifiant
  développeur configuré) — seuls les mocks sont testés, comme pour les missions 13/14 précédentes.
- Instagram ne peut publier réellement sans une URL HTTPS publique pour la vidéo — infrastructure non
  prévue par cette mission.
- Les quotas de publication Instagram ne sont pas interrogés en direct (`content_publishing_limit`) —
  limite connue, à ajouter si la publication réelle est un jour activée.
- Le rafraîchissement automatique d'un jeton proche de l'expiration n'est pas implémenté : un jeton
  expiré bloque l'envoi (`BLOCKED`, diagnostic explicite) plutôt que d'être rafraîchi silencieusement —
  choix délibéré pour rester visible à l'administrateur.
