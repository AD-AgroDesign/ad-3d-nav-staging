/* ============ Sistema de render: fauna (Ola 3, A5) ============
   Dueño: A5. Contrato: §6.3. Diales en config.js (bloque A5) y método en handoffs/a5-fauna.md.

   Dos piezas, ambas procedurales (sin assets) y por escenario (cuelgan del grupo del escenario:
   el cross-fade por dither y la visibilidad vienen del host):
     - AVES: bandadas de 8-25 en recorridos cerrados (Catmull-Rom) alrededor de parches leñosos,
       a 25-56 m sobre el suelo. Una sola InstancedMesh de 8 tris por ave; la CPU solo coloca cada
       ave (matriz) y el aleteo corre en el vertex shader (fase, frecuencia y planeo propios de cada ave).
     - POLINIZADORES: mariposas de 18 tris (alas anterior y posterior con forma, G3) sobre corr-herb y parche-herb, instanciadas por celda
       (chunks.js). Todo el movimiento (vuelo errático, rumbo, aleteo) corre en el vertex shader; solo se
       dibujan las celdas a menos de ~85 m de la cámara y se achican con la distancia (uCamPos, T1; G3: solo con la cámara muy cerca).
   Narrativa: en `inicial`, pocas aves (D-4: 1 de 4) y ningún polinizador; en `multi`, abundante.
   Reposo (T7): pide repintado al idleDriver del host (render/idle.js, tope quality.idleFps) solo si hay fauna en cuadro;
   apagada en calidad Baja (fauna = 0); Media = 50 %. Tiempo: uniforms.uTime (lo congela __nav3d.freezeTime) y
   funciones cerradas del tiempo (sin integrar dt: T5 no aplica salvo en el lazo de reposo, que usa max(0, …)). */
import * as THREE from "three";
import { idleDriver } from "../idle.js?v=20261201";
import { A5_FAUNA, TREE_SPECIES } from "../../core/config.js?v=20261201";
import { state } from "../../core/state.js?v=20261201";
import { scatterInClasses } from "../../core/geo.js?v=20261201";
import { quality } from "../../core/quality.js?v=20261201";
import { uniforms } from "../lighting.js?v=20261201";
import { patch } from "../shaderlib.js?v=20261201";
import { lowAt, terrain } from "../../terrain/terrain.js?v=20261201";
import { cellSeed, chainShader, partitionCells, shuffleDet } from "./chunks.js?v=20261201";

const C = A5_FAUNA, CB = C.birds, CF = C.butterflies;
const TAU = Math.PI * 2;

/* ---------- utilidades ---------- */
const srgb = v => Math.pow(v, 2.2);
/* hex sRGB de diseño → rgb lineal (el renderer convierte a sRGB al salir; ColorManagement está apagado) */
function linRGB(hex, out = [0, 0, 0]) {
  out[0] = srgb(((hex >> 16) & 255) / 255); out[1] = srgb(((hex >> 8) & 255) / 255); out[2] = srgb((hex & 255) / 255);
  return out;
}
function pickWeighted(palette, u) {
  let s = 0; for (const [, w] of palette) s += w;
  let a = u * s;
  for (const [c, w] of palette) { if ((a -= w) <= 0) return c; }
  return palette[palette.length - 1][0];
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const TREE_TOP = Math.max(...Object.values(TREE_SPECIES).map(s => s.h[1]));   // copa más alta posible (m)
const ALT_MIN = Math.max(CB.alt[0], TREE_TOP + CB.treeClear);                  // piso real del vuelo (m sobre el suelo)

/* ============================ AVES ============================ */

/* Ave unitaria (envergadura 1 en X, nariz +Z): cuerpo 2 tris + 3 tris por ala = 8 tris.
   El aleteo lo hace el vertex shader levantando Y según |x| (la punta se mueve más que la raíz). */
function birdGeometry() {
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  const N = [0, 0, 0.36], L = [-0.06, 0, 0.04], R = [0.06, 0, 0.04], T = [0, 0, -0.28];
  tri(N, L, R); tri(L, T, R);                           // cuerpo
  for (const s of [1, -1]) {                            // ala derecha / izquierda (espejo): cuerda ancha, se lee desde arriba
    const A = [0.06 * s, 0, 0.14], B = [0.06 * s, 0, -0.20], Cc = [0.27 * s, 0, 0.10], D = [0.27 * s, 0, -0.20], E = [0.5 * s, 0, -0.07];
    tri(A, Cc, B); tri(Cc, D, B); tri(Cc, E, D);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const BIRD_VS = `
attribute vec4 aBird;      // (fase, velocidad angular del aleteo, semilla de planeo, -)
uniform float uTime;
`;
const BIRD_BEGIN = `
vec3 transformed = vec3(position);
{
  float w = clamp((abs(position.x) - 0.05) / 0.45, 0.0, 1.0);          // 0 en el cuerpo, 1 en la punta del ala
  float fl = sin(uTime * aBird.y + aBird.x - w * 1.1);                 // la punta se atrasa respecto de la raíz
  float g = smoothstep(0.35, 0.65, 0.5 + 0.5 * sin(uTime * (0.21 + 0.12 * aBird.z) + aBird.z * 40.0));   // 1 = planeo
  float amp = mix(1.0, 0.10, g);
  transformed.y += w * w * (0.34 * fl * amp + 0.11 - 0.05 * g);        // aleteo (en envergaduras) + diedro
  transformed.z -= w * w * 0.05 * fl * amp;                            // la punta barre hacia atrás al bajar
}
`;

/* Recorrido cerrado Catmull-Rom (uniforme) por K puntos de control [x, alt, z]; devuelve M muestras
   equiespaciadas en longitud de arco con tangente y curvatura. La altura "alt" es sobre el suelo local. */
function buildPath(ctx, ctrl, M) {
  const K = ctrl.length, N = 12 * K;
  const pts = new Array(N);
  for (let i = 0; i < N; i++) {
    const u = (i / N) * K, k = Math.floor(u), t = u - k;
    const p0 = ctrl[(k + K - 1) % K], p1 = ctrl[k % K], p2 = ctrl[(k + 1) % K], p3 = ctrl[(k + 2) % K];
    const t2 = t * t, t3 = t2 * t;
    const q = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      q[c] = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
    }
    pts[i] = q;
  }
  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const L = cum[N];
  const px = new Float32Array(M), py = new Float32Array(M), pz = new Float32Array(M);   // py = altura sobre el suelo
  let j = 0;
  for (let m = 0; m < M; m++) {
    const s = (m / M) * L;
    while (j < N - 1 && cum[j + 1] < s) j++;
    const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    const a = pts[j], b = pts[(j + 1) % N];
    px[m] = a[0] + (b[0] - a[0]) * f; py[m] = a[1] + (b[1] - a[1]) * f; pz[m] = a[2] + (b[2] - a[2]) * f;
  }
  /* altura de suelo bajo el recorrido: máximo en un entorno de ±10 m (la bandada ocupa ~±8 m de ancho) */
  const gy = new Float32Array(M);
  for (let m = 0; m < M; m++) {
    let g = ctx.heightAtScene(px[m], pz[m]);
    for (const [dx, dz] of [[10, 0], [-10, 0], [0, 10], [0, -10]]) g = Math.max(g, ctx.heightAtScene(px[m] + dx, pz[m] + dz));
    gy[m] = g;
  }
  const tx = new Float32Array(M), ty = new Float32Array(M), tz = new Float32Array(M), cr = new Float32Array(M);
  const ds = L / M;
  for (let m = 0; m < M; m++) {
    const a = (m + M - 1) % M, b = (m + 1) % M;
    const dx = px[b] - px[a], dy = (py[b] + gy[b]) - (py[a] + gy[a]), dz = pz[b] - pz[a], n = Math.hypot(dx, dy, dz) || 1;
    tx[m] = dx / n; ty[m] = dy / n; tz[m] = dz / n;
  }
  for (let m = 0; m < M; m++) {   // curvatura horizontal con signo (+ = gira a la derecha del rumbo)
    const b = (m + 1) % M, a = (m + M - 1) % M;
    cr[m] = ((tx[b] - tx[a]) * tz[m] - (tz[b] - tz[a]) * tx[m]) / (2 * ds);
  }
  return { M, L, px, py, pz, gy, tx, ty, tz, cr };
}

/* Parches leñosos: centros de gravedad de los árboles por celda, ordenados por cantidad y con separación mínima. */
function findAnchors(treesXZ, corrXZ) {
  const cells = partitionCells(treesXZ, CB.anchorCell, o => o.xz);
  /* distancia al corredor herbáceo más cercano (grilla de 150 m sobre una muestra de matas de corr-herb) */
  const G = 150, grid = new Map();
  for (const [x, z] of corrXZ) { const k = Math.floor(x / G) + "," + Math.floor(z / G); (grid.get(k) || grid.set(k, []).get(k)).push([x, z]); }
  const nearCorr = (x, z) => {
    let best = Infinity;
    const ix = Math.floor(x / G), iz = Math.floor(z / G);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const l = grid.get((ix + dx) + "," + (iz + dz)); if (!l) continue;
      for (const [cx, cz] of l) best = Math.min(best, Math.hypot(cx - x, cz - z));
    }
    return best;
  };
  const list = [];
  for (const c of cells.values()) {
    if (c.items.length < CB.anchorMinTrees) continue;
    let cx = 0, cz = 0;
    for (const o of c.items) { cx += o.xz[0]; cz += o.xz[1]; }
    cx /= c.items.length; cz /= c.items.length;
    let r2 = 0;
    for (const o of c.items) r2 += (o.xz[0] - cx) ** 2 + (o.xz[1] - cz) ** 2;
    const dc = nearCorr(cx, cz);
    list.push({ x: cx, z: cz, n: c.items.length, spread: Math.sqrt(r2 / c.items.length), key: c.key, dCorr: dc,
                score: c.items.length * (dc < CB.corrNear ? CB.corrBonus : 1) });
  }
  list.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
  const out = [];
  for (const a of list) if (out.every(b => Math.hypot(a.x - b.x, a.z - b.z) >= CB.anchorSep)) out.push(a);
  return out;
}

/* total de aves de multi según su cantidad de árboles; el de inicial es la fracción D-4 (sin pasar de lo que sus árboles sostienen) */
function birdTarget(key) {
  const nM = (state.veg.multi && state.veg.multi.trees || []).length;
  const multi = Math.min(CB.max, Math.max(CB.min, Math.round(nM / CB.treesPerBird)));
  if (key === "multi") return multi;
  const nI = (state.veg.inicial && state.veg.inicial.trees || []).length;
  return Math.min(Math.round(multi * C.ratioInicial), Math.round(nI / CB.treesPerBird * 0.8));
}

/* G5: anclas de fauna sobre los polígonos herbáceos (_cls del FeatureCollection), sin depender de las matas viejas (retiradas).
   Muestreo determinista propio: semilla fija por escenario y clase, densidad = la de las matas viejas / porMata (misma narrativa y zonas). */
const HERB_SEED = { inicial: 13072026, multi: 62027031 };
function herbPoints(fc, key, cls, perPlant, frac = 1) {
  const cfg = C.herbAnchors[cls];
  if (!fc || !cfg || !(frac > 0)) return [];
  const k = cfg.k;
  return scatterInClasses(fc, [cls], HERB_SEED[key] + k * 977 + 5, cfg.density * frac / perPlant, cfg.max * frac / perPlant, 0).points;
}

function buildFlocks(ctx, key, trees, fc) {
  const rng = ctx.rng(C.seed + (key === "multi" ? 2 : 1));
  const withXZ = trees.map(t => ({ xz: ctx.toScene(t.lon, t.lat) }));
  const corrXZ = herbPoints(fc, key, "corr-herb", 40).map(([lon, lat]) => ctx.toScene(lon, lat));
  const anchors = findAnchors(withXZ, corrXZ);
  const target = birdTarget(key);
  const flocks = [];
  if (!anchors.length || target <= 0) return flocks;
  const nF = Math.max(1, Math.min(anchors.length, Math.round(target / 16)));
  const wts = Array.from({ length: nF }, () => 0.6 + rng());
  const sw = wts.reduce((a, b) => a + b, 0);
  for (let f = 0; f < nF; f++) {
    const a = anchors[f];
    const size = Math.max(CB.flockSize[0], Math.min(CB.flockSize[1], Math.round(target * wts[f] / sw)));
    /* puntos de control alrededor del parche: ángulos y radios con jitter moderado (sin autocruces) */
    const K = 7, rho0 = CB.orbit[0] + rng() * (CB.orbit[1] - CB.orbit[0]) + a.spread * 0.6;
    const th0 = rng() * TAU, ctrl = [];
    for (let k = 0; k < K; k++) {
      const th = th0 + (k + (rng() - 0.5) * 0.4) * TAU / K, rho = rho0 * (0.8 + rng() * 0.4);
      ctrl.push([a.x + Math.cos(th) * rho, ALT_MIN + 1 + rng() * (CB.alt[1] - ALT_MIN - 1), a.z + Math.sin(th) * rho]);
    }
    const path = buildPath(ctx, ctrl, 160);
    const flock = { key: a.key, size, path, speed: CB.speed[0] + rng() * (CB.speed[1] - CB.speed[0]), s0: rng() * path.L, birds: [], anchor: a };
    /* posiciones relativas en la bandada: lag a lo largo del recorrido, lateral y vertical; separación mínima ~3 m */
    const lagMax = 10 + size * 1.6, latMax = 5 + size * 0.4;
    for (let b = 0; b < size; b++) {
      let best = null;
      for (let tries = 0; tries < 24; tries++) {
        const c = { lag: Math.pow(rng(), 1.25) * lagMax, lat: (rng() - 0.5) * 2 * latMax, vert: (rng() - 0.5) * 5 };
        const dmin = Math.min(Infinity, ...flock.birds.map(o => Math.hypot(o.lag - c.lag, o.lat - c.lat, (o.vert - c.vert) * 1.5)));
        if (!best || dmin > best.d) best = { c, d: dmin };
        if (dmin >= 4.5) break;
      }
      flock.birds.push({
        ...best.c,
        ph: rng() * TAU, ph2: rng() * TAU, ph3: rng() * TAU,                    // fases del bamboleo (cada ave la suya)
        wobLag: 0.4 + rng() * 0.7, wobLat: 0.5 + rng() * 0.6,
        span: CB.span * (1 + (rng() * 2 - 1) * CB.spanVar),
        hz: CB.flapHz[0] + rng() * (CB.flapHz[1] - CB.flapHz[0]),
        glide: rng(), col: pickWeighted(CB.palette, rng()), u: rng()
      });
    }
    flocks.push(flock);
  }
  return flocks;
}

/* Pose de un ave en el instante T (s): escribe posición en `o.p` y la base (derecha, arriba, adelante) en `o.r/o.u/o.f`. */
const _o = { p: [0, 0, 0], r: [0, 0, 0], u: [0, 0, 0], f: [0, 0, 0] };
function birdPose(fl, b, T, o = _o) {
  const P = fl.path, M = P.M;
  const wob = Math.sin(T * 0.37 + b.ph) * b.wobLag;
  let s = (fl.s0 + T * fl.speed - b.lag + wob) % P.L; if (s < 0) s += P.L;
  const fi = s / P.L * M, i0 = Math.floor(fi) % M, i1 = (i0 + 1) % M, f = fi - Math.floor(fi);
  const L = (a, bb) => a + (bb - a) * f;
  const tx = L(P.tx[i0], P.tx[i1]), ty = L(P.ty[i0], P.ty[i1]), tz = L(P.tz[i0], P.tz[i1]);
  const tn = Math.hypot(tx, ty, tz) || 1, fx = tx / tn, fy = ty / tn, fz = tz / tn;
  // derecha = arriba_mundo × adelante = (fz, 0, -fx) normalizada; arriba' = adelante × derecha
  let rx = fz, rz = -fx; const rn = Math.hypot(rx, rz) || 1; rx /= rn; rz /= rn;
  let ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;
  const lat = b.lat + Math.sin(T * 0.51 + b.ph2) * b.wobLat, vert = b.vert + Math.sin(T * 0.63 + b.ph3) * 0.8;
  const px = L(P.px[i0], P.px[i1]) + rx * lat, pz = L(P.pz[i0], P.pz[i1]) + rz * lat;
  const py = L(P.gy[i0], P.gy[i1]) + L(P.py[i0], P.py[i1]) + vert;
  const bank = Math.max(-0.5, Math.min(0.5, L(P.cr[i0], P.cr[i1]) * 55)), cb = Math.cos(bank), sb = Math.sin(bank);
  o.p[0] = px; o.p[1] = py; o.p[2] = pz;
  o.f[0] = fx; o.f[1] = fy; o.f[2] = fz;
  o.r[0] = rx * cb - ux * sb; o.r[1] = -uy * sb; o.r[2] = rz * cb - uz * sb;
  o.u[0] = ux * cb + rx * sb; o.u[1] = uy * cb; o.u[2] = uz * cb + rz * sb;
  return o;
}

/* ============================ POLINIZADORES ============================ */

/* Mariposa unitaria (envergadura 1 en X, nariz +Z), 18 tris: por lado ala anterior (4 tris, punta apuntada) y
   ala posterior (3 tris, lóbulo redondeado con cola), cuerpo en rombo y dos antenas. El color por vértice
   (k) oscurece el borde y la raíz (nervadura/margen) y se multiplica por el color de instancia. */
function butterflyGeometry() {
  const pos = [], col = [];
  const tri = (a, b, c) => { for (const v of [a, b, c]) { pos.push(v[0], 0, v[1]); col.push(v[2], v[2], v[2]); } };
  for (const s of [1, -1]) {
    const P = (x, z, k) => [x * s, z, k];
    // ala anterior: borde de ataque recto, ápice, margen externo, base
    const r0 = P(0.03, 0.10, 0.45), r1 = P(0.03, -0.03, 0.45), l1 = P(0.22, 0.17, 0.85), ap = P(0.48, 0.17, 0.22), o = P(0.45, 0.00, 0.40), t = P(0.30, -0.08, 0.75);
    tri(r0, l1, r1); tri(l1, t, r1); tri(l1, ap, t); tri(ap, o, t);
    // ala posterior: abanico desde la raíz, cola en el vértice trasero
    const h0 = P(0.03, -0.03, 0.45), h1 = P(0.30, -0.06, 0.80), h2 = P(0.36, -0.19, 0.35), h3 = P(0.21, -0.31, 0.30), h4 = P(0.07, -0.21, 0.6);
    tri(h0, h1, h2); tri(h0, h2, h3); tri(h0, h3, h4);
    // antena
    tri([-0.004 * s, 0.15, 0.1], [0.004 * s, 0.15, 0.1], [0.07 * s, 0.30, 0.1]);
  }
  // cuerpo: rombo fino (cabeza-tórax-abdomen)
  tri([0, 0.15, 0.08], [-0.028, 0.02, 0.08], [0.028, 0.02, 0.08]); tri([-0.028, 0.02, 0.08], [0, -0.30, 0.08], [0.028, 0.02, 0.08]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

const BFLY_VS = `
attribute vec4 aS1;        // (fase de x, fase de z, fase de altura, fase de aleteo) en 0..1
attribute vec4 aS2;        // (amplitud x, amplitud z, tamaño/frecuencia, altura) en 0..1
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uA5Vis;       // (cerca, lejos, crecimiento lejano): se achican a 0 entre cerca y lejos; entre 60 m y el límite lejano crecen hasta ×z (se siguen leyendo: la cámara no baja de ~125 m del suelo visible)
uniform vec3 uA5B;         // (envergadura m, alt mínima m, alt máxima m)
uniform vec2 uA5Wan;       // radio de vuelo errático (mín, máx) m
uniform float uA5Grow;     // crecimiento del escenario (0..1): la fauna aparece con la vegetación
`;
const BFLY_BEGIN = `
vec3 transformed = vec3(position);
{
  vec3 home = instanceMatrix[3].xyz;
  float t = uTime;
  float p1 = aS1.x * 6.2832, p2 = aS1.y * 6.2832, p3 = aS1.z * 6.2832, pf = aS1.w * 6.2832;
  float A = mix(uA5Wan.x, uA5Wan.y, aS2.x), B = mix(uA5Wan.x, uA5Wan.y, aS2.y);
  float w1 = 0.20 + 0.14 * aS2.x, w2 = 0.27 + 0.14 * aS2.y;
  vec2 off = vec2(A * sin(w1 * t + p1) + 0.35 * A * sin(2.3 * w1 * t + p2), B * sin(w2 * t + p2));
  vec2 vel = vec2(A * w1 * cos(w1 * t + p1) + 0.35 * A * 2.3 * w1 * cos(2.3 * w1 * t + p2), B * w2 * cos(w2 * t + p2));
  float alt = mix(uA5B.y, uA5B.z, aS2.w) + 0.45 * sin(0.9 * t + p3);
  float yaw = atan(vel.x, vel.y);
  float fr = 15.0 + 8.0 * aS2.z;                                       // aleteo ~2,5-3,7 Hz (con pausas de planeo)
  float glide = smoothstep(0.55, 0.85, sin(0.7 * t + p3 * 2.0));        // 1 = alas abiertas casi quietas
  float lagW = smoothstep(0.04, -0.14, position.z) * 0.55;              // el ala posterior se atrasa respecto de la anterior
  float a = mix(0.25 + 1.0 * sin(fr * t + pf - lagW), 0.45 + 0.15 * sin(fr * 0.4 * t + pf), glide);   // ángulo de las alas (rad)
  float sx = position.x < 0.0 ? -1.0 : 1.0, ax = abs(position.x);
  float hw = clamp((ax - 0.03) / 0.02, 0.0, 1.0);                       // 0 en el cuerpo, 1 en las alas
  vec3 lp = vec3(sx * (0.03 + (ax - 0.03) * cos(a) * hw + (ax - 0.03) * (1.0 - hw)), (ax - 0.03) * sin(a) * hw, position.z);
  lp.y += 0.035 * sin(fr * t + pf) * (1.0 - glide);                       // el cuerpo cabecea con el aleteo
  lp.z += 0.02 * hw * (1.0 - cos(a));                                    // las alas se adelantan un poco al subir
  float cy = cos(yaw), sy = sin(yaw);
  float dc = distance(uCamPos, home);
  float sc = uA5B.x * (0.8 + 0.5 * aS2.z) * mix(1.0, uA5Vis.z, smoothstep(60.0, uA5Vis.y, dc)) * (1.0 - smoothstep(uA5Vis.x, uA5Vis.y, dc)) * smoothstep(0.35, 1.0, uA5Grow);
  transformed = vec3(lp.x * cy + lp.z * sy, lp.y, -lp.x * sy + lp.z * cy) * sc + vec3(off.x, alt, off.y);
}
`;

/* ============================ sistema ============================ */

const built = {};   // scenarioKey → { group, birds, flocks, bfly: [chunk…], grow: {value}, stats }
let hostCtx = null;

function makeMat(key, tag, vsDecl, begin, extra, vertexColors = false) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, side: THREE.DoubleSide, vertexColors });
  mat.userData.foliage = false;                                   // el host no le pone wrap/translucidez de follaje
  patch(mat, { fog: true, fade: key });                           // niebla unificada + cross-fade por dither
  chainShader(mat, tag, sh => {
    sh.uniforms.uTime = uniforms.uTime;
    if (extra) extra(sh);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\n" + vsDecl)
      .replace("#include <begin_vertex>", begin);                 // reemplaza (no encadena): el crecimiento lo contrarresta setGrowth
  });
  return mat;
}

/* ---- reposo (T7): el repintado lo maneja el idleDriver único del host (render/idle.js); acá solo se avisa si hay fauna en cuadro ---- */

const _v4 = new THREE.Vector4();
function inView(vp, x, y, z, m = 1.25) {
  _v4.set(x, y, z, 1).applyMatrix4(vp);
  return _v4.w > 0 && Math.abs(_v4.x) <= _v4.w * m && Math.abs(_v4.y) <= _v4.w * m;
}

const lastStats = { birdsVis: 0, bflyVis: 0, chunksVis: 0 };

export default {
  id: "fauna",

  build(ctx, key, data, veg) {
    hostCtx = ctx;
    /* El fundido de símbolos (cadena de 5-8 frames por repintado en reposo) se apaga con fadeDuration: 0 en map/style.js. */
    const group = new THREE.Group();
    const info = { group, birds: null, flocks: [], bfly: [], grow: { value: 1 }, total: 0, nB: 0 };
    built[key] = info;
    if (!C.enabled) return { object3d: group, materials: [] };
    const materials = [];

    /* ---- aves ---- */
    const flocks = buildFlocks(ctx, key, (veg && veg.trees) || [], data);
    info.flocks = flocks;
    const slots = [];                           // orden round-robin entre bandadas: un prefijo es un raleo uniforme (Media = 50 %)
    for (let k = 0; k < CB.flockSize[1]; k++) for (const fl of flocks) if (k < fl.birds.length) slots.push([fl, fl.birds[k]]);
    info.slots = slots;
    if (slots.length) {
      const g = birdGeometry();
      g.setAttribute("aBird", new THREE.InstancedBufferAttribute(new Float32Array(slots.length * 4), 4));
      const mat = makeMat(key, "a5bird", BIRD_VS, BIRD_BEGIN);
      const mesh = new THREE.InstancedMesh(g, mat, slots.length);
      const ab = g.getAttribute("aBird"), c3 = [0, 0, 0], col = new THREE.Color();
      slots.forEach(([, b], i) => {
        ab.setXYZW(i, b.ph, b.hz * TAU, b.glide, 0);
        linRGB(b.col, c3);
        const v = 0.92 + b.u * 0.16;
        mesh.setColorAt(i, col.setRGB(c3[0] * v, c3[1] * v, c3[2] * v));
      });
      mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;                // ≤130 instancias de 8 tris; la CPU ya las descarta por distancia
      mesh.count = 0;
      group.add(mesh);
      materials.push(mat);
      info.birds = mesh;
    }

    /* ---- polinizadores ---- */
    const frac = key === "multi" ? 1 : CF.inicial;
    if (frac > 0 && data) {
      let homes = [];
      for (const [cls, per] of Object.entries(CF.tuftsPerButterfly)) {
        for (const [lon, lat] of herbPoints(data, key, cls, per, frac)) {
          const xz = ctx.toScene(lon, lat);
          homes.push({ x: xz[0], z: xz[1], gy: ctx.heightAt(lon, lat) });
        }
      }
      if (homes.length > CF.max) { const st = homes.length / CF.max; homes = Array.from({ length: CF.max }, (_, i) => homes[Math.floor(i * st)]); }
      const geo = butterflyGeometry();
      const mat = makeMat(key, "a5bfly", BFLY_VS, BFLY_BEGIN, sh => {
        sh.uniforms.uCamPos = uniforms.uCamPos;
        sh.uniforms.uA5Vis = { value: new THREE.Vector3(CF.visDist[0], CF.visDist[1], CF.farBoost) };
        sh.uniforms.uA5B = { value: new THREE.Vector3(CF.span, CF.alt[0], CF.alt[1]) };
        sh.uniforms.uA5Wan = { value: new THREE.Vector2(CF.wander[0], CF.wander[1]) };
        sh.uniforms.uA5Grow = info.grow;
      }, true);
      materials.push(mat);
      const cells = partitionCells(homes, CF.cell, o => [o.x, o.z]);
      const m4 = new THREE.Matrix4(), col = new THREE.Color(), c3 = [0, 0, 0];
      for (const cell of cells.values()) {
        shuffleDet(cell.items, cellSeed(cell.ix, cell.iz, 5));
        const n = cell.items.length, r = ctx.rng(cellSeed(cell.ix, cell.iz, 55));
        const g = geo.clone();
        const a1 = new Float32Array(n * 4), a2 = new Float32Array(n * 4);
        for (let i = 0; i < n * 4; i++) { a1[i] = r(); a2[i] = r(); }
        g.setAttribute("aS1", new THREE.InstancedBufferAttribute(a1, 4));
        g.setAttribute("aS2", new THREE.InstancedBufferAttribute(a2, 4));
        const mesh = new THREE.InstancedMesh(g, mat, n);
        let cx = 0, cy = 0, cz = 0;
        cell.items.forEach((o, i) => {
          mesh.setMatrixAt(i, m4.makeTranslation(o.x, o.gy, o.z));
          linRGB(pickWeighted(CF.palette, r()), c3);
          const v = 0.9 + r() * 0.2;
          mesh.setColorAt(i, col.setRGB(c3[0] * v, c3[1] * v, c3[2] * v));
          cx += o.x; cy += o.gy; cz += o.z;
        });
        cx /= n; cy /= n; cz /= n;
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
        const rad = Math.max(...cell.items.map(o => Math.hypot(o.x - cx, o.z - cz))) + CF.wander[1] * 1.6 + CF.alt[1] + 8;
        mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy + 2, cz), rad);
        mesh.frustumCulled = true;
        mesh.visible = false;
        group.add(mesh);
        info.bfly.push({ mesh, n, cx, cy, cz, rad, home: [cell.items[0].x, cell.items[0].z] });
        info.total += n;
      }
    }
    return { object3d: group, materials };
  },

  setGrowth(key, t) {
    const b = built[key]; if (!b) return;
    b.grow.value = t;
    // sin terreno el host escala Y del grupo con el crecimiento: se contrarresta (las aves vuelan a 25-56 m, no son vegetación)
    if (!terrain.active) b.group.scale.y = 1 / Math.max(t, 0.0001);
  },

  onQuality() { /* la cantidad se resuelve por frame desde quality.fauna */ },

  update(frame) {
    const f = quality.fauna;
    const T = uniforms.uTime.value, cam = frame.camPosScene, vp = frame.viewProj;
    let birdsVis = 0, bflyVis = 0, chunksVis = 0;
    for (const key in built) {
      const b = built[key], vis = f > 0 && C.enabled && b.group.parent && b.group.parent.visible;
      b.group.visible = !!vis;
      if (!vis) continue;
      /* aves: CPU por ave (≤130): pose + escala por distancia */
      if (b.birds) {
        const n = Math.ceil(b.slots.length * Math.min(1, f)), arr = b.birds.instanceMatrix.array;
        b.birds.count = n;
        const grow = smooth(0.35, 1, b.grow.value);
        for (let i = 0; i < n; i++) {
          const [fl, bd] = b.slots[i];
          const o = birdPose(fl, bd, T);
          const d = Math.hypot(o.p[0] - cam.x, o.p[1] - lowAt(o.p[0], o.p[2]) - cam.y, o.p[2] - cam.z);   // A6: ave bajada con el suelo (relieve en vivo)
          const sc = bd.span * Math.min(CB.farBoost, Math.max(1, d / CB.boostFrom)) * (1 - smooth(CB.maxDist[0], CB.maxDist[1], d)) * grow, k = i * 16;
          arr[k] = o.r[0] * sc; arr[k + 1] = o.r[1] * sc; arr[k + 2] = o.r[2] * sc; arr[k + 3] = 0;
          arr[k + 4] = o.u[0] * sc; arr[k + 5] = o.u[1] * sc; arr[k + 6] = o.u[2] * sc; arr[k + 7] = 0;
          arr[k + 8] = o.f[0] * sc; arr[k + 9] = o.f[1] * sc; arr[k + 10] = o.f[2] * sc; arr[k + 11] = 0;
          arr[k + 12] = o.p[0]; arr[k + 13] = o.p[1]; arr[k + 14] = o.p[2]; arr[k + 15] = 1;
          if (sc > 0.05 && inView(vp, o.p[0], o.p[1], o.p[2])) birdsVis++;
        }
        b.birds.instanceMatrix.needsUpdate = true;
      }
      /* polinizadores: solo las celdas cercanas; el resto de la animación es de shader */
      for (const c of b.bfly) {
        const ccy = c.cy - lowAt(c.cx, c.cz);   // A6: centro bajado con el suelo
        const d = Math.hypot(cam.x - c.cx, cam.y - ccy, cam.z - c.cz);
        const show = d < CF.visDist[1] + c.rad;
        c.mesh.visible = show;
        c.mesh.count = Math.ceil(c.n * Math.min(1, f));
        if (show && b.grow.value > 0.4) {
          chunksVis++;
          if (inView(vp, c.cx, ccy + 2, c.cz, 1.3 + c.rad / Math.max(d, 1))) bflyVis += c.mesh.count;
        }
      }
    }
    lastStats.birdsVis = birdsVis; lastStats.bflyVis = bflyVis; lastStats.chunksVis = chunksVis;
    idleDriver.request("fauna", birdsVis > 0 || bflyVis > 0);   // tiempo congelado, document.hidden e idleFps los resuelve el driver
  },

  /* para __nav3d.stats().instances[key].fauna */
  stats(key) {
    const b = built[key];
    if (!b) return {};
    const f = Math.min(1, quality.fauna);
    return { fauna: {
      aves: b.birds ? Math.ceil(b.slots.length * f) : 0,
      bandadas: b.flocks.length,
      tamBandadas: b.flocks.map(x => x.size),
      polinizadores: b.bfly.reduce((s, c) => s + Math.ceil(c.n * f), 0),
      celdasPolinizadores: b.bfly.length,
      enCuadro: { aves: lastStats.birdsVis, polinizadores: lastStats.bflyVis, celdas: lastStats.chunksVis }
    } };
  },

  /* Auditoría de vuelo (QA): simula `secs` segundos y mide la separación mínima de las aves con el suelo (heightAt)
     y con la copa más alta posible de los árboles cercanos (TREE_TOP). Devuelve metros. */
  audit(key, secs = 600, step = 0.5) {
    const b = built[key];
    if (!b || !hostCtx) return null;
    const trees = (state.veg[key].trees || []).map(t => hostCtx.toScene(t.lon, t.lat));
    const grid = new Map();
    for (const [x, z] of trees) { const k = Math.floor(x / 40) + "," + Math.floor(z / 40); (grid.get(k) || grid.set(k, []).get(k)).push([x, z]); }
    let minGround = Infinity, minTree = Infinity, treesNear = 0, minSep = Infinity;
    const o = { p: [0, 0, 0], r: [0, 0, 0], u: [0, 0, 0], f: [0, 0, 0] };
    for (let T = 0; T < secs; T += step) {
      for (const fl of b.flocks) {
        const pts = [];
        for (const bd of fl.birds) {
          birdPose(fl, bd, T, o);
          const g = hostCtx.heightAtScene(o.p[0], o.p[2]);
          minGround = Math.min(minGround, o.p[1] - g);
          const ix = Math.floor(o.p[0] / 40), iz = Math.floor(o.p[2] / 40);
          let near = false;
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            const l = grid.get((ix + dx) + "," + (iz + dz)); if (!l) continue;
            for (const [tx, tz] of l) if (Math.hypot(tx - o.p[0], tz - o.p[2]) < 30) near = true;
          }
          if (near) { treesNear++; minTree = Math.min(minTree, o.p[1] - g - TREE_TOP); }
          pts.push([o.p[0], o.p[1], o.p[2]]);
        }
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) minSep = Math.min(minSep, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]));
      }
    }
    return { minSobreSuelo: +minGround.toFixed(1), minSobreCopaMasAlta: +(minTree === Infinity ? NaN : minTree).toFixed(1), muestrasCercaDeArboles: treesNear, minSeparacionAves: +minSep.toFixed(2), copaMasAltaM: TREE_TOP, bandadas: b.flocks.length };
  },

  /* QA: posición (lon, lat) y tamaño de cada bandada en el instante T (s) */
  where(key, T = 12.5) {
    const b = built[key]; if (!b || !hostCtx) return [];
    return b.flocks.map(fl => {
      const o = birdPose(fl, fl.birds[0], T, { p: [0, 0, 0], r: [0, 0, 0], u: [0, 0, 0], f: [0, 0, 0] });
      const [lon, lat] = hostCtx.toLngLat(o.p[0], o.p[2]);
      const [alon, alat] = hostCtx.toLngLat(fl.anchor.x, fl.anchor.z);
      return { lon, lat, alon, alat, size: fl.size, pathLen: Math.round(fl.path.L), y: +o.p[1].toFixed(1) };
    });
  },

  /* QA: lon/lat de la mata de origen de un polinizador (el de la celda más poblada), para acercar la cámara */
  whereBfly(key) {
    const b = built[key]; if (!b || !hostCtx || !b.bfly.length) return null;
    const c = b.bfly.reduce((m, x) => (x.n > m.n ? x : m));
    const [lon, lat] = hostCtx.toLngLat(c.home[0], c.home[1]);
    return { lon, lat, x: c.home[0], z: c.home[1], celdas: b.bfly.length, nCelda: c.n };
  },

  dispose() {
    idleDriver.request("fauna", false);
    for (const k in built) delete built[k];
  }
};
