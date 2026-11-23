# AlcheMix II — Analyse de l'interface après la première passe

*Revue art-direction et ergonomie, vue Camelot, 23 novembre 2026*

## Cadrage

La capture analysée montre le Deck A (11B · 100.9 BPM, stems extraits) et le Deck B (6A · 84.5 BPM, avant extraction), en vue Camelot, avec l'Oracle fermé. Je n'ai pas pu vérifier les infobulles, le rack ID3, l'Oracle ouvert ni les états survolé et pressé.

## Verdict

L'interface progresse nettement : je la note **8/10** (7,5 avant). Les stems ont enfin une logique de couleur, AUTO-MIX ressemble à une vraie touche, et les informations clés restent visibles. Le bloc Stems reste le point faible : il est bien pensé mais mal exécuté, à **5/10**. Deux problèmes subsistent : le grand vide central et le tiroir qui ne ressemble toujours pas à un tiroir. Un défaut a aussi réapparu : l'alignement des deux platines.

## Points positifs

- **Couleurs des stems cohérentes** : tout est vert sur A et bleu sur B, la contradiction est corrigée.
- **« EXTRAIRE STEMS » est une vraie touche** : 36 px de haut, bordure bleue, icône, 7,9:1 de contraste. C'est le meilleur élément du bloc.
- **La façade Stems informe, tiroir fermé** : titre, modèle (`HTDEMUCS • LOCAL`), pastille `4 STEMS` et LED d'état.
- **BPM et clé visibles dans la façade Métadonnées**, aux couleurs du canal.
- **AUTO-MIX actif lisible** : 4,8:1, contre 1,7:1 avant, avec un vrai relief laiton.
- **Le bandeau d'alerte propose maintenant une action** (`VOIR LES PONTS (3)`).
- **La roue est très parlante** pour des clés éloignées (11B → 6A) : « Δ = 5 QUINTES », « Δ BPM −16.40 » et l'arc épais A→B.
- **Les deux panneaux Stems ont la même hauteur**, et l'en-tête est plus propre sans la pastille horloge.

## Points à améliorer

### Bloc Stems : les objets ne sont pas organisés correctement (P0)

- Les 4 touches ont des largeurs inégales (≈ 27 / 30 / 30 / 38 px), sont collées à gauche et laissent ≈ 54 px de vide à droite. Trois d'entre elles font moins de 32 px de large.
- Les libellés `VOIX`, `BATT`, `BASSE` et `INST` sont posés **sur la bordure du bas** des touches et en sont coupés. Les petits ergots du haut ressemblent à des bornes de pile.
- Sur A, les quatre touches sont identiques : impossible de savoir lesquelles sont actives.
- « STEMS PRÊTS » occupe 35 px comme une touche, mais c'est juste un statut (3,2:1, il a l'air désactivé).
- La rangée des préréglages n'a ni bordures ni états. ACAPELLA porte une icône de micro **barré** (qui veut dire « sans voix »), et `INST` apparaît deux fois.
- Le double cadre (émeraude puis laiton) porte le panneau à ≈ 162 px, alors que la cible est de 150 px maximum.
- Sur B, les touches désactivées sont à 2,0–2,2:1, sans raison affichée.

### Autres points P0

- **Le vide central est toujours là** (≈ 275 px) et l'Oracle ne s'ouvre pas en aperçu, alors que le bandeau dit « utiliser un pont ». Le bouton `VOIR LES PONTS` fait ≈ 9 px et paraît désactivé.
- **Les platines ne sont plus alignées.** La pastille « CALIBRÉ STEMS » rend A plus haut de ≈ 25 px, et A touche le bord bas de la fenêtre.
- **Les façades de tiroir ne sont pas encore des tiroirs** : ≈ 30 px de haut, pas de poignée, chevron d'environ 4 px, anneau de focus blanc sur B.

### Points P1

- **Carrousel** : points toujours rouges, et le 4e point est maintenant **vert**, sans explication.
- **Roue** : l'arc pointillé chevauche encore l'arc épais, et il manque une plaque « 5 QUINTES » sur l'arc.
- **Jauges** : « ascension » est en vert et « descente » en bleu, deux couleurs réservées aux canaux. La légende reste collée à ≈ 2–3 px sous la barre.
- **Palette** : saumon (bandeau, voyant MASTER CLOCK) et orange (`DSP`, `CALIBRÉ STEMS`) s'ajoutent au laiton.
- **Redondance créée par ma précédente consigne** : les pastilles BPM/clé répètent la télémétrie juste au-dessus quand le rack est fermé. Elles ne doivent apparaître que rack ouvert.

## Avant → après

- **Stems** : « 4 touches inégales aux libellés coupés » devient « 4 touches égales sur toute la largeur, libellé à l'intérieur, état allumé/éteint visible même en noir et blanc ».
- **Statut** : « une barre qui a l'air désactivée » devient une ligne de texte de 16 px.
- **Préréglages** : « un champ sans bordures » devient deux touches avec les bonnes icônes (micro pour ACAPELLA, micro barré pour SANS VOIX).
- **Panneau** : de 162 px à ≈ 148 px (idle) ou 128 px (stems prêts).

## Consignes de développement

Le fichier `brief-agent-dev-passe-2-stems-et-finitions.md` contient :

- le statut de chaque lot précédent (fait, partiel, non fait, régression) ;
- 6 questions d'investigation, dont : que veut dire « CALIBRÉ STEMS » ? existe-t-il une vraie ré-extraction ? que signifie le point vert ?
- **WP21**, la reconstruction du bloc Stems avec grille, CSS, états et hauteurs exactes ;
- WP22 à WP24 (Oracle, alignement, façades) en P0, WP25 à WP28 en P1 ;
- 12 critères d'acceptation et l'ordre d'exécution.

Un choix de nommage est à valider : je propose `VOIX · BATT · BASSE · AUTRE` et `ACAPELLA · SANS VOIX`, pour supprimer le doublon `INST`. L'agent de développement vérifiera d'abord que votre glossaire ne l'impose pas.

## Prochaine vérification

Envoyez les stems en état « prêt », « inactif » et « désactivé » côte à côte, l'Oracle en aperçu et ouvert, une infobulle, et une capture en 1366×768.
