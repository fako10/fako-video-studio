# Voix off et synchronisation audio/vidéo (Mission 9)

> **Note (refonte 2026)** : ce document décrit une mission antérieure. Depuis l'étape 1, Docker, Redis et BullMQ sont remplacés par PostgreSQL seul (file de tâches `@fako/jobs`, basée sur pg-boss). Depuis l'étape 2, les tables `QuizVideo`, `ScheduledQuizSlot` et `QuizVideoPublicLink` s'appellent `Video`, `ScheduledSlot` et `VideoPublicLink`, et la planification se fait par programme. Voir [architecture.md](architecture.md).

## Ce qui existait déjà et a été réutilisé

`@fako/ai-providers` (mission 5) contient déjà un fournisseur TTS complet et testé :
`ElevenLabsProvider`, `MockTTSProvider`, gestion des erreurs/quotas/délais, retries bornés (429
uniquement), aucune clé jamais journalisée. Cette mission **ne recrée pas** ce client : elle
l'utilise tel quel pour la narration du template « Quiz du jour » (mission 8), qui ne passe pas
par le pipeline `VideoScript`/`AudioAsset` existant (mission 5) — ce dernier reste intact et
n'est pas modifié.

Ajouté pour cette mission :

- `packages/ai-providers/src/cache.ts` — `CachingTTSProvider` / `LocalAudioCacheStore` : décore
  n'importe quel `TTSProvider` (ElevenLabs ou mock) avec un cache local indexé par
  `sha256(texte + langue + voix + modèle + réglages)`. Un texte, une voix et des réglages
  identiques ne déclenchent jamais un second appel payant.
- `packages/video-templates/src/narration.ts` — `buildQuizNarration()` : texte de narration
  déterministe pour les six scènes, en français ou néerlandais selon `quiz.language`. L'énoncé,
  les propositions et l'explication voyagent mot pour mot depuis les props déjà validées
  (mission 8) ; seules les phrases fixes autour (intro, compte à rebours, invitation finale)
  sont rédigées ici. Aucune réponse ni explication n'est inventée.
- `packages/video-templates/src/schema.ts` — `QuizVideoProps.narration` (nullable),
  `.backgroundMusic` (nullable, désactivée par défaut) et `.interSceneSilenceSeconds` ;
  `resolveSceneDurations()` calcule les durées réellement rendues. **Sans narration, le résultat
  est strictement identique aux props d'entrée** : aucun rendu de la mission 8 n'est affecté.
- `packages/media-engine/src/{stageAudio,narrate}.ts` — synthèse de chaque scène, mesure de la
  durée réelle (`music-metadata`, déjà utilisé par la mission 5), mise en scène dans `public/`.
- Composition Remotion : lecture audio par scène (volume configurable), sous-titres synchronisés,
  piste de musique de fond optionnelle (bouclée sur toute la vidéo).

## Synchronisation

`resolveSceneDurations(quiz)` ne fait jamais rétrécir une scène sous sa durée configurée — en
particulier le compte à rebours reste toujours entièrement visible. Si la narration d'une scène
dépasse sa durée configurée, la scène s'étend pour l'accueillir en entier (plus une marge de
0,3 s) : aucune phrase n'est coupée. Un court silence (`interSceneSilenceSeconds`, 0,35 s par
défaut) est inséré après chaque scène sauf la dernière. Sans narration, cette fonction renvoie
les durées d'entrée telles quelles.

## Sous-titres

Synchronisation par scène/phrase, pas par mot : la durée totale mesurée de chaque clip est
répartie entre ses phrases au prorata de leur longueur en caractères. C'est une approximation
assumée, documentée ici, et non un alignement mot par mot inventé — conformément à la consigne de
ne jamais fabriquer de timestamp précis. La scène d'explication affiche déjà le texte intégral à
l'écran ; elle n'ajoute donc pas de sous-titre redondant, seulement l'audio.

## Musique de fond et volume

`backgroundMusic` est `null` par défaut (désactivée). Si fourni, `{ fileName, volume }` référence
un fichier déjà mis en scène dans `public/` — jamais une URL distante, et seulement si les droits
d'utilisation ont été vérifiés au préalable (aucun morceau n'est fourni ou présumé par cette
mission). Le volume de la narration est réglable indépendamment via `narration.volume` (0 à 1).

## Configuration

Mêmes variables que la mission 5 (`docs/audio-generation.md`), inchangées : `TTS_PROVIDER`,
`ELEVENLABS_API_KEY`, `AUDIO_STORAGE_ROOT`. Cette mission n'ajoute aucune nouvelle route HTTP ni
tâche de file d'attente — c'est un moteur appelable directement (comme le rendu vidéo de la
mission 8), pas encore branché à un worker ou un scheduler.

## Commandes

```powershell
npm.cmd run build
npm.cmd run demo:narrated --workspace=@fako/media-engine
```

Utilise exclusivement `MockTTSProvider` (voix factices) et des questions mock de
`@fako/content-sources` : aucun appel à ElevenLabs ou OpenAI. Produit :

- `storage/videos/quiz-du-jour-narrated-fr.mp4` — 18,4 s, piste audio AAC, 1080×1920, 30 i/s
- `storage/videos/quiz-du-jour-narrated-nl.mp4` — 22,8 s (explication incluse), même format

Les deux ont été rendus et vérifiés pendant cette mission via `@remotion/renderer`'s
`getVideoMetadata` : `audioCodec: "aac"` confirme qu'une vraie piste audio est encodée, pas
seulement plaquée en silence. Le cache (`storage/audio-cache/`) est réutilisé automatiquement
entre deux exécutions : relancer la commande ne resynthétise rien de déjà présent dans le cache à
texte, voix et réglages identiques.

## Coût estimé d'une narration

Aucun tarif n'est codé en dur — ElevenLabs facture au caractère de texte envoyé, le prix exact
dépendant de votre plan. `ElevenLabsProvider.synthesize()` (mission 5) lit déjà l'en-tête
`character-cost` renvoyé par l'API dans `usage.characters` ; c'est la source fiable à agréger
pour suivre la consommation réelle, pas une estimation a priori.

Pour une idée d'ordre de grandeur avant tout appel réel, un « Quiz du jour » type (question
mock ci-dessus) représente environ :

| Scène | Caractères (FR) |
| --- | --- |
| Intro | ~30 |
| Question + propositions | ~90–160 selon la longueur de la question |
| Compte à rebours | ~45 |
| Révélation | ~40–80 |
| Explication (si approuvée) | 0–300 selon la source |
| Outro | ~40 |
| **Total par vidéo** | **~250 à 650 caractères** |

Avec le cache actif, seule la **première** vidéo d'une question donnée consomme des caractères
facturables pour une voix/des réglages donnés ; toute régénération ultérieure (nouveau rendu,
nouvelle tentative) de la même question est servie depuis `storage/audio-cache/` sans appel
ElevenLabs. Pour obtenir un coût en devise, multipliez le nombre réel de caractères consommés
(`usage.characters`, agrégé sur vos appels) par le tarif par caractère de votre plan ElevenLabs
actuel — à vérifier sur votre tableau de bord fournisseur, jamais supposé ici.

**Aucun appel réel à ElevenLabs n'a été effectué pendant cette mission.**

## Tests

```powershell
npm.cmd run build
npm.cmd test
# Rendu narré réel optionnel (télécharge Chrome Headless Shell au premier lancement) :
$env:MEDIA_ENGINE_RENDER_TESTS = 'true'
npm.cmd run test --workspace=@fako/media-engine
```

- `packages/ai-providers/test/cache.test.ts` — réutilisation du cache, invalidation sur texte/voix/
  modèle/réglages différents, persistance entre instances.
- `packages/video-templates/test/narration.test.ts` — FR/NL, verbatim, pas d'explication inventée,
  nombre du compte à rebours cohérent avec la durée configurée.
- `packages/video-templates/test/sync.test.ts` — extension sans découpe, compte à rebours jamais
  raccourci, silence inter-scènes, comportement strictement inchangé sans narration.
- `packages/media-engine/test/narrate.test.ts` — synthèse des six scènes, absence d'explication,
  FR/NL, configuration de voix manquante, intégration avec le cache.
- `packages/media-engine/test/render.test.ts` — rendu MP4 réel (muet, puis narré), optionnel.

Aucun test n'appelle ElevenLabs, OpenAI ou RijPermis réellement ; tous utilisent `MockTTSProvider`,
`MockContentSourceProvider` ou des fournisseurs de test locaux.
