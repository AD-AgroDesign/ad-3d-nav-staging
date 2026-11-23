/* ============ Sistema de render: agua por shader (M, Ola 3) ============
   Dueño: A4. Contrato: §6.3. Ficha: PLAN §9.A4-M. Handoff: realismo/handoffs/a4-agua.md

   Malla de los polígonos `agua` (cursos de agua), triangulada en metros de escena con la misma triangulación del suelo
   (earcut; huecos respetados; la geometría GIS no se toca: los vértices son los del anillo, más puntos medios para
   apoyar en heightAt y medir la orilla). Un draw por escenario.
   Shader (ShaderMaterial; tone mapping y conversión de salida de Three + niebla de shaderlib al final, igual que el resto):
     - color somero/profundo por distancia a la orilla (por vértice), base #3f7fb5 (leyenda);
     - normales animadas: dos capas de una textura de normales generada en runtime (value noise periódico, mipmaps =
       antialias gratis), rotadas y con deriva distinta; se aplanan con la distancia;
     - fresnel de Schlick con la cámara REAL (uCamPos, T1): de arriba se ve el cuerpo del agua, en el rasante el cielo;
     - reflejo aproximado del cielo: gradiente zenit (sky-color) → horizonte (= color de la niebla, uFogColor) por la
       dirección reflejada. Sin render-to-texture;
     - destello del sol (Blinn-Phong normalizado) con uSunDir/uSunColor y la intensidad de lights.sun (lighting.js: sigue
       los modos de hora de A1 sin tocar nada);
     - luz difusa = hemisferio + sol de lighting.js (mismas unidades que MeshLambert del suelo);
     - orilla: borde suave (alfa) + aclarado por distancia + reborde claro (reemplaza la línea de MapLibre).
   Sombras de A3: el receptor de A3 MULTIPLICA el framebuffer en la lista opaca con renderOrder -9; el agua dibuja ANTES
       (renderOrder -11, lista opaca con mezcla alfa a medida, igual que el suelo): recibe las sombras gratis, sin código propio.
   Animación en reposo (T7): pide repintado al idleDriver del host (render/idle.js, quality.idleFps 30/20/0): solo si el agua está en cuadro y a menos de
       idleMaxDist, solo si el último repintado fue hace más de un intervalo (en movimiento no suma nada), pausa con
       document.hidden, y no repinta si el tiempo está congelado (freezeTime). Calidad Baja: sin malla (plano de MapLibre).
   T9: `*-agua-fill` queda con opacidad 0,001 (clic/popup); `*-agua-line` en config (0). En Baja se restauran (0,38 / 0,7). */
import * as THREE from "three";
import { A1_SKY, A4_GROUND, A4_WATER as CFG } from "../../core/config.js?v=20261201";
import { HOME_VIEW, params } from "../../core/state.js?v=20261201";
import { quality } from "../../core/quality.js?v=20261201";
import { idleDriver } from "../idle.js?v=20261201";
import { map } from "../../map/style.js?v=20261201";
import { lights, uniforms } from "../lighting.js?v=20261201";
import { GLSL_ADFOG, GLSL_FOG_UNIFORMS, scenarioFade } from "../shaderlib.js?v=20261201";
import { GLSL_DECL, lowAt, withReliefU } from "../../terrain/terrain.js?v=20261201";   // A6 relieve en vivo
import { dedupRing, triangulatePoly } from "./ground.js?v=20261201";

const wanted = () => CFG.enabled && !((params.has("qa") || params.has("debug")) && params.get("agua") === "off");   // ?agua=off: solo ?qa/?debug

/* ---------- textura de normales (runtime, ~15 ms, 256 KB) ----------
   Altura = value noise periódico de 3 octavas (8 / 16 / 32 celdas por período); normal por diferencias centrales con
   envoltura. RG = pendiente (x,z) codificada 0..1 alrededor de 0,5; B = altura (variación del reborde y de la profundidad). */
const WN = 256;
let waveTex = null;
export function getWaveTex() {
  if (waveTex) return waveTex;
  const N = WN, h = new Float32Array(N * N);
  let seed = 0x5eed0a4;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const octave = (C, amp) => {
    const L = new Float32Array(C * C); for (let k = 0; k < L.length; k++) L[k] = rnd();
    for (let y = 0; y < N; y++) {
      const v = y * C / N, j = Math.floor(v), fy = v - j, sy = fy * fy * (3 - 2 * fy), j1 = (j + 1) % C;
      for (let x = 0; x < N; x++) {
        const u = x * C / N, i = Math.floor(u), fx = u - i, sx = fx * fx * (3 - 2 * fx), i1 = (i + 1) % C;
        const a = L[j * C + i], b = L[j * C + i1], c = L[j1 * C + i], d = L[j1 * C + i1];
        h[y * N + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
  };
  octave(8, 1.0); octave(16, 0.55); octave(32, 0.28);
  const data = new Uint8Array(N * N * 4), sl = new Float32Array(N * N * 2);
  let mx = 1e-6;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h[y * N + (x + 1) % N] - h[y * N + (x + N - 1) % N], dz = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
    sl[(y * N + x) * 2] = dx; sl[(y * N + x) * 2 + 1] = dz; mx = Math.max(mx, Math.abs(dx), Math.abs(dz));
  }
  const k = 1 / (mx * 0.6);   // casi todas las pendientes caen dentro de ±1 (se satura el resto)
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(255 * (0.5 + 0.5 * Math.max(-1, Math.min(1, sl[i * 2] * k))));
    data[i * 4 + 1] = Math.round(255 * (0.5 + 0.5 * Math.max(-1, Math.min(1, sl[i * 2 + 1] * k))));
    data[i * 4 + 2] = Math.round(255 * Math.min(1, h[i] / 1.83));
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return (waveTex = t);
}

/* Refinamiento conforme por BISECCIÓN DE LA ARISTA MÁS LARGA: en cada pasada se marca solo la arista más larga de cada triángulo
   que tenga alguna > L (las dos caras que la comparten se parten igual: sin T-junctions). El refinamiento de ground.js parte
   TODAS las aristas largas y, con los triángulos-astilla del earcut de un curso (3 km × 8 m), explota (~70 k tris); así quedan
   unos pocos miles de triángulos de buena forma. */
function refineLongest(P, T, L, maxTris, adapt) {
  const L2 = L * L, key = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  const d2raw = (a, b) => { const dx = P[a][0] - P[b][0], dz = P[a][1] - P[b][1]; return dx * dx + dz * dz; };
  /* G5: con `adapt = { h, tol, minL }` (relieve) una arista tambien cuenta como "larga" si pasa minL y la altura real en su medio se aparta mas de tol
     m de la recta (flecha): la malla de agua quedaba por debajo del terreno de MapLibre y asomaba el satelite pardo en cunas. Se cachea por arista. */
  const H = [], dec = new Map(), mL2 = adapt ? adapt.minL * adapt.minL : 0;
  const hv = i => (H[i] === undefined ? (H[i] = adapt.h(P[i][0], P[i][1])) : H[i]);
  const d2 = (a, b) => {   // d2 efectiva: la real si hay que partir la arista, 0 si no (el maximo elige la mas larga de las que SI hay que partir)
    const d = d2raw(a, b);
    if (d > L2) return d;
    if (!adapt || d <= mL2) return 0;
    const k = key(a, b); let r = dec.get(k);
    if (r === undefined) { r = Math.abs(adapt.h((P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2) - (hv(a) + hv(b)) / 2) > adapt.tol; dec.set(k, r); }
    return r ? d : 0;
  };
  for (let pass = 0; pass < 80; pass++) {
    const mark = new Map();
    let any = false;
    for (const [a, b, c] of T) {
      const lab = d2(a, b), lbc = d2(b, c), lca = d2(c, a), m = Math.max(lab, lbc, lca);
      if (m <= 0) continue;
      any = true;
      const [p, q] = m === lab ? [a, b] : m === lbc ? [b, c] : [c, a], k = key(p, q);
      if (!mark.has(k)) { mark.set(k, P.length); P.push([(P[p][0] + P[q][0]) / 2, (P[p][1] + P[q][1]) / 2]); }
    }
    if (!any || T.length > maxTris) break;
    const out = [];
    for (const [a, b, c] of T) {
      const mab = mark.get(key(a, b)), mbc = mark.get(key(b, c)), mca = mark.get(key(c, a));
      const n = (mab !== undefined) + (mbc !== undefined) + (mca !== undefined);
      if (n === 0) out.push([a, b, c]);
      else if (n === 3) out.push([a, mab, mca], [mab, b, mbc], [mca, mbc, c], [mab, mbc, mca]);
      else if (n === 1) {
        if (mab !== undefined) out.push([a, mab, c], [mab, b, c]);
        else if (mbc !== undefined) out.push([b, mbc, a], [mbc, c, a]);
        else out.push([c, mca, b], [mca, a, b]);
      } else {   // dos marcadas: x,y = extremos de la arista sin marcar, z = el vértice opuesto
        const [x, y, z, mx, my] = mab === undefined ? [a, b, c, mca, mbc] : mbc === undefined ? [b, c, a, mab, mca] : [c, a, b, mbc, mab];
        out.push([z, mx, my], [x, y, my], [x, my, mx]);
      }
    }
    T = out;
  }
  return T;
}

/* ---------- orilla: mapa de distancia horneado ----------
   Los triángulos del earcut de un curso de agua son astillas larguísimas (aristas de cientos de metros entre orillas
   opuestas): la distancia a la orilla NO se puede llevar por vértice sin refinar a ~50 k triángulos. Se hornea UNA vez
   por escenario en una textura R8 (distancia exacta al borde en cada texel interior, tope SHORE_MAX m): el fragmento la
   lee. Solo se evalúan los texels dentro de los polígonos (≈ área / celda²) con una grilla espacial de segmentos. */
const SHORE_MAX = 12, SHORE_TEX = 2048;

function bakeShore(polys) {   // polys: [{ rings }] en metros de escena → { data, W, H, x0, z0, c }
  let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
  for (const { rings } of polys) for (const p of rings[0]) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  if (!(x1 > x0)) return { data: new Uint8Array(2), W: 1, H: 1, x0: 0, z0: 0, c: 1 };
  const c = Math.max(CFG.shoreCell, Math.max(x1 - x0, z1 - z0) / SHORE_TEX);
  x0 -= 2 * c; z0 -= 2 * c;
  const W = Math.ceil((x1 - x0) / c) + 3, H = Math.ceil((z1 - z0) / c) + 3, data = new Uint8Array(W * H);
  const G = SHORE_MAX;
  for (const { rings } of polys) {
    const seg = [], grid = new Map();
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const s = seg.length / 4; seg.push(r[j][0], r[j][1], r[i][0], r[i][1]);
      const ia = Math.floor((Math.min(r[j][0], r[i][0])) / G), ib = Math.floor((Math.max(r[j][0], r[i][0])) / G);
      const ja = Math.floor((Math.min(r[j][1], r[i][1])) / G), jb = Math.floor((Math.max(r[j][1], r[i][1])) / G);
      for (let u = ia; u <= ib; u++) for (let v = ja; v <= jb; v++) { const k = u + "," + v; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(s); }
    }
    let pminx = 1e18, pmaxx = -1e18, pminz = 1e18, pmaxz = -1e18;
    for (const p of rings[0]) { if (p[0] < pminx) pminx = p[0]; if (p[0] > pmaxx) pmaxx = p[0]; if (p[1] < pminz) pminz = p[1]; if (p[1] > pmaxz) pmaxz = p[1]; }
    const j0 = Math.max(0, Math.floor((pminz - z0) / c) - 1), j1 = Math.min(H - 1, Math.ceil((pmaxz - z0) / c) + 1);
    /* Relleno por regla de "no cero" para el anillo exterior (si el contorno se superpone consigo mismo, como en los codos de un
       curso digitalizado, la regla par-impar deja agujeros que earcut SÍ rellena) y par-impar para los huecos. */
    const xs = [], row = new Uint8Array(W);
    for (let j = j0; j <= j1; j++) {
      const zc = z0 + (j + 0.5) * c;
      row.fill(0);
      for (let ri = 0; ri < rings.length; ri++) {
        const r = rings[ri]; xs.length = 0;
        for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
          const za = r[b][1], zb = r[a][1];
          if ((za <= zc) !== (zb <= zc)) xs.push([r[b][0] + (zc - za) / (zb - za) * (r[a][0] - r[b][0]), zb > za ? 1 : -1]);
        }
        xs.sort((u, v) => u[0] - v[0]);
        let wnd = 0;
        for (let k = 0; k + 1 < xs.length; k++) {
          wnd += xs[k][1];
          const inside = ri === 0 ? wnd !== 0 : (k % 2 === 0);
          if (!inside) continue;
          const ia = Math.max(0, Math.ceil((xs[k][0] - x0) / c - 0.5)), ib = Math.min(W - 1, Math.ceil((xs[k + 1][0] - x0) / c - 0.5) - 1);
          for (let i = ia; i <= ib; i++) row[i] = ri === 0 ? 1 : 0;
        }
      }
      for (let i = 0; i < W; i++) {
        if (!row[i]) continue;
        {
          const px = x0 + (i + 0.5) * c, gu = Math.floor(px / G), gv = Math.floor(zc / G);
          let best = SHORE_MAX * SHORE_MAX;
          for (let u = gu - 1; u <= gu + 1; u++) for (let v = gv - 1; v <= gv + 1; v++) {
            const l = grid.get(u + "," + v); if (!l) continue;
            for (const s of l) {
              const ax = seg[s * 4], az = seg[s * 4 + 1], bx = seg[s * 4 + 2] - ax, bz = seg[s * 4 + 3] - az, l2 = bx * bx + bz * bz;
              let t = l2 > 0 ? ((px - ax) * bx + (zc - az) * bz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
              const dx = px - (ax + bx * t), dz = zc - (az + bz * t), d2 = dx * dx + dz * dz;
              if (d2 < best) best = d2;
            }
          }
          data[j * W + i] = Math.max(1, Math.round(255 * Math.sqrt(best) / SHORE_MAX));
        }
      }
    }
  }
  return { data: addHalfWidth(data, W, H, c), W, H, x0, z0, c };
}

/* Semi-ancho local (G): máximo de la distancia a la orilla en una ventana de ±HW_WIN m (filtro separable). En una cinta la cresta
   de la distancia ES el semi-ancho, así que cada texel sabe qué tan angosto es el curso donde está (arroyos < 4 m: ajuste en el shader). */
const HW_WIN = 6;
function addHalfWidth(d, W, H, c) {
  const r = Math.max(1, Math.ceil(HW_WIN / c)), tmp = new Uint8Array(W * H), out = new Uint8Array(W * H * 2);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let m = 0; for (let k = Math.max(0, i - r), e = Math.min(W - 1, i + r); k <= e; k++) { const v = d[j * W + k]; if (v > m) m = v; }
    tmp[j * W + i] = m;
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let m = 0; for (let k = Math.max(0, j - r), e = Math.min(H - 1, j + r); k <= e; k++) { const v = tmp[k * W + i]; if (v > m) m = v; }
    out[(j * W + i) * 2] = d[j * W + i]; out[(j * W + i) * 2 + 1] = d[j * W + i] ? m : 0;
  }
  return out;
}

/* ---------- geometría ---------- */
const CELL = 250;   // m · celdas de las cajas para el lazo en reposo (el curso es largo y fino: una sola caja no sirve)

function buildGeometry(ctx, data, hasH) {
  const pos = [], idx = [], items = [];
  let nv = 0, polys = 0, failed = 0, tiny = 0;
  const boxes = new Map();
  for (const f of data.features) {
    if (f.properties._cls !== "agua") continue;
    for (const poly of f.geometry.coordinates) {
      const rings = poly.map(r => dedupRing(r, ctx.toScene)).filter(r => r.length >= 3);
      const tri = triangulatePoly(rings);
      if (!tri) { failed++; continue; }
      if (tri.tiny) { tiny++; continue; }
      polys++; items.push({ rings });
      // sin terreno: triángulos crudos del earcut (la distancia a la orilla va en la textura). Con terreno: se refina para apoyar en heightAt
      const T = refineLongest(tri.P, tri.T, hasH ? CFG.maxEdgeRelief : CFG.maxEdge, 120000, hasH && A4_GROUND.sag && A4_GROUND.sag.tol > 0 ? { h: (x, z) => ctx.heightAt(...ctx.toLngLat(x, z)), tol: A4_GROUND.sag.tol, minL: A4_GROUND.sag.minL } : null), P = tri.P;
      const base = nv;
      for (const p of P) {
        const y = (hasH ? ctx.heightAt(...ctx.toLngLat(p[0], p[1])) : 0) + (hasH ? A4_GROUND.yOffRelief : CFG.yOff);
        pos.push(p[0], y, p[1]);
        const k = Math.floor(p[0] / CELL) + "," + Math.floor(p[1] / CELL);
        let b = boxes.get(k); if (!b) boxes.set(k, b = new THREE.Box3());
        b.expandByPoint(new THREE.Vector3(p[0], y, p[1]));
        nv++;
      }
      for (const [a, b, c] of T) {
        const cr = (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]) - (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]);
        idx.push(base + a, cr > 0 ? base + b : base + c, cr > 0 ? base + c : base + b);   // cara hacia arriba
      }
    }
  }
  const sh = bakeShore(items);
  const tex = new THREE.DataTexture(sh.data, sh.W, sh.H, THREE.RGFormat);
  tex.unpackAlignment = 1; tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
  return { geometry: g, tex, shore: sh, verts: nv, tris: idx.length / 3, polys, failed, tiny, boxes: [...boxes.values()] };
}

/* ---------- material ---------- */
const VS =
  "varying vec3 vWp;\n" +
  "void main() {\n  vec4 w = modelMatrix * vec4(position, 1.0);\n  w.y -= a6Low(w.xz);\n  vWp = w.xyz;\n" +
  "  gl_Position = projectionMatrix * viewMatrix * w;\n}\n";

/* uA = (escala capa 1, escala capa 2, pendiente, f0) · uB = (reflejo, exponente destello, intensidad destello, aplanado desde m)
   uC = (alfa somero, alfa profundo, ancho de orilla, borde suave) · uD = (aplanado hasta m, reborde, ganancia del cuerpo, 0) */
const FS =
  "precision highp float;\n" +
  "varying vec3 vWp;\n" +
  "uniform sampler2D tShore;\nuniform vec4 uSh;\n" +
  "uniform vec3 uCamPos;\nuniform float uTime;\nuniform float uFade;\nuniform sampler2D tWave;\n" +
  "uniform vec3 uSunDir;\nuniform vec3 uSunColor;\nuniform float uSunI;\nuniform vec3 uHemiSky;\nuniform vec3 uHemiGround;\n" +
  "uniform vec3 uZenith;\nuniform vec3 uColShallow;\nuniform vec3 uColMid;\nuniform vec3 uColDeep;\nuniform vec3 uColRim;\n" +
  "uniform vec4 uA;\nuniform vec4 uB;\nuniform vec4 uC;\nuniform vec4 uD;\nuniform vec4 uDrift;\nuniform vec4 uE;\nuniform vec4 uF;\nuniform vec3 uColNarrow;\n" +
  GLSL_FOG_UNIFORMS + GLSL_ADFOG +
  "const float PI_ = 3.14159265;\n" +
  "void main() {\n" +
  "  vec3 toCam = uCamPos - vWp;\n" +
  "  float dist = length(toCam);\n" +
  "  vec3 V = toCam / dist;\n" +
  "  vec2 p = vWp.xz;\n" +
  "  vec2 sh2 = texture2D(tShore, (p - uSh.xy) * uSh.zw).rg * " + SHORE_MAX.toFixed(1) + ";\n" +
  "  float vD = sh2.x;\n" +
  // cursos angostos: kN = 1 con semi-ancho local <= hw[0], 0 con >= hw[1] (los cuerpos anchos no cambian: kN = 0)
  "  float kN = (1.0 - smoothstep(uE.x, uE.y, sh2.y)) * uE.z;\n" +   // distancia a la orilla (m), horneada
  // normales animadas: dos capas de la misma textura, rotadas y con deriva distinta; los mipmaps las aplanan solos a distancia
  "  vec4 w1 = texture2D(tWave, mat2(0.80, -0.60, 0.60, 0.80) * p / uA.x + uTime * uDrift.xy);\n" +
  "  vec4 w2 = texture2D(tWave, mat2(0.60, 0.80, -0.80, 0.60) * p / uA.y + uTime * uDrift.zw + vec2(0.37, 0.61));\n" +
  "  float wf = 1.0 - smoothstep(uB.w, uD.x, dist);\n" +
  "  vec2 s = ((w1.rg - 0.5) + 0.7 * (w2.rg - 0.5)) * 2.0 * uA.z * wf;\n" +
  "  vec3 N = normalize(vec3(s.x, 1.0, s.y));\n" +
  // profundidad aparente: de la orilla (0) al cauce (1), con un poco de ruido para que no sea un degradé perfecto
  "  float dd = clamp((vD + (w1.b - 0.5) * 0.9) / uC.z, 0.0, 1.0);\n" +
  "  dd = dd * dd * (3.0 - 2.0 * dd);\n" +
  "  dd = max(dd, kN);\n" +
  "  vec3 body = dd < 0.5 ? mix(uColShallow, uColMid, dd * 2.0) : mix(uColMid, uColDeep, dd * 2.0 - 1.0);\n" +
  "  body = mix(body, uColNarrow, kN);\n" +
  // luz difusa: mismas unidades que MeshLambert (albedo/pi · irradiancia)
  "  float NL = max(dot(N, uSunDir), 0.0);\n" +
  "  vec3 E = mix(uHemiGround, uHemiSky, 0.5 * N.y + 0.5) + uSunColor * uSunI * NL;\n" +
  "  vec3 diff = body * E / PI_ * uD.z;\n" +
  // fresnel de Schlick con la cámara real
  "  float NV = max(dot(N, V), 0.0);\n" +
  "  float F = uA.w + (1.0 - uA.w) * pow(1.0 - NV, 5.0);\n" +
  // cielo reflejado: zenit → horizonte (= color de la niebla, pasado a lineal)
  "  vec3 R = reflect(-V, N);\n" +
  "  vec3 sky = mix(pow(uFogColor, vec3(2.2)), uZenith, pow(clamp(R.y, 0.0, 1.0), 0.45));\n" +
  "  vec3 refl = sky * uB.x * mix(1.0, uF.y, kN);\n" +
  // destello del sol (Blinn-Phong normalizado)
  "  vec3 H = normalize(V + uSunDir);\n" +
  "  float spec = pow(max(dot(N, H), 0.0), uB.y) * (uB.y + 8.0) / (8.0 * PI_) * NL;\n" +
  "  vec3 col = mix(diff, refl, F) + uSunColor * uSunI * min(spec * F, 6.0) * uB.z;\n" +
  // reborde claro en la orilla (reemplaza la línea de MapLibre)
  "  float rim = (1.0 - smoothstep(0.0, 0.9, vD)) * (0.55 + 0.9 * w2.b);\n" +
  "  col = mix(col, uColRim * E / PI_, clamp(rim * uD.y * mix(1.0, uF.z, kN), 0.0, 1.0));\n" +
  "  float a = mix(uC.x, uC.y, dd);\n" +
  "  a = mix(a, 1.0, F * 0.6);\n" +
  "  a = mix(a, max(a, uF.x), kN);\n" +
  "  a *= smoothstep(0.0, uC.w * mix(1.0, uF.w, kN), vD + (w1.b - 0.5) * 0.3);\n" +   // borde suave contra el suelo
  "  a *= uFade;\n" +
  "  if (a < 0.003) discard;\n" +
  "  gl_FragColor = vec4(col, a);\n" +
  "  #include <tonemapping_fragment>\n" +
  "  #include <colorspace_fragment>\n" +
  "  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, adFog(dist));\n" +   // niebla de shaderlib, en espacio de salida
  "}\n";

const U = {   // uniforms comunes a los dos escenarios (compartidos por referencia con lighting.js donde existen)
  uCamPos: uniforms.uCamPos, uTime: uniforms.uTime,
  uSunDir: uniforms.uSunDir, uSunColor: uniforms.uSunColor, uHemiSky: uniforms.uHemiSky, uHemiGround: uniforms.uHemiGround,
  uFogColor: uniforms.uFogColor, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar, uFogMax: uniforms.uFogMax, uFogRel: uniforms.uFogRel,
  uSunI: { value: 1 },
  uZenith: { value: new THREE.Color(A1_SKY.skyColor) },
  tWave: { value: null },
  uColShallow: { value: new THREE.Color(CFG.shallow) }, uColMid: { value: new THREE.Color(CFG.color) },
  uColDeep: { value: new THREE.Color(CFG.deep) }, uColRim: { value: new THREE.Color(CFG.rim) },
  uA: { value: new THREE.Vector4(CFG.waveScale[0], CFG.waveScale[1], CFG.waveSlope, CFG.f0) },
  uB: { value: new THREE.Vector4(CFG.reflection, CFG.spec[0], CFG.spec[1], CFG.waveFade[0]) },
  uC: { value: new THREE.Vector4(CFG.alpha[0], CFG.alpha[1], CFG.shoreWidth, CFG.edgeSoft) },
  uD: { value: new THREE.Vector4(CFG.waveFade[1], CFG.rimStrength, CFG.gain, 0) },
  uDrift: { value: new THREE.Vector4(...CFG.drift) },
  uE: { value: new THREE.Vector4(CFG.narrow.hw[0], CFG.narrow.hw[1], CFG.narrow.enabled ? 1 : 0, 0) },
  uF: { value: new THREE.Vector4(CFG.narrow.alpha, CFG.narrow.reflection, CFG.narrow.rim, CFG.narrow.edge) },
  uColNarrow: { value: new THREE.Color(CFG.narrow.color) }
};

function makeMaterial(key, hasH, tex, sh) {
  const m = new THREE.ShaderMaterial({ vertexShader: hasH ? GLSL_DECL + VS : VS.replace("  w.y -= a6Low(w.xz);\n", ""), fragmentShader: FS, uniforms: { ...U, ...(hasH ? withReliefU({}) : {}), uFade: scenarioFade[key] || { value: 1 },
    tShore: { value: tex }, uSh: { value: new THREE.Vector4(sh.x0, sh.z0, 1 / (sh.W * sh.c), 1 / (sh.H * sh.c)) } } });
  m.uniforms.tWave.value = getWaveTex();
  m.side = THREE.DoubleSide;   // las astillas del earcut pueden quedar con el signo de área dudoso: no depender del culling
  m.depthTest = false; m.depthWrite = false; m.transparent = false;   // lista OPACA (como el suelo): así el receptor de sombras de A3 lo multiplica
  if (hasH) {   // A6: con terreno, prueba de profundidad contra la malla de MapLibre + polygonOffset (mismo criterio que el suelo)
    m.depthTest = true; m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4;
  }
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  return m;
}

/* ---------- el sistema ---------- */
const S = {};   // scenarioKey → { group, mesh, mat, geometry, opacity, boxes, info }
let active = wanted() && quality.water !== "plano";

const pfx = key => (key === "inicial" ? "ini" : "multi");
const setPaint = (id, prop, v) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); };

/* Capas MapLibre del agua: casi invisibles pero vivas (T9) cuando el shader está activo; originales de layers.js si no. */
function syncMapLayers(key) {
  const s = S[key]; if (!s) return;
  const o = s.opacity, p = pfx(key);
  setPaint(`${p}-agua-fill`, "fill-opacity", (active ? 0.001 : 0.38) * o);
  setPaint(`${p}-agua-line`, "line-opacity", (active ? CFG.lineOpacity : 0.7) * o);
}

function applyModes() {
  for (const k in S) { S[k].mesh.visible = active && S[k].info.tris > 0; syncMapLayers(k); }
}

/* ---------- animación en reposo (T7): el repintado lo maneja el idleDriver único del host (render/idle.js) ---------- */
const frustum = new THREE.Frustum(), tmpV = new THREE.Vector3(), _wb = new THREE.Box3(), _wv = new THREE.Vector3();
let inView = false;

export default {
  id: "water",

  build(ctx, key, data) {
    const t0 = performance.now();
    const group = new THREE.Group();
    group.name = "a4-water";
    // ¿hay terreno? (heightAt devuelve 0 mientras A6 no lo active): mismo criterio que el suelo
    const c = HOME_VIEW.center;
    const hasH = [[0, 0], [0.01, 0], [-0.01, 0], [0, 0.01], [0, -0.01]].some(([a, b]) => ctx.heightAt(c[0] + a, c[1] + b) !== 0);
    const g = buildGeometry(ctx, data, hasH);
    const mat = makeMaterial(key, hasH, g.tex, g.shore);
    const mesh = new THREE.Mesh(g.geometry, mat);
    mesh.frustumCulled = false; mesh.renderOrder = -11; mesh.name = "a4-water-" + key;
    group.add(mesh);
    S[key] = { group, mesh, mat, geometry: g.geometry, tex: g.tex, boxes: g.boxes, opacity: key === "inicial" ? 1 : 0,
      info: { hasRelief: hasH, verts: g.verts, tris: g.tris, shoreTex: g.shore.W + "x" + g.shore.H + "@" + g.shore.c.toFixed(2) + "m", polys: g.polys, failed: g.failed, tiny: g.tiny, cells: g.boxes.length, buildMs: Math.round(performance.now() - t0) } };
    applyModes();
    return { object3d: group, materials: [] };
  },

  setOpacity(key, o) {
    const s = S[key]; if (!s) return;
    s.opacity = o;   // el alfa sale de scenarioFade[key] (host.setOpacity lo escribe antes de llamarnos)
    syncMapLayers(key);
  },

  update(frame) {
    if (lights.sun) U.uSunI.value = lights.sun.intensity;
    if (U.uZenith.value.getHex() !== _zen.set(A1_SKY.skyColor).getHex()) U.uZenith.value.set(A1_SKY.skyColor);   // por si A1 cambia el cielo con la hora
    // ¿hay agua visible en cuadro y lo bastante cerca como para que se note la animación?
    inView = false;
    if (active && quality.idleFps > 0) {
      frustum.setFromProjectionMatrix(frame.viewProj);
      const cam = frame.camPosScene;
      tmpV.set(cam.x, cam.y, cam.z);
      outer: for (const k in S) {
        const s = S[k];
        if (!s.mesh.visible || s.opacity <= 0.02) continue;
        for (const b of s.boxes) {
          const lo = lowAt((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2);   // A6: caja bajada con el suelo (relieve en vivo)
          const bb = lo ? _wb.copy(b).translate(_wv.set(0, -lo, 0)) : b;
          if (bb.distanceToPoint(tmpV) > CFG.idleMaxDist) continue;
          if (frustum.intersectsBox(bb)) { inView = true; break outer; }
        }
      }
    }
    idleDriver.request("water", inView);
  },

  onQuality(q) {
    active = wanted() && q.water !== "plano";
    applyModes();
    if (!active) { inView = false; idleDriver.request("water", false); }
  },

  dispose() {
    inView = false; idleDriver.request("water", false);
    for (const k in S) { S[k].geometry.dispose(); S[k].mat.dispose(); S[k].tex.dispose(); }
    if (waveTex) { waveTex.dispose(); waveTex = null; }
  },

  stats(key) { return S[key] ? { agua: S[key].info } : {}; }
};

const _zen = new THREE.Color();
