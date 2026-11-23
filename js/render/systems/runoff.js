/* ============ Sistema de render: simulador de escorrentía · vista "Agua natural" (hidro-render, F2) ============
   Dueño: hidro-render. Contrato del host: ARQUITECTURA §2. Modelo y objetivo visual: MODELO §6. Plan: PLAN §4 F2.

   Qué dibuja: la lámina de agua `h` (m) que calcula el motor (js/hydro, worker) sobre la grilla de la cuenca (~15 m por celda)
   como cintas de agua que confluyen hacia los cauces. La lámina real es de milímetros: la visible está exagerada a propósito
   (la leyenda de la UI lo dice). Se ve con getState().mode === "natural". F3 agrega "velocidad": mapa turbo de log10(v) (runoff-velocidad.js, misma malla y datos pero
   con un índice que cubre toda la grilla) + estelas de partículas en CPU (runoff-particulas.js); F4 agrega "diferencia" (runoff-diferencia.js: mapa de log2(v_multi/v_ini) y traza punteada del diseño).

   Ciclo de vida (el host construye UNA vez, sin reconstrucción posterior):
     - build(): grupo invisible, malla vacía y material por escenario. Cero costo con el simulador apagado: no hay texturas, no se
       compila el shader (el grupo está invisible) y update() sale temprano sin tocar el idleDriver.
     - evento "runoff" (cambio "result"): llegan h/v/dirección. La primera vez se hornea la grilla de vértices (compartida por los
       dos escenarios: x,z lineales en Mercator, y = heightAt + offset; la bajada viva a6Low va en el vertex shader). Cada resultado
       (también al cambiar la lluvia) REEMPLAZA los datos in situ: se reescribe el RGBA32F del escenario y el índice de la malla.
     - evento "runoff" (cambio "mode"): muestra u oculta.

   Datos en la GPU (WebGL2 sin extensiones de render a float; en celulares solo se LEE):
     tD   RGBA32F, NEAREST, una por escenario: r = h (m), g = v (m/s), b/a = dirección unitaria del flujo (x este, z sur).
          El filtrado bilineal es manual en el fragment shader (NEAREST es el único filtro de float que WebGL2 garantiza).
     tIn  R8, LINEAR (el filtrado de enteros normalizados sí es de hardware), compartida: 1 = celda dentro del campo.
   La malla es una grilla de 1 vértice por celda; el índice solo incluye los cuadros donde alguna esquina tiene lámina visible
   (en el sintético ~10 % de la cuenca), así el costo de rasterizado es el de las cintas y no el de 3 km² de agua inexistente.

   Shader: derivado de water.js (fresnel de Schlick con uCamPos, cielo zenit→horizonte, destello del sol, luz de hemisferio + sol,
   niebla GLSL_ADFOG después del tone mapping, uFade). Alfa y color por profundidad; ondas = flowmap de dos fases cruzadas
   sobre la textura de normales de water.js (getWaveTex), desplazadas en la dirección del flujo con rapidez según v.

   Orden de dibujo: renderOrder −9,5 = después del suelo (−10) y antes del receptor de sombras (−9): el agua queda sobre el suelo
   y recibe gratis las sombras de los árboles (el receptor multiplica lo ya dibujado). Todos los de esa lista tienen depthWrite
   apagado, así que el desempate entre ellos es solo el orden; contra la malla de terreno de MapLibre se usa depthTest +
   polygonOffset(−2, −4) (mismo criterio que suelo y agua) y yOff por encima del suelo. */
import * as THREE from "three";
import { A1_SKY, A4_GROUND, HIDRO } from "../../core/config.js?v=20261201";
import { quality } from "../../core/quality.js?v=20261201";
import { on } from "../../core/events.js?v=20261201";
import { idleDriver } from "../idle.js?v=20261201";
import { map } from "../../map/style.js?v=20261201";
import { lights, uniforms } from "../lighting.js?v=20261201";
import { GLSL_ADFOG, GLSL_FOG_UNIFORMS, scenarioFade } from "../shaderlib.js?v=20261201";
import { simFade } from "./runoff-fade.js?v=20261201";
import { GLSL_DECL, lowAt, terrain, withReliefU } from "../../terrain/terrain.js?v=20261201";
import { state as appState } from "../../core/state.js?v=20261201";
import { getState } from "../../hydro/state.js?v=20261201";
import { pxToLonLat } from "../../hydro/grid.js?v=20261201";
import { getWaveTex } from "./water.js?v=20261201";
import { makeVelocityMaterial } from "./runoff-velocidad.js?v=20261201";
import { createParticles } from "./runoff-particulas.js?v=20261201";
import { makeDifMaterial, makeDlogTex, createTraza } from "./runoff-diferencia.js?v=20261201";
export { turboCss } from "./runoff-turbo.js?v=20261201";   // la leyenda de la UI importa la paleta desde acá

/* ---------- diales: HIDRO.vis.natural (antes constante local NAT) ---------- */
const NAT = HIDRO.vis.natural, VEL = HIDRO.vis.velocidad, PV = HIDRO.vis.particulas, DIF = HIDRO.vis.diferencia;
const glf = n => { const s = String(+n); return /[.e]/.test(s) ? s : s + ".0"; };   // número como literal float de GLSL
const LIFT_FROM = glf(VEL.liftDistDesdeM);

/* ---------- shaders ---------- */
const VS =
  "varying vec3 vWp;\nuniform vec3 uCamPos;\nuniform float uLift;\n" +
  "void main() {\n  vec4 w = modelMatrix * vec4(position, 1.0);\n  w.y -= a6Low(w.xz);\n  w.y += uLift * max(length(uCamPos - w.xyz) - " + LIFT_FROM + ", 0.0);\n  vWp = w.xyz;\n" +
  "  gl_Position = projectionMatrix * viewMatrix * w;\n}\n";

/* uG = afín escena→celda (fx = x·G.x + G.y ; fy = z·G.z + G.w) · uN = tamaño de la grilla
   uV = (h visible, h opaca, alfa fuera, ganancia del cuerpo) · uW = (escala capa 1, escala capa 2, pendiente, ciclo s)
   uS = (base de rapidez, ganancia de rapidez, reflejo, f0) · uQ = (exponente del destello, intensidad, aplanado desde, hasta) */
const FS =
  "precision highp float;\n" +
  "varying vec3 vWp;\n" +
  "uniform sampler2D tD;\nuniform sampler2D tIn;\nuniform sampler2D tWave;\n" +
  "uniform vec4 uG;\nuniform vec2 uN;\nuniform vec4 uV;\nuniform vec4 uW;\nuniform vec4 uS;\nuniform vec4 uQ;\n" +
  "uniform vec3 uCamPos;\nuniform float uTime;\nuniform float uFlowOn;\nuniform float uFade;\n" +
  "uniform vec3 uSunDir;\nuniform vec3 uSunColor;\nuniform float uSunI;\nuniform vec3 uHemiSky;\nuniform vec3 uHemiGround;\n" +
  "uniform vec3 uZenith;\nuniform vec3 uColShallow;\nuniform vec3 uColDeep;\nuniform float uEdgeNoise;\n" +
  GLSL_FOG_UNIFORMS + GLSL_ADFOG +
  "const float PI_ = 3.14159265;\n" +
  "vec4 tx(ivec2 i) { return texelFetch(tD, clamp(i, ivec2(0), ivec2(uN) - 1), 0); }\n" +
  // ondas: dos capas de la textura de normales (xy = pendiente, z = altura), rotadas distinto
  "vec3 wave(vec2 q) {\n" +
  "  vec4 a = texture2D(tWave, mat2(0.80, -0.60, 0.60, 0.80) * q / uW.x);\n" +
  "  vec4 b = texture2D(tWave, mat2(0.60, 0.80, -0.80, 0.60) * q / uW.y + vec2(0.37, 0.61));\n" +
  "  return vec3((a.rg - 0.5) + 0.7 * (b.rg - 0.5), a.b);\n}\n" +
  "void main() {\n" +
  "  vec3 toCam = uCamPos - vWp;\n  float dist = length(toCam);\n  vec3 V = toCam / dist;\n  vec2 p = vWp.xz;\n" +
  // bilineal manual de h, v y dirección (la dirección se pesa con la lámina: las celdas secas no la tuercen)
  "  vec2 f = vec2(p.x * uG.x + uG.y, p.y * uG.z + uG.w);\n" +
  // distorsión de dominio con ruido estático (±uEdgeNoise celdas): rompe la escalera de 15 m del borde sin mover la red de cauces
  "  f += (texture2D(tWave, p / 41.0).rg - 0.5) * 2.0 * uEdgeNoise;\n" +
  "  ivec2 i0 = ivec2(floor(f));\n  vec2 t = f - vec2(i0);\n  t = t * t * (3.0 - 2.0 * t);\n" +
  "  vec4 d00 = tx(i0), d10 = tx(i0 + ivec2(1, 0)), d01 = tx(i0 + ivec2(0, 1)), d11 = tx(i0 + ivec2(1, 1));\n" +
  "  float w00 = (1.0 - t.x) * (1.0 - t.y), w10 = t.x * (1.0 - t.y), w01 = (1.0 - t.x) * t.y, w11 = t.x * t.y;\n" +
  "  float h = d00.r * w00 + d10.r * w10 + d01.r * w01 + d11.r * w11;\n" +
  "  float v = d00.g * w00 + d10.g * w10 + d01.g * w01 + d11.g * w11;\n" +
  "  vec2 dr = d00.ba * (w00 * (d00.r + 1e-5)) + d10.ba * (w10 * (d10.r + 1e-5)) + d01.ba * (w01 * (d01.r + 1e-5)) + d11.ba * (w11 * (d11.r + 1e-5));\n" +
  "  float dl = length(dr);\n  vec2 dir = dl > 1e-9 ? dr / dl : vec2(0.0);\n" +
  // borde orgánico: la lámina se modula con ruido ESTÁTICO (no parpadea)
  "  float hE = h * (1.0 + 0.5 * (texture2D(tWave, p / 9.0).b - 0.5));\n" +
  "  float edge = smoothstep(uV.x * 0.6, uV.x * 1.25, hE);\n" +
  "  float body = smoothstep(uV.x, uV.y, hE);\n" +
  "  if (edge < 0.004) discard;\n" +
  // flowmap de dos fases cruzadas: cada fase arrastra el patrón por el flujo y vuelve a empezar; se mezclan con pesos triangulares
  "  float tt = uTime * uFlowOn / uW.w;\n" +
  "  float ph0 = fract(tt), ph1 = fract(tt + 0.5);\n" +
  "  float k0 = 1.0 - abs(1.0 - 2.0 * ph0), k1 = 1.0 - k0;\n" +
  "  vec2 off = dir * (uS.x + uS.y * v) * uW.w;\n" +
  "  vec3 wv = k0 * wave(p - off * ph0) + k1 * wave(p - off * ph1);\n" +
  "  float wf = 1.0 - smoothstep(uQ.z, uQ.w, dist);\n" +
  "  vec2 s = wv.xy * 2.0 * uW.z * wf * (0.55 + 0.9 * clamp(v, 0.0, 1.0));\n" +
  "  vec3 N = normalize(vec3(s.x, 1.0, s.y));\n" +
  // color por profundidad (somero → profundo) y un poco de textura a lo largo del flujo
  "  float dd = pow(body, 0.75);\n" +
  "  vec3 base = mix(uColShallow, uColDeep, dd);\n" +
  "  base *= 1.0 + 0.22 * (wv.z - 0.5);\n" +
  "  float NL = max(dot(N, uSunDir), 0.0);\n" +
  "  vec3 E = mix(uHemiGround, uHemiSky, 0.5 * N.y + 0.5) + uSunColor * uSunI * NL;\n" +
  "  vec3 diff = base * E / PI_ * uV.w;\n" +
  "  float NV = max(dot(N, V), 0.0);\n" +
  "  float F = uS.w + (1.0 - uS.w) * pow(1.0 - NV, 5.0);\n" +
  "  vec3 R = reflect(-V, N);\n" +
  "  vec3 sky = mix(pow(uFogColor, vec3(2.2)), uZenith, pow(clamp(R.y, 0.0, 1.0), 0.45));\n" +
  "  vec3 refl = sky * uS.z;\n" +
  "  vec3 H = normalize(V + uSunDir);\n" +
  "  float spec = pow(max(dot(N, H), 0.0), uQ.x) * (uQ.x + 8.0) / (8.0 * PI_) * NL;\n" +
  "  vec3 col = mix(diff, refl, F) + uSunColor * uSunI * min(spec * F, 6.0) * uQ.y;\n" +
  // alfa: invisible bajo ~2 cm, crece hasta opaco hacia hOpaca; el rasante la sube un poco (fresnel)
  "  float a0 = mix(" + NAT.alphaMin.toFixed(3) + ", " + NAT.alphaMax.toFixed(3) + ", body);\n" +
  "  float a = edge * mix(a0, 1.0, F * 0.5);\n" +
  "  float ins = texture2D(tIn, (f + 0.5) / uN).r;\n" +
  "  a *= mix(uV.z, 1.0, ins);\n" +
  "  a *= uFade;\n" +
  "  if (a < 0.003) discard;\n" +
  "  gl_FragColor = vec4(col, a);\n" +
  "  #include <tonemapping_fragment>\n" +
  "  #include <colorspace_fragment>\n" +
  "  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, adFog(dist));\n" +
  "}\n";

/* Subida de las capas de velocidad y estelas proporcional a la distancia a la cámara (m por m): lejos, la malla de terreno de MapLibre
   (LOD grueso) asoma por encima de la nuestra (fina) y la tapa a manchones; con 0,002 no se ve ni en la cenital a varios km y en
   el rasante son centímetros. La lámina natural (F2) no la usa (no cambia su aspecto). */
const LIFT = VEL.liftDist;       // la subida empieza a VEL.liftDistDesdeM de la cámara: de cerca no se mueve nada
const HALO_M = VEL.haloM;        // m · en Velocidad y Diferencia el mapa se desvanece a 0 a esta distancia del borde del campo
const PART_IDLE_MAX = PV.idleMaxDistM;   // m · las estelas se ven (y se animan) desde mucho más lejos que las ondas del agua natural (1500 m)

/* Cámara y niebla, compartidos por referencia con lighting.js: los usan los tres materiales (natural, velocidad, estelas). */
const SHARED = {
  uCamPos: uniforms.uCamPos, uLift: { value: LIFT }, uLift0: { value: VEL.liftFijoM },   // m · subida fija (cerca): la malla de MapLibre asoma en manchitas ovaladas a < 0,3 m del suelo
   
  uFogColor: uniforms.uFogColor, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar, uFogMax: uniforms.uFogMax, uFogRel: uniforms.uFogRel
};

const U = {   // uniforms comunes a los dos escenarios (compartidos por referencia con lighting.js donde existen)
  uCamPos: uniforms.uCamPos, uTime: uniforms.uTime, uLift: SHARED.uLift,
  uSunDir: uniforms.uSunDir, uSunColor: uniforms.uSunColor, uHemiSky: uniforms.uHemiSky, uHemiGround: uniforms.uHemiGround,
  uFogColor: uniforms.uFogColor, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar, uFogMax: uniforms.uFogMax, uFogRel: uniforms.uFogRel,
  uSunI: { value: 1 },
  uZenith: { value: new THREE.Color(A1_SKY.skyColor) },
  uColShallow: { value: new THREE.Color(NAT.colShallow) }, uColDeep: { value: new THREE.Color(NAT.colDeep) },
  uFlowOn: { value: 1 },
  uEdgeNoise: { value: NAT.edgeNoise },
  uV: { value: new THREE.Vector4(HIDRO.vis.hVisibleM, HIDRO.vis.hOpacoM, NAT.outside, NAT.gain) },
  uW: { value: new THREE.Vector4(NAT.waveScale[0], NAT.waveScale[1], NAT.waveSlope, NAT.cycle) },
  uS: { value: new THREE.Vector4(NAT.speedBase, NAT.speedGain, NAT.reflection, NAT.f0) },
  uQ: { value: new THREE.Vector4(NAT.spec[0], NAT.spec[1], NAT.waveFade[0], NAT.waveFade[1]) }
};

function makeMaterial(key) {
  const m = new THREE.ShaderMaterial({
    vertexShader: GLSL_DECL + VS, fragmentShader: FS,
    uniforms: { ...U, ...withReliefU({}), uFade: simFade[key] || { value: 1 },
      tD: { value: null }, tIn: { value: null }, tWave: { value: null }, uG: { value: new THREE.Vector4(1, 0, 1, 0) }, uN: { value: new THREE.Vector2(1, 1) } }
  });
  m.side = THREE.DoubleSide;
  m.depthTest = true; m.depthWrite = false; m.transparent = false;   // lista OPACA con mezcla a medida (como suelo y agua): el receptor de sombras la multiplica
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;   // alfa de destino preservado
  return m;
}

/* ---------- estado ---------- */
const S = {};          // key → { group, mesh, mat, geom, idx, data, tex, tris, hasData, vmesh, vmat, vgeom, part }
let G = null;          // grilla compartida: { nx, ny, gx0, gy0, pos, inTex, aff, box, idxAll (índice completo, perezoso) }
let lastRes = null;    // último resultado del motor
let mode = "off";      // espejo de getState().mode (evento "runoff")
let wantReq = false;   // último valor pasado a idleDriver.request("runoff", …)
let ctxRef = null, subscribed = false;
const MB = 1 / 1048576;

const shown = () => (mode === "natural" || mode === "velocidad" || mode === "diferencia") && !!G && terrain.active;
/* Diferencia es UNA capa que compara los dos escenarios: se ve igual en inicial y en multi. El host oculta el grupo del escenario con fade ≤ 0,02;
   para no dibujarla dos veces (el doble alfa se vería como un pulso en el fundido) la dibuja el grupo "inicial" mientras sea visible y,
   cuando ya no, el "multi". Su uFade es la suma de los dos fades (= la opacidad del diseño), así no baja a la mitad en el cruce. */
const DIF_FADE = { value: 1 };
const difActive = key => mode === "diferencia" && (key === "inicial" ? scenarioFade.inicial.value > 0.02 : !(scenarioFade.inicial.value > 0.02));
let traza = null;

/* Halo del campo (Velocidad): 1 dentro, cae linealmente a 0 a HALO_M metros del borde. Distancia por chamfer 3-4 (dos pasadas, en CPU,
   una vez por resultado) → R8 con filtrado lineal que leen el mapa y las estelas. */
function buildHalo(inside) {
  const { nx, ny } = G, n = nx * ny, d = G.dist || (G.dist = new Float32Array(n)), INF = 1e9;
  for (let i = 0; i < n; i++) d[i] = inside[i] ? 0 : INF;
  for (let j = 0; j < ny; j++) for (let i = 0, q = j * nx; i < nx; i++, q++) {
    let v = d[q];
    if (i > 0 && d[q - 1] + 3 < v) v = d[q - 1] + 3;
    if (j > 0) {
      if (d[q - nx] + 3 < v) v = d[q - nx] + 3;
      if (i > 0 && d[q - nx - 1] + 4 < v) v = d[q - nx - 1] + 4;
      if (i < nx - 1 && d[q - nx + 1] + 4 < v) v = d[q - nx + 1] + 4;
    }
    d[q] = v;
  }
  const cells = HALO_M / G.cellM, out = G.haloTex.image.data;
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1, q = j * nx + i; i >= 0; i--, q--) {
    let v = d[q];
    if (i < nx - 1 && d[q + 1] + 3 < v) v = d[q + 1] + 3;
    if (j < ny - 1) {
      if (d[q + nx] + 3 < v) v = d[q + nx] + 3;
      if (i < nx - 1 && d[q + nx + 1] + 4 < v) v = d[q + nx + 1] + 4;
      if (i > 0 && d[q + nx - 1] + 4 < v) v = d[q + nx - 1] + 4;
    }
    d[q] = v;
    const h = 1 - v / 3 / cells;
    out[q] = h <= 0 ? 0 : h >= 1 ? 255 : (h * 255 + 0.5) | 0;
  }
  G.haloTex.needsUpdate = true;
}

/* Índice de TODA la grilla (mapa de velocidad): se arma una vez, perezoso (con el simulador en "natural" no se paga), y lo
   comparten los dos escenarios. */
function ensureFieldIndex() {
  if (!G || G.idxAll) return;
  const { nx, ny } = G, ix = new Uint32Array(6 * (nx - 1) * (ny - 1)), hl = G.haloTex.image.data;
  let c = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0, q = j * nx; i < nx - 1; i++, q++) {
    if (!(hl[q] | hl[q + 1] | hl[q + nx] | hl[q + nx + 1])) continue;   // fuera del halo no hay nada que dibujar
    ix[c++] = q; ix[c++] = q + nx; ix[c++] = q + 1; ix[c++] = q + 1; ix[c++] = q + nx; ix[c++] = q + nx + 1;
  }
  G.idxAll = new THREE.BufferAttribute(ix.slice(0, c), 1); G.vTris = c / 3;
  for (const k in S) S[k].vgeom.setIndex(G.idxAll);
}

/* Diferencia (perezoso: con otra vista no se paga nada): textura R32F de dlog (referencia al resultado) y contorno punteado del diseño multi. */
function ensureDif() {
  if (!G || !lastRes || !lastRes.dlog) return;
  const m = lastRes.meta;
  if (!G.difTex) G.difTex = makeDlogTex(lastRes.dlog, m.nx, m.ny);
  else if (G.difTex.image.data !== lastRes.dlog) { G.difTex.image.data = lastRes.dlog; G.difTex.needsUpdate = true; }
  for (const k in S) S[k].dmat.uniforms.tDl.value = G.difTex;
  const src = S.multi && S.multi.src;
  if (src && !traza.isBuilt(G, src)) traza.build(ctxRef, G, src);
}
function releaseDif() {
  if (G && G.difTex) { G.difTex.dispose(); G.difTex = null; }
  if (traza && traza.points) traza.release();
  for (const k in S) { S[k].dmesh.visible = false; S[k].tmesh.visible = false; }
}

function applyVisibility() {
  const on_ = shown(), vel = on_ && mode === "velocidad", dif = on_ && mode === "diferencia";
  if (vel || dif) ensureFieldIndex();
  if (dif) ensureDif();
  for (const k in S) {
    const s = S[k], ok = on_ && s.hasData;
    s.group.visible = ok;
    s.mesh.visible = mode === "natural";
    s.vmesh.visible = vel;
    s.part.show(ok && vel);
    s.dmesh.visible = ok && difActive(k); s.tmesh.visible = s.dmesh.visible && traza.points > 0;
  }
  if (mode === "off") { for (const k in S) S[k].part.release(); releaseDif(); }   // simulador apagado: devuelve la memoria de las estelas y de Diferencia
  else if (mode !== "diferencia") releaseDif();
  if (!on_ && wantReq) { wantReq = false; idleDriver.request("runoff", false); }
  map.triggerRepaint();
}

/* Hornea la grilla de vértices (una vez por cuenca): x,z lineales (Mercator es lineal en la escena), y = heightAt + yOff. */
function initGrid(ctx, meta) {
  const { nx, ny, gx0, gy0, z } = meta;
  if (G) { G.pos.dispose?.(); G.inTex.dispose(); G.haloTex.dispose(); if (G.difTex) G.difTex.dispose(); if (traza) traza.release(); G = null; for (const k in S) S[k].vgeom.setIndex(null); }
  // columnas: lon solo depende de i; filas: lat solo de j (esquinas de píxel, convención de terrain.hf)
  const [xa, za] = ctx.toScene(...pxToLonLat(gx0, gy0, z)), [xb, zb] = ctx.toScene(...pxToLonLat(gx0 + nx, gy0 + ny, z));
  const dx = (xb - xa) / nx, dz = (zb - za) / ny;
  const lon = new Float64Array(nx), lat = new Float64Array(ny);
  for (let i = 0; i < nx; i++) lon[i] = pxToLonLat(gx0 + i, gy0, z)[0];
  for (let j = 0; j < ny; j++) lat[j] = pxToLonLat(gx0, gy0 + j, z)[1];
  const pos = new Float32Array(nx * ny * 3);
  let ymin = 1e9, ymax = -1e9;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const o = (j * nx + i) * 3, y = ctx.heightAt(lon[i], lat[j]) + NAT.yOff;
    pos[o] = xa + i * dx; pos[o + 1] = y; pos[o + 2] = za + j * dz;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  const inTex = new THREE.DataTexture(new Uint8Array(nx * ny), nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
  inTex.magFilter = inTex.minFilter = THREE.LinearFilter; inTex.generateMipmaps = false; inTex.flipY = false;
  inTex.wrapS = inTex.wrapT = THREE.ClampToEdgeWrapping; inTex.unpackAlignment = 1; inTex.needsUpdate = true;
  const haloTex = new THREE.DataTexture(new Uint8Array(nx * ny), nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
  haloTex.magFilter = haloTex.minFilter = THREE.LinearFilter; haloTex.generateMipmaps = false; haloTex.flipY = false;
  haloTex.wrapS = haloTex.wrapT = THREE.ClampToEdgeWrapping; haloTex.unpackAlignment = 1; haloTex.needsUpdate = true;
  G = { nx, ny, gx0, gy0, haloTex, cellM: meta.cell, pos: new THREE.BufferAttribute(pos, 3), inTex, mk: new Uint8Array(nx * ny), mk2: new Uint8Array(nx * ny),
    aff: new THREE.Vector4(1 / dx, -xa / dx, 1 / dz, -za / dz),   // fx = (x − xa)/dx ; fy = (z − za)/dz
    box: new THREE.Box3(new THREE.Vector3(xa, ymin, za), new THREE.Vector3(xa + nx * dx, ymax, za + ny * dz)) };
  for (const k in S) {
    const s = S[k];
    s.geom.setAttribute("position", G.pos);
    s.idx = new THREE.BufferAttribute(new Uint32Array(6 * (nx - 1) * (ny - 1)), 1); s.idx.setUsage(THREE.DynamicDrawUsage);
    s.geom.setIndex(s.idx);
    if (s.tex) { s.tex.dispose(); s.tex = null; }
    s.data = new Float32Array(nx * ny * 4);
    s.mat.uniforms.uG.value.copy(G.aff); s.mat.uniforms.uN.value.set(nx, ny);
    s.mat.uniforms.tIn.value = inTex; s.mat.uniforms.tWave.value = getWaveTex();
    s.vgeom.setAttribute("position", G.pos);
    s.vmat.uniforms.uG.value.copy(G.aff); s.vmat.uniforms.uN.value.set(nx, ny); s.vmat.uniforms.tIn.value = haloTex;
    s.dmat.uniforms.uG.value.copy(G.aff); s.dmat.uniforms.uN.value.set(nx, ny); s.dmat.uniforms.tIn.value = haloTex;
    { const u = s.part.mat.uniforms; u.uG.value.copy(G.aff); u.uN.value.set(nx, ny); u.tIn.value = haloTex; }
  }
}

/* Reemplaza los datos de los dos escenarios con el resultado vigente (primera vez y cada recálculo por lluvia). */
function setResult(res) {
  if (!ctxRef || !res || !res.meta) return;
  lastRes = res;
  const m = res.meta;
  if (!G || G.nx !== m.nx || G.ny !== m.ny || G.gx0 !== m.gx0 || G.gy0 !== m.gy0) initGrid(ctxRef, m);
  const n = m.nx * m.ny, thr = HIDRO.vis.hVisibleM * 0.5;   // el borde empieza en 0,6·hVisible (con el ruido de h, 0,45): 0,5 lo cubre
  const ins = G.inTex.image.data;
  for (let i = 0; i < n; i++) ins[i] = res.inside[i] ? 255 : 0;
  G.inTex.needsUpdate = true;
  buildHalo(res.inside);
  G.idxAll = null;   // el índice de Velocidad depende del halo: se rehace al mostrar
  for (const k in S) {
    const s = S[k], r = res[k];
    if (!r) continue;
    const d = s.data, h = r.h, v = r.v, dx = res.dirX, dy = res.dirY;
    for (let i = 0, o = 0; i < n; i++, o += 4) { d[o] = h[i]; d[o + 1] = v[i]; d[o + 2] = dx[i]; d[o + 3] = dy[i]; }
    if (!s.tex) {
      s.tex = new THREE.DataTexture(d, m.nx, m.ny, THREE.RGBAFormat, THREE.FloatType);
      s.tex.internalFormat = "RGBA32F"; s.tex.magFilter = s.tex.minFilter = THREE.NearestFilter; s.tex.generateMipmaps = false; s.tex.flipY = false;
      s.tex.wrapS = s.tex.wrapT = THREE.ClampToEdgeWrapping; s.tex.unpackAlignment = 4;
      s.mat.uniforms.tD.value = s.tex; s.vmat.uniforms.tD.value = s.tex;
    }
    s.tex.needsUpdate = true;
    // índice: solo los cuadros que pueden mostrar agua. El bilineal no supera el máximo de sus esquinas, y la distorsión de dominio del
    // shader trae valores de hasta 1 celda de distancia: se dilata 1 celda la máscara de "h ≥ umbral" (separable) antes de armar los cuadros.
    const ix = s.idx.array, nx = m.nx, ny = m.ny, mk = G.mk, mk2 = G.mk2;
    for (let i = 0; i < n; i++) mk[i] = h[i] >= thr ? 1 : 0;
    for (let j = 0; j < ny; j++) for (let i = 0, q = j * nx; i < nx; i++, q++) mk2[q] = mk[q] | (i > 0 ? mk[q - 1] : 0) | (i < nx - 1 ? mk[q + 1] : 0);
    for (let j = 0; j < ny; j++) for (let i = 0, q = j * nx; i < nx; i++, q++) mk[q] = mk2[q] | (j > 0 ? mk2[q - nx] : 0) | (j < ny - 1 ? mk2[q + nx] : 0);
    let c = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0, q = j * nx; i < nx - 1; i++, q++) {
      if (!(mk[q] | mk[q + 1] | mk[q + nx] | mk[q + nx + 1])) continue;
      ix[c++] = q; ix[c++] = q + nx; ix[c++] = q + 1; ix[c++] = q + 1; ix[c++] = q + nx; ix[c++] = q + nx + 1;
    }
    s.idx.needsUpdate = true; s.geom.setDrawRange(0, c); s.tris = c / 3; s.hasData = true;
    s.part.setField(G, res, r);   // campo de advección nuevo (lluvia incluida): referencias, sin reconstruir
  }
  applyVisibility();
}

/* ---------- animación en reposo: el repintado lo maneja el idleDriver único del host ---------- */
const frustum = new THREE.Frustum(), _cam = new THREE.Vector3(), _bb = new THREE.Box3(), _lo = new THREE.Vector3();

export default {
  id: "runoff",

  build(ctx, key, data) {
    ctxRef = ctx;
    const group = new THREE.Group();
    group.name = "hidro-runoff"; group.visible = false;   // simulador apagado = grupo invisible (cero costo)
    const geom = new THREE.BufferGeometry();
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    geom.setDrawRange(0, 0);
    const mat = makeMaterial(key);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false; mesh.renderOrder = -9.5; mesh.name = "hidro-runoff-" + key;
    group.add(mesh);
    // mapa de velocidad: malla propia (comparte posiciones y, perezoso, el índice completo) y estelas (un draw call)
    const vgeom = new THREE.BufferGeometry();
    vgeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    const vmat = makeVelocityMaterial(key, SHARED);
    const vmesh = new THREE.Mesh(vgeom, vmat);
    vmesh.frustumCulled = false; vmesh.renderOrder = -9.5; vmesh.name = "hidro-runoff-vel-" + key; vmesh.visible = false;
    group.add(vmesh);
    // Diferencia: malla propia sobre la geometría del mapa de velocidad (misma grilla e índice con halo) y la traza (una geometría compartida)
    const dmat = makeDifMaterial(SHARED, DIF_FADE);
    const dmesh = new THREE.Mesh(vgeom, dmat);
    dmesh.frustumCulled = false; dmesh.renderOrder = -9.5; dmesh.name = "hidro-runoff-dif-" + key; dmesh.visible = false;
    group.add(dmesh);
    if (!traza) traza = createTraza(SHARED, DIF_FADE, () => map.getCanvas());
    const tmesh = traza.makeMesh("hidro-runoff-traza-" + key);
    group.add(tmesh);
    const part = createParticles(ctx, key, SHARED, () => map.getCanvas());
    part.configure(quality);
    group.add(part.mesh);
    S[key] = { group, mesh, mat, geom, idx: null, data: null, tex: null, tris: 0, hasData: false, vmesh, vmat, vgeom, part, dmesh, dmat, tmesh, src: data };
    if (!subscribed) {   // una sola suscripción para los dos escenarios
      subscribed = true;
      on("runoff", p => {
        mode = p.mode;
        if (p.cambio === "opacity") { if (shown()) map.triggerRepaint(); return; }   // el update() recalcula uFade en el próximo cuadro
        if (p.cambio === "result" && p.result) setResult(p.result);
        else applyVisibility();
      });
    }
    const st = getState();
    mode = st.mode;
    if (st.result && key === "multi") setResult(st.result);   // por si el resultado ya existía (ambos escenarios ya construidos)
    return { object3d: group, materials: [] };
  },

  update(frame) {
    if (!shown()) { if (wantReq) { wantReq = false; idleDriver.request("runoff", false); } return; }
    const vel = mode === "velocidad", dif = mode === "diferencia";
    /* fundido propio: el del escenario sin el factor del diseño (se divide por designOpacity, que nunca baja de 0,2) × opacidad del simulador */
    const dOp = Math.max(0.05, appState.designOpacity || 1), sOp = getState().opacity;
    simFade.inicial.value = Math.min(1, scenarioFade.inicial.value / dOp) * sOp;
    simFade.multi.value = Math.min(1, scenarioFade.multi.value / dOp) * sOp;
    if (dif) {   // una sola capa: fade = opacidad del diseño; la dibuja un solo grupo; la raya de la traza se mide en píxeles de pantalla
      DIF_FADE.value = Math.min(1, (scenarioFade.inicial.value + scenarioFade.multi.value) / dOp) * sOp;
      for (const k in S) { const s = S[k]; s.dmesh.visible = s.hasData && difActive(k); s.tmesh.visible = s.dmesh.visible && traza.points > 0; }
      traza.setViewport(); traza.updatePx(frame.viewProj);
    }
    if (!vel && !dif && lights.sun) U.uSunI.value = lights.sun.intensity;
    if (!vel && !dif && U.uZenith.value.getHex() !== _zen.set(A1_SKY.skyColor).getHex()) U.uZenith.value.set(A1_SKY.skyColor);
    let anim = false;
    if (quality.idleFps > 0) {
      let vis = false;
      for (const k in S) if (S[k].group && S[k].group.visible && scenarioFade[k] && scenarioFade[k].value > 0.02 && !dif && (!vel || S[k].part.animated)) vis = true;
      if (vis) {
        frustum.setFromProjectionMatrix(frame.viewProj);
        _cam.set(frame.camPosScene.x, frame.camPosScene.y, frame.camPosScene.z);
        const lo = lowAt((G.box.min.x + G.box.max.x) / 2, (G.box.min.z + G.box.max.z) / 2);   // caja bajada con el suelo (relieve en vivo)
        _bb.copy(G.box); if (lo) _bb.translate(_lo.set(0, -lo, 0));
        anim = _bb.distanceToPoint(_cam) < (vel ? PART_IDLE_MAX : NAT.idleMaxDist) && frustum.intersectsBox(_bb);
      }
    }
    if (vel) {   // estelas: un paso por frame, solo de los escenarios visibles (en el fundido, los dos: se cruzan con uFade)
      const dt = Math.max(0, frame.dt || 0) / 1000;
      _cam.set(frame.camPosScene.x, frame.camPosScene.y, frame.camPosScene.z);
      const dCam = G.box.distanceToPoint(_cam);   // sin la bajada viva: alcanza para un LOD
      for (const k in S) {
        const part = S[k].part;
        if (!part.mesh.visible || !(scenarioFade[k] && scenarioFade[k].value > 0.02)) continue;
        part.setViewport();
        part.setDist(dCam);
        if (anim) part.tick(dt);
      }
    }
    if (anim !== wantReq) { wantReq = anim; idleDriver.request("runoff", anim); }
  },

  /* Baja: sin animación de normales (idleFps 0). Las ondas quedan congeladas en una fase fija. */
  onQuality(q) {
    U.uFlowOn.value = q.idleFps > 0 ? 1 : 0;
    for (const k in S) { S[k].part.configure(q); if (S[k].hasData && lastRes) S[k].part.setField(G, lastRes, lastRes[k]); }
    if (G) applyVisibility();
    if (!(q.idleFps > 0) && wantReq) { wantReq = false; idleDriver.request("runoff", false); }
  },

  dispose() {
    wantReq = false; idleDriver.request("runoff", false);
    for (const k in S) {
      const s = S[k]; if (!s || !s.geom) continue;
      s.geom.dispose(); s.mat.dispose(); s.vgeom.dispose(); s.vmat.dispose(); s.dmat.dispose(); s.part.dispose(); if (s.tex) s.tex.dispose();
    }
    if (G) { G.inTex.dispose(); if (G.difTex) G.difTex.dispose(); }
    if (traza) traza.dispose();
  },

  stats(key) {
    const s = S[key];
    if (!s || !s.hasData) return {};   // simulador nunca prendido: no agrega claves (stats() idéntico al de antes)
    const fieldTris = G && G.vTris || 0;
    const dif = mode === "diferencia", difMB = G && G.difTex && key === "inicial" ? G.nx * G.ny * 4 * MB + (traza ? traza.mb : 0) : 0;   // la textura de dlog y la traza se cuentan una vez (en "inicial")
    const bytes = (s.data ? s.data.byteLength : 0) + (G && key === "inicial" ? G.nx * G.ny + (G.idxAll ? G.idxAll.array.byteLength : 0) : 0);
    return { runoffTris: (mode === "velocidad" || dif ? fieldTris : s.tris) + s.part.tris + (dif && s.tmesh.visible ? traza.tris : 0), runoffParticles: s.part.count,
      runoffTexMB: +(bytes * MB + s.part.texMB + difMB).toFixed(2) };
  }
};

/* Para la verificación: tiempo medio (ms, CPU) del paso de partículas por escenario. */
export function particleTiming() { const o = {}; for (const k in S) o[k] = +S[k].part.tickMs.toFixed(3); return o; }

const _zen = new THREE.Color();
