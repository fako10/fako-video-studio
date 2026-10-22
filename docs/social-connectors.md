# Connecteurs réseaux sociaux — TikTok, Instagram, Facebook (Mission 13)

Cette mission prépare la connexion OAuth aux comptes TikTok, Instagram et à la Page Facebook
RijPermis, le stockage sécurisé des jetons, et un diagnostic précis des capacités de publication.
**Aucune vidéo n'est publiée par ce travail** — la publication réelle est la mission 14.

## Audit préalable

- `packages/publishing` et `packages/shared` étaient vides : aucun connecteur social préexistant,
  rien à préserver.
- L'interface mission 12 (`apps/web`) n'avait pas de page Paramètres au moment de cette mission —
  conformément à la consigne, le backend a été construit seul. **Mise à jour** : la page
  Paramètres → Réseaux sociaux a depuis été construite dans `apps/web` (finalisation mission 12,
  voir `docs/rijpermis-admin.md`) ; la section [Intégration frontend](#intégration-frontend) ci-dessous
  décrit ce qui a été livré.
- `@fako/video-jobs` exposait déjà `isPublicationBlocked`/`PublicationCheck` (vérification de
  traçabilité RijPermis, mission 7) et `@fako/quiz-pipeline` exposait `verifyQuizVideoBeforePublication`
  (mission 10) — ces points d'intégration ont été **réutilisés**, pas réimplémentés : voir
  `packages/publishing/src/readiness.ts`.

## Architecture

```
Navigateur admin ──(1. redirige vers la plateforme)──> TikTok / Meta
                                                            │
                                                  (2. redirige avec code+state)
                                                            ▼
                                   apps/web (BFF à session — construit, finalisation mission 12)
                                                            │
                                            (3. appel serveur-à-serveur, Bearer token)
                                                            ▼
                                   apps/api  src/routes/social-accounts.ts
                                                            │
                                           @fako/publishing (connecteurs, chiffrement, readiness)
                                                            │
                                                     PostgreSQL (SocialAccount, SocialOAuthState)
```

`apps/api` ne reçoit jamais directement la redirection du navigateur : il expose des endpoints Bearer
(même garde `timingSafeEqual` que `quiz-videos.ts`, token `QUIZ_VIDEO_API_TOKEN` réutilisé — "même
frontière de confiance" déjà établie pour les routes scheduler) pensés pour être appelés par le futur
`apps/web`, exactement comme celui-ci proxy déjà `/quiz-videos/:id/preview` sans jamais exposer le
token au navigateur.

**"Connexion réussie ≠ autorisation de publier"** (mission 13 section 12) est un choix de modélisation
explicite : `SocialAccount.status` (`DISCONNECTED`/`CONNECTING`/`CONNECTED`/`EXPIRED`/
`INSUFFICIENT_PERMISSIONS`/`ERROR`) ne contient pas de valeur "publication non autorisée" — c'est un
diagnostic calculé à la demande par `GET /social-accounts/:id/capabilities`, jamais persisté, pour
rester correct sans migration si les exigences d'une plateforme changent.

## Tableau des scopes exacts par plateforme

| Plateforme | Parcours retenu | Scope de base | Scope de publication | PKCE |
|---|---|---|---|---|
| TikTok | Login Kit v2 OAuth | `user.info.basic` | `video.publish` (direct) / `video.upload` (brouillon seul) | Requis pour desktop/mobile, pas pour un flux web confidentiel (supporté si fourni) |
| Instagram | **Instagram API with Instagram Login** (choix validé — pas de Page Facebook requise) | `instagram_business_basic` | `instagram_business_content_publish` | Non documenté chez Meta, non utilisé |
| Facebook Pages | Facebook Login | `pages_show_list`, `pages_read_engagement` | `pages_manage_posts` | Non documenté chez Meta, non utilisé |

Scopes renommés par Meta le 27/01/2025 : le parcours *Instagram Login* utilise désormais
`instagram_business_*` ; l'ancien `instagram_basic`/`instagram_content_publish` appartient au
parcours *Facebook Login* et n'est **pas interchangeable** — notre adaptateur Instagram utilise
exclusivement les noms `instagram_business_*`.

## Statuts de connexion vs diagnostic de capacité

| Statut UI (mission 13 §9) | Origine |
|---|---|
| Non connecté | `status = DISCONNECTED` |
| Connexion en cours | `status = CONNECTING` (réservé, non encore émis par le flux actuel — à utiliser si un futur parcours asynchrone l'exige) |
| Connecté | `status = CONNECTED` (scope de base **et** scope de publication accordés) |
| Permissions insuffisantes | `status = INSUFFICIENT_PERMISSIONS` (scope de base ou de publication manquant à l'OAuth) |
| Autorisation expirée | `status = EXPIRED` (à faire passer par un futur job de vérification périodique, hors mission 13) |
| Erreur de connexion | `status = ERROR` (échec d'échange de code, best effort) |
| **Publication non autorisée** | **Jamais un statut stocké** — calculé par `getCapabilities()` : `canPublishDirectly = false` alors même que `status = CONNECTED`, p. ex. app TikTok non auditée (restriction imposée par la plateforme, indépendante du scope accordé) |

## Tableau des fonctionnalités réellement disponibles aujourd'hui

**Mise à jour mission 15** : le blocage d'infrastructure qui empêchait toute
publication Instagram (absence d'URL publique pour `video_url`) est résolu —
voir le mécanisme d'URL signée temporaire (`docs/social-publishing.md`,
section 4). Le seul blocage restant pour chaque plateforme est désormais côté
autorisation de la plateforme elle-même (App Review/Advanced Access Meta,
audit d'app TikTok), jamais côté code de ce dépôt.

| Plateforme | OAuth testable localement (mock) | OAuth réel possible | Publication directe possible |
|---|---|---|---|
| TikTok | ✅ (`MockSocialConnector`) | ❌ tant que `TIKTOK_CLIENT_KEY/SECRET` ne sont pas configurés | ❌ — même avec `video.publish`, toute app non auditée est restreinte par TikTok à des posts **privés uniquement** (blocage TikTok, pas d'infrastructure manquante côté code) |
| Instagram | ✅ | ❌ tant que `INSTAGRAM_APP_ID/SECRET` ne sont pas configurés | ❌ — nécessite Advanced Access (App Review + Business Verification Meta). L'URL publique requise par `video_url` est désormais fournie par ce dépôt (mission 15 section 4) ; il ne reste qu'à déployer avec `PUBLIC_VIDEO_BASE_URL` configurée et à obtenir l'Advanced Access |
| Facebook Pages | ✅ | ❌ tant que `FACEBOOK_APP_ID/SECRET` ne sont pas configurés | ❌ — `pages_manage_posts` nécessite Advanced Access (blocage Meta, pas d'infrastructure manquante côté code) |

`GET /social/platforms` reflète ceci en direct via `isConfigured()` par plateforme — jamais de bouton
de connexion présenté comme fonctionnel sans ces identifiants.

## Actions à réaliser sur les portails développeurs (hors code)

### TikTok for Developers
1. Créer un compte développeur et une app sur developers.tiktok.com.
2. Ajouter les produits **Login Kit** et **Content Posting API**.
3. Configurer les URI de redirection (HTTPS, statique, sans query/fragment, max 10) ; vérifier le
   domaine de publication si `PULL_FROM_URL` est utilisé un jour.
4. Activer les scopes `user.info.basic`, `video.publish`, `video.upload`.
5. Tester intégralement le parcours en **mode Sandbox** (jusqu'à 10 comptes test).
6. Soumettre l'app à l'audit TikTok (démo login→post→statut) avant toute publication non privée.

### Instagram (Meta)
1. Créer une app Meta ; choisir le produit **Instagram API with Instagram Login**.
2. S'assurer que les comptes RijPermis FR/NL sont en type **Business ou Creator** (jamais personnel).
3. Déclarer les URI de redirection exactes dans le tableau de bord de l'app.
4. Ajouter les scopes `instagram_business_basic`, `instagram_business_content_publish`.
5. Compléter la **Vérification d'entreprise** Meta.
6. Soumettre à l'**App Review** (description du cas d'usage, capture de l'intégration, politique de
   confidentialité).
7. En attendant l'Advanced Access, tester uniquement avec des comptes ayant un rôle dans le Business
   Manager/l'app elle-même (Standard Access).

### Facebook Pages
1. Dans la même app Meta, configurer Facebook Login et le cas d'usage de gestion de Page.
2. Déclarer les URI de redirection.
3. Ajouter `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`.
4. Compléter la Vérification d'entreprise (partagée avec Instagram).
5. Soumettre à l'App Review pour `pages_read_engagement`/`pages_manage_posts`.
6. En attendant l'Advanced Access, tester uniquement sur des Pages où le compte développeur a déjà
   un rôle.

### Points explicitement non vérifiables (recherche officielle, octobre 2026)
Plusieurs pages de référence Meta (specs Reels exactes, limite de publication par 24h, nommage
`pages_manage_metadata` vs `pages_read_engagement`) n'ont pas pu être confirmées verbatim sur une
page officielle lors de la recherche (404 ou chiffres incohérents selon les pages Meta elles-mêmes).
Ces points sont marqués `confidence: 'unverified'` dans `@fako/publishing/media.ts` et ne bloquent
jamais un envoi — à reconfirmer en conditions réelles (Graph API Explorer) avant la mission 14.

## Variables d'environnement (`apps/api/.env.example`)

```dotenv
SOCIAL_ACCOUNTS_ENABLED=false        # opt-in, comme QUIZ_VIDEO_ENABLED
SOCIAL_MOCK_MODE=false               # mocks en mémoire, zéro appel réseau ; refusé si NODE_ENV=production
SOCIAL_TOKEN_ENCRYPTION_KEY=         # 64 hex (32 octets), requis seulement si enabled=true
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
```

`QUIZ_VIDEO_API_TOKEN` est réutilisé comme Bearer token de ces nouvelles routes (même frontière de
confiance que les routes scheduler/quiz-videos).

## Contrat d'endpoints (pour la future page Paramètres → Réseaux sociaux)

Tous protégés par `Authorization: Bearer <QUIZ_VIDEO_API_TOKEN>`, désactivés tant que
`SOCIAL_ACCOUNTS_ENABLED=false`.

| Méthode | Route | Usage |
|---|---|---|
| GET | `/social/platforms` | `{ platforms: [{ platform, configured }] }` |
| GET | `/projects/:id/social-accounts` | `{ socialAccounts: [...] }` (jamais de ciphertext) |
| POST | `/projects/:id/social-accounts/:platform/oauth/start` | body `{ redirectUri }` → `{ authorizationUrl, state, expiresAt }` |
| POST | `/projects/:id/social-accounts/:platform/oauth/callback` | body `{ code, state }` → `SocialAccount` créé/mis à jour |
| GET | `/social-accounts/:id` | infos d'un compte |
| GET | `/social-accounts/:id/capabilities` | diagnostic complet (section 12) |
| PATCH | `/social-accounts/:id` | body `{ languages: ('fr'\|'nl')[] }` |
| POST | `/social-accounts/:id/disconnect` | déconnexion (best-effort côté plateforme, toujours effective localement) |

### Intégration frontend

Livrée (finalisation mission 12, voir `docs/rijpermis-admin.md`) : `apps/web/src/routes/admin.ts`
ajoute `GET /admin/settings/social`, `/:platform/connect`, `/:platform/mock-consent` (GET/POST),
`/:platform/callback`, `/:id/disconnect`, `/:id/languages` — exactement selon le contrat ci-dessus,
`redirectUri` construit depuis `ADMIN_PUBLIC_BASE_URL` (pas l'en-tête `Host`), aucun jeton de
plateforme transmis au navigateur. En production, l'URI de redirection enregistrée sur les portails
développeurs doit pointer vers `{ADMIN_PUBLIC_BASE_URL}/admin/settings/social/:platform/callback`.

Pour tester sans identifiants développeur réels : `apps/api` avec `SOCIAL_MOCK_MODE=true` renvoie
une URL d'autorisation `https://mock.invalid/...` ; `apps/web` la détecte et affiche un écran de
consentement simulé local au lieu de rediriger vers une URL externe invalide — tout le parcours
(connecter, modifier les langues, déconnecter) est ainsi exerçable dans un vrai navigateur.

## Limites et prérequis pour la mission 14

- Aucun des trois adaptateurs réels n'a été exercé contre une vraie API (aucun identifiant
  développeur configuré) — seuls les mocks sont testés. Le premier test réel nécessite les actions
  listées ci-dessus.
- `validatePublicationReadiness` (`@fako/publishing/readiness.ts`) réutilise le dernier
  `checkStatus`/`checkedAt` connu du `QuizVideo` ; la mission 14 doit appeler
  `verifyQuizVideoBeforePublication` (déjà existant) **juste avant** tout appel de publication réel,
  pas seulement se fier à readiness.
- Un compte `CONNECTED` avec le scope de publication accordé n'est pas forcément publiable : TikTok
  restreint toute app non auditée au posting privé, et Instagram/Facebook nécessitent l'Advanced
  Access Meta — `getCapabilities().notes` porte ces avertissements.
- Les specs média Reels non confirmées officiellement ne sont que des avertissements
  (`confidence: 'unverified'`) : la mission 14 doit les revérifier en direct avant un envoi réel.
- `SocialAccount.status = EXPIRED` n'est émis par aucun flux actuel (pas de job de vérification
  périodique des tokens dans cette mission) — à construire si la mission 14 en a besoin.

## Rapport — fichiers modifiés et résultats des tests

**Nouveau package** `packages/publishing` (`@fako/publishing`) : `src/{types,crypto,state,connector,
media,readiness,mocks,index}.ts`, `src/adapters/{tiktok,instagram,facebook}.ts`,
`test/{crypto,state,readiness,mocks}.test.ts`.

**Modifiés/ajoutés dans `apps/api`** : `prisma/schema.prisma` (+ modèles `SocialAccount`,
`SocialOAuthState`, enums), migration `prisma/migrations/20261020115104_add_social_accounts/`,
`src/routes/social-accounts.ts` (nouveau), `src/app.ts` (câblage des connecteurs + route),
`package.json` (dépendance `@fako/publishing`), `.env.example` (nouvelles variables),
`test/social-accounts.test.ts` (nouveau, unitaire), `test/integration/social-accounts.test.ts`
(nouveau, Postgres réel + mocks).

**Racine** : `package.json` (chaîne de build met à jour `@fako/publishing`).

**Tests** : `npm test` (racine, tous workspaces) → 239 tests, 0 échec, aucune régression mission
10–12. Les 7 nouveaux tests d'intégration sociaux (`test/integration/social-accounts.test.ts`) sont
tous verts isolément contre Postgres local. En relançant *l'intégralité* de
`test/integration/*.test.ts` dans cet environnement de développement partagé, 3 tests préexistants
et sans rapport échouent : ce sont des garde-fous d'isolation déjà présents dans le code (pas
introduits par cette mission) qui détectent que `apps/api/.env` local a `QUIZ_VIDEO_ENABLED=true`
avec un vrai token, et que Postgres/Redis locaux ne sont pas des instances de test isolées
(`seed.test.ts` : "Run this test on an isolated test database" ; `video-jobs.test.ts` : "REDIS_URL
must target an isolated test Redis" ; `quiz-videos.test.ts` : attend 503 mais obtient 401 à cause du
token déjà configuré). Vérifié que ces trois tests ne touchent ni `social-accounts.ts`, ni le schéma
Prisma ajouté, ni `app.ts` au-delà de l'enregistrement de la nouvelle route — ce ne sont pas des
régressions de la mission 13. Aucun appel réseau réel à TikTok/Meta n'a été effectué dans les tests —
chaque test injecte `mockConnectors()` ; les adaptateurs réels restent inertes tant que leurs
identifiants développeur ne sont pas configurés (vérifié par un test dédié).
