/* ============ Sistema de render: pasto de corredores y parches herbáceos (G5) ============
   Dueño: A2. Plan: realismo/PLAN_PASTO.md §3.1 y §3.2. Contrato de sistema: §6.3.

   Reemplaza a las matas de la Ola 1-2 (la decisión de Mike del 2026-11-14 retira la regla "las matas aprobadas no cambian").
   Las matas viejas (GRASS_CLASSES, generateGrassData, TUFT_GEOS y el gancho ?pasto=viejo) se retiraron al aprobarse la hoja G5.

   CÓMO FUNCIONA
   - Plantas = 3 tarjetas cruzadas (6 triángulos) con un atlas procedural de 6 tiles (grassgen.js). Un solo atlas y un solo material
     por escenario; cada celda es una InstancedMesh que comparte geometría base y material.
   - Las plantas NO se generan al cargar el campo (serían millones). Hay una lista precalculada de las celdas de 50 m (A2_PASTO.cell) que tocan
     polígonos corr-herb / parche-herb. Cada cuadro se activan, de las más cercanas a las más lejanas y con un presupuesto de ms por cuadro
     (A2_PASTO.budgetMs), las celdas que están a menos de R de la cámara y dentro del cuadro (o muy cerca). Las que quedan lejos se reciclan
     (los buffers vuelven a un pool por capacidad: sin basura).
   - Determinista: cada celda sale de mulberry32(cellSeed(ix, iz)) y la mezcla de especies, de un ruido de mundo (parches de ~9 m).
     Los candidatos se generan en un orden fijo y la calidad/lejanía solo cambian CUÁNTOS se generan (prefijo de la secuencia):
     un candidato siempre cae en el mismo lugar, con la misma especie, altura y giro.
   - Pertenencia al polígono SIN tocar ground.js (de A4): (1) al armar el escenario se rasteriza todo en un canvas 2D grueso (10 m/px) que da, por
     celda, la fracción cubierta por cada clase (así se arma la lista de celdas y las celdas totalmente adentro no necesitan máscara);
     (2) las celdas de borde rasterizan sus polígonos en un canvas 2D de 100×100 px (2 px/m) con Path2D precalculados y leen la máscara por
     candidato. Costo medido: ver handoffs/a2-pasto.md.
   - Raleo por distancia: la geometría lleva `aRank` (candidato/Nc); applyLod (chunks.js) encoge hasta 0 las instancias de rango alto entre
     nearM y R, y la CPU dibuja solo el prefijo con rango < keep (búsqueda binaria). Las celdas lejanas ni siquiera generan el resto
     (tiers: 1/8, 1/4, 1/2, todo) y se regeneran con más instancias al acercarse la cámara.
   - GPU: rampa de escala ×1,3 (hasta 50 m) → ×2 (300 m), desaparición entre 0,75·R y R, mipmaps de cobertura.

   MATERIAL: MeshLambertMaterial con `map` = atlas, encadenado con shaderlib.patch (viento, niebla, fade dither por escenario), applyLod, applyAO
   y, desde afuera, patchGrowth (A6) y la recepción de sombra de A3 (patchGrassReceive: busca userData.adChunks.wind y el texto de la niebla).
   alphaTest siempre; alphaToCoverage si el contexto tiene MSAA. El alfa del canvas queda intacto por shaderlib.keepFramebufferAlpha
   (mezcla personalizada: color = fuente, alfa = destino) porque el material lleva alphaTest/alphaToCoverage.

   QA (solo ?qa/?debug): ?pastoms=<ms de presupuesto> · window.__nav3dGrass { settle(), flush(), stats(), budget(ms) }. */
import * as THREE from "three";
import { A2_PASTO as PC, WIND_IDLE_DIST } from "../../core/config.js?v=20261201";
import { quality } from "../../core/quality.js?v=20261201";
import { params } from "../../core/state.js?v=20261201";
import { mulberry32 } from "../../core/geo.js?v=20261201";
import { patch } from "../shaderlib.js?v=20261201";
import { idleDriver } from "../idle.js?v=20261201";
import { applyAO, applyLod, cellSeed, chainShader } from "./chunks.js?v=20261201";
import { map } from "../../map/style.js?v=20261201";
import { fitSpheres, lowAt, terrain } from "../../terrain/terrain.js?v=20261201";   // A6 relieve en vivo
import { uniforms } from "../lighting.js?v=20261201";
import { GRASS_ATLAS, GRASS_TILE_COUNT, createAtlasJob } from "./grassgen.js?v=20261201";

const DBG = params.has("qa") || params.has("debug");
/* ?pastocfg={"nearM":40,"lodPow":0.8,"byQuality":{"alta":{"R":300,"dens":1}}} se mezcla sobre A2_PASTO (solo ?qa/?debug; para afinar diales con capturas) */
if (DBG && params.get("pastocfg")) {
  try { const o = JSON.parse(params.get("pastocfg")); for (const k in o) { if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) { for (const j in o[k]) PC[k][j] = (o[k][j] && typeof o[k][j] === "object" && !Array.isArray(o[k][j])) ? Object.assign(PC[k][j] || {}, o[k][j]) : o[k][j]; } else PC[k] = o[k]; } }
  catch (e) { console.warn("pasto: JSON inválido en ?pastocfg"); }
}
const BUDGET_QA = DBG && Number(params.get("pastoms")) > 0 ? Number(params.get("pastoms")) : 0;

const _fr = new THREE.Frustum(), _sp = new THREE.Sphere();

/* =====================================================================================================
   CAMINO NUEVO (G5): celdas bajo demanda
   ===================================================================================================== */
const CELL = PC.cell;
const CAP_CLASSES = [256, 512, 1024, 2048, 4096, 8192, 16384];          // capacidades del pool (instancias)
const CAP_MAX = CAP_CLASSES[CAP_CLASSES.length - 1];
const SEED_IDX = [0, 0, 1, 2, 3, 4];                                    // tile → lattice de ruido (las dos gramíneas comparten el mismo manchón)
const NSEED = 5;
const MS = 2;                                                           // px por metro de la máscara de borde
const MPX = CELL * MS;                                                  // 100 px
const CP = 5;                                                           // px por celda del raster grueso (10 m/px)
const HS = 5, HN = CELL / HS + 1;                                       // retícula de alturas cada 5 m (11 × 11)
const NOISE_M = PC.patchM, INV_NOISE = 1 / NOISE_M;
const NLW = Math.ceil(CELL / NOISE_M) + 3;                              // ancho de la retícula de ruido por celda
const TWO_PI = 6.283185307179586;

const lodNew = { value: new THREE.Vector4(PC.nearM, 450, PC.lodBand, 1) };   // near, far, band, compMax (1 = sin compensación: la escala la maneja la rampa)
/* Curva de raleo del pasto: densidad completa hasta nearM y de ahí ∝ (nearM/d)^lodPow (más barata que el smoothstep general de chunks.js:
   la cantidad de instancias de un disco crece como d^(2-pow), no como d²). La CPU usa la misma fórmula (keepAt) para el prefijo a dibujar. */
const KEEP_BASE = PC.lodPow === 1 ? "clamp(uA2Lod.x / max(lodD, 1.0), 0.0, 1.0)" : "pow(clamp(uA2Lod.x / max(lodD, 1.0), 0.0, 1.0), " + PC.lodPow.toFixed(3) + ")";
/* Raleo interior (ronda de rendimiento a pie): dentro de innerM metros la fracción que sobrevive baja suavemente a innerK (las plantas muy cercanas
   tapan mucha pantalla y se superponen; el relleno de tarjetas transparentes es lo que cuesta). Solo en GPU: la cuenta de la CPU no cambia. innerK >= 1 = apagado. */
const INNER_ON = PC.innerM > 0 && PC.innerK < 1;
const KEEP_GLSL = INNER_ON ? "(" + KEEP_BASE + ") * mix(" + PC.innerK.toFixed(3) + ", 1.0, smoothstep(0.0, " + PC.innerM.toFixed(1) + ", lodD))" : KEEP_BASE;
function keepAt(d) { const k = Math.min(1, lodNew.value.x / Math.max(d, 1)); return PC.lodPow === 1 ? k : Math.pow(k, PC.lodPow); }
const scaleU = { value: new THREE.Vector4(PC.scale[0], PC.scale[1], PC.scale[2], PC.scale[3]) };
const fadeU = { value: new THREE.Vector2(450 * PC.fadeFrom, 450) };
const qCfg = () => PC.byQuality[quality.name] || PC.byQuality.alta;
function applyQuality() {
  const c = qCfg(), R = Math.max(c.R, 1);
  lodNew.value.set(Math.min(PC.nearM, R * 0.5), R, PC.lodBand, 1);
  fadeU.value.set(R * PC.fadeFrom, R);
}
applyQuality();

let CTX = null;
let atlas = null;                       // { texture, ms, ... } cuando el horneado terminó
let atlasJob = null;
const PLACEHOLDER = new THREE.DataTexture(new Uint8Array([90, 110, 70, 0]), 1, 1, THREE.RGBAFormat);
PLACEHOLDER.colorSpace = THREE.SRGBColorSpace; PLACEHOLDER.needsUpdate = true;
const mats = [];
function finishAtlas() { atlas = atlasJob.result; for (const m of mats) m.map = atlas.texture; }
/* El atlas se hornea en pasos cortos en momentos ociosos (requestIdleCallback) desde que se arma el primer escenario; si una celda
   lo necesita antes, se termina de golpe. */
function ensureAtlas() {
  if (atlas) return atlas;
  if (!atlasJob) atlasJob = createAtlasJob();
  atlasJob.finish(); finishAtlas();
  return atlas;
}
function pumpAtlas() {
  if (atlas) return;
  if (!atlasJob) atlasJob = createAtlasJob();
  if (atlasJob.step()) { finishAtlas(); return; }
  if (typeof requestIdleCallback === "function") requestIdleCallback(pumpAtlas, { timeout: 300 }); else setTimeout(pumpAtlas, 30);
}

function hasMSAA() {
  try { const c = map.getCanvas(), gl = c.getContext("webgl2") || c.getContext("webgl"); const a = gl && gl.getContextAttributes(); return !!(a && a.antialias); } catch (e) { return false; }
}

/* ---- geometría base compartida: 3 tarjetas cruzadas (6 triángulos), base en y=0, altura 1 ---- */
let baseGeo = null;
function getBaseGeo() {
  if (baseGeo) return baseGeo;
  const pos = [], uv = [], nor = [], idx = [];
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI / 3, dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5, nx = -Math.sin(a), nz = Math.cos(a), v0 = pos.length / 3;
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) nor.push(nx * 0.6, 0.8, nz * 0.6);   // normales inclinadas hacia arriba: luz más suave (igual que el boceto)
    idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
  }
  baseGeo = {
    position: new THREE.Float32BufferAttribute(pos, 3), uv: new THREE.Float32BufferAttribute(uv, 2), normal: new THREE.Float32BufferAttribute(nor, 3),
    index: new THREE.Uint16BufferAttribute(idx, 1)
  };
  return baseGeo;
}

/* ---- material ---- */
function makeMaterial(ctx, key) {
  const msaa = hasMSAA() && !(DBG && params.get("pastoa2c") === "0");   // ?pastoa2c=0 (solo QA): fuerza el camino sin alpha-to-coverage (alphaTest común)
  const mat = new THREE.MeshLambertMaterial({ map: atlas ? atlas.texture : PLACEHOLDER, side: THREE.DoubleSide, alphaTest: GRASS_ATLAS.alphaRef, alphaToCoverage: msaa });
  mat.userData.foliage = false;           // A1: sin piso de luminancia ni translucidez de copas (los colores del atlas ya son los del boceto)
  mat.userData.a2msaa = msaa;
  /* 1) shaderlib: viento, niebla por distancia real y fade dither del escenario (+ keepFramebufferAlpha: el alfa del canvas no se toca) */
  patch(mat, { wind: true, fog: true, fade: key });
  /* 2) propio: tile del atlas y espejado por instancia, rampa de escala + desaparición, normal sin invertir por cara */
  chainShader(mat, "a2g5", sh => {
    sh.uniforms.uA2GCam = ctx.uniforms.uCamPos;
    sh.uniforms.uA2GScale = scaleU;
    sh.uniforms.uA2GFade = fadeU;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aTR;\nuniform vec3 uA2GCam;\nuniform vec4 uA2GScale;\nuniform vec2 uA2GFade;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n#ifdef USE_MAP\n" +
        "  { float a2t = aTR.x; float a2c = mod(a2t, " + GRASS_ATLAS.cols.toFixed(1) + "); float a2r = floor(a2t / " + GRASS_ATLAS.cols.toFixed(1) + ");\n" +
        "    float a2u = aTR.y > 0.5 ? 1.0 - uv.x : uv.x;\n" +
        "    vMapUv = vec2((a2c + a2u) / " + GRASS_ATLAS.cols.toFixed(1) + ", (a2r + 1.0 - uv.y) / " + GRASS_ATLAS.rows.toFixed(1) + "); }\n#endif")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n" +
        "{ float a2d = distance(uA2GCam, vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z));\n" +
        "  transformed *= mix(uA2GScale.x, uA2GScale.y, smoothstep(uA2GScale.z, uA2GScale.w, a2d)) * (1.0 - smoothstep(uA2GFade.x, uA2GFade.y, a2d)); }");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n  normal = normalize(vNormal);   // misma normal (inclinada hacia arriba) en las dos caras de la tarjeta");
  });
  applyLod(mat, ctx.uniforms.uCamPos, lodNew, { keep: KEEP_GLSL, tag: "g5p" + PC.lodPow + "i" + (INNER_ON ? PC.innerM + "_" + PC.innerK : 0) });   // raleo por rango (aRank), curva propia; se encadena DESPUÉS de patch()
  applyAO(mat, PC.ao.amount, 0, PC.ao.top);                            // E-AO: oscurece la base (igual que el boceto)
  mats.push(mat);
  return mat;
}

/* ---- pool de mallas por capacidad ---- */
const pool = CAP_CLASSES.map(() => []);
let poolCreated = 0;
function acquireMesh(mat, n) {
  let ci = 0; while (CAP_CLASSES[ci] < n) ci++;
  let mesh = pool[ci].pop();
  if (!mesh) {
    const cap = CAP_CLASSES[ci], bg = getBaseGeo(), g = new THREE.BufferGeometry();
    g.setIndex(bg.index); g.setAttribute("position", bg.position); g.setAttribute("uv", bg.uv); g.setAttribute("normal", bg.normal);
    g.setAttribute("aTR", new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2));
    g.setAttribute("aRank", new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    mesh = new THREE.InstancedMesh(g, mat, cap);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.boundingSphere = new THREE.Sphere();
    mesh.userData.ci = ci;
    poolCreated++;
  }
  mesh.material = mat;
  return mesh;
}
function releaseMesh(mesh) { mesh.visible = false; pool[mesh.userData.ci].push(mesh); }

/* ---- buffers de trabajo (una sola vez) ---- */
const sMat = new Float32Array(CAP_MAX * 16), sCol = new Float32Array(CAP_MAX * 3), sTR = new Float32Array(CAP_MAX * 2), sRank = new Float32Array(CAP_MAX);
const hLat = new Float32Array(HN * HN);
const nLat = new Float32Array(NSEED * NLW * NLW);
const wTmp = new Float32Array(GRASS_TILE_COUNT), nv = new Float32Array(NSEED);
const MIX = { 1: Float32Array.from(PC.mix["corr-herb"]), 2: Float32Array.from(PC.mix["parche-herb"]) };

/* hash entero → [0,1): ruido de mundo idéntico en cualquier motor (sin Math.sin) */
function ihash(xi, zi, s) {
  let h = Math.imul(xi, 374761393) ^ Math.imul(zi, 668265263) ^ Math.imul(s + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* ---- máscara de borde: canvas 2D de MPX × MPX ---- */
let mcv = null, mctx = null;
function getMaskCtx() {
  if (!mctx) { mcv = document.createElement("canvas"); mcv.width = mcv.height = MPX; mctx = mcv.getContext("2d", { willReadFrequently: true }); }
  return mctx;
}
const maskBuf = new Uint8Array(MPX * MPX);
function rasterMask(S, cell) {
  const c = getMaskCtx();
  /* Fondo NEGRO OPACO (no transparente): getImageData devuelve el color des-premultiplicado, así que sobre fondo transparente un píxel
     apenas rozado por el borde se lee como rojo 255. Con fondo opaco el canal = cobertura real (fix 2026-11-17: plantas sobre los caminos). */
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = "source-over"; c.fillStyle = "#000"; c.fillRect(0, 0, MPX, MPX);
  c.setTransform(MS, 0, 0, MS, -cell.x0 * MS, -cell.z0 * MS);
  c.globalCompositeOperation = "lighter";
  const x1 = cell.x0 + CELL, z1 = cell.z0 + CELL;
  const list = S.buckets.get(Math.floor(cell.x0 / S.bucket) + "," + Math.floor(cell.z0 / S.bucket));
  if (list) for (const p of list) {
    if (p.x1 < cell.x0 || p.x0 > x1 || p.z1 < cell.z0 || p.z0 > z1) continue;
    c.fillStyle = p.cls === 1 ? "#f00" : "#00f";
    c.fill(p.path, "evenodd");
  }
  const d = c.getImageData(0, 0, MPX, MPX).data;
  for (let i = 0, j = 0; i < maskBuf.length; i++, j += 4) maskBuf[i] = d[j] > 127 ? 1 : d[j + 2] > 127 ? 2 : 0;
  return maskBuf;
}

/* =========== precálculo por escenario: polígonos en metros de escena + raster grueso → lista de celdas ========== */
function prepare(ctx, S, data) {
  const t0 = performance.now();
  const polys = [];
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const f of (data && data.features) || []) {
    const cls = f.properties._cls === "corr-herb" ? 1 : f.properties._cls === "parche-herb" ? 2 : 0;
    if (!cls) continue;
    for (const poly of f.geometry.coordinates) {
      const path = new Path2D();
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, nv2 = 0;
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          const [x, z] = ctx.toScene(ring[i][0], ring[i][1]);
          if (i === 0) path.moveTo(x, z); else path.lineTo(x, z);
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        path.closePath(); nv2 += ring.length;
      }
      if (!(x1 > x0 && z1 > z0)) continue;
      polys.push({ cls, path, x0, z0, x1, z1 });
      if (x0 < bx0) bx0 = x0; if (z0 < bz0) bz0 = z0; if (x1 > bx1) bx1 = x1; if (z1 > bz1) bz1 = z1;
    }
  }
  S.cells = []; S.cellMap = new Map(); S.buckets = new Map(); S.bucket = CELL * 5; S.nPolys = polys.length;
  if (!polys.length) { S.prepMs = performance.now() - t0; return; }
  for (const p of polys) {                                                     // índice espacial de polígonos (buckets de 250 m)
    for (let bx = Math.floor(p.x0 / S.bucket); bx <= Math.floor(p.x1 / S.bucket); bx++)
      for (let bz = Math.floor(p.z0 / S.bucket); bz <= Math.floor(p.z1 / S.bucket); bz++) {
        const k = bx + "," + bz; let l = S.buckets.get(k); if (!l) S.buckets.set(k, l = []); l.push(p);
      }
  }
  const ix0 = Math.floor(bx0 / CELL), iz0 = Math.floor(bz0 / CELL), ix1 = Math.floor(bx1 / CELL), iz1 = Math.floor(bz1 / CELL);
  const NX = ix1 - ix0 + 1, NZ = iz1 - iz0 + 1, W = NX * CP, H = NZ * CP;
  if (W > 16384 || H > 16384) { console.warn("[pasto] campo demasiado extenso para el raster grueso: sin pasto"); S.prepMs = performance.now() - t0; return; }
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const c = cv.getContext("2d", { willReadFrequently: true });
  /* Fondo negro opaco: ver rasterMask. Sobre fondo transparente, cada píxel de borde se leía como cubierto al 100 % y las celdas cruzadas
     por un camino o un borde quedaban como "totalmente adentro" (sin máscara): se sembraban enteras, camino incluido. */
  c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
  c.setTransform(CP / CELL, 0, 0, CP / CELL, -ix0 * CP, -iz0 * CP);
  c.globalCompositeOperation = "lighter";
  for (const cls of [1, 2]) {
    c.fillStyle = cls === 1 ? "#f00" : "#00f";
    for (const p of polys) if (p.cls === cls) c.fill(p.path, "evenodd");
  }
  const d = c.getImageData(0, 0, W, H).data;
  const inv = 1 / (CP * CP * 255);
  for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
    let sr = 0, sb = 0;
    for (let y = 0; y < CP; y++) { let i = ((iz * CP + y) * W + ix * CP) * 4; for (let x = 0; x < CP; x++, i += 4) { sr += d[i]; sb += d[i + 2]; } }
    if (sr === 0 && sb === 0) continue;
    const cell = { ix: ix0 + ix, iz: iz0 + iz, x0: (ix0 + ix) * CELL, z0: (iz0 + iz) * CELL, fc: sr * inv, fp: sb * inv,
      mode: sr * inv >= 0.995 ? 1 : sb * inv >= 0.995 ? 2 : 0,
      cx: (ix0 + ix + 0.5) * CELL, cz: (iz0 + iz + 0.5) * CELL, yc: 0, ycOk: false, rad: CELL * 0.7071 + 3,
      mesh: null, n: 0, tier: -1, empty: false, ai: -1, d: 0 };
    S.cells.push(cell); S.cellMap.set((ix0 + ix) + "," + (iz0 + iz), cell);
  }
  S.prepMs = performance.now() - t0;
  S.coarse = { W, H };
}

/* =========== generación de una celda ========== */
function cellY(cell) {
  if (!cell.ycOk) { cell.yc = terrain.active ? CTX.heightAtScene(cell.cx, cell.cz) : 0; cell.ycOk = true; }
  return cell.yc;
}

const genStats = { cells: 0, total: 0, msMask: 0, nMask: 0, msLoop: 0, msCopy: 0, cand: 0, ring: new Float32Array(512), ri: 0, nFrames: 0, lastFrame: 0, maxCell: 0, slices: 0 };

/* La generación de una celda es un TRABAJO REANUDABLE: se hace por bloques de candidatos y, si se acaba el presupuesto del cuadro, sigue en el
   próximo (una sola celda en curso a la vez: los buffers de trabajo son compartidos). Así ni una celda llena (~8000 candidatos, unos 4-7 ms)
   produce un cuadro largo. */
let job = null, frameGen = 0;                                             // frameGen: ms de generación acumulados en el cuadro
const BLOCK = 128;                                                       // candidatos entre control de tiempo (~0,1-0,2 ms)
const SIN = new Float32Array(1024), COS = new Float32Array(1024);        // giro por tabla (evita sin/cos por planta)
for (let i = 0; i < 1024; i++) { SIN[i] = Math.sin(i * TWO_PI / 1024); COS[i] = Math.cos(i * TWO_PI / 1024); }

function startJob(S, cell, tierIdx) {
  const t0 = performance.now();
  const cfg = qCfg();
  const Nc = Math.max(1, Math.round(CELL * CELL * PC.density * cfg.dens));
  const M = Math.min(Nc, Math.ceil(Nc * PC.tiers[tierIdx]));
  const x0 = cell.x0, z0 = cell.z0;
  /* alturas del suelo: retícula de 5 m (con terreno); sin terreno, 0 */
  let ymin = 0, ymax = 0;
  const hasH = terrain.active;
  if (hasH) {
    ymin = Infinity; ymax = -Infinity;
    for (let j = 0; j < HN; j++) for (let i = 0; i < HN; i++) { const y = CTX.heightAtScene(x0 + i * HS, z0 + j * HS); hLat[j * HN + i] = y; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  }
  /* ruido de mundo: retícula de NOISE_M, 5 semillas */
  const gx0 = Math.floor(x0 * INV_NOISE), gz0 = Math.floor(z0 * INV_NOISE);
  for (let s = 0; s < NSEED; s++) for (let j = 0; j < NLW; j++) for (let i = 0; i < NLW; i++) nLat[(s * NLW + j) * NLW + i] = ihash(gx0 + i, gz0 + j, s);
  const tm = performance.now();
  const mode = cell.mode;
  if (mode === 0) rasterMask(S, cell);
  const tl = performance.now();
  if (mode === 0) { genStats.msMask += tl - tm; genStats.nMask++; }
  frameGen += tl - t0;
  job = { S, cell, tier: tierIdx, M, Nc, c: 0, n: 0, nCorr: 0, rnd: mulberry32(cellSeed(cell.ix, cell.iz, 0x6a5)), mode, hasH, ymin, ymax, gx0, gz0, ms: tl - t0 };
  cell.job = true;
}

/* Sigue el trabajo en curso hasta `deadline` (performance.now()). Procesa al menos un bloque si todavía hay tiempo al entrar; si el
   presupuesto se acabó justo al terminar los candidatos, el pase a buffers (finishJob) queda para el próximo cuadro. Devuelve true si la celda quedó terminada. */
function runJob(deadline) {
  const J = job, cell = J.cell, x0 = cell.x0, z0 = cell.z0, rnd = J.rnd, mode = J.mode, hasH = J.hasH, M = J.M, Nc = J.Nc, gx0 = J.gx0, gz0 = J.gz0;
  const tl = performance.now();
  if (J.c >= M) { finishJob(); return true; }                              // los candidatos ya estaban hechos: solo falta pasar a buffers
  const mask = maskBuf, types = PC.types;
  let c = J.c, n = J.n, nCorr = J.nCorr;
  do {
    const cEnd = Math.min(M, c + BLOCK);
    for (; c < cEnd; c++) {
      const x = x0 + rnd() * CELL, z = z0 + rnd() * CELL, u = rnd(), hu = rnd(), rot = rnd(), rr = rnd(), r2 = rnd(), r3 = rnd();
      let cls = mode;
      if (!cls) { cls = mask[(Math.min(MPX - 1, ((z - z0) * MS) | 0)) * MPX + Math.min(MPX - 1, ((x - x0) * MS) | 0)]; if (!cls) continue; }
      const W = MIX[cls];
      const fx = x * INV_NOISE - gx0, fz = z * INV_NOISE - gz0, ii = fx | 0, jj = fz | 0, tx = fx - ii, tz = fz - jj;
      const ux = tx * tx * (3 - 2 * tx), uz = tz * tz * (3 - 2 * tz), uxz = ux * uz;
      for (let s = 0; s < NSEED; s++) {
        const b = (s * NLW + jj) * NLW + ii, a0 = nLat[b], b0 = nLat[b + 1], c0 = nLat[b + NLW], d0 = nLat[b + NLW + 1];
        nv[s] = a0 + (b0 - a0) * ux + (c0 - a0) * uz + (a0 - b0 - c0 + d0) * uxz;
      }
      let tot = 0;
      for (let t = 0; t < GRASS_TILE_COUNT; t++) { const w = W[t] > 0 ? W[t] * (0.35 + 1.3 * nv[SEED_IDX[t]]) : 0; wTmp[t] = w; tot += w; }
      let pk = u * tot, tile = 0;
      while (tile < GRASS_TILE_COUNT - 1 && pk > wTmp[tile]) { pk -= wTmp[tile]; tile++; }
      const T = types[tile], hh = T.h[0] + hu * (T.h[1] - T.h[0]), sxz = hh * T.asp;
      let y = 0;
      if (hasH) {
        const gx = (x - x0) / HS, gz = (z - z0) / HS, gi = Math.min(HN - 2, gx | 0), gj = Math.min(HN - 2, gz | 0), fx2 = gx - gi, fz2 = gz - gj;
        const k = gj * HN + gi, a1 = hLat[k], b1 = hLat[k + 1], c1 = hLat[k + HN], d1 = hLat[k + HN + 1];
        y = a1 + (b1 - a1) * fx2 + (c1 - a1) * fz2 + (a1 - b1 - c1 + d1) * fx2 * fz2;
      }
      const ri = (rot * 1024) | 0, co = COS[ri], si = SIN[ri], o = n * 16;
      sMat[o] = co * sxz; sMat[o + 1] = 0; sMat[o + 2] = -si * sxz; sMat[o + 3] = 0;
      sMat[o + 4] = 0; sMat[o + 5] = hh; sMat[o + 6] = 0; sMat[o + 7] = 0;
      sMat[o + 8] = si * sxz; sMat[o + 9] = 0; sMat[o + 10] = co * sxz; sMat[o + 11] = 0;
      sMat[o + 12] = x; sMat[o + 13] = y; sMat[o + 14] = z; sMat[o + 15] = 1;
      const v = 0.88 + r2 * 0.24;
      sCol[n * 3] = v; sCol[n * 3 + 1] = v * (0.97 + r3 * 0.06); sCol[n * 3 + 2] = v;
      sTR[n * 2] = tile; sTR[n * 2 + 1] = rr;
      sRank[n] = (c + 0.5) / Nc;
      if (cls === 1) nCorr++;
      n++;
    }
  } while (c < M && performance.now() < deadline);
  J.c = c; J.n = n; J.nCorr = nCorr;
  const now = performance.now(); J.ms += now - tl; genStats.msLoop += now - tl; genStats.slices++; frameGen += now - tl;
  if (c < M || now >= deadline) return false;
  finishJob();
  return true;
}

/* Pasa lo generado al buffer de una malla del pool y la deja en escena */
function finishJob() {
  const J = job, S = J.S, cell = J.cell, n = J.n, tc = performance.now();
  job = null; cell.job = false;
  if (cell.mesh) { S.group.remove(cell.mesh); releaseMesh(cell.mesh); cell.mesh = null; }
  cell.tier = J.tier; cell.Nc = J.Nc;
  if (n === 0) {
    if (cell.ai >= 0) removeActive(S, cell);
    cell.empty = J.M >= J.Nc; cell.n = 0;                                 // sin plantas (todo el prefijo cayó fuera del polígono)
  } else {
    const mesh = acquireMesh(S.mat, n), g = mesh.geometry;
    mesh.instanceMatrix.array.set(sMat.subarray(0, n * 16)); mesh.instanceColor.array.set(sCol.subarray(0, n * 3));
    g.attributes.aTR.array.set(sTR.subarray(0, n * 2)); g.attributes.aRank.array.set(sRank.subarray(0, n));
    for (const a of [mesh.instanceMatrix, mesh.instanceColor, g.attributes.aTR, g.attributes.aRank]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
    mesh.count = n; mesh.visible = true;
    const yc = (J.ymin + J.ymax) * 0.5 + 1.2;
    cell.yc = J.hasH ? (J.ymin + J.ymax) * 0.5 : 0; cell.ycOk = true;
    cell.rad = Math.hypot(CELL * 0.5, CELL * 0.5, (J.ymax - J.ymin) * 0.5 + 3) + 1.5;
    mesh.boundingSphere.center.set(cell.cx, yc, cell.cz); mesh.boundingSphere.radius = cell.rad;
    delete mesh.userData.a6by;
    if (terrain.active && terrain.k < 1) fitSpheres(mesh);                // relieve en vivo: esfera de culling bajada
    cell.mesh = mesh; cell.n = n; cell.nCorr = J.nCorr; cell.rank = g.attributes.aRank.array;
    if (cell.ai < 0) addActive(S, cell);
    S.group.add(mesh);
  }
  const now = performance.now(); genStats.msCopy += now - tc; J.ms += now - tc; frameGen += now - tc;
  genStats.cells++; genStats.total += J.ms; if (J.ms > genStats.maxCell) genStats.maxCell = J.ms;
}

function addActive(S, cell) { cell.ai = S.active.length; S.active.push(cell); }
function removeActive(S, cell) {
  const last = S.active.pop();
  if (last !== cell) { S.active[cell.ai] = last; last.ai = cell.ai; }
  cell.ai = -1;
}
function release(S, cell) {
  if (job && job.cell === cell) { job = null; cell.job = false; }
  if (cell.mesh) { S.group.remove(cell.mesh); releaseMesh(cell.mesh); cell.mesh = null; }
  if (cell.ai >= 0) removeActive(S, cell);
  cell.n = 0; cell.tier = -1; cell.empty = false;
}
function releaseAll(S) { for (let i = S.active.length - 1; i >= 0; i--) release(S, S.active[i]); }

/* =========== cuenta de instancias a dibujar: el prefijo con rango < t (los rangos salen ordenados) ========== */
function countBelow(rank, n, t) {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rank[m] < t) lo = m + 1; else hi = m; }
  return lo;
}

/* =========== actualización por cuadro de un escenario ========== */
const queue = [];
let lastCam = new THREE.Vector3(), lastVP = new THREE.Matrix4(), lastFrame = null;
let budgetOverride = 0;

function updateScenario(S, cam, frame, deadline) {
  const R = qCfg().R, far = lodNew.value.y, near = lodNew.value.x, band = PC.lodBand;
  const camY = cam.y;
  let windNear = false, pending = 0;
  if (R <= 0) { if (S.active.length) releaseAll(S); return { windNear, pending }; }
  const eff = (cell) => cellY(cell) - lowAt(cell.cx, cell.cz);          // A6: centro bajado con el relieve vivo
  /* 1) candidatas: celdas a menos de R, en cuadro (o muy cerca) y sin la resolución que les toca */
  queue.length = 0;
  const reach = R + 45, nearAlways = R * 0.25;
  for (const cell of S.cells) {
    if ((cell.empty && cell.tier >= PC.tiers.length - 1) || cell.job) continue;
    const dx = cell.cx - cam.x, dz = cell.cz - cam.z;
    if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue;
    const cy = eff(cell), dy = camY - cy;
    const d = Math.sqrt(dx * dx + dz * dz + dy * dy) - cell.rad;
    if (d >= far) continue;
    const need = Math.min(1, keepAt(Math.max(d - 20, 0)) * (1 + band));   // 20 m de anticipación: la celda sube de resolución antes de que la cámara llegue
    if (need <= 0) continue;
    let ti = 0; while (ti < PC.tiers.length - 1 && PC.tiers[ti] < need) ti++;
    if (cell.tier >= ti) continue;                                         // ya tiene resolución suficiente (o la celda quedó vacía a ese nivel)
    if (d > nearAlways && !_fr.intersectsSphere(_sp.set(_sp.center.set(cell.cx, cy, cell.cz), cell.rad))) continue;
    cell.d = d; cell.want = ti; queue.push(cell);
  }
  if (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    if (!atlas) ensureAtlas();
    let i = 0;
    for (; i < queue.length; i++) {
      if (job || performance.now() >= deadline) break;                     // celda en curso (de otro escenario) o sin presupuesto: sigue en el próximo cuadro
      startJob(S, queue[i], queue[i].want);
      if (!runJob(deadline)) { i++; break; }                              // se acabó el presupuesto a mitad de celda: sigue en el próximo cuadro
      if (performance.now() >= deadline) { i++; break; }
    }
    pending = queue.length - i;
  }
  if (job && job.S === S) pending++;
  /* 2) LOD por celda: visibilidad y cantidad de instancias a dibujar */
  const act = S.active;
  for (let k = 0; k < act.length; k++) {
    const cell = act[k], cy = eff(cell);
    const dx = cell.cx - cam.x, dz = cell.cz - cam.z, dy = camY - cy;
    const dc = Math.sqrt(dx * dx + dz * dz + dy * dy), d = dc - cell.rad;
    cell.d = d;
    if (d >= far) { cell.mesh.visible = false; continue; }
    const keep = keepAt(d);
    cell.mesh.visible = true;
    cell.mesh.count = countBelow(cell.rank, cell.n, Math.min(1, keep * (1 + band)));
    if (!windNear && d < WIND_IDLE_DIST && _fr.intersectsSphere(_sp.set(_sp.center.set(cell.cx, cy, cell.cz), cell.rad))) windNear = true;
  }
  /* 3) reciclado: lo que quedó lejos, o lo más lejano si se pasa del tope */
  if (act.length) {
    for (let k = act.length - 1; k >= 0; k--) if (act[k].d > far + 150) release(S, act[k]);
    if (act.length > PC.maxCells) {
      const sorted = act.slice().sort((a, b) => b.d - a.d);
      for (let k = 0; k < sorted.length && act.length > PC.maxCells * 0.9; k++) release(S, sorted[k]);
    }
  }
  return { windNear, pending };
}

const built = {};

const visibleScenario = b => { const g = b.group; return !g.parent || g.parent.visible; };
let lastQName = null;

export default {
  id: "grass",

  build(ctx, scenarioKey, data, veg) {
    CTX = ctx;
    const group = new THREE.Group();
    const S = { key: scenarioKey, group, active: [], hiddenMs: 0, mat: null };
    prepare(ctx, S, data);
    S.mat = makeMaterial(ctx, scenarioKey);
    /* Ancla invisible: las celdas se crean después, y shadows.js (A3, onRenderer) busca en la escena una InstancedMesh con este material
       (userData.adChunks.wind) para engancharle la recepción de sombra del pasto en Ultra. Sin esta malla no encontraría ninguna. */
    const bg = getBaseGeo(), ag = new THREE.BufferGeometry();
    ag.setIndex(bg.index); ag.setAttribute("position", bg.position); ag.setAttribute("uv", bg.uv); ag.setAttribute("normal", bg.normal);
    const anchor = new THREE.InstancedMesh(ag, S.mat, 1);
    anchor.count = 0; anchor.visible = false; anchor.frustumCulled = false; anchor.boundingSphere = new THREE.Sphere(); anchor.userData.a2anchor = true;
    group.add(anchor);
    built[scenarioKey] = S;
    lastQName = quality.name;
    pumpAtlas();   // el atlas se hornea de a pasos en momentos ociosos
    return { object3d: group, materials: [S.mat] };
  },

  setOpacity() {},   // el fade lo hace el dither (shaderlib.scenarioFade, escrito por host.setOpacity)

  setGrowth() {},    // el crecimiento lo aplica el host (scale.y del grupo, o growthU con terreno)

  update(frame) {
    const c = frame.camPosScene;
    _fr.setFromProjectionMatrix(frame.viewProj);
    lastCam.copy(c); lastVP.copy(frame.viewProj); lastFrame = frame;
    let windNear = false, pending = 0;
    const tg = performance.now(), deadline = tg + (budgetOverride || BUDGET_QA || PC.budgetMs);
    if (job) { if (visibleScenario(job.S)) runJob(deadline); else { job.cell.job = false; job = null; } }   // sigue la celda que quedó a medias
    for (const b of Object.values(built)) {
      if (!visibleScenario(b)) {                                            // escenario oculto: pasados unos segundos suelta sus celdas
        b.hiddenMs += frame.dt || 16;
        if (b.hiddenMs > 3000 && b.active.length) releaseAll(b);
        continue;
      }
      b.hiddenMs = 0;
      const r = updateScenario(b, c, frame, deadline);
      if (r.windNear) windNear = true;
      pending += r.pending;
    }
    const genMs = frameGen; frameGen = 0;
    if (genMs > 0) { genStats.ring[genStats.ri++ & 511] = genMs; genStats.nFrames++; if (genMs > genStats.lastFrame) genStats.lastFrame = genMs; }
    if (pending > 0) map.triggerRepaint();                                  // sigue generando cuadro a cuadro hasta terminar (después, reposo = 0 cuadros)
    idleDriver.request("grass", windNear);
  },

  onQuality(q) {
    applyQuality();
    if (lastQName !== q.name) {                                             // R y densidad cambian: se regeneran las celdas
      lastQName = q.name;
      for (const b of Object.values(built)) releaseAll(b);
      map.triggerRepaint();
    }
  },

  /* Para __nav3d.stats(). Las instancias de las celdas activas son las GENERADAS (la CPU dibuja menos, según el LOD: `grassDibujadas`). */
  stats(scenarioKey) {
    const b = built[scenarioKey];
    if (!b) return { grass: {}, grassTotal: 0, grassChunks: 0, grassChunksVisibles: 0 };
    let gen = 0, drawn = 0, vis = 0, corr = 0, nTiers = [0, 0, 0, 0];
    for (const cell of b.active) { gen += cell.n; corr += cell.nCorr || 0; nTiers[cell.tier] = (nTiers[cell.tier] || 0) + 1; if (cell.mesh.visible) { vis++; drawn += cell.mesh.count; } }
    const ring = Array.from(genStats.ring.subarray(0, Math.min(genStats.nFrames, 512))).sort((x, y) => x - y);
    const p95 = ring.length ? ring[Math.min(ring.length - 1, Math.floor(ring.length * 0.95))] : 0;
    return {
      pasto: "nuevo", grass: { "corr-herb": corr, "parche-herb": gen - corr }, grassTotal: gen, grassDibujadas: drawn,
      grassChunks: b.active.length, grassChunksVisibles: vis,
      grassCeldas: { candidatas: b.cells.length, activas: b.active.length, visibles: vis, porTier: nTiers, pool: pool.map(p => p.length).reduce((s, n) => s + n, 0), mallasCreadas: poolCreated },
      grassGen: { celdasGeneradas: genStats.cells, msCeldaMedio: genStats.cells ? +(genStats.total / genStats.cells).toFixed(2) : 0, msCeldaMax: +genStats.maxCell.toFixed(2),
        msCuadroMax: +genStats.lastFrame.toFixed(2), msCuadroP95: +p95.toFixed(2), cuadrosConGeneracion: genStats.nFrames },
      grassPrep: { ms: +(b.prepMs || 0).toFixed(1), poligonos: b.nPolys || 0, raster: b.coarse || null },
      grassAtlasMs: atlas ? { total: +atlas.ms.toFixed(1), dibujo: +atlas.fases.dibujo.toFixed(1), relleno: +atlas.fases.relleno.toFixed(1), mipmaps: +atlas.fases.mipmaps.toFixed(1), pasos: atlas.steps } : null, grassMsaa: !!b.mat.userData.a2msaa
    };
  },

  dispose() {}
};

/* ---- ganchos de QA ---- */
if (DBG) {
  window.__nav3dGrass = {
    /* genera de una vez todo lo pendiente alrededor de la última cámara (para capturas deterministas) */
    settle() {
      if (!lastFrame) return 0;
      let n = 0;
      for (let it = 0; it < 8; it++) {
        _fr.setFromProjectionMatrix(lastVP);
        let pend = 0;
        for (const b of Object.values(built)) if (visibleScenario(b)) {
          if (job && job.S === b) while (job && !runJob(Infinity));
          const r = updateScenario(b, lastCam, lastFrame, Infinity); pend += r.pending; n++;
        }
        if (!pend) break;
      }
      frameGen = 0;
      map.triggerRepaint();
      return n;
    },
    flush() { for (const b of Object.values(built)) releaseAll(b); map.triggerRepaint(); },
    budget(ms) { budgetOverride = ms; },
    resetGenStats() { genStats.msMask = genStats.nMask = genStats.msLoop = genStats.msCopy = genStats.cand = 0; genStats.cells = 0; genStats.total = 0; genStats.ri = 0; genStats.nFrames = 0; genStats.lastFrame = 0; genStats.maxCell = 0; genStats.ring.fill(0); },
    ensureAtlas() { return ensureAtlas(); },
    cells(key) { const b = built[key]; return b ? b.active.map(c => ({ ix: c.ix, iz: c.iz, cx: c.cx, cz: c.cz, n: c.n, tier: c.tier, d: +c.d.toFixed(1), count: c.mesh.count, vis: c.mesh.visible, fc: +c.fc.toFixed(2), fp: +c.fp.toFixed(2), yc: c.yc })) : []; },
    built,
    genStats
  };
}
