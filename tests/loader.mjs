// ALC-165-2 : resolveur `$lib` pour `node --test`.
// Node 26 dé-srtipe nativement les types TS ; il ne connait pas l'alias SvelteKit `$lib`.
// Ce loader mappe `$lib/...` vers `../src/lib/...` afin que le moteur pur soit testable
// hors du bundler (aucun import Svelte, aucun DOM).

import { register } from 'node:module';

// Node >= 20.6 : `--import` évalue ce module mais sans l'activer comme hooks.
// `register()` (self-hook) rend le resolveur `$lib` actif pour `node --test`.
// (Un simple avertissement de déprédation est émis sous Node 26 — sans impact sur les tests.)
register(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === 'string' && specifier.startsWith('$lib/')) {
    let rel = specifier.slice('$lib/'.length);
    // l'import sans extension -> ajouter .ts pour l'ESM de-stripe de Node 26
    if (!/\.(ts|js|mjs|cjs)$/.test(rel)) rel += '.ts';
    const target = new URL('../src/lib/' + rel, import.meta.url);
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}