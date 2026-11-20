# Bascule de la simulation vers la production réelle

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

Ce document décrit comment faire évoluer le déploiement VPS **mission 16** (100 % simulation :
contenu mock, TTS mock, publication mock, aucun appel réseau réel, aucun coût) vers une diffusion
réelle sur TikTok/Instagram/Facebook. **Aucune de ces étapes n'a été activée par la mission 16** —
ce guide décrit uniquement le chemin, dans l'ordre, avec les variables exactes du dépôt.

Chaque étape est indépendante et réversible : on peut s'arrêter à n'importe laquelle, revenir en
arrière (remettre `..._MOCK_MODE=true` / `..._ENABLED=false`) sans perdre de données.

## Pré-requis communs à toutes les étapes

- Un nom de domaine réel pointant vers ce VPS (`62.171.178.212`), avec `ADMIN_DOMAIN` et
  `ADMIN_PUBLIC_BASE_URL` renseignés dans `infrastructure/docker/.env` et le service `proxy`
  (Caddy) démarré pour obtenir un certificat HTTPS valide — **bloquant pour les étapes B et C**,
  puisque `isValidRedirectUri()` (`apps/api/src/routes/social-accounts.ts`) refuse toute URI de
  redirection OAuth non-HTTPS dès que `NODE_ENV=production`.
- Durcissement SSH du VPS (`PasswordAuthentication no`, `PermitRootLogin prohibit-password`) —
  identifié comme point ouvert par l'audit de sécurité mission 16, à traiter avant toute ouverture
  publique de l'interface admin.
- `FAKO_ALLOW_MOCK_IN_PRODUCTION` doit redevenir `false` une fois la bascule complète (étape A
  terminée) : c'est l'opt-in explicite de la mission 16 pour un déploiement staging 100 % mock
  sous `NODE_ENV=production`, il n'a aucune raison d'exister en production réelle.

## Étape A — Génération réelle (contenu + voix)

Objectif : remplacer les questions et la voix mock par le vrai connecteur RijPermis et une vraie
synthèse vocale, tout en gardant la publication en mock.

1. Contenu réel : `RIJPERMIS_MOCK_MODE=false`, `RIJPERMIS_API_ENABLED=true`,
   `RIJPERMIS_API_BASE_URL=` et `RIJPERMIS_API_KEY=` renseignés avec les vraies valeurs de l'API
   RijPermis (jamais une clé de développement — voir l'audit secrets mission 15/16).
2. Voix réelle : `QUIZ_VIDEO_TTS_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY=` avec une vraie clé.
   Remplacer les lignes `ProjectVoice` de test (`mock-voice-fr`/`mock-voice-nl`, insérées
   manuellement pendant les tests mission 16) par de vrais `voiceId` ElevenLabs via
   `PUT /projects/:id/voices/:language` (nécessite aussi `TTS_PROVIDER=elevenlabs` et
   `AUDIO_API_TOKEN` pour que cette route s'active — voir `apps/api/src/app.ts`).
3. Script réel (optionnel) : `AI_PROVIDER=openai`, `OPENAI_API_KEY=` si la génération de script
   doit cesser d'être désactivée.
4. Garder `SOCIAL_MOCK_MODE=true` et `SOCIAL_PUBLISHING_ENABLED=false` à ce stade : on valide un
   rendu réel (coût ElevenLabs réel, donc tester avec un seul quiz d'abord) sans jamais publier.
5. Rebuild + redeploy `worker` (et `api` si `AI_PROVIDER` change) avec un nouveau tag d'image.
   Vérifier manuellement la vidéo produite (`GET /quiz-videos/:id/preview`) avant de continuer.

## Étape B — Connexion des comptes sociaux réels

Objectif : obtenir un vrai jeton OAuth par plateforme, sans jamais publier.

1. Nécessite le domaine HTTPS réel (pré-requis commun ci-dessus).
2. Credentials développeur réels dans `.env` : `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`,
   `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`. Laisser
   `TIKTOK_APP_AUDITED=false` (et équivalents Instagram/Facebook) tant que l'app n'a **réellement**
   passé l'audit de la plateforme — mission 16 a vérifié que ce flag bloque bien la publication
   directe même avec un compte connecté.
3. `SOCIAL_MOCK_MODE=false` (bascule les connecteurs réels, pas encore la publication).
4. Se connecter depuis l'interface admin (`/admin/settings/social`) avec le vrai compte TikTok/
   Instagram/Facebook RijPermis. Vérifier le statut `CONNECTED` et les `grantedScopes`.
5. `SOCIAL_PUBLISHING_ENABLED` reste `false` : connecter un compte n'envoie jamais rien tant que
   cette variable n'est pas activée (c'est la variable testée et confirmée par mission 16).

## Étape C — Première publication réelle (supervisée)

Objectif : publier une seule vidéo, manuellement, en observant chaque étape.

1. `SOCIAL_PUBLISHING_ENABLED=true`.
2. Si la plateforme n'a pas encore passé l'audit officiel (TikTok notamment), la capacité
   `canPublishDirectly` restera fausse et la publication sera `BLOCKED` avec un message explicite
   (comportement vérifié par mission 16) — c'est le signal attendu tant que l'audit n'est pas fait.
3. Planifier **une seule** publication depuis `/admin/publications/new`, avec un
   `scheduledAtLocal` proche, sur le compte réellement audité/autorisé.
4. Surveiller `GET /social-publications/:id` jusqu'à `PUBLISHED` ou `FAILED`/`BLOCKED`, et
   vérifier manuellement sur la plateforme elle-même que la vidéo est bien en ligne (ou absente,
   si le statut est négatif).
5. Ne pas enchaîner d'autre publication avant d'avoir validé celle-ci de bout en bout.

## Étape D — Automatisation progressive

Objectif : passer de publications manuelles à un flux planifié, à faible volume d'abord.

1. `SCHEDULER_ENABLED=true` sur **un seul** scheduler à la fois pour commencer
   (`scheduler-generation` ou `scheduler-publication`), avec `SCHEDULER_SLOTS` réduit à un seul
   créneau par jour.
2. Démarrer le conteneur correspondant (il était volontairement laissé arrêté depuis la mission 16
   — `SCHEDULER_ENABLED=false` lui aurait fait quitter immédiatement avec `exit(0)` et
   boucler sous `restart: unless-stopped`).
3. Observer plusieurs cycles complets (génération → approbation manuelle → publication) avant
   d'ajouter des créneaux.
4. Surveiller `infrastructure/docker/monitor.sh` (timer actif, toutes les 5 minutes) pour détecter
   tout `QuizVideo FAILED`, `SocialPublication BLOCKED` ou `OUTCOME_UNKNOWN` dès qu'ils apparaissent.

## Étape E — Régime complet (3 FR + 3 NL / jour)

Objectif : le rythme de croisière visé par le projet.

1. `SCHEDULER_SLOTS` porté à 3 créneaux/jour, les deux schedulers (`scheduler-generation` et
   `scheduler-publication`) actifs.
2. Revoir `QUIZ_VIDEO_WORKER_CONCURRENCY`/`QUIZ_VIDEO_RENDER_CONCURRENCY` (actuellement 1/1,
   dimensionnés pour un VPS modeste) à la lumière de la charge réelle observée à l'étape D.
3. Avant ce palier, corriger le point de fragilité identifié par mission 16 : le `lockDuration`
   BullMQ par défaut (30 s) est trop court face à un rendu Remotion réel (1 à 3 minutes observées
   en simulation), ce qui provoque des pertes de verrou et des re-tentatives inutiles. À augmenter
   explicitement dans `apps/worker/src/quiz-video-worker.ts` (option `lockDuration` du `Worker`)
   avant de multiplier les rendus quotidiens.
4. Mettre en place une vraie alerte externe (mail/webhook) branchée sur l'exit code de
   `fako-monitor.service` — mission 16 n'a délibérément rien configuré ici (aucune intégration
   externe sans accord explicite), c'est une action restante pour ce palier.
5. Revoir la politique de rétention vidéo (`QUIZ_VIDEO_RETENTION_DAYS`, `prune-videos.sh`) au
   régime de croisière : à ce volume, surveiller la croissance du volume `quiz_video_data`.

## Rappel de sécurité à chaque étape

Chaque variable `..._MOCK_MODE` ou `..._ENABLED` listée ci-dessus doit être changée **une à la
fois**, avec vérification du comportement observé avant de passer à la suivante — ne jamais activer
plusieurs bascules en même temps "pour gagner du temps", c'est exactement le scénario de
mauvaise configuration partielle que la mission 16 a cherché à exclure dès la conception
(`FAKO_ALLOW_MOCK_IN_PRODUCTION` comme opt-in isolé plutôt qu'un simple assouplissement de
`NODE_ENV`).
