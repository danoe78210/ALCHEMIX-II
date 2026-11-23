# Rôle : Compression CLI « RTK » (Rust Token Killer)

## IDENTITÉ & MISSION
RTK (`rtk-ai.rtk`, v1.2.1) est un proxy CLI haute performance qui filtre et résume les
sorties des commandes de diagnostic/versionnage **avant** qu'elles n'atteignent le contexte
LLM, afin d'économiser les tokens. Sous l'agent **Cline**, RTK travaille en « awareness full » :
Cline ne disposant pas de hook de commande, c'est **l'agent lui-même qui préfixe** ses commandes
avec `rtk` (config `awareness.level = "default"` non applicable à Cline).

## 1. RÈGLE D'USAGE — PRÉFIXE SYSTÉMATIQUE `rtk`
Préfixer **systématiquement** les commandes de diagnostic et de versionnement du projet par `rtk` :
- `rtk cargo check`
- `rtk cargo test`
- `rtk cargo clippy`
- `rtk npm run check`
- `rtk git status`
- `rtk git diff`
- `rtk git log`

En cas de besoin d'une **trace brute complète** pour un débogage profond, utiliser
`rtk bypass <commande>` (exécute la commande sans filtrage mais en garde la trace de consommation).

## 2. VALIDATION & TRACABILITÉ
- `rtk --version` pour confirmer la présence du binaire.
- `rtk gain` pour afficher les économies de tokens accumulées (Vérification : « No tracking data yet » tant qu'aucune commande n'a été exécutée et/ou aucun hook installé).
- `rtk init -g` installe RTK comme hook global optionnel (`ALLOWLIST`/`DENYLIST` de l'interpréteur) pour des économies automatiques ; non requis sous Cline (awareness full manuelle).

## 3. INTÉGRATION CLINE (sans écraser `.clinerules/01` à `06`)
La génération `rtk init --agent cline --dry-run` confirme que RTK cible un artefact racine
`.clinerules` (awareness full — pas de hook Cline). Conformément à la gouvernance, les
instructions RTK sont intégrées ici dans **`.clinerules/07-rtk-compression-cli.md`**, sans écraser
les règles existantes `01-architecte-technique`, `02-kanban-et-journaux`, `03-ui-ux-et-depot`,
`04-dj-mashup-architect`, `05-developpeur-senior-innovant`, `06-specifications-vivantes`.