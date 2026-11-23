/* ============ Pasto de corredores y parches (G5): atlas procedural ============
   Dueño: A2. Plan: realismo/PLAN_PASTO.md §3.3. Boceto aprobado: realismo/spikes/pasto.html (los pintores de
   canvas 2D y los mipmaps que conservan la cobertura están portados de ahí, sin cambiar trazos ni colores).

   Atlas 512 x 1024 (2 columnas x 4 filas de tiles de 256 px), 6 tiles usados (los 2 últimos lugares quedan vacíos):
     0  gramíneas A      1  gramíneas B      2  achicoria B
     3  melilotos A      4  alfalfa B        5  estrato bajo B
   La variante de cada tipo es la elegida por el dueño (?v=ABABB del boceto). Cada tile se dibuja con la
   misma semilla que tenía en el boceto (1000 + 7919·(tipo·3 + variante)), así que el dibujo es idéntico.

   Se genera una vez, en runtime, con canvas 2D (como treegen.js): no se descarga nada. Devuelve una DataTexture
   con mipmaps propios: en cada nivel el alfa de cada tile se reescala hasta que la fracción de píxeles sobre el umbral
   sea la del nivel 0 (método de Castaño); sin eso, de lejos solo sobreviven las flores y el corredor se ve blanquecino.

   API:  buildGrassAtlas() → { texture, ms, msPaint, msMips }   (ms = tiempo total de generación)
         GRASS_ATLAS = { cols: 2, rows: 4, tile: 256, alphaRef: 0.42 }                                          */
import * as THREE from "three";
import { mulberry32 } from "../../core/geo.js?v=20261201";

export const GRASS_ATLAS = { cols: 2, rows: 4, tile: 256, alphaRef: 0.42 };
const TP = GRASS_ATLAS.tile, COLS = GRASS_ATLAS.cols, ROWS = GRASS_ATLAS.rows, AW = TP * COLS, AH = TP * ROWS;

/* ------------------------------------------------ utilidades de dibujo (del boceto) ---------- */
function centerline(x, y, len, ang, curve, steps = 10) {
  const pts = [[x, y]]; let a = ang; const st = len / steps;
  for (let i = 0; i < steps; i++) { a += curve / steps; x += Math.sin(a) * st; y -= Math.cos(a) * st; pts.push([x, y]); }
  return pts;
}
function at(pts, t) {
  const f = Math.max(0, Math.min(1, t)) * (pts.length - 1), i = Math.min(Math.floor(f), pts.length - 2), k = f - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
}
function angAt(pts, t) { const a = at(pts, Math.max(0, t - 0.05)), b = at(pts, Math.min(1, t + 0.05)); return Math.atan2(b[0] - a[0], -(b[1] - a[1])); }
function stroke(c, pts, w, col) {
  c.strokeStyle = col; c.lineWidth = w; c.lineCap = "round"; c.lineJoin = "round";
  c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.stroke();
}
function blade(c, pts, w, col, keep = 0.08) {
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const o = pts[Math.max(i - 1, 0)], q = pts[Math.min(i + 1, pts.length - 1)];
    let dx = q[0] - o[0], dy = q[1] - o[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const t = i / (pts.length - 1), ww = w * 0.5 * (1 - t * (1 - keep)) * (t < 0.15 ? 0.7 + t * 2 : 1);
    L.push([pts[i][0] - dy * ww, pts[i][1] + dx * ww]); R.push([pts[i][0] + dy * ww, pts[i][1] - dx * ww]);
  }
  c.fillStyle = col; c.beginPath(); c.moveTo(L[0][0], L[0][1]);
  for (const p of L) c.lineTo(p[0], p[1]); for (const p of R.reverse()) c.lineTo(p[0], p[1]); c.closePath(); c.fill();
}
function ell(c, x, y, rx, ry, a, col) { c.fillStyle = col; c.beginPath(); c.ellipse(x, y, Math.max(rx, 0.6), Math.max(ry, 0.6), a, 0, 6.2832); c.fill(); }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

function trifoliate(c, r, x, y, s, a, cols, round = false) {
  for (let k = -1; k <= 1; k++) {
    const aa = a + k * 0.9, d = s * 0.9;
    ell(c, x + Math.sin(aa) * d, y - Math.cos(aa) * d, round ? s * 0.72 : s * 0.42, s * 0.75, aa, pick(r, cols));
  }
}
function chicoryFlower(c, r, x, y, R) {
  const cols = ["#7c9df0", "#6e90e8", "#8eaaf3", "#93a6ec", "#7a95e6"];
  const faded = r() < 0.08, col = faded ? "#c9d3f0" : pick(r, cols);
  const sq = 0.45 + r() * 0.55, tilt = (r() - 0.5) * 1.2, n = 13;
  c.save(); c.translate(x, y); c.rotate(tilt); c.scale(1, sq);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 6.2832 + r() * 0.15;
    ell(c, Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55, R * 0.52, R * 0.17, a, col);
  }
  ell(c, 0, 0, R * 0.22, R * 0.22, 0, faded ? "#9aa6cf" : "#3f55a8");
  c.restore();
}

/* Variantes (solo las dos que se usan): A = fino, B = legible */
const VAR_A = { lw: 1.0, n: 1.15, fs: 0.85, stems: 3, fl: 3, leafy: false };
const VAR_B = { lw: 1.8, n: 0.6, fs: 1.5, stems: 2, fl: 2, leafy: false };

/* Gramíneas: mata de hojas finas y arqueadas + tallos con 3 tipos de espiga */
function paintGram(c, r, s, VW) {
  const cx = VW / 2, by = 250;
  const greens = ["#46622e", "#516d33", "#5c7538", "#41592c", "#657d42", "#4d6731"], straw = ["#a39a5e", "#b0a568", "#958d55"];
  const nL = Math.round(34 * s.n);
  for (let i = 0; i < nL; i++) {
    const x0 = cx + (r() - 0.5) * 44, ang = (r() - 0.5) * 1.4, curve = Math.sign(ang || 1) * (0.3 + r() * 1.0);
    const pts = centerline(x0, by, 80 + r() * 115, ang, curve);
    blade(c, pts, (3.2 + r() * 2.4) * s.lw, r() < 0.14 ? pick(r, straw) : pick(r, greens));
  }
  const nS = Math.round(6 * s.n + 1);
  for (let k = 0; k < nS; k++) {
    const x0 = cx + (r() - 0.5) * 34, ang = (r() - 0.5) * 0.55;
    const pts = centerline(x0, by, 165 + r() * 75, ang, (r() - 0.5) * 0.5);
    stroke(c, pts, 1.3 * s.lw, "#6b7d48");
    const kind = k % 3, fs = s.fs;
    if (kind === 0) {                                 // ryegrass: espiga plana, espiguillas alternas
      let side = 1;
      for (let t = 0.7; t <= 1.0; t += 0.034) {
        const p = at(pts, t), a = angAt(pts, t); side = -side;
        ell(c, p[0] + side * 2.6 * fs, p[1], 5 * fs, 1.9 * fs, a + Math.PI / 2 + side * 0.55, r() < 0.5 ? "#6f7d48" : "#7b8650");
      }
    } else if (kind === 1) {                          // cebadilla: panoja colgante
      const p = pts[pts.length - 1];
      for (let j = 0; j < 6; j++) {
        const side = j % 2 ? 1 : -1, t0 = 0.82 + r() * 0.18, q = at(pts, t0);
        const br = centerline(q[0], q[1], (20 + r() * 22) * fs, side * (0.5 + r() * 0.7), side * 1.6, 6);
        stroke(c, br, 0.9 * s.lw, "#8d9a62");
        const e = br[br.length - 1];
        ell(c, e[0], e[1] + 3 * fs, 7 * fs, 2.6 * fs, side * 0.4 + Math.PI / 2, pick(r, ["#8f8c58", "#7d8a50", "#9a935f"]));
      }
      ell(c, p[0], p[1] - 2, 6 * fs, 2.4 * fs, Math.PI / 2, "#8f8c58");
    } else {                                          // pasto ovillo: glomérulos densos
      for (let j = 0; j < 3; j++) {
        const t0 = 0.84 + j * 0.06, q = at(pts, t0), side = j % 2 ? 1 : -1;
        const br = centerline(q[0], q[1], (10 + r() * 14) * fs, side * (0.5 + r() * 0.4), 0, 4);
        stroke(c, br, 1.0 * s.lw, "#7d8a55");
        const e = br[br.length - 1];
        for (let m = 0; m < 9; m++) ell(c, e[0] + (r() - 0.5) * 9 * fs, e[1] + (r() - 0.5) * 8 * fs, 2.6 * fs, 2.0 * fs, r() * 3, pick(r, ["#6f7d4f", "#7e6f73", "#8c8a63", "#75805a"]));
      }
      const e = pts[pts.length - 1];
      for (let m = 0; m < 10; m++) ell(c, e[0] + (r() - 0.5) * 10 * fs, e[1] + (r() - 0.5) * 9 * fs, 2.8 * fs, 2.1 * fs, r() * 3, pick(r, ["#6f7d4f", "#7e6f73", "#8c8a63"]));
    }
  }
}

/* Achicoria: tallos rígidos ramificados en V, flores celestes sueltas en todo el tallo */
function paintAchi(c, r, s, VW) {
  const cx = VW / 2, by = 250;
  const nB = s.leafy ? 9 : 5;
  for (let i = 0; i < nB; i++) {
    const ang = (r() - 0.5) * 2.4, pts = centerline(cx + (r() - 0.5) * 20, by, 45 + r() * 40, ang, Math.sign(ang) * 0.4, 8);
    blade(c, pts, (10 + r() * 4) * Math.min(s.lw, 1.3), pick(r, ["#5d7d3f", "#6b8a47", "#58773b"]), 0.15);
  }
  const flowers = [];
  for (let k = 0; k < s.stems; k++) {
    const x0 = cx + (r() - 0.5) * 24, ang = (r() - 0.5) * 0.4;
    const pts = centerline(x0, by, 195 + r() * 50, ang, (r() - 0.5) * 0.35, 12);
    stroke(c, pts, 2.2 * s.lw, "#5a7146");
    let side = r() < 0.5 ? 1 : -1;
    for (let t = 0.3; t < 0.95; t += 0.1 + r() * 0.06) {
      side = -side;
      const bp = at(pts, t), a2 = ang + side * (0.45 + r() * 0.45), bl = (45 + r() * 55) * (1.15 - t);
      const br = centerline(bp[0], bp[1], bl, a2, -side * 0.25, 5);
      stroke(c, br, 1.4 * s.lw, "#5e7549");
      if (s.leafy) blade(c, centerline(bp[0], bp[1], 16 + r() * 10, a2 + side * 0.5, 0, 4), 5 * s.lw, "#6a8a4a", 0.2);
      for (let f = 0; f < s.fl; f++) flowers.push(at(br, 0.35 + r() * 0.65));
      if (r() < 0.6) flowers.push(bp);
    }
    flowers.push(pts[pts.length - 1]);
  }
  for (const p of flowers) {
    if (r() < 0.18) { ell(c, p[0], p[1], 2.2 * s.fs, 2.6 * s.fs, 0, "#6f8a50"); continue; }   // pimpollo
    chicoryFlower(c, r, p[0], p[1], (4.6 + r() * 1.8) * s.fs);
  }
}

/* Melilotos: varas erguidas con ramas hacia arriba, hojas trifoliadas chicas y racimos finos */
function paintMeli(c, r, s, VW) {
  const cx = VW / 2, by = 250, leafC = ["#6a8f45", "#5f8540", "#77994f"];
  const racemes = [];
  for (let k = 0; k < s.stems + 1; k++) {
    const x0 = cx + (r() - 0.5) * 20, ang = (r() - 0.5) * 0.5;
    const pts = centerline(x0, by, 200 + r() * 45, ang, (r() - 0.5) * 0.25, 12);
    stroke(c, pts, 1.8 * s.lw, "#587340");
    racemes.push([pts, 0.82]);
    let side = 1;
    for (let t = 0.25; t < 0.92; t += 0.11) {
      side = -side;
      const bp = at(pts, t), a2 = ang + side * (0.22 + r() * 0.3);
      const br = centerline(bp[0], bp[1], (40 + r() * 45) * (1.1 - t * 0.5), a2, -side * 0.1, 6);
      stroke(c, br, 1.1 * s.lw, "#5b7743");
      racemes.push([br, 0.5]);
      const nl = s.leafy ? 4 : 2;
      for (let l = 0; l < nl; l++) { const q = at(pts, t + (r() - 0.5) * 0.1); trifoliate(c, r, q[0] + side * 4, q[1], 4.2 * s.lw, a2 + side * 0.8, leafC); }
    }
  }
  for (const [pts] of racemes) {
    const yellow = r() < 0.07, a = angAt(pts, 1), e = pts[pts.length - 1];
    const rl = (28 + r() * 26) * (0.8 + s.fs * 0.2), rp = centerline(e[0], e[1], rl, a, (r() - 0.5) * 0.3, 8);
    stroke(c, rp, 0.8 * s.lw, "#6a8352");
    let side = 1;
    for (let t = 0.12; t <= 1; t += 0.085 / Math.sqrt(s.fs)) {
      side = -side; const p = at(rp, t);
      const col = yellow ? pick(r, ["#e2cd45", "#d8bf32", "#ead760"]) : pick(r, ["#d3d2c3", "#c8c7b6", "#dcdacb", "#b9b9a6"]);
      ell(c, p[0] + side * 1.8 * s.fs, p[1], 1.9 * s.fs, 1.5 * s.fs, 0, col);
    }
  }
}

/* Alfalfa: mata frondosa de tallos con hojas trifoliadas oblongas y racimos violetas */
function paintAlfa(c, r, s, VW) {
  const cx = VW / 2, by = 250, leafC = ["#4f7535", "#5c8740", "#466b2f", "#62904a"];
  const nS = Math.round(12 * s.n);
  const tips = [];
  for (let k = 0; k < nS; k++) {
    const x0 = cx + (r() - 0.5) * 50, ang = (r() - 0.5) * 1.0;
    const pts = centerline(x0, by, 150 + r() * 90, ang, (r() - 0.5) * 0.6, 10);
    stroke(c, pts, 1.6 * s.lw, "#4c6b32");
    const step = s.leafy ? 0.07 : 0.11;
    for (let t = 0.15; t < 0.92; t += step + r() * 0.04) {
      const p = at(pts, t), side = r() < 0.5 ? -1 : 1;
      trifoliate(c, r, p[0] + side * 5, p[1], 5.2 * Math.min(s.lw, 1.4), angAt(pts, t) + side * 1.0, leafC);
    }
    tips.push([pts[pts.length - 1], angAt(pts, 1)]);
  }
  for (const [e, a] of tips) {
    if (r() < 0.2) continue;
    const fs = s.fs, n = Math.round(10 + 4 * fs);
    for (let m = 0; m < n; m++) {
      const t = m / n, x = e[0] + Math.sin(a) * t * 14 * fs + (r() - 0.5) * 7 * fs, y = e[1] - Math.cos(a) * t * 14 * fs + (r() - 0.5) * 5 * fs;
      ell(c, x, y, 2.6 * fs, 1.7 * fs, r() * 3, pick(r, ["#7a55b8", "#9b7bd6", "#6a48a8", "#8a66c8"]));
    }
  }
}

/* Estrato bajo: tréboles (cabezuelas blancas y rosadas) y lotus (amarillo) */
function paintBajo(c, r, s, VW) {
  const by = 252, leafC = ["#4e7a36", "#5c8a3e", "#4a7032", "#67934a"];
  const nLeaf = Math.round(70 * s.n);
  for (let i = 0; i < nLeaf; i++) {
    const x = 20 + r() * (VW - 40), y = by - 10 - r() * (r() < 0.6 ? 90 : 140);
    stroke(c, [[x, by], [x + (r() - 0.5) * 10, y]], 1.2 * s.lw, "#5f8040");
    trifoliate(c, r, x, y, 7 * Math.min(s.lw, 1.4), (r() - 0.5) * 1.2, leafC, true);
  }
  const heads = [["w", 7], ["r", 5], ["l", 6]];
  for (const [kind, base] of heads) {
    const n = Math.round(base * s.n * (s.leafy ? 0.8 : 1));
    for (let i = 0; i < n; i++) {
      const x = 30 + r() * (VW - 60), y = by - 110 - r() * 70, R = (7.5 + r() * 2.5) * s.fs;
      stroke(c, [[x + (r() - 0.5) * 16, by], [x, y]], 1.2 * s.lw, "#6b8a4c");
      if (kind === "w") { ell(c, x, y, R, R * 0.92, 0, "#efeee2"); for (let m = 0; m < 6; m++) ell(c, x + (r() - 0.5) * R, y + (r() - 0.3) * R, R * 0.28, R * 0.2, r() * 3, "#d4d4c2"); }
      else if (kind === "r") { ell(c, x, y, R * 1.05, R, 0, "#c4507f"); ell(c, x, y - R * 0.3, R * 0.7, R * 0.55, 0, "#d97ca3"); }
      else { for (let m = 0; m < 5; m++) { const a = -1.2 + m * 0.6; ell(c, x + Math.sin(a) * R * 0.6, y - Math.cos(a) * R * 0.6, R * 0.32, R * 0.55, a, m % 2 ? "#e8c12e" : "#dca81f"); } }
    }
  }
}

/* Tile → { pintor, variante, tipo-del-boceto, relación de aspecto }.  `seed` = el del boceto (1000 + 7919·(tipo·3 + variante)). */
const TILES = [
  { paint: paintGram, v: VAR_A, seed: 1000 + 0 * 7919, asp: 1.0 },    // 0 gramíneas A      (tipo 0, var A → tile 0)
  { paint: paintGram, v: VAR_B, seed: 1000 + 1 * 7919, asp: 1.0 },    // 1 gramíneas B      (tipo 0, var B → tile 1)
  { paint: paintAchi, v: VAR_B, seed: 1000 + 4 * 7919, asp: 0.9 },    // 2 achicoria B      (tipo 1, var B → tile 4)
  { paint: paintMeli, v: VAR_A, seed: 1000 + 6 * 7919, asp: 0.8 },    // 3 melilotos A      (tipo 2, var A → tile 6)
  { paint: paintAlfa, v: VAR_B, seed: 1000 + 10 * 7919, asp: 1.0 },   // 4 alfalfa B        (tipo 3, var B → tile 10)
  { paint: paintBajo, v: VAR_B, seed: 1000 + 13 * 7919, asp: 2.0 }    // 5 estrato bajo B   (tipo 4, var B → tile 13)
];
export const GRASS_TILE_COUNT = TILES.length;

/* ------------------------------------------------ mipmaps que conservan la cobertura ---------- */
const A_REF = GRASS_ATLAS.alphaRef * 255;
const hist = new Uint32Array(256), gt = new Uint32Array(256);
/* Cobertura de un tile: fracción de píxeles con alfa·k > A_REF. Con un histograma del alfa del tile la búsqueda de k es O(256) por paso
   (antes recorría el tile 14 veces por nivel y por tile); el resultado es el mismo. */
function histogram(px, W, x0, y0, T) {
  hist.fill(0);
  for (let y = y0; y < y0 + T; y++) { let i = (y * W + x0) * 4 + 3; for (let x = 0; x < T; x++, i += 4) hist[px[i]]++; }
  let acc = 0;
  for (let v = 255; v >= 0; v--) { gt[v] = acc; acc += hist[v]; }          // gt[v] = píxeles con alfa > v
}
function covFromHist(T, k) {
  const thr = A_REF / k;
  return thr >= 255 ? 0 : gt[Math.floor(thr)] / (T * T);
}
function* coverageMips(base, out) {
  const levels = out; levels.push({ data: base, width: AW, height: AH });
  const target = [];
  for (let t = 0; t < COLS * ROWS; t++) { histogram(base, AW, (t % COLS) * TP, (t / COLS | 0) * TP, TP); target.push(covFromHist(TP, 1)); }
  let src = base, w = AW, h = AH;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), dst = new Uint8Array(nw * nh * 4);
    const sx = w > 1 ? 2 : 1, sy = h > 1 ? 2 : 1, cnt = sx * sy;
    if (sx === 2 && sy === 2) {                            // caso general (unrolled): 4 muestras por píxel
      for (let y = 0; y < nh; y++) {
        let i0 = (2 * y * w) * 4, i1 = i0 + w * 4, o = y * nw * 4;
        for (let x = 0; x < nw; x++, i0 += 8, i1 += 8, o += 4) {
          const a0 = src[i0 + 3], a1 = src[i0 + 7], a2 = src[i1 + 3], a3 = src[i1 + 7], a = a0 + a1 + a2 + a3;
          if (a > 0) {
            dst[o] = (src[i0] * a0 + src[i0 + 4] * a1 + src[i1] * a2 + src[i1 + 4] * a3) / a;
            dst[o + 1] = (src[i0 + 1] * a0 + src[i0 + 5] * a1 + src[i1 + 1] * a2 + src[i1 + 5] * a3) / a;
            dst[o + 2] = (src[i0 + 2] * a0 + src[i0 + 6] * a1 + src[i1 + 2] * a2 + src[i1 + 6] * a3) / a;
          } else {
            dst[o] = (src[i0] + src[i0 + 4] + src[i1] + src[i1 + 4]) / 4;
            dst[o + 1] = (src[i0 + 1] + src[i0 + 5] + src[i1 + 1] + src[i1 + 5]) / 4;
            dst[o + 2] = (src[i0 + 2] + src[i0 + 6] + src[i1 + 2] + src[i1 + 6]) / 4;
          }
          dst[o + 3] = a / 4;
        }
      }
    } else {                                               // niveles finales (1 × n): genérico
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        let r = 0, g = 0, b = 0, a = 0, rs = 0, gs = 0, bs = 0;
        for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) {
          const i = ((y * sy + dy) * w + x * sx + dx) * 4, al = src[i + 3];
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; rs += src[i]; gs += src[i + 1]; bs += src[i + 2];
        }
        const o = (y * nw + x) * 4;
        if (a > 0) { dst[o] = r / a; dst[o + 1] = g / a; dst[o + 2] = b / a; } else { dst[o] = rs / cnt; dst[o + 1] = gs / cnt; dst[o + 2] = bs / cnt; }
        dst[o + 3] = a / cnt;
      }
    }
    const T = nw / COLS;                                   // tamaño de tile en este nivel (nw = 512 >> nivel)
    if (T >= 1) for (let t = 0; t < COLS * ROWS; t++) {
      if (target[t] <= 0) continue;                        // tile vacío
      const x0 = (t % COLS) * T, y0 = (t / COLS | 0) * T;
      histogram(dst, nw, x0, y0, T);
      if (covFromHist(T, 1) < target[t]) {
        let lo = 1, hi = 8;
        for (let it = 0; it < 14; it++) { const k = (lo + hi) / 2; if (covFromHist(T, k) < target[t]) lo = k; else hi = k; }
        for (let y = y0; y < y0 + T; y++) { let o = (y * nw + x0) * 4 + 3; for (let x = 0; x < T; x++, o += 4) dst[o] = Math.min(255, dst[o] * hi); }
      }
    }
    levels.push({ data: dst, width: nw, height: nh });
    src = dst; w = nw; h = nh;
    yield;
  }
}

/* ------------------------------------------------ atlas ---------- */
/* El atlas se hornea en pasos cortos (un tile, el relleno, unos niveles de mipmap) para poder repartirlos en momentos ociosos y no
   hacer un cuadro largo. createAtlasJob() devuelve { step(), finish(), done, result, ms }: step() hace el próximo paso (true si terminó),
   finish() termina todo de golpe (el sistema lo usa si necesita el atlas ya); ms = tiempo de CPU acumulado (sin esperas). */
function* atlasSteps(job) {
  const cv = document.createElement("canvas"); cv.width = AW; cv.height = AH;
  const c = cv.getContext("2d", { willReadFrequently: true });
  c.clearRect(0, 0, AW, AH);
  job.phase = 'dibujo';
  for (let tile = 0; tile < TILES.length; tile++) {
    const T = TILES[tile], col = tile % COLS, row = tile / COLS | 0;
    const r = mulberry32(T.seed);
    c.save(); c.beginPath(); c.rect(col * TP + 2, row * TP + 2, TP - 4, TP - 4); c.clip();
    c.translate(col * TP, row * TP);
    const VW = TP * T.asp; c.scale(TP / VW, 1);
    T.paint(c, r, T.v, VW);
    c.restore();
    yield;
  }
  job.phase = 'relleno';
  const usedRows = Math.ceil(TILES.length / COLS), d = new Uint8ClampedArray(AW * AH * 4);   // solo se lee la parte usada del canvas (las filas de abajo quedan vacías)
  d.set(c.getImageData(0, 0, AW, usedRows * TP).data);
  // Relleno de color en los píxeles transparentes (evita halos oscuros al hacer mipmaps)
  for (let t = 0; t < TILES.length; t++) {
    const x0 = (t % COLS) * TP, y0 = (t / COLS | 0) * TP; let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = y0; y < y0 + TP; y++) for (let x = x0; x < x0 + TP; x++) { const i = (y * AW + x) * 4; if (d[i + 3] > 128) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; } }
    const m = n ? [sr / n, sg / n, sb / n] : [90, 110, 70];
    for (let y = y0; y < y0 + TP; y++) for (let x = x0; x < x0 + TP; x++) { const i = (y * AW + x) * 4; if (d[i + 3] === 0) { d[i] = m[0]; d[i + 1] = m[1]; d[i + 2] = m[2]; } }
  }
  yield;
  job.phase = 'mipmaps';
  const mips = [];
  yield* coverageMips(new Uint8Array(d.buffer.slice(0)), mips);
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), AW, AH, THREE.RGBAFormat);
  tex.mipmaps = mips;
  tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8; tex.needsUpdate = true;
  return tex;
}

export function createAtlasJob() {
  const job = { done: false, result: null, ms: 0, ph: { dibujo: 0, relleno: 0, mipmaps: 0 }, phase: 'dibujo', steps: 0 };
  const gen = atlasSteps(job);
  job.step = () => {
    if (job.done) return true;
    const t0 = performance.now();
    const r = gen.next();
    const dt = performance.now() - t0; job.ms += dt; job.ph[r.done ? 'mipmaps' : job.phase] += dt; job.steps++;
    if (r.done) { job.done = true; job.result = { texture: r.value, ms: job.ms, fases: job.ph, steps: job.steps }; }
    return job.done;
  };
  job.finish = () => { while (!job.step()); return job.result; };
  return job;
}

/* Versión de un solo paso (QA y pruebas) */
export function buildGrassAtlas() { return createAtlasJob().finish(); }
