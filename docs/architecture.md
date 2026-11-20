# Architecture de l'usine à vidéos

Fako Video Studio produit automatiquement des vidéos pour plusieurs projets, chacun avec ses
propres types de vidéos, son planning, sa voix et ses réseaux sociaux. Aucune vidéo n'est publiée
sans validation humaine.

## Modèle

| Notion | Table | Rôle |
| --- | --- | --- |
| Marque | `Brand` | Identité commune : nom, site, logo (`assets/brands/<slug>/…`), palette de couleurs |
| Projet | `Project` | Une chaîne de diffusion : marque, langue unique, fuseau horaire, source de contenu, voix, comptes sociaux |
| Type de vidéo | code (`packages/video-types`) | Module qui sait préparer, rendre et légender un genre de vidéo |
| Programme | `Program` | Un type de vidéo activé dans un projet : créneaux, jours, avance de génération, durée, réseaux, paramètres du type |
| Vidéo | `Video` | Une exécution : contenu choisi, MP4, statut de validation, publications |
| Créneau | `ScheduledSlot` | Réservation unique (programme, date, heure) qui garantit une seule vidéo par créneau |

## Cycle d'une vidéo

1. Le planificateur (`apps/scheduler`, `runProgramsTick`) parcourt chaque minute les programmes actifs.
   Chaque créneau devient « à générer » `leadDays` jours avant son heure de publication.
2. Il réserve le créneau, puis `requestVideo` demande au module du type de préparer le contenu
   et crée une ligne `Video` (statut `PENDING`).
3. Le worker (`apps/worker`) récupère la vidéo via la file `video-renders` (PostgreSQL, pg-boss),
   puis `generateVideo` délègue au module : narration ElevenLabs, rendu Remotion, stockage du MP4.
   La vidéo passe en `WAITING_APPROVAL`.
4. L'administrateur visionne la vidéo dans l'admin, puis la valide ou la rejette.
5. Une vidéo validée peut être programmée sur les réseaux du projet (moteur de publication existant).

## Ajouter un type de vidéo

1. Créer `packages/video-types/src/<id>/index.ts` qui exporte un objet `VideoTypeModule` :
   `id`, `label`, `paramsSchema` (schéma JSON des paramètres), `defaultParams`, `defaultDuration`,
   `requiresContentSource`, et les fonctions `prepare`, `render` et `caption`.
2. L'enregistrer dans `createDefaultRegistry()` (`packages/video-types/src/index.ts`).
3. Créer un programme de ce type dans un projet (API `POST /projects/:id/programs`, puis admin).

Le planificateur, le worker, la validation et la publication n'ont rien à changer.

## Sources de contenu

`Project.contentSource` désigne la source utilisée par les types qui en ont besoin
(`requiresContentSource`). Les sources disponibles sont déclarées dans `contentSourcesByKey`
(`apps/scheduler/src/config.ts`) : `rijpermis` pour l'instant, `monpermisenpoche` à venir.

## API de configuration

Toutes protégées par le jeton administrateur `QUIZ_VIDEO_API_TOKEN`.

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/video-types` | Types de vidéos disponibles et schéma de leurs paramètres |
| GET, POST | `/brands` | Lister, créer une marque |
| GET, PATCH | `/brands/:id` | Lire, modifier une marque |
| GET, POST | `/projects/:id/programs` | Lister, créer un programme (paramètres validés par le type) |
| GET, PATCH | `/programs/:id` | Lire, modifier un programme (activation, créneaux, jours…) |
| GET | `/projects/:id/scheduler/days/:date` | Rapport de production d'une journée |

## Configuration initiale

`npm run db:seed --workspace=@fako/api` crée les marques RijPermis et MonPermisEnPoche, les projets
RijPermis FR, RijPermis NL et MonPermisEnPoche FR, et un programme « Quiz du jour » désactivé par
projet. Il ne modifie jamais une configuration existante.
