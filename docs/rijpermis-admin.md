# Interface d'administration (Mission 12)

## Architecture

`apps/web` était absent — confirmé avant toute création. C'est une application **Fastify
autonome** (même framework que `apps/api`, pas de nouveau framework introduit), entièrement rendue
côté serveur (templates en littéraux de gabarit TypeScript, échappement HTML systématique) :
aucun React/Angular/SPA, aucune étape de build front-end. Elle ne touche **jamais** PostgreSQL ni
Redis directement ; c'est un BFF (*backend-for-frontend*) qui appelle l'API existante (missions 10
et 11) en HTTP, côté serveur, avec `QUIZ_VIDEO_API_TOKEN` — qui n'est **jamais** envoyé au
navigateur, jamais présent dans le HTML, le JavaScript livré ou une URL.

```
Navigateur ──(session cookie chiffrée)──> apps/web ──(Authorization: Bearer, serveur à serveur)──> apps/api
```

Seul point d'écriture : `reviewQuizVideo` (mission 10), réutilisé tel quel. Aucun second mécanisme
de validation n'a été créé ; aucune méthode « publish » n'existe sur le client API de l'interface —
vérifié par un test dédié qui inspecte les méthodes réellement exposées.

## Endpoint API complété

Un seul manquait : `GET /projects/:id/quiz-videos?language=&status=&date=&limit=&offset=`, ajouté
dans `apps/api/src/routes/quiz-videos.ts` en suivant exactement les conventions déjà en place
(`video-jobs.ts`). Tout le reste (tableau de bord quotidien, détail, prévisualisation, validation)
réutilise les routes des missions 10 et 11 sans modification.

## Sécurité

- **Authentification** : un compte administrateur unique (`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH`,
  scrypt + comparaison à temps constant — aucune nouvelle dépendance de hachage).
- **Session côté serveur** : `@fastify/secure-session`, cookie chiffré `httpOnly`, `sameSite=lax`,
  `secure` en production, expiration à 12 h. C'est une session **sans état serveur** (tout l'état
  est chiffré dans le cookie) : la déconnexion efface le cookie côté navigateur (vérifié par test),
  mais ne peut pas invalider rétroactivement une copie volée de ce cookie avant son expiration —
  limite assumée et documentée, raisonnable pour un outil d'administration interne à faible nombre
  d'utilisateurs.
- **Anti-force-brute** : limiteur de tentatives en mémoire (5 essais / 15 min par IP).
- **Jamais de jeton côté navigateur** : vérifié par deux tests — aucune page rendue ne contient le
  jeton, et le client HTTP réel ne l'envoie que comme en-tête, jamais dans une URL ou un corps.
- **Aucun accès anonyme** : toutes les routes `/admin/*`, y compris la prévisualisation vidéo,
  exigent une session valide ; sinon redirection vers `/login`.
- **CSRF** : `sameSite=lax` suffit pour un outil interne à formulaires classiques ; un jeton CSRF
  dédié serait l'amélioration suivante si l'exposition publique augmentait.

## Pages

| Route | Contenu |
| --- | --- |
| `/login` | Formulaire de connexion |
| `/admin` | Tableau de bord du jour : prévues, créées, générées, en attente, approuvées, rejetées, échecs, répartition FR/NL, créneaux 09h/16h/21h, questions utilisées |
| `/admin/quiz-videos` | Liste filtrable (langue, statut, date) et paginée |
| `/admin/quiz-videos/:id` | Lecteur vidéo 9:16, traçabilité RijPermis, informations de rendu, actions |
| `/admin/quiz-videos/:id/confirm?decision=` | Étape de confirmation explicite, sans JavaScript requis |
| `/admin/quiz-videos/:id/preview` | Flux MP4 relayé depuis l'API avec support `Range` (206, recherche dans le lecteur), jamais exposé directement |
| `/admin/settings/social` | Paramètres → Réseaux sociaux : TikTok, Instagram, Facebook (mission 13 finalisée) |
| `/admin/settings/social/:platform/connect` | Démarre l'OAuth serveur à serveur, redirige le navigateur vers la plateforme (ou l'écran simulé en `SOCIAL_MOCK_MODE`) |
| `/admin/settings/social/:platform/mock-consent` | Écran de consentement simulé, actif uniquement quand l'API tourne en `SOCIAL_MOCK_MODE` |
| `/admin/settings/social/:platform/callback` | Termine l'échange OAuth, jamais appelé directement par une vraie plateforme sans passer par cette page |
| `/admin/settings/social/:id/disconnect`, `/languages` | Déconnexion et modification des langues FR/NL d'un compte |
| `/admin/publications` | Publications programmées/en cours/publiées/échouées/bloquées/d'issue inconnue (mission 14), filtrable par statut et plateforme |
| `/admin/publications/new` | Programmer une publication : vidéo **COMPLETED uniquement**, compte **CONNECTED uniquement**, légende, hashtags, date (Europe/Brussels) |
| `/admin/publications/:id` | Détail, historique des tentatives, lien distant, actions |
| `/admin/publications/:id/schedule`, `/cancel`, `/retry` | Modifier la programmation, annuler (si non commencée), relancer (uniquement depuis bloquée/échec confirmé) |

Voir `docs/social-publishing.md` pour l'architecture complète du moteur de publication (mission 14) :
cycle de vie des statuts, vérification en direct avant chaque envoi, adaptateurs TikTok/Instagram/
Facebook, scheduler et worker dédiés, mode simulation.

L'approbation et le rejet exigent systématiquement cette page de confirmation intermédiaire avant
l'appel réel à `POST /quiz-videos/:id/review` — aucune action sensible n'est déclenchée par un
simple clic. **Approuver une vidéo ne la publie jamais** : elle passe uniquement de
`WAITING_APPROVAL` à `COMPLETED` côté API. Les connecteurs réseaux sociaux (mission 13) ne publient
jamais non plus — connecter un compte ne fait qu'enregistrer ses jetons chiffrés et ses permissions ;
aucun appel de publication n'existe dans ce dépôt.

### Paramètres → Réseaux sociaux

Réutilise telles quelles les 8 routes sociales d'`apps/api` (mission 13) — aucun nouvel endpoint.
Le vrai redirect OAuth (navigateur → TikTok/Meta) est géré ici, dans le BFF à session, exactement
comme la prévisualisation vidéo : `oauth/start` et `oauth/callback` sont appelés serveur à serveur,
le jeton d'accès de la plateforme n'est jamais vu par le navigateur ni par cette couche au-delà de
l'instant de l'appel (l'API renvoie toujours un `SocialAccount` assaini, sans `*Ciphertext`).

Quand `apps/api` tourne avec `SOCIAL_MOCK_MODE=true`, le connecteur TikTok/Instagram/Facebook mock
renvoie une URL d'autorisation `https://mock.invalid/...` qu'un vrai navigateur ne peut pas
résoudre ; `apps/web` le détecte (hôte `mock.invalid`) et redirige à la place vers un écran de
consentement simulé local (`mock-consent`), qui boucle vers le même callback qu'une vraie plateforme
utiliserait. Permet de piloter tout le parcours — connexion, langues, déconnexion — depuis un vrai
navigateur, sans aucun identifiant développeur ni appel réseau réel.

« Connexion réussie ≠ autorisation de publier » (mission 13 §12) reste visible ici : un compte au
statut *Connecté* peut encore afficher « Publication non autorisée » si `canPublishDirectly` est
faux (ex. app TikTok non auditée).

## Configuration

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=
ADMIN_SESSION_KEY=
ADMIN_API_BASE_URL=http://127.0.0.1:3000
QUIZ_VIDEO_API_TOKEN=
ADMIN_PROJECT_SLUG=rijpermis
ADMIN_PUBLIC_BASE_URL=http://127.0.0.1:3100
PORT=3100
```

`ADMIN_PUBLIC_BASE_URL` sert uniquement à construire l'URI de redirection OAuth exacte enregistrée
sur les portails TikTok/Meta — jamais déduite de l'en-tête `Host` (falsifiable), conformément à la
validation stricte d'URI de la mission 13. Côté `apps/api`, ajouter `SOCIAL_ACCOUNTS_ENABLED=true`,
`SOCIAL_MOCK_MODE=true` et `SOCIAL_TOKEN_ENCRYPTION_KEY=<64 hex>` pour piloter les connexions
sociales en mode mock (voir `docs/social-connectors.md`), en plus de `NODE_ENV=development`
ci-dessus (requis pour que l'URI de redirection `http://127.0.0.1:3100/...` soit acceptée).

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ADMIN_SESSION_KEY
npm.cmd run hash-password --workspace=@fako/web -- "votre phrase de passe"   # ADMIN_PASSWORD_HASH
```

## Démarrage local

```powershell
npm.cmd run build
docker compose up -d --wait postgres redis
npm.cmd run dev:api        # terminal 1
npm.cmd run dev:worker     # terminal 2 — démarre aussi le worker de publication (mission 14)
npm.cmd run dev:web        # terminal 3 — http://127.0.0.1:3100
```

Pour exercer le moteur de publication (mission 14) en plus du tableau de bord, ajouter un 4ᵉ
terminal (`SOCIAL_PUBLISHING_ENABLED=true` requis dans `apps/api/.env`, voir
`docs/social-publishing.md`) :

```powershell
npm.cmd run --workspace=@fako/scheduler dev:social-publications   # terminal 4
```

**Important (finalisation mission 12/13)** : `apps/api/.env` et `apps/web/.env` doivent définir
`NODE_ENV=development` (voir leurs `.env.example`). Sans cette valeur, `isValidRedirectUri`
(`apps/api/src/routes/social-accounts.ts`) rejette l'URI de redirection `http://127.0.0.1:3100/...`
utilisée en local avec l'erreur « Invalid redirect URI » — le parcours OAuth mock de la page
Paramètres → Réseaux sociaux ne démarre pas sans elle. C'était un trou dans le démarrage documenté,
corrigé dans cette finalisation ; `NODE_ENV` ne doit jamais valoir autre chose que `production` en
production.

Fonctionne sur ordinateur et smartphone (mise en page responsive, tableaux convertis en cartes sous
600 px de large) ; aucune modification du site public RijPermis.

## Tests

```powershell
npm.cmd run build
npm.cmd test
```

46 tests (`apps/web/test/*.test.ts`), tous avec un client API factice injecté (aucun appel réseau,
aucune base de données) : authentification et autorisations, anti-force-brute, session forgée,
déconnexion, tableau de bord (figures, navigation par date, erreurs API), liste et filtres,
pagination, prévisualisation sécurisée avec support `Range` (206/`Content-Range`, sans session,
fichier absent), confirmation explicite avant validation, approbation/rejet avec le réviseur tiré de
la session, erreurs API explicites, protection du jeton, absence de toute méthode de publication,
et le parcours complet Paramètres → Réseaux sociaux (connexion mock, refus, déconnexion, langues,
aucun jeton de plateforme rendu). Aucun appel réel à ElevenLabs, OpenAI, RijPermis, TikTok ou Meta.

## Tests d'intégration isolés (`apps/api`)

`test:integration` utilise désormais `.env.test`, pas `.env` — les données de développement réelles
(`fako`, Redis par défaut) ne sont **jamais** touchées par les tests. Configuration une fois pour
toutes, en PowerShell (Postgres/Redis déjà démarrés via `docker compose up -d --wait postgres redis`) :

```powershell
docker compose exec postgres psql -U fako -d fako -c "CREATE DATABASE fako_test;"
Copy-Item apps\api\.env.test.example apps\api\.env.test
# Éditer apps\api\.env.test : mettre le mot de passe Postgres local dans DATABASE_URL.
$env:DATABASE_URL = "postgresql://fako:<votre-mot-de-passe>@127.0.0.1:5433/fako_test?schema=public"
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Puis, à chaque exécution :

```powershell
npm.cmd run test:integration --workspace=@fako/api
```

`fako_test` reste une base Postgres dédiée sur le même conteneur (aucune nouvelle infrastructure),
avec Redis sur l'index logique 1 (`redis://127.0.0.1:6379/1`) plutôt que 0, pour ne jamais interférer
avec le worker/scheduler de développement.
