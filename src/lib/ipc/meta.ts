// ALC-134/135 — Enrichissement des métadonnées via APIs publiques
// (MusicBrainz / Cover Art Archive / Deezer).
//
// Conformité MusicBrainz : User-Agent identifiant + rate-limit coopératif D'≥ 1 s entre requêtes.

export const MUSICBRAINZ_UA = 'AlcheMixII/1.0 (contact@alchemix.local)';

let lastRequestAt = 0;

/** Requête fetch limitée à 1 requête/seconde (règle MusicBrainz). */
async function rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
  const wait = Math.max(0, 1000 - (Date.now() - lastRequestAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const headers = new Headers(init?.headers || {});
  headers.set('User-Agent', MUSICBRAINZ_UA);
  return fetch(url, { ...init, headers });
}

function quote(s: string): string {
  return `"${(s || '').replace(/"/g, '')}"`;
}

/**
 * ALC-134-1 : nettoie un nom de fichier brut — extension, préfixe numérique, underscores,
 * mentions de plateforme/bitrate ([Official Video], (320kbps)) → requête « artiste + titre ».
 */
export function cleanFilename(raw: string): string {
  return (raw || '')
    .replace(/\.[A-Za-z0-9]{2,4}$/i, '') // extension
    .replace(/^\s*\d{1,3}[\s._\-—–]+/, '') // préfixe numérique « 01_ »
    .replace(/_/g, ' ')
    .replace(/\[Official\s*Video\]/gi, '')
    .replace(/\[Official\s*Audio\]/gi, '')
    .replace(/\bOfficial\s*Video\b/gi, '')
    .replace(/\s*\((\d{3,4})\s*kbps?\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sépare « Artiste - Titre » (ou « – / — »). */
export function extractArtistTitle(cleaned: string): { artist: string; title: string } {
  const m = cleaned.match(/^(.*?)\s*[-–—]\s*(.+)$/);
  if (m && m[1] && m[2]) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: cleaned };
}

export interface MbResult {
  title: string;
  artist: string;
  year: string;
  genre: string;
  releaseMbid: string;
  recordingMbid: string;
}

export interface ExternalKeyResult {
  camelotKey: string;
  strength: number;
}

/** ALC-141-2 : conversion tonique/échelle (0=maj,1..11) + scale → notation Camelot 1A–12B. */
export function camelotFromKeyScale(tonicIdx: number, scale: 'major' | 'minor'): string {
  const idx = ((tonicIdx % 12) + 12) % 12;
  if (scale === 'minor') {
    const rel = (idx + 3) % 12; // relative major
    const num = ((5 * rel + 8) % 12) || 12;
    return `${num}A`;
  }
  const num = ((5 * idx + 8) % 12) || 12;
  return `${num}B`;
}

/**
 * ALC-141-2 : interroge l'API publique AcousticBrainz (sans clé) à partir du Recording MBID et
 * renvoie la clé Camelot + la force tonale (tonal.key_key / key_scale / key_strength), ou null.
 */
export async function fetchAcousticBrainzKey(recordingMbid: string): Promise<ExternalKeyResult | null> {
  if (!recordingMbid) return null;
  const url = `https://acousticbrainz.org/api/v1/${recordingMbid}/low-level`;
  try {
    const res = await rateLimitedFetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const tonal = json?.lowlevel?.tonal;
    const keyKey = tonal?.key_key;
    const keyScale = tonal?.key_scale;
    const keyStrength = tonal?.key_strength;
    if (typeof keyKey !== 'number' || typeof keyStrength !== 'number') return null;
    const scale = keyScale === 'minor' ? 'minor' : 'major';
    return { camelotKey: camelotFromKeyScale(keyKey, scale), strength: Math.max(0, Math.min(1, keyStrength)) };
  } catch {
    return null;
  }
}

/**
 * ALC-134-2 : interroge MusicBrainz (recording) et renvoie le meilleur résultat / null.
 */
export async function searchMusicBrainz(artist: string, title: string): Promise<MbResult | null> {
  const cleaned = cleanFilename(title || '');
  const { artist: a, title: t } = extractArtistTitle(cleaned);
  const name = (artist?.trim() || a || '').trim();
  const artistPart = name ? ` AND artist:${quote(name)}` : '';
  const query = `recording:${quote(t)}${artistPart}`;
  const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=1`;
  try {
    const res = await rateLimitedFetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const rec = json?.recordings?.[0];
    if (!rec) return null;
    const artistName = rec['artist-credit']?.[0]?.name || name || '';
    const year = String(rec['first-release-date'] || '').slice(0, 4);
    const genre = (rec.tag || []).map((x: { name: string }) => x.name).slice(0, 2).join(' / ');
    const releaseMbid = rec.releases?.[0]?.id || '';
    const recordingMbid = rec.id || ''; // Recording MBID (AcousticBrainz)
    return { title: rec.title || t, artist: artistName, year, genre, releaseMbid, recordingMbid };
  } catch {
    return null;
  }
}

/**
 * ALC-134-3 : URL pochette haute résolution via Cover Art Archive.
 * (Le <img> charge directement l'image ; l'accès distant est autorisé par l'Archive.)
 */
export function fetchCoverArtArchive(releaseMbid: string): string | null {
  if (!releaseMbid) return null;
  return `https://coverartarchive.org/release/${releaseMbid}/front-500`;
}

export interface DeezerTrack {
  id: number;
  title: string;
  artist: string;
  coverSmall: string;
  preview: string;
}

/** ALC-135-2 : recherche de pistes ponts via l'API publique Deezer (sans clé). */
export async function searchDeezer(query: string): Promise<DeezerTrack[]> {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=3`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.data || []).map((d: any) => ({
      id: d.id as number,
      title: d.title as string,
      artist: (d.artist && d.artist.name) as string,
      coverSmall: (d.album && d.album.cover_medium) as string,
      preview: d.preview as string,
    }));
  } catch {
    return [];
  }
}