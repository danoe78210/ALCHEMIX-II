# AlcheMix II — Design System « Venezia 1889 » / Luxe Horloger

Source de vérité des tokens visuels et de la grille « Luxe Horloger & Dynamique Instrumentale » (voir
`.agents/skills/unslop/SKILL.md` → `## Standard Luxe Horloger & Dynamique (AlcheMix II)`).

## 1. Palette (Sans valeur = non autorisé hors conteneur macro)

| Rôle | Hex | Usage |
|---|---|---|
| Ébène châssis | `#120d0a` / `#17120f` | fonds, châssis brossé |
| Cuve encastrée | `#120d0a` | zones profondes (`inset 0 3px 10px rgba(0,0,0,0.92)`) |
| Encart surface | `#201a17` | panneaux, guichets |
| Laiton oxydé | `#4f4539` | bordures, engrenages |
| Laiton poli | `#8c6d3f` | lunettes, bagues |
| Or vénitien | `#edbf7a` | accents primaires, master |
| Crème lisible | `#ffddb0` | textes de guichet actif |
| Émeraude (A) | `#10b981` | platine A, halo |
| Bleu (B) | `#3b82f6` | platine B, halo |

### Typographie
- **Space Grotesk** : titres / labels (weights 400–700, `uppercase tracking-widest` léger).
- **JetBrains Mono** : chiffres, temps, BPM, index (`tabular-nums` sys).
- **Hanken Grotesk** : corps / lecture.
- Toute valeur chiffrée vive en `JetBrains Mono`.

## 2. Matériaux (3 couches)

1. **Ébène brossé** (`#17120f`) — fond de châssis.
2. **Laiton satiné** — plaques avec **chanfrein lumineux supérieur** `box-shadow: inset 0 1px 0 rgba(255,221,176,0.14)`.
3. **Cuves encastrées** (`#120d0a`) — `box-shadow: inset 0 3px 10px rgba(0,0,0,0.92)`.

Ajouter aux cadrans/guichets un **reflet verre saphir** :
`background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, transparent 45%)`,
et des **micro-vis d'angle** (`#8c7853`/`#edbf7a`, 5–8 px, rondes avec reflet).

## 3. Certitudes ergonomiques (règles UI/UX Pro Max)

- **Anti-Wrap** : libellés clés `whitespace-nowrap`, contraste `#ffddb0` sur `#201a17`, chiffres `JetBrains Mono tabular-nums`.
- **Affordance directionnelle** : icône/chevron explicite + `active:translate-y-[1px]` + micro-LED (`box-shadow` radiale douce).
- **Double codage** : jamais de couleur seule pour un état (couple icône + relief + LED).
- **Physique** : inertie mécanique `cubic-bezier(0.22,1,0.36,1)`, 60 fps, `h-screen overflow-hidden` (zéro reflow).

## 4. Courbes & durées

| Cas | Courbe | Durée |
|---|---|---|
| Engrenages / chariot / tambour | `cubic-bezier(0.22,1,0.36,1)` | 420 ms |
| Faders / curseurs laiton | `cubic-bezier(0.22,1,0.36,1)` | 200 ms |
| Boutons mécaniques | `ease` / `duration-200` | 200 ms |

## 5. Halos LED dynamiques (liés au signal)

- Platine A en lecture : halo émeraude `#10b981` (pulse/tense avec `transport==='playing'`).
- Platine B en lecture : halo bleu `#3b82f6`.
- Master / Crossfader : or `#edbf7a`.
- Ne jamais faire « briller à vide » : le halo suit l'activité réelle.

## 6. Curseurs laiton rainurés (faders)

Poignée : gradient vertical `#3a2f24 → #6b5a3c → #18120e`, **rainures** `repeating-linear-gradient` horizontales,
**trait central lumineux** (émeraude / bleu / or selon canal), ombre réaliste
`inset 0 -3px 6px rgba(0,0,0,0.6)` + `inset 0 1px 0 rgba(255,221,176,0.16)` sur rail encastré.