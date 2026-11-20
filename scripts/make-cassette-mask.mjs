// ALC-172-1 : génération du masque PNG transparent de la cassette à partir de
// sources/cassette-raw.jpg -> static/assets/cassette-shell.png (largeur 960 px, ratio ~1.57:1).
// Pipeline : 1) couleur de fond échantillonnée sur les 4 coins ; 2) alpha=0 pour les pixels proches
// du fond (extérieur coque + alésages bobines + fenêtre qui laissent voir le fond), 255 sinon ;
// 3) trim au boîtier (bbox du contenu) ; 4) resize largeur 960. Best-effort : à vérifier visuellement.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'sources', 'cassette-raw.jpg');
const OUT = join(root, 'static', 'assets', 'cassette-shell.png');

const m = await sharp(SRC).metadata();
console.log('source:', m.width, 'x', m.height);
const W = m.width, H = m.height;

// 1) Couleur de fond = moyenne des 4 coins (tiles 8x8).
const TILE = 8;
const corners = [[0, 0], [W - TILE, 0], [0, H - TILE], [W - TILE, H - TILE]];
let sr = 0, sg = 0, sb = 0, cn = 0;
for (const [x, y] of corners) {
  const b = await sharp(SRC).extract({ left: x, top: y, width: TILE, height: TILE }).raw().toBuffer();
  for (let i = 0; i < b.length; i += 3) { sr += b[i]; sg += b[i + 1]; sb += b[i + 2]; cn++; }
}
sr = Math.round(sr / cn); sg = Math.round(sg / cn); sb = Math.round(sb / cn);
console.log('bg ~', sr, sg, sb);

// 2) Données RGB brutes.
const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const ch = info.channels;
const TOL = 38;
let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
const rgba = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * ch;
    const o = (y * W + x) * 4;
    rgba[o] = data[i]; rgba[o + 1] = data[i + 1]; rgba[o + 2] = data[i + 2];
    const dr = data[i] - sr, dg = data[i + 1] - sg, db = data[i + 2] - sb;
    const inside = Math.sqrt(dr * dr + dg * dg + db * db) > TOL;
    rgba[o + 3] = inside ? 255 : 0;
    if (inside) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
}
if (maxX < 0) { console.error('AUCUN contenu détecté'); process.exit(1); }
const pad = 6;
const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
const cw = Math.min(W - cx, maxX - minX + pad * 2), cH = Math.min(H - cy, maxY - minY + pad * 2);
console.log('bbox trimmed:', cx, cy, cw, cH, 'aspect=', (cw / cH).toFixed(3));

// 3) Crop + resize largeur 960 (hauteur suivie ~ aspect source).
await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
  .extract({ left: cx, top: cy, width: cw, height: cH })
  .resize({ width: 960, fit: 'inside', withoutEnlargement: false })
  .png()
  .toFile(OUT);
const out = await sharp(OUT).metadata();
console.log('OUT:', OUT, out.width, 'x', out.height, '(ratio', (out.width / out.height).toFixed(3) + ')');