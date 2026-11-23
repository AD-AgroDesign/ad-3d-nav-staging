/* ============ Sistema de render: suelo por shader (I) y surcos de cultivo (J) ============
   Dueño: A4 (Ola 2). Contrato: §6.3. Ficha: PLAN §9.A4-I/J. Handoff: realismo/handoffs/a4-suelo.md

   I · SUELO. Los polígonos corr-herb / parche-herb / bajo (y parche-le / corr-le como base bajo
       los árboles) se triangulan en metros de escena con THREE.ShapeUtils (earcut; huecos respetados;
       la geometría GIS no se toca: los vértices son los del anillo). Sin terreno queda casi el
       triángulo crudo del earcut (maxEdgeFlat); con terreno se refina por puntos medios (maxEdge) para
       apoyar cada vértice en heightAt. La distancia al borde (revelado) va horneada en una textura.
       Shader: color base de §4 con variantes seco/verde por ruido en coordenadas de MUNDO a 3
       escalas (≈0,7 / 4 / 25 m), AO de borde (franja de 1–2 m, geometría aparte), niebla y fade de
       shaderlib, luz de A1 (MeshLambert + hemisferio + sol).
       a4-g2: el ruido sale de UNA textura 512² generada en runtime (value noise periódico, 3 canales
       = 3 escalas; mipmaps = antialias gratis, sin fwidth ni hash por fragmento): período ≥ 22 m en la
       octava fina, rotaciones distintas por escala, sin repetición visible.
       Crecimiento: SOLO "revelado" (decisión G2): desde el eje, máscara por profundidad = distancia al
       borde normalizada por polígono. La extrusión (losa con paredes) se retiró (commit 9d7ed10).
   J · SURCOS. Malla por lote agrícola dibujada SOBRE el satélite con blending multiplicativo:
       modula la luminancia, no el color. a4-g2: antialias analítico por derivadas (huella del píxel en
       períodos) con fundido anticipado y bandas de 8 surcos con fase deformada (sin moiré). Dirección = eje principal del lote (PCA área-ponderada de la
       malla triangulada, momento de segundo orden): es textura de render, NO dato GIS.

   T9: las capas MapLibre *-herb-ext y *-woody-base quedan con opacidad 0,001 (clic/popup);
       *-herb-pattern (no clicable, interact.js no la consulta) queda en 0 para ahorrar su pasada de
       profundidad. Eso se hace desde setOpacity() (corre después de applyOpacity de layers.js).
   Dibujo: sin prueba ni escritura de profundidad (las extrusiones MapLibre invisibles escriben
       profundidad hasta 0,6–1,2 m y taparían un suelo plano); en la lista opaca con renderOrder
       negativo (primero), así árboles y pasto, que van después, quedan encima.
   A6 (terreno 3D): con terreno activo las extrusiones MapLibre pasan a `fill` drapeado (layers.js, T14) y el
       suelo/surcos SÍ usan prueba de profundidad (la malla del terreno ya está en el depth buffer cuando
       dibuja esta capa) + polygonOffset, apoyados en heightAt, con normales del relieve para que reciban el sol
       como la ladera real. Sin terreno nada cambia. */
import * as THREE from "three";
import { A4_FURROWS, A4_GROUND, WOODY_BASE } from "../../core/config.js?v=20261201";
import { HOME_VIEW, params } from "../../core/state.js?v=20261201";
import { quality } from "../../core/quality.js?v=20261201";
import { map } from "../../map/style.js?v=20261201";
import { chainShader } from "./chunks.js?v=20261201";
import { mulberry32 } from "../../core/geo.js?v=20261201";
import { extOpacityProp, GLSL_DECL, withReliefU } from "../../terrain/terrain.js?v=20261201";   // A6: relieve

/* ---------- parámetros efectivos (config + URL) ---------- */
const DBG = params.has("qa") || params.has("debug");
const furrowsWanted = () => {
  const q = DBG ? params.get("surcos") : null;   // solo ?qa/?debug
  return q === "0" ? false : q === "1" ? true : A4_FURROWS.enabled;
};
const texWanted = () => A4_GROUND.tex.enabled && !(DBG && params.get("a4tex") === "0");   // ?a4tex=0: solo ?qa/?debug (color plano anterior)
const groundWanted = () => A4_GROUND.enabled && !(DBG && params.get("a4") === "off")   // ?a4=off: solo ?qa/?debug;

/* ---------- ruido: textura generada en runtime (a4-g2) ----------
   Value noise periódico (lattice NOISE_C×NOISE_C, interpolación smoothstep: la misma estadística que el hash
   por fragmento anterior) en NOISE_N² texels, un canal por escala (R fina, G media, B gruesa). Mipmaps +
   filtro trilineal reemplazan el fundido por fwidth: a distancia cada octava tiende sola a su media 0,5.
   Sin repetición visible: período real = NOISE_C × tamaño de celda (≥ 22 m en la fina, 100 m la media, 800 m la
   gruesa) y las tres escalas van rotadas distinto. Costo: ~25 ms una vez, 1 MB de GPU. */
const NOISE_N = 512, NOISE_C = 32;
let noiseTex = null;
function getNoiseTex() {
  if (noiseTex) return noiseTex;
  const N = NOISE_N, C = NOISE_C, data = new Uint8Array(N * N * 4);
  let seed = 0x1badb002;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const i0 = new Int32Array(N), i1 = new Int32Array(N), sw = new Float32Array(N);
  for (let x = 0; x < N; x++) { const u = x * C / N, i = Math.floor(u), f = u - i; i0[x] = i; i1[x] = (i + 1) % C; sw[x] = f * f * (3 - 2 * f); }
  for (let ch = 0; ch < 3; ch++) {
    const L = new Float32Array(C * C); for (let k = 0; k < L.length; k++) L[k] = rnd();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const a = L[i0[y] * C + i0[x]], b = L[i0[y] * C + i1[x]], c = L[i1[y] * C + i0[x]], d = L[i1[y] * C + i1[x]];
      const top = a + (b - a) * sw[x], bot = c + (d - c) * sw[x];
      data[(y * N + x) * 4 + ch] = Math.round((top + (bot - top) * sw[y]) * 255);
    }
  }
  for (let k = 3; k < data.length; k += 4) data[k] = 255;
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return (noiseTex = t);
}
/* Muestreo en GLSL: u = metros / (tamaño de celda × NOISE_C). */
const GLSL_NOISE_TEX = "uniform sampler2D tNoise;\n";
const nu = cell => (1 / (cell * NOISE_C)).toFixed(7);

/* ---------- texturas de suelo del corredor y del parche (G5) ----------
   Pintores de spikes/pasto.html (`corrTex`) en un canvas 2D, sin red. Misma paleta que los pintores de las plantas del boceto, para que el
   promedio del suelo coincida con el de las plantas de A2 vistas de lejos. Sin costura: cada mancha se dibuja también desplazada ±S cuando
   cruza el borde. sRGB (la GPU decodifica a lineal; los mipmaps promedian en lineal). Costo: ~2 canvas de 1024² (full) o 512² (lite, Baja);
   se hace UNA vez en el primer build y se rehace solo si el nivel cambia de tamaño (onQuality). */
const TEX_SEED = { corr: 77, parche: 91, camino: 133 };
/* Variantes de suelo (devolución G5 de Mike: "piso marrón más oscuro, tipo tierra arada"). v0 = el G5 original (gris verdoso claro, solo para comparar);
   v1/v2/v3 = tierra oscura con moteado + matas verdes + las mismas flores. ?suelo=v0|v1|v2|v3 (solo ?qa/?debug); el default y los diales por variante
   (gain, colores de Baja) están en A4_GROUND.tex.variants / .variant (config.js). Cada entrada de los pintores: [cantidad, radio mín, radio máx, colores]. */
const FLOWERS_C = [
  [1500, 1, 2.4, ["#8ea4e0", "#7f98dc", "#9fb2ea"]],            // achicoria
  [250, 1, 2, ["#dcdbcf", "#e4e3d8"]],                          // melilotos y trébol blanco
  [350, 1, 2, ["#8a6cc0", "#7a5cb0"]],                          // alfalfa
  [200, 1, 1.8, ["#d9c446", "#c4507f"]]                         // lotus y trébol rojo
];
const FLOWERS_P = [
  [400, 1, 2.4, ["#8ea4e0", "#7f98dc"]],                        // achicoria (6 %)
  [60, 1, 2, ["#dcdbcf"]],
  [90, 1, 2, ["#8a6cc0", "#7a5cb0"]],
  [190, 1, 1.8, ["#d9c446", "#c4507f", "#e2e0d2"]]
];
const FLOWER_SET = new Set([...FLOWERS_C, ...FLOWERS_P]);
const SOIL_PAINT = {
  v0: {
    corr: { base: "#66704f",   // G5 original. Corredor: mezcla de plantas del PLAN_PASTO §1 (38 % gramíneas, 22 % achicoria, 20 % estrato bajo, 16 % alfalfa, 4 % meliloto)
      blobs: [
        [900, 10, 34, ["#5a6444", "#737d58", "#7d875f", "#6a7550"]],
        [380, 8, 22, ["#465034", "#4d5839"]],                         // sombras entre matas
        [2600, 2, 7, ["#56613f", "#74805a", "#808a62", "#8e9670", "#6c7a4a"]],
        ...FLOWERS_C
      ] },
    parche: { base: "#5b6a41",   // pastizal (PLAN_PASTO §5.1: ~70 % gramíneas, 18 % estrato bajo, 6 % achicoria, 4 % alfalfa, 2 % meliloto): más verde/pajizo, menos azul
      blobs: [
        [900, 10, 34, ["#52623a", "#667548", "#6f7c4c", "#5d6d42"]],
        [380, 8, 22, ["#3f4c2e", "#46532f"]],
        [2600, 2, 7, ["#4f6236", "#6a7a4a", "#7c8750", "#5b7038", "#5f7340"]],
        [900, 3, 9, ["#8f9160", "#9a9660", "#a39a62"]],               // paja / espigas secas
        ...FLOWERS_P
      ] }
  },
  v1: {   // pardo oscuro como el suelo viejo (#6b5d38 x 0,54/0,62/1,02) + moteado, matas verdes y flores
    corr: { base: "#54452a",
      blobs: [
        [900, 10, 34, ["#463a22", "#62502e", "#574829", "#6b5a33"]],  // terrones claros y oscuros
        [380, 8, 22, ["#352b1a", "#3d321e"]],                         // sombras entre matas
        [2600, 2, 7, ["#4a5530", "#5f6e38", "#6a7a40", "#56482b", "#756338"]],   // matas verdes y tierra entre ellas
        ...FLOWERS_C
      ] },
    parche: { base: "#3f4a2a",
      blobs: [
        [900, 10, 34, ["#38441f", "#4e5a30", "#58663a", "#454f2a"]],
        [380, 8, 22, ["#2c3620", "#323d22"]],
        [2600, 2, 7, ["#41522a", "#58693a", "#697944", "#4a5e30", "#52633a"]],
        [900, 3, 9, ["#6f6c48", "#7a7650", "#82795a"]],               // paja / espigas secas (apagadas: el parche es oscuro)
        ...FLOWERS_P
      ] }
  },
  v2: {   // tierra arada húmeda: más oscuro, casi sin verde
    corr: { base: "#3f3322",
      blobs: [
        [900, 10, 34, ["#33291b", "#4a3b25", "#3e3220", "#54432a"]],
        [380, 8, 22, ["#271f14", "#2e2517"]],
        [2600, 2, 7, ["#3b4528", "#4c5a2e", "#55663a", "#3f3322", "#5d4d2e"]],
        ...FLOWERS_C
      ] },
    parche: { base: "#2e3520",
      blobs: [
        [900, 10, 34, ["#262d19", "#3a4426", "#434e2c", "#2f3720"]],
        [380, 8, 22, ["#1f2615", "#252c18"]],
        [2600, 2, 7, ["#33401f", "#46542e", "#52613a", "#3a4a26", "#41502c"]],
        [900, 3, 9, ["#5a5a3a", "#646140", "#6a6444"]],
        ...FLOWERS_P
      ] }
  },
  v3: {   // intermedio, con más verde de matas: se lee vegetado y no tierra pelada
    corr: { base: "#4e4a2b",
      blobs: [
        [900, 10, 34, ["#423e27", "#5a5733", "#4c472b", "#655f37"]],
        [380, 8, 22, ["#312f1b", "#393620"]],
        [1500, 4, 12, ["#4c6532", "#5a7938", "#43582c"]],             // matas verdes anchas
        [2600, 2, 7, ["#4f6032", "#62773a", "#6d8340", "#586a36", "#6f7d44"]],
        ...FLOWERS_C
      ] },
    parche: { base: "#3d4a2a",
      blobs: [
        [900, 10, 34, ["#36421f", "#4b5a2f", "#566a38", "#424f29"]],
        [380, 8, 22, ["#2a3520", "#303c22"]],
        [1500, 4, 12, ["#44632c", "#527a34", "#3a542a"]],
        [2600, 2, 7, ["#40562a", "#58703a", "#687f44", "#4a6330", "#52683a"]],
        [900, 3, 9, ["#706e49", "#7a7650", "#837a58"]],
        ...FLOWERS_P
      ] }
  }
};
/* Caminos de tierra (2026-11-17, devolución de Mike antes de la demo: "los caminos lucen a contramano de los corredores"). Tierra apisonada con
   tosca: manchas secas/húmedas grandes, ripio fino claro y oscuro, algo de pasto ralo. No depende de la variante del suelo de corredores.
   Sin dirección (no hay eje del camino en el GIS): nada de huellas de ruedas, que con un patrón fijo quedarían cruzadas en las curvas. */
const ROAD_PAINT = {
  base: "#a8936f",
  blobs: [
    [700, 14, 44, ["#9f8a68", "#b29d79", "#a6916e", "#b9a581"]],   // zonas más secas y más compactas
    [420, 8, 22, ["#8f7b5c", "#957f5f", "#8a7758"]],               // manchas húmedas / tierra suelta
    [2200, 2, 5, ["#c2b090", "#9a8564", "#b7a482"]],                // terrones
    [7000, 0.7, 1.9, ["#cfc0a0", "#d8cbad", "#7b6a50", "#6c5c45", "#bba985", "#e0d5ba"]],   // ripio / tosca
    [160, 2, 6, ["#7a7d48", "#6f7642", "#868a52"]]                  // pasto ralo que asoma
  ]
};
const soilVariant = () => { const v = DBG ? params.get("suelo") : null; return v && SOIL_PAINT[v] && A4_GROUND.tex.variants[v] ? v : A4_GROUND.tex.variant; };
const soilVar = () => A4_GROUND.tex.variants[soilVariant()];
let texMean = null;   // QA: promedio sRGB de cada textura (solo con ?qa/?debug)
function paintSoilTex(kind, size) {
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  const c = cv.getContext("2d"), r = mulberry32(TEX_SEED[kind]), sc = size / 1024;
  const pal = kind === "camino" ? ROAD_PAINT : SOIL_PAINT[soilVariant()][kind], kk = kind === "camino" ? null : soilVar().soilK, blobs = pal.blobs;
  /* soilK = [r,g,b] por tipo: multiplica (sRGB) los colores de TIERRA y matas pero no los de las flores: así se oscurece el piso sin apagar los puntos celestes */
  const tone = col => { if (!kk || !kk[kind]) return col; const k = kk[kind], n = parseInt(col.slice(1), 16); return "#" + [n >> 16, (n >> 8) & 255, n & 255].map((v, i) => Math.min(255, Math.round(v * k[i])).toString(16).padStart(2, "0")).join(""); };
  c.fillStyle = tone(pal.base); c.fillRect(0, 0, size, size);
  /* fill() por mancha: con Path2D por color todo junto es ~13x MAS lento (rasteriza miles de subcaminos solapados). */
  for (const bl of blobs) for (let i = 0, [n, rmin, rmax, cols0] = bl, cols = FLOWER_SET.has(bl) ? cols0 : cols0.map(tone); i < n; i++) {
    const x = r() * size, y = r() * size, rr = Math.max((rmin + r() * (rmax - rmin)) * sc, 0.6), ry = Math.max(rr * (0.7 + r() * 0.5), 0.6), a = r() * 3, col = cols[Math.floor(r() * cols.length)];
    const e = Math.max(rr, ry) + 1;
    c.fillStyle = col;
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
      const px = x + dx, py = y + dy;
      if (px + e < 0 || px - e > size || py + e < 0 || py - e > size) continue;
      c.beginPath(); c.ellipse(px, py, rr, ry, a, 0, 6.2832); c.fill();
    }
  }
  if (DBG) {   // QA: promedio sRGB (reduce a 16x16 y promedia)
    const t = document.createElement("canvas"); t.width = t.height = 16; const tc = t.getContext("2d"); tc.drawImage(cv, 0, 0, 16, 16);
    const d = tc.getImageData(0, 0, 16, 16).data, m = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; }
    (texMean = texMean || {})[kind] = m.map(v => Math.round(v / 256));
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = size >= 1024 ? 8 : 2; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  return { tex };
}
const SOIL = { size: 0, corr: null, parche: null, camino: null };
let texMs = 0;
function ensureSoilTex(lite) {
  const size = lite ? A4_GROUND.tex.size.lite : A4_GROUND.tex.size.full;
  if (SOIL.size === size) return SOIL;
  const t0 = performance.now();
  for (const k of ["corr", "parche", "camino"]) {
    const o = paintSoilTex(k, size);
    if (SOIL[k]) {   // cambio de tamaño en caliente: se reemplaza la textura en los uniforms vivos
      SOIL[k].tex.dispose();
      for (const key in S) { const u = S[key].gMat.userData.a4u; u["t_" + k].value = o.tex; }
    }
    SOIL[k] = o;
  }
  SOIL.size = size; texMs = Math.round(performance.now() - t0);
  return SOIL;
}

/* ---------- geometría ---------- */
const MAXC = 8;   // clases de suelo máximas en los uniform arrays
const CLASS_LIST = Object.keys(A4_GROUND.classes);

function dedupRing(ring, toScene) {
  const out = [];
  for (const c of ring) {
    const [x, z] = toScene(c[0], c[1]);
    const l = out[out.length - 1];
    if (l && Math.abs(l[0] - x) < 1e-3 && Math.abs(l[1] - z) < 1e-3) continue;
    out.push([x, z]);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-3 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-3) out.pop();
  return out;
}

function ringArea2(r) {   // 2×área con signo (x,z)
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a;
}

/* Triangula un polígono (anillos en metros de escena). Devuelve { P, T, rings } o null. */
function triangulatePoly(rings) {
  if (rings.length === 0 || rings[0].length < 3) return null;
  if (Math.abs(ringArea2(rings[0])) < 2) return { tiny: true };   // < 1 m²: no vale la pena
  const v2 = r => r.map(p => new THREE.Vector2(p[0], p[1]));
  const contour = v2(rings[0]);
  const holes = rings.slice(1).filter(r => r.length >= 3).map(v2);
  let faces;
  try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { return null; }
  if (!faces || !faces.length) return null;
  const P = [];
  for (const p of contour) P.push([p.x, p.y]);
  for (const h of holes) for (const p of h) P.push([p.x, p.y]);
  return { P, T: faces.map(f => [f[0], f[1], f[2]]) };
}

/* Refinamiento conforme por puntos medios: parte toda arista más larga que L (las dos caras que
   la comparten la parten igual, sin T-junctions).
   G5 (devolución de Mike, manchas pardas con relieve): con `adapt = { h(x,z), tol, minL }` una arista TAMBIÉN se parte si es más larga que
   minL y la altura real en su punto medio se aparta más de `tol` m de la recta entre sus extremos (flecha de la malla). Una arista de 40 m
   cruza varias celdas del DEM (~16 m, bilineal con quiebres) y la malla Three quedaba hasta decímetros por DEBAJO del terreno de MapLibre:
   el terreno la tapaba en cuñas y asomaba la capa de abajo. La decisión se cachea por arista (clave a<b), así las dos caras que la
   comparten la toman igual (sin T-junctions). */
function refine(P, T, L, adapt) {
  const L2 = L * L, mL2 = adapt ? adapt.minL * adapt.minL : 0;
  const H = [];                                  // altura por vértice (solo con adapt), crece con P
  const hv = i => (H[i] === undefined ? (H[i] = adapt.h(P[i][0], P[i][1])) : H[i]);
  const dec = new Map();                         // arista → ¿partir? (adapt)
  const key = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  const mid = new Map();
  const mp = (a, b) => {
    const k = key(a, b); let m = mid.get(k);
    if (m === undefined) { m = P.length; P.push([(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2]); mid.set(k, m); }
    return m;
  };
  const long = (a, b) => {
    const dx = P[a][0] - P[b][0], dz = P[a][1] - P[b][1], d2 = dx * dx + dz * dz;
    if (d2 > L2) return true;
    if (!adapt || d2 <= mL2) return false;
    const k = key(a, b); let r = dec.get(k);
    if (r === undefined) {
      const hm = adapt.h((P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2);
      r = Math.abs(hm - (hv(a) + hv(b)) / 2) > adapt.tol; dec.set(k, r);
    }
    return r;
  };
  for (let pass = 0; pass < 14; pass++) {
    mid.clear();
    const out = []; let any = false;
    for (const [a, b, c] of T) {
      const lab = long(a, b), lbc = long(b, c), lca = long(c, a), n = lab + lbc + lca;
      if (!n) { out.push([a, b, c]); continue; }
      any = true;
      if (n === 3) {
        const ab = mp(a, b), bc = mp(b, c), ca = mp(c, a);
        out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      } else if (n === 1) {
        let [p, q, r] = lab ? [a, b, c] : lbc ? [b, c, a] : [c, a, b];   // (p,q) = arista larga
        const m = mp(p, q);
        out.push([p, m, r], [m, q, r]);
      } else {
        // dos aristas largas: la corta es (x,y) y z el vértice opuesto
        let [x, y, z] = !lab ? [a, b, c] : !lbc ? [b, c, a] : [c, a, b];
        const my = mp(y, z), mx = mp(z, x);
        out.push([z, mx, my], [x, y, my], [x, my, mx]);
      }
    }
    T = out;
    if (!any) break;
  }
  return T;
}

/* ---------- mapa de profundidad (a4-g2) ----------
   El revelado "desde el eje" necesita la distancia al borde de cada punto del polígono, normalizada por su máximo.
   Antes salía de la malla (grilla de 40 m): ~125 k triángulos en El Carmen, la mayoría sub-píxel a distancia, y eso
   (sobre-sombreado de quads) era casi todo el costo del suelo en la Intel. Ahora se hornea UNA vez por escenario en
   una textura R8 (transformada de distancia exacta por polígono sobre una grilla de ≥ DEPTH_CELL_MIN m) y la
   geometría queda con los triángulos del earcut (sin terreno) → ~10× menos triángulos. Con terreno la malla se
   sigue refinando (maxEdge) porque ahí la altura se pide por vértice. */
const DEPTH_CELL_MIN = 4, DEPTH_MAXTEX = 1024, INF = 1e12;

/* Transformada de distancia cuadrada 1D (Felzenszwalb–Huttenlocher), f en Float64Array. */
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let sx;
    for (;;) { const p = v[k]; sx = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (sx <= z[k]) k--; else break; }
    k++; v[k] = q; z[k] = sx; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}

/* Hornea la profundidad normalizada de un polígono (anillos en metros de escena) en la textura global.
   Devuelve dmax (m) ≈ distancia máxima al borde. map = { data, W, H, x0, z0, c }. */
function bakeDepth(map, rings) {
  const { W, H, x0, z0, c, data } = map;
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const p of rings[0]) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < minz) minz = p[1]; if (p[1] > maxz) maxz = p[1]; }
  const i0 = Math.max(0, Math.floor((minx - x0) / c) - 1), i1 = Math.min(W - 1, Math.ceil((maxx - x0) / c) + 1);
  const j0 = Math.max(0, Math.floor((minz - z0) / c) - 1), j1 = Math.min(H - 1, Math.ceil((maxz - z0) / c) + 1);
  const w = i1 - i0 + 1, h = j1 - j0 + 1;
  if (w < 1 || h < 1) return 0.5;
  const g = new Float64Array(w * h);   // 0 = fuera; INF = dentro
  // relleno por scanline, regla par-impar (los huecos quedan fuera)
  const xs = [];
  for (let j = 0; j < h; j++) {
    const zc = z0 + (j0 + j + 0.5) * c; xs.length = 0;
    for (const r of rings) for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
      const za = r[b][1], zb = r[a][1];
      if ((za <= zc) !== (zb <= zc)) xs.push(r[b][0] + (zc - za) / (zb - za) * (r[a][0] - r[b][0]));
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ia = Math.max(0, Math.ceil((xs[k] - x0) / c - 0.5) - i0), ib = Math.min(w - 1, Math.ceil((xs[k + 1] - x0) / c - 0.5) - 1 - i0);
      for (let i = ia; i <= ib; i++) g[j * w + i] = INF;
    }
  }
  // distancia al texel "fuera" más cercano (dos pasadas)
  const n = Math.max(w, h), col = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w; i++) { for (let j = 0; j < h; j++) col[j] = g[j * w + i]; edt1d(col, h, out, v, z); for (let j = 0; j < h; j++) g[j * w + i] = out[j]; }
  for (let j = 0; j < h; j++) { for (let i = 0; i < w; i++) col[i] = g[j * w + i]; edt1d(col, w, out, v, z); for (let i = 0; i < w; i++) g[j * w + i] = out[i]; }
  let dm = 0;
  for (let k = 0; k < g.length; k++) if (g[k] > 0) { g[k] = Math.max(0.5, Math.sqrt(g[k]) - 0.5) * c; if (g[k] > dm) dm = g[k]; }
  if (dm <= 0) return 0.5;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const d = g[j * w + i]; if (d <= 0) continue;
    data[(j0 + j) * W + (i0 + i)] = Math.max(1, Math.round(255 * Math.min(1, d / dm)));
  }
  return dm;
}

/* Criterio de flecha para refine(): altura real del suelo en (x,z) de escena (ver refine). Dial: A4_GROUND.sag = { tol, minL } (null/0 = como antes). */
function sagAdapt(ctx, toLngLat) {
  const sg = A4_GROUND.sag;
  if (!sg || !(sg.tol > 0)) return null;
  const tol = DBG && params.get("a4sag") ? +params.get("a4sag") : sg.tol;   // ?a4sag=<m> (solo QA): 0 = sin refinamiento adaptativo
  return tol > 0 ? { h: (x, z) => ctx.heightAt(...toLngLat(x, z)), tol, minL: DBG && params.get("a4minl") ? +params.get("a4minl") : sg.minL } : null;   // ?a4minl=<m> (solo QA)
}

/* ---------- construcción de la malla de suelo ---------- */
function buildGroundGeometry(ctx, data, toLngLat, hasH) {
  const P_ = [], I_ = { tops: [], ribbons: [] };   // P_: floats por vértice (5): x,y,z, cls,edge
  let nv = 0, polys = 0, failed = 0, tiny = 0;
  const yOffH = DBG && params.get("a4yoff") ? +params.get("a4yoff") : A4_GROUND.yOffRelief;
  const yAt = (x, z) => (hasH ? ctx.heightAt(...toLngLat(x, z)) : 0) + (hasH ? yOffH : A4_GROUND.yOff);
  /* A6: normal del relieve por vértice (diferencias centrales de heightAt a ±NRM_D m) */
  const N_ = [], NRM_D = 12;
  const nrmAt = (x, z) => {
    const [lo, la] = toLngLat(x, z);
    const dLon = NRM_D / (111320 * Math.cos(la * Math.PI / 180)), dLat = NRM_D / 110574;
    const hx = ctx.heightAt(lo + dLon, la) - ctx.heightAt(lo - dLon, la), hz = ctx.heightAt(lo, la - dLat) - ctx.heightAt(lo, la + dLat);   // +z de escena = sur
    const nx = -hx / (2 * NRM_D), nz = hz / (2 * NRM_D), l = Math.hypot(nx, 1, nz);
    N_.push(nx / l, 1 / l, nz / l);
  };
  const pushV = (x, y, z, cls, edge) => {
    P_.push(x, y, z, cls, edge);
    if (hasH) nrmAt(x, z);
    return nv++;
  };
  const W = A4_GROUND.edgeAO ? A4_GROUND.edgeAO.width : 1.8;

  // --- pasada 1: triangular y juntar cajas (para dimensionar el mapa de profundidad) ---
  const items = [];
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const f of data.features) {
    const cls = f.properties._cls, ci = CLASS_LIST.indexOf(cls);
    if (ci < 0) continue;
    for (const poly of f.geometry.coordinates) {
      const rings = poly.map(r => dedupRing(r, ctx.toScene)).filter(r => r.length >= 3);
      const tri = triangulatePoly(rings);
      if (!tri) { failed++; continue; }
      if (tri.tiny) { tiny++; continue; }
      polys++;
      for (const p of rings[0]) { if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0]; if (p[1] < bz0) bz0 = p[1]; if (p[1] > bz1) bz1 = p[1]; }
      items.push({ ci, rings, tri });
    }
  }
  const dmap = { W: 1, H: 1, x0: 0, z0: 0, c: 1, data: new Uint8Array(1) };
  if (items.length) {
    const c = Math.max(DEPTH_CELL_MIN, Math.max(bx1 - bx0, bz1 - bz0) / DEPTH_MAXTEX);
    dmap.c = c; dmap.x0 = bx0 - c; dmap.z0 = bz0 - c;
    dmap.W = Math.ceil((bx1 - bx0) / c) + 3; dmap.H = Math.ceil((bz1 - bz0) / c) + 3;
    dmap.data = new Uint8Array(dmap.W * dmap.H);
  }

  // --- pasada 2: profundidad horneada + geometría ---
  for (const { ci, rings, tri } of items) {
    const dmax = Math.max(0.5, bakeDepth(dmap, rings));
    const T = refine(tri.P, tri.T, hasH ? A4_GROUND.maxEdge : A4_GROUND.maxEdgeFlat, hasH ? sagAdapt(ctx, toLngLat) : null);
    const P = tri.P;
    // --- tapa (cara hacia arriba) ---
    const base = nv;
    for (let k = 0; k < P.length; k++) pushV(P[k][0], yAt(P[k][0], P[k][1]), P[k][1], ci, 0);
    for (const [a, b, c] of T) {
      const cr = (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]) - (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]);
      I_.tops.push(base + a, cr > 0 ? base + b : base + c, cr > 0 ? base + c : base + b);
    }
    // --- franja de AO por anillo (solo con los vértices originales del anillo) ---
    rings.forEach((r, ri) => {
      const A = ringArea2(r), isHole = ri > 0;
      const side = (A > 0 ? 1 : -1) * (isHole ? -1 : 1);   // hacia el interior del polígono respecto de la normal izquierda
      const w = Math.min(W, dmax * 0.8), m = r.length;
      const pIn = [], qIn = [];
      for (let i = 0; i < m; i++) {
        const p0 = r[(i + m - 1) % m], p1 = r[i], p2 = r[(i + 1) % m];
        let d0x = p1[0] - p0[0], d0z = p1[1] - p0[1], l0 = Math.hypot(d0x, d0z) || 1; d0x /= l0; d0z /= l0;
        let d1x = p2[0] - p1[0], d1z = p2[1] - p1[1], l1 = Math.hypot(d1x, d1z) || 1; d1x /= l1; d1z /= l1;
        const n0x = -d0z * side, n0z = d0x * side, n1x = -d1z * side, n1z = d1x * side;
        let mx = n0x + n1x, mz = n0z + n1z; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
        const k = Math.min(2, 1 / Math.max(mx * n0x + mz * n0z, 0.5));
        pIn.push(pushV(p1[0], yAt(p1[0], p1[1]), p1[1], ci, 1));
        qIn.push(pushV(p1[0] + mx * k * w, yAt(p1[0] + mx * k * w, p1[1] + mz * k * w), p1[1] + mz * k * w, ci, 0));
      }
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const a = pIn[i], b = pIn[j], c = qIn[j], e = qIn[i];
        // franja: sentido hacia arriba
        const pu = P_.slice(a * 5, a * 5 + 3), pv = P_.slice(b * 5, b * 5 + 3), pw = P_.slice(c * 5, c * 5 + 3);
        const cr = (pv[2] - pu[2]) * (pw[0] - pu[0]) - (pv[0] - pu[0]) * (pw[2] - pu[2]);
        if (cr > 0) I_.ribbons.push(a, b, c, a, c, e); else I_.ribbons.push(a, c, b, a, e, c);
      }
    });
  }
  const dTex = new THREE.DataTexture(dmap.data, dmap.W, dmap.H, THREE.RedFormat);
  dTex.unpackAlignment = 1; dTex.magFilter = dTex.minFilter = THREE.LinearFilter; dTex.generateMipmaps = false;
  dTex.wrapS = dTex.wrapT = THREE.ClampToEdgeWrapping; dTex.needsUpdate = true;
  const g = new THREE.BufferGeometry();
  const F = new Float32Array(P_);
  const buf = new THREE.InterleavedBuffer(F, 5);
  g.setAttribute("position", new THREE.InterleavedBufferAttribute(buf, 3, 0));
  g.setAttribute("aG", new THREE.InterleavedBufferAttribute(buf, 2, 3));   // cls, edge (1 en el borde de la franja de AO)
  if (hasH) g.setAttribute("aNrm", new THREE.Float32BufferAttribute(N_, 3));   // A6: normales del relieve
  const idx = [...I_.tops, ...I_.ribbons];   // orden de dibujo: tapa → franja (sin depth test)
  g.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);   // se dibuja siempre (frustumCulled=false igual)
  return { geometry: g, dTex, dmap, verts: nv, tris: idx.length / 3, topTris: I_.tops.length / 3, ribTris: I_.ribbons.length / 3, polys, failed, tiny };
}

/* ---------- material de suelo (Lambert + chunks propios sobre patch de A1) ---------- */
function makeGroundMaterial(ctx, key, hasH, dTex, dmap) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.userData.foliage = false;
  m.side = THREE.FrontSide;
  m.depthTest = false; m.depthWrite = false; m.transparent = false;
  if (hasH) {   // A6: con terreno, prueba de profundidad contra la malla de MapLibre + polygonOffset (yOff 0,04 m solo no alcanza a ras de piso: ±0,05 m de error de malla)
    m.depthTest = true;
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4;
  }
  // mezcla alfa en la lista OPACA (CustomBlending no se anula con transparent:false)
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  ctx.shaderlib.patch(m, { fog: true, fade: key });

  const dry = [], grn = [], alp = [], sel = [];
  const TX = A4_GROUND.tex, soil = ensureSoilTex(lite());
  for (let i = 0; i < MAXC; i++) {
    const c = A4_GROUND.classes[CLASS_LIST[i]];
    const tn = c && c.tune ? c.tune : [1, 1, 1];
    dry.push(new THREE.Color(c ? c.dry : "#000000").multiply(new THREE.Color(...tn))); grn.push(new THREE.Color(c ? c.green : "#000000").multiply(new THREE.Color(...tn)));
    alp.push(c ? c.alpha : 1);
    sel.push(c && texWanted() ? (c.tex === "corr" ? 1 : c.tex === "parche" ? 2 : c.tex === "camino" ? 3 : 0) : 0);   // G5: 0 = color plano (dry/green), 1 = textura de corredor, 2 = de parche, 3 = de camino
  }
  const U = {
    uDry: { value: dry }, uGrn: { value: grn }, uAlp: { value: alp },
    uGrow: { value: 1 }, uGain: { value: A4_GROUND.gain }, tNoise: { value: getNoiseTex() },
    tDepth: { value: dTex }, uDMap: { value: new THREE.Vector4(dmap.x0, dmap.z0, 1 / (dmap.W * dmap.c), 1 / (dmap.H * dmap.c)) },
    uNoise: { value: new THREE.Vector3(A4_GROUND.noise.fine, A4_GROUND.noise.mid, A4_GROUND.noise.coarse) },
    uAO: { value: new THREE.Vector2(A4_GROUND.edgeAO.width, A4_GROUND.edgeAO.strength) },
    uSoft: { value: new THREE.Vector2(A4_GROUND.reveal.soft, A4_GROUND.reveal.jitter) },
    // G5: texturas de corredor/parche (ver bloque A4_GROUND.tex en config.js)
    uTexSel: { value: sel }, t_corr: { value: soil.corr.tex }, t_parche: { value: soil.parche.tex }, t_camino: { value: soil.camino.tex },
    uRoad: { value: new THREE.Vector4(...TX.road.gain, TX.road.borderW) },   // caminos: albedo RGB y cuánto del borde verde se aplica
    uTexK: { value: new THREE.Vector4(1 / TX.period, 1 / TX.detailPeriod, TX.detailAmp, soilVar().noiseK ?? TX.noiseK) },
    uTexP: { value: new THREE.Vector4(TX.tint, TX.aoK, TX.borderW, 0) },
    uTexGainC: { value: new THREE.Vector3(...soilVar().gain[0]) }, uTexGainP: { value: new THREE.Vector3(...soilVar().gain[1]) },
    uBorder: { value: new THREE.Vector3(...TX.border) },
    uLite: { value: lite() ? 1 : 0 }
  };
  m.userData.a4u = U;
  // Rotaciones por escala (R, R², R³ de 36,87°) para que las 3 octavas no compartan ejes.
  const SC = [nu(0.7), nu(4), nu(25)];
  chainShader(m, hasH ? "a4ground-n" : "a4ground", sh => {
    Object.assign(sh.uniforms, U);
    if (hasH) withReliefU(sh.uniforms);   // A6 relieve en vivo: textura de alturas y factor k (terrain.js)
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>",
        "#include <common>\n" + (hasH ? GLSL_DECL : "") + "attribute vec2 aG;\n" + (hasH ? "attribute vec3 aNrm;\n" : "") + "uniform float uAlp[" + MAXC + "];\nuniform vec3 uDry[" + MAXC + "];\nuniform vec3 uGrn[" + MAXC + "];\nuniform float uTexSel[" + MAXC + "];\n" +
        "varying vec3 vWp;\nflat varying vec3 vDry;\nflat varying vec3 vGrn;\nflat varying float vTex;\nvarying vec2 vInf;")   // vInf: edge (franja AO), alfa de clase
      .replace("#include <beginnormal_vertex>", hasH ? "vec3 objectNormal = normalize(vec3(aNrm.x * uA6K, aNrm.y, aNrm.z * uA6K));" : "vec3 objectNormal = vec3(0.0, 1.0, 0.0);")   // A6: con terreno, normal del relieve
      .replace("#include <begin_vertex>",
        "vec3 transformed = vec3(position);\n" +
        (hasH ? "transformed.y -= a6Low(transformed.xz);\n" : "") +   // A6 relieve en vivo: baja (1-k)·g(x,z) (todo horneado con relieve completo)
        "int ci = int(aG.x + 0.5);\n" +
        "vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\n" +
        "vTex = uTexSel[ci]; vDry = uDry[ci]; vGrn = uGrn[ci]; vInf = vec2(aG.y, uAlp[ci]);");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>",
        "#include <common>\nvarying vec3 vWp;\nflat varying vec3 vDry;\nflat varying vec3 vGrn;\nflat varying float vTex;\nvarying vec2 vInf;\n" +
        "uniform sampler2D t_corr;\nuniform sampler2D t_parche;\nuniform sampler2D t_camino;\nuniform vec4 uRoad;\nuniform vec4 uTexK;\nuniform vec4 uTexP;\nuniform vec3 uTexGainC;\nuniform vec3 uTexGainP;\nuniform vec3 uBorder;\nuniform float uLite;\n" +
        "uniform sampler2D tDepth;\nuniform vec4 uDMap;\nuniform float uGrow;\nuniform float uGain;\nuniform vec3 uNoise;\nuniform vec2 uAO;\nuniform vec2 uSoft;\n" + GLSL_NOISE_TEX)
      .replace("vec4 diffuseColor = vec4( diffuse, opacity );",
        "vec2 adP = vWp.xz;\n" +
        "vec2 adPx = dFdx(adP), adPy = dFdy(adP);\n" +   // derivadas fuera de las ramas (textureGrad dentro de if: uniforme por primitiva, pero asi no depende del compilador)
        "float n2 = texture2D(tNoise, mat2(0.28, -0.96, 0.96, 0.28) * adP * " + SC[1] + " + vec2(0.37, 0.11)).g;\n" +
        "float n3 = texture2D(tNoise, mat2(-0.352, -0.936, 0.936, -0.352) * adP * " + SC[2] + " + vec2(0.71, 0.53)).b;\n" +
        "float gmix = smoothstep(0.30, 0.70, n3 * 0.65 + n2 * 0.35);\n" +   // parches de pasto seco <-> verde
        "vec3 adCol;\n" +
        "float aoK = 1.0;\n" +
        "if (vTex > 0.5) {\n" +                                              // G5: corredor / parche con textura de suelo
        "  vec2 uvA = adP * uTexK.x, dAx = adPx * uTexK.x, dAy = adPy * uTexK.x;\n" +
        "  vec3 tx;\n" +
        "  bool adRoad = vTex > 2.5;\n" +                                     // caminos (2026-11-17)
        "  if (adRoad) tx = textureGrad(t_camino, uvA, dAx, dAy).rgb; else if (vTex < 1.5) tx = textureGrad(t_corr, uvA, dAx, dAy).rgb; else tx = textureGrad(t_parche, uvA, dAx, dAy).rgb;\n" +
        "  if (uLite < 0.5) {\n" +                                            // 2.a muestra, rotada y a otra escala: rompe la repeticion; suma solo la desviacion (promedio intacto)
        "    mat2 R = mat2(0.87, -0.50, 0.50, 0.87);\n" +
        "    vec2 uvB = R * adP * uTexK.y + vec2(0.31, 0.77), dBx = R * adPx * uTexK.y, dBy = R * adPy * uTexK.y;\n" +
        "    vec3 tb = adRoad ? textureGrad(t_camino, uvB, dBx, dBy).rgb : vTex < 1.5 ? textureGrad(t_corr, uvB, dBx, dBy).rgb : textureGrad(t_parche, uvB, dBx, dBy).rgb;\n" +
        "    vec3 mn = adRoad ? textureLod(t_camino, vec2(0.5), 10.0).rgb : vTex < 1.5 ? textureLod(t_corr, vec2(0.5), 10.0).rgb : textureLod(t_parche, vec2(0.5), 10.0).rgb;\n" +
        "    tx += (tb - mn) * uTexK.z;\n" +
        "  }\n" +
        "  adCol = max(tx, vec3(0.0)) * (adRoad ? uRoad.rgb : vTex < 1.5 ? uTexGainC : uTexGainP);\n" +
        "  if (!adRoad) adCol *= mix(vec3(1.0 + uTexP.x, 1.0 + 0.3 * uTexP.x, 1.0 - 1.5 * uTexP.x), vec3(1.0 - 0.6 * uTexP.x, 1.0, 1.0 + 0.5 * uTexP.x), gmix);\n" +   // seco <-> verde (no en caminos)
        "  adCol *= (1.0 + 2.0 * uTexK.w * (uNoise.y * (n2 - 0.5) + uNoise.z * (n3 - 0.5))) * uGain;\n" +
        "  adCol *= mix(vec3(1.0), uBorder, (adRoad ? uRoad.w : uTexP.z) * smoothstep(0.0, 1.0, vInf.x));\n" +   // borde verde junto al cultivo (franja de AO); en caminos, la banquina
        "  aoK = uTexP.y;\n" +
        "} else {\n" +
        "  float n1 = 0.5;\n" +
        "  if (uLite < 0.5) n1 = texture2D(tNoise, mat2(0.80, -0.60, 0.60, 0.80) * adP * " + SC[0] + ").r;\n" +
        "  adCol = mix(vDry, vGrn, gmix);\n" +
        "  adCol *= (1.0 + 2.0 * (uNoise.x * (n1 - 0.5) + uNoise.y * (n2 - 0.5) + uNoise.z * (n3 - 0.5))) * uGain;\n" +
        "}\n" +
        "adCol *= 1.0 - uAO.y * aoK * smoothstep(0.0, 1.0, vInf.x);\n" +       // AO de borde (franja)
        "float adM = 1.0;\n" +
        "if (uGrow < 0.999 && vTex < 2.5) {\n" +                                   // revelado desde el eje (los caminos existen en los dos escenarios: no se revelan)
        "  float span = 1.0 + uSoft.x + uSoft.y;\n" +
        "  float lo = 1.0 - uGrow * span;\n" +
        "  float s = texture2D(tDepth, (vWp.xz - uDMap.xy) * uDMap.zw).r + (n3 - 0.5) * 2.0 * uSoft.y;\n" +   // profundidad horneada (a4-g2)
        "  adM = uGrow <= 0.001 ? 0.0 : smoothstep(lo, lo + uSoft.x, s);\n" +
        "}\n" +
        "vec4 diffuseColor = vec4(adCol, vInf.y * adM);");
  });
  return m;
}

/* ---------- surcos (J) ---------- */
function buildFurrowGeometry(ctx, data, toLngLat, hasH) {
  const pos = [], row = [], idx = [];
  let nv = 0, lots = 0, seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const f of data.features) {
    if (!A4_FURROWS.classes.includes(f.properties._cls)) continue;
    for (const poly of f.geometry.coordinates) {
      const rings = poly.map(r => dedupRing(r, ctx.toScene)).filter(r => r.length >= 3);
      const tri = triangulatePoly(rings);
      if (!tri || tri.tiny) continue;
      const { P, T } = tri;
      // momento de segundo orden área-ponderado de la malla → eje principal del lote
      const ox = P[0][0], oz = P[0][1];
      let A = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0;
      for (const [a, b, c] of T) {
        const x = [P[a][0] - ox, P[b][0] - ox, P[c][0] - ox], z = [P[a][1] - oz, P[b][1] - oz, P[c][1] - oz];
        const ar = Math.abs((x[1] - x[0]) * (z[2] - z[0]) - (x[2] - x[0]) * (z[1] - z[0])) / 2;
        const Sx = x[0] + x[1] + x[2], Sz = z[0] + z[1] + z[2];
        A += ar; sx += ar * Sx / 3; sz += ar * Sz / 3;
        sxx += ar / 12 * (x[0] * x[0] + x[1] * x[1] + x[2] * x[2] + Sx * Sx);
        szz += ar / 12 * (z[0] * z[0] + z[1] * z[1] + z[2] * z[2] + Sz * Sz);
        sxz += ar / 12 * (x[0] * z[0] + x[1] * z[1] + x[2] * z[2] + Sx * Sz);
      }
      if (A < 4) continue;
      const mx = sx / A, mz = sz / A, cxx = sxx / A - mx * mx, czz = szz / A - mz * mz, cxz = sxz / A - mx * mz;
      const th = 0.5 * Math.atan2(2 * cxz, cxx - czz);       // ángulo del eje mayor
      const ax = Math.cos(th), az = Math.sin(th), nx = -az, nz = ax;
      const phase = rnd() * A4_FURROWS.spacing * 8;
      const cx = ox + mx, cz = oz + mz, base = nv;
      // A6: con terreno, malla fina (misma arista máxima que el suelo) y cada vértice a su altura (los surcos dibujan sobre la ladera)
      const T2 = hasH ? refine(P, T, A4_GROUND.maxEdge)   /* sin refinamiento adaptativo: con la malla fina las huellas de pulverizadora (0,5 m) salen en trazos a 300 m */ : T;
      for (const p of P) {
        pos.push(p[0], (hasH ? ctx.heightAt(...toLngLat(p[0], p[1])) : 0) + A4_GROUND.yOff, p[1]);
        row.push((p[0] - cx) * nx + (p[1] - cz) * nz + phase, (p[0] - cx) * ax + (p[1] - cz) * az, 0);
        nv++;
      }
      for (const [a, b, c] of T2) idx.push(base + a, base + b, base + c);
      lots++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aRow", new THREE.Float32BufferAttribute(row, 3));
  g.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
  return { geometry: g, verts: nv, tris: idx.length / 3, lots };
}

function makeFurrowMaterial(ctx, hasH) {
  const F = A4_FURROWS;
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uCamPos: ctx.uniforms.uCamPos,
      uFadeS: { value: 1 },
      tNoise: { value: getNoiseTex() },
      uRow: { value: new THREE.Vector4(F.spacing, F.rowAmp, F.rowFade[0], F.rowFade[1]) },
      uW: { value: new THREE.Vector4(F.rowW[0], F.rowW[1], F.bandW[0], F.bandW[1]) },
      uBandAmp: { value: F.bandAmp },
      uTram: { value: new THREE.Vector4(F.tramPeriod, F.tramGauge, F.tramWidth, F.tramAmp) },
      uTramFade: { value: new THREE.Vector2(F.tramFade[0], F.tramFade[1]) },
      ...(hasH ? withReliefU({}) : {})   // A6 relieve en vivo
    },
    vertexShader: (hasH ? GLSL_DECL : "") +
      "attribute vec3 aRow;\nvarying vec3 vRow;\nvarying vec3 vWp;\n" +
      "void main() {\n  vRow = aRow;\n  vec3 pL = position;\n" + (hasH ? "  pL.y -= a6Low(pL.xz);\n" : "") +
      "  vWp = (modelMatrix * vec4(pL, 1.0)).xyz;\n" +
      "  gl_Position = projectionMatrix * modelViewMatrix * vec4(pL, 1.0);\n}",
    fragmentShader:
      "precision highp float;\nvarying vec3 vRow;\nvarying vec3 vWp;\nuniform vec3 uCamPos;\nuniform float uFadeS;\n" +
      "uniform vec4 uRow;\nuniform vec4 uW;\nuniform float uBandAmp;\nuniform vec4 uTram;\nuniform vec2 uTramFade;\n" + GLSL_NOISE_TEX +
      "void main() {\n" +
      "  float d = distance(vWp, uCamPos);\n" +
      "  float fD = (1.0 - smoothstep(uRow.z, uRow.w, d)) * uFadeS;\n" +
      "  float fTram = (1.0 - smoothstep(uTramFade.x, uTramFade.y, d)) * uFadeS;\n" +
      // Antialias analítico: wR = huella del píxel en períodos de surco (derivada del parámetro de fila).
      // El surco se funde entre rowW[0] y rowW[1] (período de 10 a 3 px): nunca se muestrea cerca de Nyquist → sin moiré.
      // Las bandas (8 surcos, período ×8) toman la posta (fundido cruzado) y se funden con su propio w.
      "  float fu = max(fwidth(vRow.x), 1e-4);\n" +
      "  float wR = fu / uRow.x;\n" +
      "  float inB = smoothstep(uW.x, uW.y, wR);\n" +
      "  float aRow = fD * (1.0 - inB);\n" +
      "  float aBand = fD * inB * (1.0 - smoothstep(uW.z, uW.w, wR * 0.125));\n" +
      "  if (aRow < 0.003 && aBand < 0.003 && fTram < 0.002) discard;\n" +
      "  vec2 p = vWp.xz;\n" +
      "  float patchy = 0.55 + 0.9 * texture2D(tNoise, p * " + nu(9) + " + vec2(0.13, 0.61)).b;\n" +   // rastrojo: manchones
      "  float warp = (texture2D(tNoise, p * " + nu(45) + " + vec2(0.52, 0.27)).g - 0.5) * 5.0;\n" +    // bandas onduladas: sin paralelismo perfecto
      "  float speck = (texture2D(tNoise, p * " + nu(0.35) + ").r - 0.5) * 0.10 * aRow;\n" +             // el mipmap lo funde solo
      "  float m = 1.0 + (aRow * uRow.y * sin(6.2831853 * vRow.x / uRow.x)\n" +
      "                 + aBand * uBandAmp * sin(6.2831853 * vRow.x / (uRow.x * 8.0) + 1.7 + warp)) * patchy + speck;\n" +
      // huellas de pulverizadora: dos líneas de ancho uTram.z separadas uTram.y, cada uTram.x m
      "  float q = mod(vRow.x, uTram.x) - uTram.x * 0.5;\n" +
      "  float dd = abs(abs(q) - uTram.y * 0.5);\n" +
      "  float hw = uTram.z * 0.5;\n" +
      "  float line = 1.0 - smoothstep(hw - fu * 0.75, hw + fu * 0.75, dd);\n" +
      "  line *= min(1.0, sqrt(hw / (fu * 1.5)));\n" +
      "  float broken = 0.6 + 0.8 * texture2D(tNoise, vec2(vRow.y * " + nu(40) + ", floor(vRow.x / uTram.x) * 0.137) + vec2(0.9, 0.3)).g;\n" +
      "  m -= uTram.w * fTram * line * min(broken, 1.0);\n" +
      // salida = factor/2: con blend (DST_COLOR, SRC_COLOR) el resultado es dst * factor
      "  gl_FragColor = vec4(vec3(0.5 * m), 0.5);\n}"
  });
  m.depthTest = false; m.depthWrite = false; m.transparent = false; m.toneMapped = false;
  if (hasH) { m.depthTest = true; m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4; }   // A6: ver makeGroundMaterial
  m.side = THREE.DoubleSide;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.DstColorFactor; m.blendDst = THREE.SrcColorFactor;
  m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  return m;
}

/* ---------- el sistema ---------- */
const S = {};            // scenarioKey → { group, gMesh, fMesh, gMat, fMat, opacity, info }
const LAYER_OFF = { herbExt: 0.001, woody: 0.001, pattern: 0 };
/* Modo de suelo por calidad: "completo" | "sin-surcos" | "simple" | "apagado". "simple" = Baja con A4_GROUND.lowSoil (Baja ya no dibuja
   plantas: el suelo la cubre, sin 2.a muestra de textura, sin ruido fino y sin franja de AO). quality.js sigue diciendo soil: "apagado" para
   Baja; la traduccion vive aca para no tocar archivos ajenos (pedido opcional: renombrar a "simple" en quality.js). */
const soilMode = q => (q.soil === "apagado" && A4_GROUND.lowSoil ? (A4_GROUND.lowSoilMode === "textura" ? "simple" : "plano") : q.soil);
/* G5b "plano": Baja sin malla Three; las capas MapLibre herb-ext (ya dibujadas en Baja desde siempre) llevan el color promedio de Alta. */
const flatLow = () => groundWanted() && soilMode(quality) === "plano";
const lite = () => soilMode(quality) === "simple";
const furrowsFor = q => furrowsWanted() && soilMode(q) === "completo" && !(!(DBG && params.has("surcos")) && A4_FURROWS.byQuality[q.name] === false);
let active = groundWanted() && soilMode(quality) !== "apagado" && soilMode(quality) !== "plano";
let furrowsOn = furrowsFor(quality);

const pfx = key => (key === "inicial" ? "ini" : "multi");
const setPaint = (id, prop, v) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); };

/* Capas MapLibre de las clases reemplazadas: casi invisibles pero vivas (T9) cuando el suelo está activo;
   valores originales de layers.js cuando no (calidad Baja). */
const HERB_ORIG = {};   // expresion original de fill(-extrusion)-color de herb-ext, para restaurarla fuera de Baja
function paintHerbColor(p) {
  const id = `${p}-herb-ext`, L = map.getLayer(id); if (!L) return;
  const prop = L.type === "fill" ? "fill-color" : "fill-extrusion-color";
  if (!(id in HERB_ORIG)) HERB_ORIG[id] = map.getPaintProperty(id, prop);
  const lv = soilVar(), LC = { ...A4_GROUND.lowColor, ...(lv.lowColor || {}) }, LX = { ...A4_GROUND.lowColorExtr, ...(lv.lowColorExtr || {}) };
  const C = L.type === "fill" ? LC : { ...LC, ...LX };
  const o = HERB_ORIG[id];   // ["match", ["get","_cls"], "corr-herb", c, "bajo", c, "parche-herb", c, default]
  map.setPaintProperty(id, prop, flatLow() ? [o[0], o[1], o[2], C["corr-herb"], o[4], o[5], o[6], C["parche-herb"], o[8]] : o);
}
function syncMapLayers(key) {
  const s = S[key]; if (!s) return;
  const o = s.opacity, p = pfx(key);
  paintHerbColor(p);
  if (flatLow()) {   // G5b: herb-ext recoloreado (pattern fuera: Baja mas barata que antes), woody-base como siempre
    setPaint(`${p}-herb-ext`, extOpacityProp(), A4_GROUND.lowColor.opacity * o);
    setPaint(`${p}-herb-pattern`, extOpacityProp(), 0);
    setPaint(`${p}-woody-base`, extOpacityProp(), WOODY_BASE.opacity * o);
  } else if (active) {
    setPaint(`${p}-herb-ext`, extOpacityProp(), LAYER_OFF.herbExt * o);   // A6: extOpacityProp() = fill-opacity con terreno (T14), fill-extrusion-opacity sin terreno
    setPaint(`${p}-herb-pattern`, extOpacityProp(), LAYER_OFF.pattern * o);
    setPaint(`${p}-woody-base`, extOpacityProp(), LAYER_OFF.woody * o);
  } else {
    setPaint(`${p}-herb-ext`, extOpacityProp(), 0.9 * o);
    setPaint(`${p}-herb-pattern`, extOpacityProp(), 0.75 * o);
    setPaint(`${p}-woody-base`, extOpacityProp(), WOODY_BASE.opacity * o);
  }
}

function applyModes() {
  for (const k in S) {
    S[k].gMesh.visible = active;
    S[k].gMat.userData.a4u.uLite.value = lite() ? 1 : 0;
    S[k].gMesh.geometry.setDrawRange(0, lite() ? S[k].info.topTris * 3 : Infinity);   // simple: sin la franja de AO (sus triangulos van despues de las tapas)
    if (S[k].fMesh) S[k].fMesh.visible = active && furrowsOn;
    syncMapLayers(k);
  }
}

export default {
  id: "ground",

  build(ctx, key, data) {
    const t0 = performance.now();
    const group = new THREE.Group();
    group.name = "a4-ground";
    // ¿hay terreno? (heightAt devuelve 0 mientras A6 no lo active): si es todo 0 se evita el costo por vértice
    const o = (() => { const mc = maplibregl.MercatorCoordinate.fromLngLat(HOME_VIEW.center, 0); return { mc, s: mc.meterInMercatorCoordinateUnits() }; })();
    const toLngLat = (x, z) => { const ll = new maplibregl.MercatorCoordinate(o.mc.x + x * o.s, o.mc.y + z * o.s, 0).toLngLat(); return [ll.lng, ll.lat]; };
    const c = HOME_VIEW.center;
    const hasH = [[0, 0], [0.01, 0], [-0.01, 0], [0, 0.01], [0, -0.01]].some(([a, b]) => ctx.heightAt(c[0] + a, c[1] + b) !== 0);

    const gg = buildGroundGeometry(ctx, data, toLngLat, hasH);
    const gMat = makeGroundMaterial(ctx, key, hasH, gg.dTex, gg.dmap);
    const gMesh = new THREE.Mesh(gg.geometry, gMat);
    gMesh.frustumCulled = false; gMesh.renderOrder = -10; gMesh.name = "a4-ground-" + key;
    group.add(gMesh);

    const fg = buildFurrowGeometry(ctx, data, toLngLat, hasH);   // A6: toLngLat/hasH para apoyar los surcos en el relieve
    const fMat = makeFurrowMaterial(ctx, hasH);
    const fMesh = new THREE.Mesh(fg.geometry, fMat);
    fMesh.frustumCulled = false; fMesh.renderOrder = -20; fMesh.name = "a4-furrows-" + key;
    group.add(fMesh);

    S[key] = { group, gMesh, fMesh, gMat, fMat, dTex: gg.dTex, opacity: key === "inicial" ? 1 : 0,
      info: { verts: gg.verts, tris: gg.tris, topTris: gg.topTris, ribTris: gg.ribTris, polys: gg.polys, failed: gg.failed, tiny: gg.tiny, furrowTris: fg.tris, lots: fg.lots, buildMs: Math.round(performance.now() - t0) } };
    applyModes();
    // materials vacío: el host no re-parcha (la niebla y el fade ya van en patch()); los surcos no usan niebla
    return { object3d: group, materials: [] };
  },

  setOpacity(key, o) {
    const s = S[key]; if (!s) return;
    s.opacity = o;
    s.fMat.uniforms.uFadeS.value = o;   // multiplicativo: se funde a "sin efecto" en vez de dither
    syncMapLayers(key);
  },

  setGrowth(key, t) {
    const s = S[key]; if (!s) return;
    s.gMat.userData.a4u.uGrow.value = t;   // revelado desde el eje (única variante desde a4-g2)
  },

  update(frame) {
    // surcos: más allá de ~1,5 km no se ven (curvas de intensidad): ahorro del draw
    const far = frame.camera && frame.camera.altitudeM > A4_FURROWS.tramFade[1];
    for (const k in S) if (S[k].fMesh) S[k].fMesh.visible = active && furrowsOn && !far;
    if (DBG && params.has("a4solo")) {   // solo QA: oculta árboles y pasto para medir el suelo solo
      for (const k in S) for (const ch of S[k].group.parent ? S[k].group.parent.children : []) if (ch !== S[k].group) ch.visible = false;
    }
  },

  onQuality(q) {
    active = groundWanted() && soilMode(q) !== "apagado" && soilMode(q) !== "plano";
    furrowsOn = furrowsFor(q);
    if (active && Object.keys(S).length) ensureSoilTex(soilMode(q) === "simple");   // textura 512 en Baja, 1024 en el resto
    applyModes();
  },

  dispose() {
    for (const k in S) { S[k].gMesh.geometry.dispose(); S[k].gMat.dispose(); S[k].dTex.dispose(); S[k].fMesh.geometry.dispose(); S[k].fMat.dispose(); }
  },

  stats(key) { return S[key] ? { suelo: { ...S[key].info, texMs, texSize: SOIL.size, modo: soilMode(quality), variante: soilVariant(), texMean } } : {}; }
};

/* A4 (water.js reutiliza la triangulación del suelo) */
export { dedupRing, triangulatePoly };
