/* ============ Generador procedural de árboles (geometría + atlas de hojas) ============
   Dueño: A2 (archivo nuevo de la Ola 2, G). Lo consume trees.js. Sin assets descargados:
   todo se genera en código al cargar (el atlas con canvas 2D, ~512x512, no pesa nada en img/).

   - buildAtlas()                → THREE.DataTexture 512x512 (2x2 tiles de 256): hojas de tala,
                                    algarrobo y chañar (RGBA con alfa recortado) + corteza opaca.
   - buildSpecies(name, cfg)     → { geometry, R0u, cyU, rxU, ryU } árbol de UNIDAD de altura (H=1):
                                    tronco + ramas (tubos de 6 lados) + copa de tarjetas de follaje con
                                    normales ESFÉRICAS (desde el centro de la copa) y oclusión horneada
                                    en el color de vértice. Una sola geometría = una sola malla por
                                    especie/celda (tronco y follaje comparten material y atlas).
   - buildProxy()                → copa simplificada (32 tris, elipsoide unitario): YA NO se dibuja; queda solo como
                                    geometría de sombra lejana (trees.casters().far, lo consume A3).
   - buildImpostorAtlas(list)    → impostores horneados EN EL NAVEGADOR a partir del propio modelo (G2): vistas laterales
                                    (2, a 0° y 90°) y cenital de cada especie, dibujadas con canvas 2D (proyección ortográfica
                                    de las mismas tarjetas, troncos y colores con AO). Sin WebGL: no toca el contexto de MapLibre.
   - buildImpostorGeometry()     → 3 quads cruzados (2 verticales + 1 horizontal = 6 tris) de caja unitaria.
   Colores de vértice en sRGB (host.js los pasa a lineal con el chunk srgbVC, como las matas).
   Las semillas son fijas (mulberry32): la misma geometría en cada carga. */
import * as THREE from "three";
import { mulberry32 } from "../../core/geo.js?v=20261201";
import { TREE_BAKE } from "../../core/config.js?v=20261201";

const ATLAS = 512, TILE_PX = 256, PAD = 0.03;
const TILE = { tala: 0, algarrobo: 1, chanar: 2, bark: 3 };

/* UV dentro de un tile del atlas (u, v en 0..1; v hacia ARRIBA de la imagen dibujada). */
function tileUV(tile, u, v) {
  const col = tile & 1, row = tile >> 1;   // row 0 = arriba
  return [(col * TILE_PX + u * TILE_PX) / ATLAS, 1 - (row * TILE_PX + (1 - v) * TILE_PX) / ATLAS];
}

/* ---------------------------------------------------------------- Atlas ---------- */
let atlasCache = null, atlasSrc = null;   // atlasSrc: canvas 512x512 RGBA (sin voltear) = fuente de los impostores horneados

function gray(g) { g = Math.max(0, Math.min(255, Math.round(g))); return "rgb(" + g + "," + g + "," + g + ")"; }
function leaf(c, x, y, len, wid, ang, g) {
  c.save(); c.translate(x, y); c.rotate(ang);
  c.fillStyle = gray(g);
  c.beginPath(); c.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2); c.fill();
  c.restore();
}
function twig(c, x0, y0, x1, y1, w, g) {
  c.strokeStyle = gray(g); c.lineWidth = w; c.lineCap = "round";
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
}

/* Dibuja los 4 tiles en gris sobre negro (el gris es el sombreado de la hoja, el negro es vacío). */
function paintTiles(c) {
  c.fillStyle = "#000"; c.fillRect(0, 0, ATLAS, ATLAS);
  const r = mulberry32(20261110);
  const tile = (n, fn) => {
    c.save(); c.beginPath(); c.rect((n & 1) * TILE_PX, (n >> 1) * TILE_PX, TILE_PX, TILE_PX); c.clip();
    c.translate((n & 1) * TILE_PX, (n >> 1) * TILE_PX); fn(); c.restore();
  };

  /* Tala: hojas ovadas chicas y densas sobre varias ramitas (copa cerrada) */
  tile(TILE.tala, () => {
    const cx = 128, cy = 232;
    for (let k = 0; k < 6; k++) {          // ramitas en abanico desde la base
      const a = -Math.PI / 2 + (k - 2.5) * 0.42 + (r() - 0.5) * 0.2, L = 120 + r() * 70;
      const ex = cx + Math.cos(a) * L, ey = cy + Math.sin(a) * L;
      twig(c, cx, cy, ex, ey, 3, 150);
      for (let t = 0.25; t <= 1.0; t += 0.13) {
        const px = cx + (ex - cx) * t, py = cy + (ey - cy) * t;
        for (const s of [-1, 1]) leaf(c, px + s * 6, py, 38 + r() * 10, 20 + r() * 6, a + s * (0.9 + r() * 0.4), 200 + r() * 55);
      }
      leaf(c, ex, ey, 40, 22, a, 220 + r() * 35);
    }
    for (let i = 0; i < 46; i++) {         // relleno: hojas sueltas dentro de un círculo
      const a = r() * 6.283, d = Math.sqrt(r()) * 96;
      leaf(c, 128 + Math.cos(a) * d, 120 + Math.sin(a) * d * 0.9, 34 + r() * 12, 18 + r() * 6, r() * 6.283, 190 + r() * 65);
    }
  });

  /* Algarrobo: hojas bipinnadas, folíolos angostos sobre raquis finas (follaje fino, con huecos) */
  tile(TILE.algarrobo, () => {
    const cx = 128, cy = 238;
    for (let k = 0; k < 7; k++) {
      const a = -Math.PI / 2 + (k - 3) * 0.34 + (r() - 0.5) * 0.15, L = 140 + r() * 80;
      const ex = cx + Math.cos(a) * L, ey = cy + Math.sin(a) * L;
      twig(c, cx, cy, ex, ey, 2, 140);
      for (let t = 0.12; t <= 1.0; t += 0.065) {
        const px = cx + (ex - cx) * t, py = cy + (ey - cy) * t, ll = (30 - 14 * t) * (0.85 + r() * 0.3);
        for (const s of [-1, 1]) leaf(c, px + Math.cos(a + s * 1.2) * ll * 0.5, py + Math.sin(a + s * 1.2) * ll * 0.5, ll, 5.5, a + s * 1.2, 195 + r() * 60);
      }
    }
  });

  /* Chañar: hojas pinnadas con pocos folíolos redondeados, muy ralas (copa abierta) */
  tile(TILE.chanar, () => {
    for (let k = 0; k < 9; k++) {
      const bx = 40 + r() * 176, by = 140 + r() * 100, a = -Math.PI / 2 + (r() - 0.5) * 2.4, L = 50 + r() * 40;
      const ex = bx + Math.cos(a) * L, ey = by + Math.sin(a) * L;
      twig(c, bx, by, ex, ey, 2, 150);
      for (let t = 0.3; t <= 1.0; t += 0.24) {
        const px = bx + (ex - bx) * t, py = by + (ey - by) * t;
        for (const s of [-1, 1]) leaf(c, px + Math.cos(a + s * 1.4) * 9, py + Math.sin(a + s * 1.4) * 9, 26 + r() * 6, 13 + r() * 3, a + s * 1.2, 205 + r() * 50);
      }
      leaf(c, ex, ey, 24, 13, a, 225 + r() * 30);
    }
  });

  /* Corteza: opaca, vetas verticales onduladas y algunas grietas (se usa en tubos de tronco y ramas) */
  tile(TILE.bark, () => {
    c.fillStyle = gray(200); c.fillRect(0, 0, TILE_PX, TILE_PX);
    for (let i = 0; i < 70; i++) {
      const x0 = r() * TILE_PX, w = 1 + r() * 4, g = 120 + r() * 100;
      c.strokeStyle = gray(g); c.lineWidth = w; c.beginPath(); c.moveTo(x0, 0);
      for (let y = 0; y <= TILE_PX; y += 32) c.lineTo(x0 + Math.sin(y * 0.05 + i) * 5 + (r() - 0.5) * 3, y);
      c.stroke();
    }
    for (let i = 0; i < 26; i++) { const y = r() * TILE_PX; c.fillStyle = gray(110 + r() * 40); c.fillRect(r() * TILE_PX, y, 6 + r() * 26, 1.5); }
  });
}

export function buildAtlas() {
  if (atlasCache) return atlasCache;
  const cv = document.createElement("canvas");
  cv.width = cv.height = ATLAS;
  const c = cv.getContext("2d", { willReadFrequently: true });
  paintTiles(c);
  const src = c.getImageData(0, 0, ATLAS, ATLAS).data;
  const data = new Uint8Array(ATLAS * ATLAS * 4);
  const flat = new Uint8ClampedArray(ATLAS * ATLAS * 4);
  for (let y = 0; y < ATLAS; y++) {
    const dst = (ATLAS - 1 - y) * ATLAS * 4;      // fila 0 de la textura = abajo (v=0): se invierte el canvas
    for (let x = 0; x < ATLAS; x++) {
      const v = src[(y * ATLAS + x) * 4];
      const isBark = x >= TILE_PX && y >= TILE_PX;
      const o = dst + x * 4;
      /* RGB = sombreado de la hoja (tope bajo: las hojas no quedan negras); alfa = cobertura.
         En el vacío el RGB queda neutro (sin halos oscuros al generar mipmaps). */
      const g = isBark ? v : Math.max(v, 185);
      data[o] = data[o + 1] = data[o + 2] = g;
      data[o + 3] = isBark ? 255 : Math.round(Math.max(0, Math.min(1, (v - 24) / 90)) * 255);
      const f = (y * ATLAS + x) * 4;
      flat[f] = flat[f + 1] = flat[f + 2] = g; flat[f + 3] = data[o + 3];
    }
  }
  atlasSrc = document.createElement("canvas"); atlasSrc.width = atlasSrc.height = ATLAS;
  atlasSrc.getContext("2d").putImageData(new ImageData(flat, ATLAS, ATLAS), 0, 0);
  const tex = new THREE.DataTexture(data, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  atlasCache = tex;
  return tex;
}

/* ------------------------------------------------------------- Geometría --------- */
const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
};
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hex3 = h => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

class GeoBuilder {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.uv = []; this.idx = []; this.tubes = []; this.cards = []; }   // tubes/cards: copia de lo armado, para hornear los impostores
  vert(p, n, c, uv) { this.pos.push(p[0], p[1], p[2]); this.nor.push(n[0], n[1], n[2]); this.col.push(c[0], c[1], c[2]); this.uv.push(uv[0], uv[1]); return this.pos.length / 3 - 1; }

  /* Tubo cónico de `sides` lados entre p0 y p1 (radios r0, r1), sin tapas. colorAt(y) → rgb. */
  tube(p0, p1, r0, r1, sides, colorAt) {
    this.tubes.push({ p0, p1, r0, r1, col: colorAt((p0[1] + p1[1]) / 2) });
    const a = v3.norm(v3.sub(p1, p0));
    let u = v3.cross(a, Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]); u = v3.norm(u);
    const w = v3.cross(a, u);                  // (u, w, a) diestro
    const base = this.pos.length / 3;
    for (let ring = 0; ring < 2; ring++) {
      const p = ring ? p1 : p0, rad = ring ? r1 : r0;
      for (let i = 0; i <= sides; i++) {
        const th = (i / sides) * Math.PI * 2, d = v3.add(v3.mul(u, Math.cos(th)), v3.mul(w, Math.sin(th)));
        this.vert(v3.add(p, v3.mul(d, rad)), d, colorAt(p[1]), tileUV(TILE.bark, 0.05 + 0.9 * (i / sides), ring ? 0.9 : 0.1));
      }
    }
    for (let i = 0; i < sides; i++) {
      const A = base + i, B = A + 1, C = base + sides + 1 + i, D = C + 1;
      this.idx.push(A, B, C, B, D, C);
    }
  }

  /* Tarjeta (quad) de follaje centrada en c, normal de plano `n`, giro `roll`; las normales de
     sombreado son ESFÉRICAS: las da normalFn(p). colorAt(p) → rgb horneado (AO). */
  card(c, w, h, n, roll, tile, flip, normalFn, colorAt) {
    let up = v3.sub([0, 1, 0], v3.mul(n, n[1]));
    if (v3.len(up) < 0.15) up = v3.sub([1, 0, 0], v3.mul(n, n[0]));
    up = v3.norm(up);
    const cs = Math.cos(roll), sn = Math.sin(roll);
    up = v3.add(v3.mul(up, cs), v3.mul(v3.cross(n, up), sn));
    const right = v3.norm(v3.cross(up, n));
    const base = this.pos.length / 3;
    const rec = { P: [], T: [], tile, col: colorAt(c) };
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = v3.add(c, v3.add(v3.mul(right, sx * w / 2), v3.mul(up, sy * h / 2)));
      const u = PAD + (1 - 2 * PAD) * ((sx > 0) !== flip ? 1 : 0), v = PAD + (1 - 2 * PAD) * (sy > 0 ? 1 : 0);
      this.vert(p, normalFn(p), colorAt(p), tileUV(tile, u, v));
      rec.P.push(p); rec.T.push([u, v]);
    }
    this.cards.push(rec);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /* Escala todo (la geometría se arma en metros nominales y se normaliza a altura 1). */
  toGeometry(scale) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos.map(x => x * scale), 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* Normales esféricas de un elipsoide (centro c, radios r): normalize((p-c)/r²). */
const ellipsoidNormal = (c, r) => p => v3.norm([(p[0] - c[0]) / (r[0] * r[0]), (p[1] - c[1]) / (r[1] * r[1]), (p[2] - c[2]) / (r[2] * r[2])]);

/* Dirección de normal de un plano de tarjeta: elevación `el` (rad) y rumbo `th`. */
const planeNormal = (el, th) => [Math.cos(el) * Math.cos(th), Math.sin(el), Math.cos(el) * Math.sin(th)];

/* Árboles de forma nominal en metros (H nominal, radio de copa R, centro/radios del elipsoide de la
   copa). Cada especie arma esqueleto (tubos) y follaje (tarjetas) con su propia semilla. */
const SHAPES = {
  /* Tala: globosa y densa, ramificada desde abajo; copa redonda que casi toca el suelo */
  tala: {
    H: 7, R: 3.4, seed: 7101,
    crown: { c: [0, 4.3, 0], r: [3.4, 2.7, 3.4] }, shellMin: 0.5, cardW: 0.78, cardH: 0.68, flat: 0, minY: 1.3,
    skeleton(b, r, colorAt) {
      b.tube([0, 0, 0], [0.1, 1.1, 0.05], 0.31, 0.25, 6, colorAt);
      b.tube([0.1, 1.1, 0.05], [0, 2.2, 0], 0.25, 0.19, 6, colorAt);
      for (let k = 0; k < 4; k++) {
        const th = k * Math.PI / 2 + (r() - 0.5) * 0.6;
        b.tube([0, 2.2, 0], [Math.cos(th) * 1.9, 4.0 + r() * 0.7, Math.sin(th) * 1.9], 0.14, 0.06, 6, colorAt);
      }
      return 2.2;
    }
  },
  /* Algarrobo: aparasolado, ancho y chato; tronco corto y torcido que se abre en 5 ramas */
  algarrobo: {
    H: 9, R: 5.4, seed: 7102,
    crown: { c: [0, 7.2, 0], r: [5.4, 1.85, 5.4] }, shellMin: 0.55, cardW: 0.46, cardH: 0.40, flat: 0.4, minY: 4.6,
    skeleton(b, r, colorAt) {
      b.tube([0, 0, 0], [0.3, 1.9, 0.1], 0.40, 0.30, 6, colorAt);
      b.tube([0.3, 1.9, 0.1], [0, 3.9, 0.2], 0.30, 0.25, 6, colorAt);
      for (let k = 0; k < 5; k++) {
        const th = k * 1.2566 + (r() - 0.5) * 0.5, R = 3.3 + r() * 1.4;
        b.tube([0, 3.9, 0.2], [Math.cos(th) * R, 6.5 + r() * 0.9, Math.sin(th) * R], 0.24, 0.09, 6, colorAt);
      }
      return 3.9;
    }
  },
  /* Chañar: irregular y abierto, tronco torcido, 3 ramas con kinks y copa en lóbulos separados */
  chanar: {
    H: 5, R: 2.7, seed: 7103,
    crown: { c: [0, 3.3, 0], r: [2.7, 1.9, 2.7] }, shellMin: 0.35, cardW: 0.60, cardH: 0.50, flat: 0, minY: 1.9, lumps: true,
    skeleton(b, r, colorAt, shape) {
      b.tube([0, 0, 0], [0.35, 1.3, 0.1], 0.23, 0.18, 6, colorAt);
      b.tube([0.35, 1.3, 0.1], [-0.1, 2.3, 0.3], 0.18, 0.13, 6, colorAt);
      shape.lumpList = [];
      for (let k = 0; k < 3; k++) {
        const th = k * 2.094 + r() * 0.7, c = [Math.cos(th) * 1.3, 3.2 + r() * 0.5, Math.sin(th) * 1.3];
        shape.lumpList.push(c);
        const mid = [(-0.1 + c[0]) * 0.5 + (r() - 0.5) * 0.5, 2.9 + r() * 0.3, (0.3 + c[2]) * 0.5 + (r() - 0.5) * 0.5];
        b.tube([-0.1, 2.3, 0.3], mid, 0.11, 0.08, 6, colorAt);
        b.tube(mid, [c[0] * 0.85, c[1] - 0.2, c[2] * 0.85], 0.08, 0.04, 6, colorAt);
      }
      shape.lumpList.push([0, 4.0, 0]);   // lóbulo superior
      return 2.3;
    }
  }
};

/* Árbol de la especie `name` normalizado a altura 1. cfg = TREE_SPECIES[name]. */
export function buildSpecies(name, cfg) {
  const shape = { ...SHAPES[name] }, r = mulberry32(shape.seed), b = new GeoBuilder();
  const leafRGB = hex3(cfg.leaf), barkRGB = hex3(cfg.bark);
  const cc = shape.crown.c, cr = shape.crown.r;
  let trunkTop = 2;

  /* AO horneado del tronco: oscurece el 30 % inferior (como pide E-AO) */
  const trunkAO = y => 1 - TREE_BAKE.trunk * (1 - sstep(0, 0.3 * trunkTop, y));
  const barkAt = y => { const k = trunkAO(y); return [barkRGB[0] * k, barkRGB[1] * k, barkRGB[2] * k]; };
  trunkTop = shape.skeleton(b, r, barkAt, shape);

  /* Follaje: N tarjetas en el elipsoide (dirs de Fibonacci con jitter + radio sesgado a la cáscara) */
  const N = cfg.cards;
  const lumps = shape.lumps && shape.lumpList.length ? shape.lumpList : null;
  const lumpR = [1.55, 1.25, 1.55];
  for (let i = 0; i < N; i++) {
    const y = 1 - 2 * (i + 0.5 + (r() - 0.5) * 0.5) / N, rr = Math.sqrt(Math.max(0, 1 - y * y)), ph = i * 2.399963 + r() * 0.6;
    const dir = [Math.cos(ph) * rr, y, Math.sin(ph) * rr];
    const f = shape.shellMin + (1 - shape.shellMin) * r();
    let center, radii;
    if (lumps) {                                   // chañar: cada tarjeta pertenece a un lóbulo
      const L = lumps[i % lumps.length]; center = L; radii = lumpR;
    } else { center = cc; radii = cr; }
    const p = [center[0] + dir[0] * radii[0] * f, Math.max(shape.minY, center[1] + dir[1] * radii[1] * f), center[2] + dir[2] * radii[2] * f];
    // orientación del plano: en el algarrobo la mayoría casi horizontales (aparasolado)
    let el;
    if (r() < shape.flat) { el = (0.8 + r() * 0.75) * (r() < 0.2 ? -1 : 1); }
    else { el = Math.asin(r() * 2 - 1); }
    const n = planeNormal(el, r() * 6.283);
    const sz = (0.85 + r() * 0.3) * (name === "chanar" ? 1 : 1);
    const w = cr[0] * shape.cardW * sz, h = cr[0] * shape.cardH * sz;
    // normales esféricas: del lóbulo (chañar: mezcladas con las de la copa entera) o de la copa
    const nGlobal = ellipsoidNormal(cc, cr), nLocal = lumps ? ellipsoidNormal(center, radii) : null;
    const normalFn = lumps ? (q => v3.norm(v3.add(v3.mul(nLocal(q), 0.6), v3.mul(nGlobal(q), 0.4)))) : nGlobal;
    const tint = 0.94 + r() * 0.12;
    const colorAt = q => {
      const dep = v3.len([(q[0] - cc[0]) / cr[0], (q[1] - cc[1]) / cr[1], (q[2] - cc[2]) / cr[2]]);       // 0 centro … 1 cáscara
      const low = (q[1] - cc[1]) / cr[1];                                                                // -1 abajo … 1 arriba
      const k = (1 - TREE_BAKE.interior * (1 - sstep(0.35, 1.0, dep))) * (1 - TREE_BAKE.bottom * (1 - sstep(-0.9, 0.2, low))) * tint;
      return [leafRGB[0] * k, leafRGB[1] * k, leafRGB[2] * k];
    };
    b.card(p, w, h, n, (r() - 0.5) * 1.2, TILE[name], r() < 0.5, normalFn, colorAt);
  }

  const H = shape.H, inv = 1 / H;
  return {
    geometry: b.toGeometry(inv),
    R0u: shape.R * inv,                              // radio de copa nominal (en unidades de altura)
    cyU: cc[1] * inv, rxU: cr[0] * inv, ryU: cr[1] * inv,
    bake: { cards: b.cards, tubes: b.tubes, H }       // material para buildImpostorAtlas (metros nominales)
  };
}

/* Impostor: copa simplificada (elipsoide de 8 meridianos x 2 anillos = 32 tris), radio 1, con
   normales suaves y oscurecimiento vertical horneado (valores sRGB multiplicadores). Se
   dimensiona por instancia (escala = radios del elipsoide de cada árbol). */
export function buildProxy() {
  const b = new GeoBuilder(), S = 8;
  const rings = [[-1, 0, 0.80], [-0.5, 0.866, 0.90], [0.5, 0.866, 1.0], [1, 0, 1.0]];   // [y, radio, brillo]
  const ids = [];
  rings.forEach(([y, rad, k], j) => {
    const row = [];
    const n = (j === 0 || j === 3) ? 1 : S;
    for (let i = 0; i < n; i++) {
      const th = (i + (j === 2 ? 0.5 : 0)) / S * Math.PI * 2, p = [Math.cos(th) * rad, y, Math.sin(th) * rad];
      row.push(b.vert(p, v3.norm(p), [k, k, k], [0, 0]));
    }
    ids.push(row);
  });
  const [bot, rA, rB, top] = ids;
  for (let i = 0; i < S; i++) {
    const i1 = (i + 1) % S;
    b.idx.push(bot[0], rA[i], rA[i1]);                 // casquete inferior
    b.idx.push(rA[i], rB[i], rA[i1], rA[i1], rB[i], rB[i1]);   // faja
    b.idx.push(rB[i], top[0], rB[i1]);                 // casquete superior
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

/* ======================================================= Impostores horneados (G2) ======
   Para cada especie se dibuja, con canvas 2D, una vista lateral a 0°, otra a 90° y una cenital del
   propio árbol (las mismas tarjetas con su tinte/AO y los mismos troncos). Tres quads cruzados
   (buildImpostorGeometry) las muestran a distancia: se parecen al árbol real de esa especie y llevan
   su color e iluminación horneados. Es proyección ortográfica de quads planos = transformaciones afines:
   alcanza con drawImage + transform (sin WebGL, sin render-to-texture: no toca el contexto de MapLibre). */
export const IMP_COLS = 3, IMP_ROWS = 3;            // columnas: lateral 0°, lateral 90°, cenital; filas: una por especie
const IMP_T = 128, IMP_M = 2, IMP_DEPTH_AO = 0.45, IMP_BLEED = 3, IMP_EDGE_DARK = 0.15;                       // px por tile y margen interno

const rgb255 = c => "rgb(" + Math.round(Math.min(1, c[0]) * 255) + "," + Math.round(Math.min(1, c[1]) * 255) + "," + Math.round(Math.min(1, c[2]) * 255) + ")";

/* Afín que lleva los puntos a0,a1,a3 (px de la imagen fuente) a s0,s1,s3 (px del tile). */
function affine(a0, a1, a3, s0, s1, s3) {
  const e1 = [a1[0] - a0[0], a1[1] - a0[1]], e2 = [a3[0] - a0[0], a3[1] - a0[1]];
  const det = e1[0] * e2[1] - e1[1] * e2[0];
  const S1 = [s1[0] - s0[0], s1[1] - s0[1]], S2 = [s3[0] - s0[0], s3[1] - s0[1]];
  const A = (S1[0] * e2[1] - S2[0] * e1[1]) / det, C = (S2[0] * e1[0] - S1[0] * e2[0]) / det;
  const B = (S1[1] * e2[1] - S2[1] * e1[1]) / det, D = (S2[1] * e1[0] - S1[1] * e2[0]) / det;
  return [A, B, C, D, s0[0] - (A * a0[0] + C * a0[1]), s0[1] - (B * a0[0] + D * a0[1])];
}

/* Extensión de un árbol (metros nominales): semiancho W (x/z) y alto Ht. */
function extents(src) {
  let W = 0, Ht = 0;
  for (const cd of src.cards) for (const p of cd.P) { W = Math.max(W, Math.abs(p[0]), Math.abs(p[2])); Ht = Math.max(Ht, p[1]); }
  for (const t of src.tubes) for (const p of [t.p0, t.p1]) { W = Math.max(W, Math.abs(p[0]) + t.r0, Math.abs(p[2]) + t.r0); Ht = Math.max(Ht, p[1]); }
  return { W: W * 1.01, Ht: Ht * 1.01 };
}

/* list: [{ name, bake: { cards, tubes, H }, cy }] (en orden de fila; cy = altura nominal del centro de la copa).
   Devuelve { texture, info: { name: { row, half (semiancho del quad / H), yb (base del quad / H),
   hgt (alto del quad / H), topFrac (altura del quad cenital dentro de la caja, 0..1) } } }. */
export function buildImpostorAtlas(list) {
  buildAtlas();
  const T = IMP_T, M = IMP_M, inner = T - 2 * M;
  const cv = document.createElement("canvas");
  cv.width = IMP_COLS * T; cv.height = IMP_ROWS * T;
  const c = cv.getContext("2d", { willReadFrequently: true });
  const tmp = document.createElement("canvas"); tmp.width = tmp.height = 64;
  const tc = tmp.getContext("2d");
  const info = {};

  list.forEach(({ name, bake: src, cy }, row) => {
    const { W, Ht } = extents(src), H = src.H;
    const pxX = x => M + (x + W) / (2 * W) * inner;            // -W..W → M..T-M
    const pxY = y => T - M - y / Ht * inner;                   // 0..Ht → T-M..M
    const quadHalf = W * T / inner, yb = -M * Ht / inner, yt = (T - M) * Ht / inner;
    const views = [
      { proj: p => [pxX(p[0]), pxY(p[1])], depth: p => p[2], tube: true },       // lateral 0° (cámara en +z)
      { proj: p => [pxX(-p[2]), pxY(p[1])], depth: p => p[0], tube: true },      // lateral 90° (cámara en +x)
      { proj: p => [pxX(p[0]), M + (p[2] + W) / (2 * W) * inner], depth: p => p[1], tube: false }   // cenital
    ];
    views.forEach((V, col) => {
      c.save();
      c.beginPath(); c.rect(col * T, row * T, T, T); c.clip();
      c.translate(col * T, row * T);
      c.imageSmoothingQuality = "high";
      if (V.tube) {                                              // tronco y ramas, detrás de las hojas
        for (const t of src.tubes) {
          const a = V.proj(t.p0), b = V.proj(t.p1), sc = inner / (2 * W);
          const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
          const w0 = Math.max(0.7, t.r0 * sc), w1 = Math.max(0.5, t.r1 * sc);
          c.fillStyle = rgb255(t.col);
          c.beginPath();
          c.moveTo(a[0] + nx * w0, a[1] + ny * w0); c.lineTo(b[0] + nx * w1, b[1] + ny * w1);
          c.lineTo(b[0] - nx * w1, b[1] - ny * w1); c.lineTo(a[0] - nx * w0, a[1] - ny * w0);
          c.closePath(); c.fill();
        }
      }
      const mid = cd => [(cd.P[0][0] + cd.P[2][0]) / 2, (cd.P[0][1] + cd.P[2][1]) / 2, (cd.P[0][2] + cd.P[2][2]) / 2];
      const order = src.cards.map((cd, i) => ({ i, d: V.depth(mid(cd)) })).sort((p, q) => p.d - q.d);   // lejos → cerca
      const dMin = order[0].d, dSpan = (order[order.length - 1].d - dMin) || 1;
      for (const { i, d } of order) {
        const cd = src.cards[i];
        /* oclusión por profundidad (AO horneado de la vista): las tarjetas del fondo, vistas a través de los huecos del frente, quedan más oscuras */
        const dk = 1 - IMP_DEPTH_AO * (1 - (d - dMin) / dSpan), tint = [cd.col[0] * dk, cd.col[1] * dk, cd.col[2] * dk];
        // tile de hoja con el tinte de la tarjeta (64x64): gris × color, con el alfa del tile
        tc.globalCompositeOperation = "source-over"; tc.clearRect(0, 0, 64, 64);
        const ox = (cd.tile & 1) * TILE_PX, oy = (cd.tile >> 1) * TILE_PX;
        tc.drawImage(atlasSrc, ox, oy, TILE_PX, TILE_PX, 0, 0, 64, 64);
        tc.globalCompositeOperation = "multiply"; tc.fillStyle = rgb255(tint); tc.fillRect(0, 0, 64, 64);
        tc.globalCompositeOperation = "destination-in"; tc.drawImage(atlasSrc, ox, oy, TILE_PX, TILE_PX, 0, 0, 64, 64);
        const a = k => [cd.T[k][0] * 64, (1 - cd.T[k][1]) * 64];
        const m = affine(a(0), a(1), a(3), V.proj(cd.P[0]), V.proj(cd.P[1]), V.proj(cd.P[3]));
        c.save();
        c.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        c.drawImage(tmp, 0, 0);
        c.restore();
      }
      c.restore();
    });
    info[name] = { row, half: quadHalf / H, yb: yb / H, hgt: (yt - yb) / H, topFrac: Math.min(1, Math.max(0, (cy - yb) / (yt - yb))) };
  });

  /* Bajada a textura (fila 0 = abajo). En los píxeles casi transparentes el RGB se rellena con el color medio
     de su tile: los mipmaps no arrastran halos oscuros ni de otros tiles. El canvas guarda premultiplicado. */
  const img = c.getImageData(0, 0, cv.width, cv.height).data, Wd = cv.width, Hd = cv.height;
  const data = new Uint8Array(Wd * Hd * 4);
  const mean = [];
  for (let r = 0; r < IMP_ROWS; r++) for (let k = 0; k < IMP_COLS; k++) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = r * T; y < (r + 1) * T; y++) for (let x = k * T; x < (k + 1) * T; x++) {
      const o = (y * Wd + x) * 4;
      if (img[o + 3] > 200) { sr += img[o]; sg += img[o + 1]; sb += img[o + 2]; n++; }
    }
    mean[r * IMP_COLS + k] = n ? [sr / n, sg / n, sb / n] : [100, 120, 80];
  }
  /* Halo claro (G2b). CAUSA: getImageData ya devuelve el color SIN premultiplicar, y acá se lo dividía otra vez por el alfa
     (img * 255 / a): todo texel de alfa parcial (el borde de la silueta y las hojas ralas) salía hasta 6x más brillante
     (saturado a casi blanco) = el "bordecito claro / bolsa clara". Además, los mipmaps promedian RGB sin ponderar por alfa.
     ARREGLO: se usa el color tal cual; los texels de alfa parcial/nulo toman el color medio de sus vecinos ponderado por
     alfa (sangrado, radio IMP_BLEED, dentro del tile), así los mipmaps y el filtrado no arrastran fondo ni colores sueltos;
     y el borde se oscurece apenas (IMP_EDGE_DARK) para que el contorno no quede más claro que la masa. */
  const R = IMP_BLEED, bk = IMP_EDGE_DARK;
  for (let y = 0; y < Hd; y++) {
    const dst = (Hd - 1 - y) * Wd * 4, tx = 0, ty = Math.floor(y / T) * T;
    for (let x = 0; x < Wd; x++) {
      const o = (y * Wd + x) * 4, d = dst + x * 4, a = img[o + 3], x0 = Math.floor(x / T) * T;
      let r = img[o], g = img[o + 1], b = img[o + 2];
      if (a < 255) {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let yy = Math.max(ty, y - R); yy <= Math.min(ty + T - 1, y + R); yy++) for (let xx = Math.max(x0, x - R); xx <= Math.min(x0 + T - 1, x + R); xx++) {
          const q = (yy * Wd + xx) * 4, w = img[q + 3] / 255; w * w && (sr += img[q] * w * w, sg += img[q + 1] * w * w, sb += img[q + 2] * w * w, sa += w * w);
        }
        const mn = mean[Math.floor(y / T) * IMP_COLS + Math.floor(x / T)];
        const nr = sa > 0.02 ? sr / sa : mn[0], ng = sa > 0.02 ? sg / sa : mn[1], nb = sa > 0.02 ? sb / sa : mn[2];
        const t = a < 40 ? 1 : 1 - a / 255;                    // 1 = todo vecindad, 0 = color propio
        const k = 1 - bk * (1 - a / 255);                      // oscurecimiento del borde
        r = (r + (nr - r) * t) * k; g = (g + (ng - g) * t) * k; b = (b + (nb - b) * t) * k;
      }
      data[d] = r; data[d + 1] = g; data[d + 2] = b; data[d + 3] = a;
    }
  }
  const tex = new THREE.DataTexture(data, Wd, Hd, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 2;
  tex.needsUpdate = true;
  return { texture: tex, info, debugCanvas: cv };
}

/* 3 quads de caja unitaria (x,z en -1..1; y en 0..1): lateral 0° (plano z=0), lateral 90° (plano x=0) y
   cenital (plano horizontal; y = 0.5 solo como marca: el vertex shader lo pone a la altura de la copa
   de la especie con aImp.z). UV de la fila de abajo (el shader suma el offset de fila por instancia).
   La marca de "cenital" es normal.y > 0.5; la iluminación usa siempre +Y (se fuerza en el shader). */
export function buildImpostorGeometry() {
  const b = new GeoBuilder();
  const quad = (pts, n, col, uvOf) => {
    const ids = pts.map(p => { const [u, v] = uvOf(p); return b.vert(p, n, [1, 1, 1], [(col + u) / IMP_COLS, v / IMP_ROWS]); });
    b.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  };
  quad([[-1, 0, 0], [1, 0, 0], [1, 1, 0], [-1, 1, 0]], [0, 0, 1], 0, p => [(p[0] + 1) / 2, p[1]]);
  quad([[0, 0, 1], [0, 0, -1], [0, 1, -1], [0, 1, 1]], [1, 0, 0], 1, p => [(1 - p[2]) / 2, p[1]]);          // u = (-z+1)/2
  quad([[-1, 0.5, -1], [-1, 0.5, 1], [1, 0.5, 1], [1, 0.5, -1]], [0, 1, 0], 2, p => [(p[0] + 1) / 2, 1 - (p[2] + 1) / 2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}
