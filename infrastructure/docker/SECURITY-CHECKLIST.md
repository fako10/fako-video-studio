# Checklist de sécurité avant déploiement (mission 15)

À cocher explicitement avant tout déploiement réel sur le VPS Contabo. Rien
dans cette liste n'a été exécuté contre une infrastructure réelle — chaque
point renvoie vers le test qui l'a validé en conditions isolées/jetables.

## Secrets

- [ ] Tous les secrets de `infrastructure/docker/.env.example` (et des
      `.env.example` par app) ont une vraie valeur générée, jamais une valeur
      d'exemple recopiée telle quelle (`QUIZ_VIDEO_API_TOKEN`,
      `SOCIAL_TOKEN_ENCRYPTION_KEY`, `ADMIN_SESSION_KEY`, `ADMIN_PASSWORD_HASH`,
      `POSTGRES_PASSWORD`).
- [ ] Le mot de passe PostgreSQL et le mot de passe admin de test utilisés en
      développement local (`Rivaldo10`, `TestAdmin123!` — voir section 1 de
      l'audit) ne sont **jamais** réutilisés en production.
- [ ] `infrastructure/docker/.env` a les permissions `chmod 600` et n'est
      jamais commité (`.gitignore` déjà vérifié conforme).
- [ ] Une copie des secrets est conservée dans un coffre séparé du VPS
      (gestionnaire de mots de passe d'équipe / Vault) — voir
      `infrastructure/docker/README.md` section Secrets.

## Authentification et autorisation

- [ ] `QUIZ_VIDEO_API_TOKEN` fait bien 32+ caractères aléatoires (sinon toutes
      les routes API répondent 503, jamais un 200 non protégé).
- [ ] Toutes les routes API exigent un jeton Bearer, sauf
      `/public/quiz-video-links/:token` (volontaire, voir section 4).
- [ ] Un seul admin existe aujourd'hui (`ADMIN_USERNAME`) — modèle à jeton
      partagé unique, pas multi-utilisateur ; isolation multi-projet non
      implémentée (acceptable tant qu'un seul projet — RijPermis — existe).

## Base de données

- [ ] `apps/api/test/integration/_test-env.ts` est toujours importé en premier
      par chaque fichier de test d'intégration (vérifié dans ce dépôt).
- [ ] `DATABASE_URL` n'est **jamais** exporté dans le shell d'un environnement
      CI/dev avant de lancer `test:integration` (cause probable de l'incident
      QuizVideo — voir mémoire/audit section 2).
- [ ] Les sauvegardes automatiques (`fako-backup.timer`) sont actives et un
      test de restauration (`restore-check.sh`) a été fait sur le VPS réel au
      moins une fois après le premier déploiement.

## Réseau

- [ ] `postgres` et `redis` restent sans port publié (réseau `database`
      `internal: true`) — ne jamais ajouter de `ports:` dessus.
- [ ] `api` reste bound à `127.0.0.1` côté hôte — jamais `0.0.0.0` directement.
- [ ] Le service `proxy` (Caddy) n'est démarré qu'après confirmation que
      `$ADMIN_DOMAIN` pointe réellement vers ce VPS en DNS.
- [ ] `PUBLIC_VIDEO_BASE_URL` pointe vers une origine HTTPS réellement
      joignable depuis l'internet public (testée avec un client externe, pas
      seulement depuis le VPS lui-même) avant d'activer `SOCIAL_PUBLISHING_ENABLED`
      pour Instagram.

## Admin web

- [ ] `ADMIN_PASSWORD_HASH` généré via
      `npm run hash-password --workspace=@fako/web`, jamais une valeur de
      développement.
- [ ] `NODE_ENV=production` effectivement positionné pour `web` (active les
      cookies sécurisés — vérifié dans `apps/web/src/config.ts`).
- [ ] En-têtes de sécurité (CSP, X-Frame-Options, nosniff) vérifiés présents
      sur une vraie réponse après déploiement (`curl -I` sur `/login`).

## Supervision

- [ ] `fako-monitor.timer` actif ; premier passage manuel
      (`infrastructure/docker/monitor.sh`) exécuté et lu après déploiement.
- [ ] `LOG_LEVEL` déployé à `info` (pas `debug`, qui pourrait être plus
      verbeux en production) sauf investigation ponctuelle.
- [ ] Procédure de redémarrage testée réellement sur le VPS (`docker kill` un
      conteneur puis vérifier qu'il redémarre seul — comportement non garanti
      sur toutes les plateformes Docker, voir README section Supervision).

## Avant toute publication sociale réelle

- [ ] `SOCIAL_MOCK_MODE=false` et `SOCIAL_PUBLISHING_ENABLED=true` ne sont
      activés qu'après un test de bout en bout réussi en mode mock sur cette
      installation précise.
- [ ] Les apps TikTok/Meta ont passé leur propre processus d'audit/App Review
      (voir `docs/social-connectors.md`) — sinon la publication reste
      restreinte (privée uniquement pour TikTok, refusée pour Instagram/
      Facebook sans Advanced Access), indépendamment de la configuration ici.
- [ ] `*_APP_AUDITED` reflète l'état réel de chaque audit plateforme — jamais
      mis à `true` par anticipation.
