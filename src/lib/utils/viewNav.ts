// ALC-191 : navigation centrale du guide Mashup — logique PURE, testable sous `node --test`
// (le store Svelte 5, runes, n'est pas importable sous Node). Le store délègue ici.

export type CenterModuleId = 'camelot' | 'beatgrid' | 'library' | 'stems' | 'fx_rack' | 'live_mix';
export type CenterView = CenterModuleId | 'guide';
export type GuideTab = 'camelot' | 'beatgrid' | 'library' | 'stems';

/** ALC-205-1 : les 6 modules principaux de la console centrale, dans l'ordre du Barillet Horloger. */
export interface CenterModule {
  id: CenterModuleId;
  index: string; // '01'..'06'
  label: string; // libellé complet (cylindre)
  shortLabel: string; // libellé court (pastilles)
}

/** ALC-205-1 : tableau ordonné exporté (ordre exact du Crân 01 → 06). */
export const CENTER_MODULES: readonly CenterModule[] = [
  { id: 'camelot', index: '01', label: 'ROUE DE CAMELOT', shortLabel: 'CAMELOT' },
  { id: 'beatgrid', index: '02', label: 'BEATGRID', shortLabel: 'BEATGRID' },
  { id: 'library', index: '03', label: 'LIBRAIRIE', shortLabel: 'LIBRAIRIE' },
  { id: 'stems', index: '04', label: 'STEMS IA', shortLabel: 'STEMS IA' },
  { id: 'fx_rack', index: '05', label: 'RACK FX', shortLabel: 'RACK FX' },
  { id: 'live_mix', index: '06', label: 'MIX LIVE', shortLabel: 'MIX LIVE' },
];

/** Index du module courant → -1 si non trouvé (vue guide hors crans). */
function moduleIndexOf(current: CenterView): number {
  return CENTER_MODULES.findIndex((m) => m.id === current);
}

/** ALC-205-1 : cran suivant (boucle 06 → 01). */
export function nextCenterModule(current: CenterView): CenterModuleId {
  const idx = moduleIndexOf(current);
  if (idx < 0) return CENTER_MODULES[0].id; // guide / inconnu → CAMELOT
  return CENTER_MODULES[(idx + 1) % CENTER_MODULES.length].id;
}

/** ALC-205-1 : cran précédent (boucle 01 → 06). */
export function prevCenterModule(current: CenterView): CenterModuleId {
  const idx = moduleIndexOf(current);
  if (idx < 0) return CENTER_MODULES[0].id;
  return CENTER_MODULES[(idx - 1 + CENTER_MODULES.length) % CENTER_MODULES.length].id;
}

/** ALC-205-1 : accès direct à un module précis (pastilles 01..06). */
export function setCenterModule(_current: CenterView, id: CenterModuleId): CenterModuleId {
  return id;
}

/**
 * ALC-206-2 : écart signé de crans (en pas de Barillet) entre la vue courante et la cible.
 * - Retourne +1 (cran suivant) / -1 (cran précédent), ou l'écart le plus court
 *   (plage ]-n/2, +n/2]) pour un saut direct (rivet/raccourci), direction horaire prioritaire.
 * - Retourne 0 si l'état courant est hors Barillet (ex. guide) ou la cible introuvable.
 */
export function moduleStepDelta(current: CenterView, target: CenterModuleId): number {
  const ci = CENTER_MODULES.findIndex((m) => m.id === current);
  const ti = CENTER_MODULES.findIndex((m) => m.id === target);
  if (ci < 0 || ti < 0) return 0;
  const n = CENTER_MODULES.length;
  let d = ((ti - ci) % n + n) % n;
  if (d > n >> 1) d -= n;
  return d;
}

export function guideIsOpen(current: CenterView): boolean {
  return current === 'guide';
}

/**
 * Transition du guide Mashup.
 * - Ouverture (current ≠ guide) → `view='guide'`, on mémorise `current` (retour ultérieur).
 * - Fermeture (current === guide) → `view = previous` (restaure la vue d'origine).
 */
export function guideTransition(
  current: CenterView,
  previous: CenterView
): { view: CenterView; memorize: CenterView } {
  if (guideIsOpen(current)) {
    return { view: previous || 'camelot', memorize: previous };
  }
  return { view: 'guide', memorize: current };
}

/** ALC-198-3 : bascule d'onglet central (source unique de la vue active). */
export function switchCenterView(_current: CenterView, tab: GuideTab): CenterView {
  return tab;
}