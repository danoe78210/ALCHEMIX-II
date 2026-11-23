// ALC-225 : échange intégral des états de platines — logique PUR testable sous `node --test`.
// `swapDecks()` échange toutes les propriétés métier de `deckA` <-> `deckB` (titre, BPM, clé,
// stems, position, EQ, …). On exclut uniquement l'identifiant `id` (A / B).

export function swapDeckState<T extends Record<string, unknown>>(a: T, b: T): { a: T; b: T } {
  const keys = new Set<string>([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.delete('id');
  const na: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  const nb: Record<string, unknown> = { ...(b as Record<string, unknown>) };
  for (const k of keys) {
    const t = na[k];
    na[k] = nb[k];
    nb[k] = t;
  }
  return { a: na as T, b: nb as T };
}