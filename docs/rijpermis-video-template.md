# Template vidéo « Quiz du jour RijPermis » (Mission 8)

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

## Architecture

Deux nouveaux packages, chacun avec un rôle précis :

- `packages/video-templates` — le contenu vidéo : le contrat de données (`QuizVideoProps`),
  la fonction qui le construit à partir d'une question RijPermis (`buildQuizVideoProps`), les
  traductions FR/NL de l'habillage, et la composition Remotion `QuizDuJour`.
- `packages/media-engine` — le rendu : `renderQuizVideo()` (bundle + rendu Remotion vers un MP4
  local) et `stageImage()` (copie d'une image déjà téléchargée par la mission 7 dans le dossier
  `public/` du projet Remotion).

Cette séparation permet de tester tout le contenu (validation, FR/NL, durées, présence
d'explication/image) sans jamais démarrer de navigateur, et de ne réserver le rendu réel qu'aux
tests explicitement activés.

## De la question RijPermis à la vidéo

`buildQuizVideoProps(question, options)` est le seul endroit où une question RijPermis devient du
contenu vidéo :

- Refuse toute question dont `validationStatus !== 'APPROVED'` ou `answerType !== 'SINGLE_CHOICE'`.
  Il s'agit d'un contrôle technique, pas d'une nouvelle validation pédagogique : `@fako/content-sources`
  (mission 7) garantit déjà, au niveau du schéma, qu'une question analysée avec succès est `APPROVED`
  (`validationStatus: { const: 'APPROVED' }`) ; ce second contrôle est une défense en profondeur,
  dans le même esprit que les vérifications déjà présentes dans `parseQuestion`.
- Conserve l'énoncé, les propositions et la réponse correcte mot pour mot ; ne suppose jamais un
  nombre fixe de propositions (2 à 50 acceptées).
- N'inclut une explication que si `explanation.status === 'APPROVED'` ; sinon `explanation: null`
  et la scène correspondante dure `0` seconde (absente de la vidéo). Aucune explication n'est
  jamais rédigée par ce code.
- Conserve `source.questionId`, `source.contentHash` et `source.category` tels quels pour la
  traçabilité déjà en place (mission 7, table `VideoScriptSource`).
- N'affiche une image que si elle a déjà été mise en scène localement (`imageFileName`, produit par
  `stageImage()` à partir d'un fichier déjà téléchargé et vérifié par la mission 7) ; jamais depuis
  une URL distante. Une question sans image reste utilisable.

`validateQuizVideoProps` (Ajv) revalide l'objet final : identifiants d'options uniques, réponse
correcte existante, cohérence durée/texte de l'explication, `contentHash` au format `sha256:...`.

## Statut technique APPROVED et questions existantes

Le filtre `validationStatus: APPROVED` fonctionne déjà correctement côté Fako : une question qui
n'a pas ce statut n'est même pas convertie en objet exploitable, elle est rejetée dès
`parseQuestion` (voir `packages/content-sources/test/schema.test.ts`,
« rejects: validationStatus not APPROVED »). Si des questions RijPermis déjà vérifiées
pédagogiquement n'ont pas encore ce statut technique, **la correction se fait côté RijPermis**, pas
ici : voir la proposition dans le rapport de mission pour une procédure d'approbation technique en
lot, à valider avant toute implémentation.

## Composition Remotion

`QuizDuJour` (`packages/video-templates/src/QuizDuJour/`) enchaîne six séquences via `<Series>`,
chacune dimensionnée en frames à partir de `props.durations` et `props.fps` :

1. **Intro** — marque et accroche traduite.
2. **Question** — catégorie, image éventuelle, énoncé, propositions (A/B/C ou plus).
3. **Compte à rebours** — anneau de progression et chiffre, calculés à partir de la frame courante.
4. **Révélation** — reprise de la question avec la bonne réponse mise en évidence.
5. **Explication** — uniquement si `props.explanation` est non nul.
6. **Outro** — invitation à s'entraîner sur le site configuré (`rijpermis.be` par défaut).

Palette et typographie sont définies dans `QuizDuJour/theme.ts`, volontairement différentes de
celles des rapports de mission. Seules des polices système sont utilisées (aucun appel réseau vers
une CDN de polices), pour que le rendu reste **entièrement reproductible hors ligne**. Les imports
relatifs utilisent l'extension `.js` comme partout ailleurs dans ce monorepo ; `renderQuizVideo()`
et `remotion.config.ts` configurent webpack (`resolve.extensionAlias`) pour résoudre ces imports
vers les fichiers `.ts`/`.tsx` réels.

`calculateMetadata` recalcule `durationInFrames`/`fps`/`width`/`height` à partir des props à chaque
rendu : chaque question peut avoir une durée différente (avec ou sans explication) sans toucher au
composant.

## Générer une vidéo de démonstration

```powershell
npm.cmd run build
npm.cmd run demo --workspace=@fako/media-engine
```

Utilise exclusivement `@fako/content-sources` en mode mock (questions fictives, une en français
sans image ni explication, une en néerlandais avec explication approuvée) : aucun appel réseau vers
RijPermis, OpenAI ou ElevenLabs. Produit :

- `storage/videos/quiz-du-jour-demo-fr.mp4` (17 s — pas d'explication)
- `storage/videos/quiz-du-jour-demo-nl.mp4` (21 s — avec explication)

Les deux ont été rendus et vérifiés pendant cette mission : 1080×1920, 30 i/s, H.264, lisibles.
Le premier rendu télécharge Chrome Headless Shell (~120 Mo, une seule fois, mis en cache par
Remotion) ; aucun appel payant n'est effectué.

## Paramètres

| Champ | Description | Défaut |
| --- | --- | --- |
| `brand.name` / `brand.website` | Marque et site affichés en intro/outro | `RijPermis` / `rijpermis.be` |
| `durations.*Seconds` | Durée de chaque scène, configurable indépendamment | intro 3, question 5, countdown 3, reveal 3, explanation 4 (0 si absente), outro 3 |
| `fps` / `width` / `height` | Format de rendu | 30 / 1080 / 1920 |
| `imageFileName` | Nom de fichier déjà présent dans `public/`, ou `null` | `null` |

`ElevenLabs` n'est pas appelé dans cette mission ; la composition et le pipeline de rendu
n'embarquent aucune piste audio pour l'instant (voir « reste à traiter »).

## Tests

```powershell
npm.cmd run build
npm.cmd test
# Rendu réel optionnel (télécharge Chrome Headless Shell au premier lancement) :
$env:MEDIA_ENGINE_RENDER_TESTS = 'true'
npm.cmd run test --workspace=@fako/media-engine
```

`packages/video-templates/test` (23 tests) couvre la construction des props, la validation stricte,
les questions à 3 et 4 propositions, les réponses incohérentes, l'absence d'explication ou d'image,
la cohérence des durées et la complétude des traductions FR/NL. `packages/media-engine/test`
couvre la mise en scène d'image et, lorsque `MEDIA_ENGINE_RENDER_TESTS=true`, un rendu MP4 réel
vérifié via `@remotion/renderer`'s `getVideoMetadata` (résolution, fps, codec, durée totale).
