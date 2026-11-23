/* ============ Sistema de render: sombras de los árboles (Ola 2, A3) ============
   Dueño: A3. Contrato: §6.3. Diales en config.js (bloque A3) y método en handoffs/a3-sombras.md.

   Tres piezas, todas por escenario (cuelgan del grupo del escenario: crecimiento y cross-fade gratis):

   1. PASE DE SOMBRAS propio (no el shadowMap de Three). Una cámara ortográfica alineada con el sol y
      ajustada a la ZONA ÚTIL alrededor del objetivo de la cámara (lado ∝ distancia cámara-objetivo, T1),
      con snapping al texel. Rinde solo profundidad (DepthTexture con comparación por hardware) de los
      árboles: tarjetas con alphaTest (cerca) o impostor (lejos). Se recalcula SOLO si la zona sale de
      su margen, cambia el sol, el crecimiento, el escenario visible o la calidad: en reposo cuesta 0.
      Por qué propio: con el shadowMap de Three toda luz con castShadow recompila TODOS los materiales
      (pasto con millones de vértices incluido) con código de sombras; así árboles y pasto no se tocan.
   2. RECEPTOR: un cuadrado sobre el suelo (cubre solo la caja del mapa) con ShaderMaterial que MULTIPLICA
      lo que ya hay (satélite + suelo de A4) por un tinte azulado-verdoso, sin depth test, en la lista
      opaca después del suelo (renderOrder -9) y antes de árboles y pasto (que se dibujan encima).
      Las matas de pasto reciben por instancia (se muestrea el mapa en la base de cada mata) solo en
      Ultra/Alta: sin eso el pasto, que tapa el suelo, taparía también la sombra.
   3. BLOBS: una InstancedMesh por escenario con un decal elíptico por árbol, estirado y orientado según
      el sol (reemplazan las manchas GeoJSON de MapLibre, cuyas capas se apagan sin tocar el dato).
      Se desvanecen hacia adentro de la zona de sombra real. En calidad Baja son lo único.

   El sol sale de lighting.js (uniforms.uSunDir; azimut por campo medido contra el satélite, T13).
   Las alturas salen de las matrices de instancia de trees.js (con terreno ya traen y = heightAt).
   A6 (terreno): el receptor deja de ser un plano a y=0: es una grilla cuyas alturas salen de ctx.heightAtScene (se
   recalcula con cada caja nueva), con prueba de profundidad + polygonOffset; el crecimiento de los casters y de los blobs
   usa el uniforme de crecimiento de A6 (growthU) en vez de scale.y (el host no escala el grupo con terreno). */
import * as THREE from "three";
import { A3_SHADOWS as CFG } from "../../core/config.js?v=20261201";
import { quality } from "../../core/quality.js?v=20261201";
import { state } from "../../core/state.js?v=20261201";
import { map } from "../../map/style.js?v=20261201";
import { uniforms } from "../lighting.js?v=20261201";
import { GLSL_ADFOG, GLSL_FOG_UNIFORMS, scenarioFade } from "../shaderlib.js?v=20261201";
import { chainShader } from "./chunks.js?v=20261201";
import trees from "./trees.js?v=20261201";
import { GLSL_DECL, fitSpheres, growthU, patchGrowth, terrain, withReliefU } from "../../terrain/terrain.js?v=20261201";   // A6: receptor y casters sobre el relieve

const URL = new URLSearchParams(location.search);
const MODE = (URL.has("qa") || URL.has("debug")) ? URL.get("sombras") : null;   // solo ?qa/?debug: ?sombras=0 apaga todo · ?sombras=blobs solo blobs
const ENABLED = CFG.enabled && MODE !== "0" && MODE !== "off";
const FORCE_BLOBS = MODE === "blobs";
const TIMING = (URL.has("qa") || URL.has("debug")) && URL.has("a3time");   // mide el pase con gl.finish() (solo diagnóstico)

/* ---------- uniforms compartidos (receptor, blobs y pasto) ---------- */
const U = {
  uA3Map:  { value: null },                              // DepthTexture del pase (comparación por hardware)
  uA3VP:   { value: new THREE.Matrix4() },               // mundo → clip de la cámara de sombra
  uA3P:    { value: new THREE.Vector4(0.0005, 1 / 2048, CFG.edge, CFG.strength) },   // sesgo (prof.), texel (uv), franja de fundido, intensidad
  uA3Tint: { value: new THREE.Vector3(...CFG.tint) },
  uA3On:   { value: 0 },                                 // 1 = el pasto muestrea el mapa
  uA3Sun:  { value: new THREE.Vector4(0, 1, 1, 1) },     // xy dirección horizontal de la sombra (X,Z), z = tan(elev), w = sen(elev)
  uA3Zone: { value: new THREE.Vector4(0, 0, 0, CFG.edge) },   // xy centro (suelo), z semilado (0 = sin mapa: blobs en todos lados), w franja
  uA3Axes: { value: new THREE.Vector4(1, 0, 0, 1) },     // ejes del cuadrado en el suelo: derecha (xz) y dirección de sombra (xz)
  uA3Blob: { value: new THREE.Vector4(CFG.blob.strength, CFG.blob.centerK, CFG.blob.capOff, CFG.blob.capLen) }
};

/* ---------- GLSL ---------- */
/* Consulta del mapa: devuelve 0 (iluminado) .. 1 (sombra), ya con el fundido de borde. `wp` en metros de escena. */
const GLSL_LOOKUP =
  "uniform sampler2DShadow uA3Map;\nuniform mat4 uA3VP;\nuniform vec4 uA3P;\nuniform vec3 uA3Tint;\n" +
  "float a3Shadow(vec3 wp, bool soft) {\n" +
  "  vec3 s = (uA3VP * vec4(wp, 1.0)).xyz * 0.5 + 0.5;\n" +
  "  float e = min(min(s.x, 1.0 - s.x), min(s.y, 1.0 - s.y));\n" +
  "  if (e <= 0.0) return 0.0;\n" +
  "  float z = s.z - uA3P.x;\n" +
  "  float lit;\n" +
  "  if (soft) {\n" +
  "    float o = uA3P.y * 0.75;\n" +
  "    lit = 0.25 * (texture(uA3Map, vec3(s.xy + vec2(-o, -o), z)) + texture(uA3Map, vec3(s.xy + vec2(o, -o), z)) +\n" +
  "                  texture(uA3Map, vec3(s.xy + vec2(-o, o), z)) + texture(uA3Map, vec3(s.xy + vec2(o, o), z)));\n" +
  "  } else lit = texture(uA3Map, vec3(s.xy, z));\n" +
  "  return (1.0 - lit) * smoothstep(0.0, uA3P.z, e);\n" +
  "}\n";

const GLSL_BAYER =
  "float a3Bayer(vec2 p) {\n" +
  "  ivec2 q = ivec2(mod(p, 4.0));\n" +
  "  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);\n" +
  "  return (float(m[q.x + q.y * 4]) + 0.5) / 16.0;\n" +
  "}\n";

/* Receptor: cuadrado del suelo. Salida = factor que MULTIPLICA el framebuffer (blending Zero/SrcColor). */
const RECV_VS =
  "varying vec3 vW;\nvoid main() {\n  vec4 w = modelMatrix * vec4(position, 1.0);\n  vW = w.xyz;\n  gl_Position = projectionMatrix * viewMatrix * w;\n}\n";
const RECV_FS =
  GLSL_LOOKUP + GLSL_FOG_UNIFORMS + GLSL_ADFOG + GLSL_BAYER +
  "uniform vec3 uCamPos;\nuniform float uFade;\nvarying vec3 vW;\n" +
  "void main() {\n" +
  "  if (uFade < 1.0 && uFade <= a3Bayer(gl_FragCoord.xy)) discard;\n" +
  "  float s = a3Shadow(vW, SOFT_PCF) * uA3P.w;\n" +
  "  if (s < 0.004) discard;\n" +
  "  vec3 f = mix(vec3(1.0), uA3Tint, s);\n" +
  "  f = mix(f, vec3(1.0), adFog(distance(vW, uCamPos)));\n" +
  "  gl_FragColor = vec4(f, 1.0);\n" +
  "}\n";

/* A6 relieve en vivo: variantes con la resta (1-k)·g del suelo (terrain.js, GLSL_DECL). Las usa el build cuando hay terreno estructural. */
const RECV_VS_R = GLSL_DECL + RECV_VS.replace("vec4 w = modelMatrix * vec4(position, 1.0);", "vec4 w = modelMatrix * vec4(position, 1.0);\n  w.y -= a6Low(w.xz);");

/* Blobs: decal elíptico por árbol. instanceMatrix = traslación (base del árbol) + escala (R, H, R). */
const BLOB_VS =
  "uniform vec4 uA3Sun;\nuniform vec4 uA3Zone;\nuniform vec4 uA3Axes;\nuniform vec4 uA3Blob;\nuniform vec2 uA3G;\n" +
  "varying vec2 vUv;\nvarying float vK;\nvarying vec3 vW;\n" +
  "void main() {\n" +
  "  float gy = uA3G.y > 0.5 ? uA3G.x : modelMatrix[1][1];\n" +
  "  float R = length(instanceMatrix[0].xyz);\n" +
  "  float H = length(instanceMatrix[1].xyz) * gy;\n" +   // el crecimiento (scale.y del grupo) acorta la sombra
  "  vec3 base = instanceMatrix[3].xyz;\n" +
  "  float off = min(uA3Blob.y * H / uA3Sun.z, uA3Blob.z * H);\n" +    // centro de la copa proyectado al suelo: H/tan(elev), con tope
  "  float halfLen = min(R / uA3Sun.w, uA3Blob.w * R);\n" +            // círculo de la copa visto desde el sol: R/sen(elev), con tope
  "  vec2 sd = uA3Sun.xy;\n  vec2 pd = vec2(-sd.y, sd.x);\n" +
  "  vec2 c = base.xz + sd * off;\n" +
  "  vec2 xz = c + sd * position.x * halfLen + pd * position.z * R * 1.05;\n" +
  "  vec4 w = modelMatrix * vec4(xz.x, base.y + 0.03, xz.y, 1.0);\n" +
  "  vW = w.xyz;\n  vUv = position.xz;\n" +
  "  float k = 1.0;\n" +
  "  if (uA3Zone.z > 0.0) {\n" +                                         // fundido hacia adentro de la zona de sombra real
  "    vec2 d = c - uA3Zone.xy;\n" +
  "    float m = max(abs(dot(d, uA3Axes.xy)), abs(dot(d, uA3Axes.zw))) / uA3Zone.z;\n" +
  "    k = smoothstep(1.0 - 2.0 * uA3Zone.w, 1.0, m);\n" +
  "  }\n" +
  "  vK = k * step(0.02, gy);\n" +
  "  gl_Position = projectionMatrix * viewMatrix * w;\n" +
  "}\n";
const BLOB_FS =
  GLSL_FOG_UNIFORMS + GLSL_ADFOG + GLSL_BAYER +
  "uniform vec3 uCamPos;\nuniform float uFade;\nuniform vec4 uA3Blob;\nuniform vec3 uA3Tint;\n" +
  "varying vec2 vUv;\nvarying float vK;\nvarying vec3 vW;\n" +
  "void main() {\n" +
  "  if (uFade < 1.0 && uFade <= a3Bayer(gl_FragCoord.xy)) discard;\n" +
  "  float a = (1.0 - smoothstep(0.35, 1.0, length(vUv))) * vK * uA3Blob.x;\n" +
  "  if (a < 0.004) discard;\n" +
  "  vec3 f = mix(vec3(1.0), uA3Tint, a);\n" +
  "  f = mix(f, vec3(1.0), adFog(distance(vW, uCamPos)));\n" +
  "  gl_FragColor = vec4(f, 1.0);\n" +
  "}\n";

const BLOB_VS_R = GLSL_DECL + BLOB_VS.replace("vec3 base = instanceMatrix[3].xyz;", "vec3 base = instanceMatrix[3].xyz;\n  base.y -= a6Low(base.xz);");

const withRel = u => (terrain.active ? withReliefU(u) : u);

/* Multiplicar el framebuffer: resultado = destino × salida. Alfa intacto. */
function multiplyMaterial(vs, fs, extraUniforms, defines) {
  const m = new THREE.ShaderMaterial({
    vertexShader: vs, fragmentShader: fs, defines: defines || {},
    uniforms: {
      uCamPos: uniforms.uCamPos, uFogColor: uniforms.uFogColor, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar, uFogMax: uniforms.uFogMax, uFogRel: uniforms.uFogRel,
      uA3Map: U.uA3Map, uA3VP: U.uA3VP, uA3P: U.uA3P, uA3Tint: U.uA3Tint, uA3Sun: U.uA3Sun, uA3Zone: U.uA3Zone, uA3Axes: U.uA3Axes, uA3Blob: U.uA3Blob,
      ...extraUniforms
    },
    transparent: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor
  });
  m.toneMapped = false;
  return m;
}

/* ---------- estado del sistema ---------- */
const S = {};              // scenarioKey → { group, recv, blobs, mats, casters:{group,list}, nBlobs, visible }
let ctxRef = null, renderer = null;
let rt = null, rtSize = 0;
let dirty = true;
let grassPatched = false;   // el material del pasto ya recibe sombra (se decide al crear el renderer)
const shadowScene = new THREE.Scene();
const shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100);
const box = { on: false, hq: 0, h: 0, cg: new THREE.Vector2(), right: new THREE.Vector2(1, 0), hs: new THREE.Vector2(0, 1), sun: new THREE.Vector3(), size: 0 };
const pass = { renders: 0, calls: 0, tris: 0, cells: 0, near: 0, far: 0, ms: null, lastKey: "" };

const mapOn = () => ENABLED && !FORCE_BLOBS && quality.shadows > 0 && !!rt;
const grassOn = () => mapOn() && grassPatched && (CFG.grass === "ultra" ? quality.shadows >= 4096 : CFG.grass === "alta" ? quality.shadows >= 2048 : false);

function ensureTarget() {
  const size = ENABLED && !FORCE_BLOBS ? (quality.shadows | 0) : 0;
  if (rt && rtSize === size) return;
  if (rt) { rt.depthTexture.dispose(); rt.dispose(); rt = null; }
  rtSize = size; U.uA3Map.value = null;
  if (!size || !renderer) return;
  const depth = new THREE.DepthTexture(size, size);                // DEPTH_COMPONENT24
  depth.minFilter = depth.magFilter = THREE.LinearFilter;          // con comparación: PCF bilineal por hardware
  depth.compareFunction = THREE.LessEqualCompare;
  rt = new THREE.WebGLRenderTarget(size, size, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false, depthTexture: depth });
  U.uA3Map.value = depth;
  U.uA3P.value.y = 1 / size;
  dirty = true; box.on = false;
}

/* ---------- construcción por escenario ---------- */
/* Pesos del casters(): copias baratas de las mallas de árboles (misma geometría y MISMA instanceMatrix) con material de
   solo profundidad. Las celdas se eligen cerca/lejos según la caja; el frustum de la cámara de sombra las descarta. */
function buildCasters(key, casters) {
  const group = new THREE.Group();
  if (!terrain.active) group.scale.y = Math.max(state.growth[key] || 0.0001, 0.0001);   // igual que el grupo del escenario (host.js)
  const depthNear = new THREE.MeshBasicMaterial({ map: casters.atlas, alphaTest: casters.alphaTest, side: THREE.DoubleSide, colorWrite: false });
  const depthFar = new THREE.MeshBasicMaterial({ colorWrite: false });
  if (terrain.active) { patchGrowth(depthNear, key); patchGrowth(depthFar, key); }   // A6: crecimiento apoyado en el suelo (mismo uniforme que el host)
  const list = [];
  for (const c of casters.cells) {
    const e = { cx: c.cx, cz: c.cz, r: c.r, near: [], far: null };
    for (const m of c.near) {
      const s = new THREE.InstancedMesh(m.geometry, depthNear, m.count);
      s.instanceMatrix = m.instanceMatrix; s.boundingSphere = m.boundingSphere.clone(); s.visible = false;
      group.add(s); e.near.push(s);
    }
    const f = new THREE.InstancedMesh(c.far.geometry, depthFar, c.far.count);
    f.instanceMatrix = c.far.instanceMatrix; f.boundingSphere = c.far.boundingSphere.clone(); f.visible = false;
    group.add(f); e.far = f;
    list.push(e);
  }
  shadowScene.add(group);
  return { group, list, mats: [depthNear, depthFar] };
}

/* Un decal por árbol: base, altura y radio salen de la matriz de instancia de las mallas cercanas (trees.js). */
function buildBlobs(casters) {
  const items = [];
  const bb = new THREE.Box3();
  for (const c of casters.cells) for (const m of c.near) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    bb.copy(m.geometry.boundingBox);
    const wHalf = 0.5 * (bb.max.x - bb.min.x) * 0.9;          // radio de copa por unidad de escala horizontal
    const a = m.instanceMatrix.array;
    for (let i = 0; i < m.count; i++) {
      const o = i * 16;
      const sxz = Math.hypot(a[o], a[o + 1], a[o + 2]), H = Math.hypot(a[o + 4], a[o + 5], a[o + 6]);
      items.push([a[o + 12], a[o + 13], a[o + 14], Math.max(1.2, sxz * wHalf), H]);
    }
  }
  if (!items.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  const mesh = new THREE.InstancedMesh(g, null, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  items.forEach(([x, y, z, R, H], i) => { m4.compose(p.set(x, y, z), q, s.set(R, H, R)); mesh.setMatrixAt(i, m4); });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;                                  // un solo draw por escenario (≤ 4200 quads)
  mesh.renderOrder = -8;
  return mesh;
}

/* Recepción del pasto: se encadena al material de las matas (A2) sin tocar su archivo. */
function patchGrassReceive(m) {
  chainShader(m, "a3rx", sh => {
    sh.uniforms.uA3Map = U.uA3Map; sh.uniforms.uA3VP = U.uA3VP; sh.uniforms.uA3P = U.uA3P; sh.uniforms.uA3Tint = U.uA3Tint; sh.uniforms.uA3On = U.uA3On;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vA3W;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n  vA3W = (modelMatrix * vec4(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z, 1.0)).xyz;");   // base de la mata (A6: y = altura del suelo)
    const rx = "if (uA3On > 0.5) gl_FragColor.rgb *= mix(vec3(1.0), uA3Tint, a3Shadow(vA3W, false) * uA3P.w);\n  ";
    const fogTag = "gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor";
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vA3W;\nuniform float uA3On;\n" + GLSL_LOOKUP);
    // antes de la niebla (ya en espacio de pantalla, igual que el receptor del suelo)
    sh.fragmentShader = sh.fragmentShader.includes(fogTag)
      ? sh.fragmentShader.replace(fogTag, rx + fogTag)
      : sh.fragmentShader.replace("#include <dithering_fragment>", rx + "#include <dithering_fragment>");
  });
}

/* ---------- A6: receptor sobre el relieve ---------- */
const GRID = 96;   // segmentos por lado de la grilla del receptor (2h/96: ~12 m con h = 600 m, del orden del píxel del DEM)
/* Pone la altura de cada vértice de la grilla (espacio local: x,z en [-1,1]; mundo = centro + R(ang)·(h·local)). */
function fitReceiver(recv, h, ang) {
  const pos = recv.geometry.attributes.position, c = recv.position, ca = Math.cos(ang), sa = Math.sin(ang);
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i) * h, lz = pos.getZ(i) * h;
    // rotación Y de Three: x' = x·cos + z·sin ; z' = -x·sin + z·cos
    const wx = c.x + lx * ca + lz * sa, wz = c.z - lx * sa + lz * ca;
    pos.setY(i, ctxRef.heightAtScene(wx, wz) + 0.03);
  }
  pos.needsUpdate = true;
  recv.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
}

/* ---------- caja del mapa de sombras ---------- */
const _m = new THREE.Matrix4(), _zero = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _upL = new THREE.Vector3(), _c = new THREE.Vector3(), _eye = new THREE.Vector3();

function updateBox(frame) {
  const sun = uniforms.uSunDir.value;
  const sinEl = Math.max(0.12, sun.y), cosEl = Math.max(1e-3, Math.hypot(sun.x, sun.z));
  const sunMoved = box.sun.distanceToSquared(sun) > 1e-8;

  // zona útil: centro = objetivo de la cámara en el suelo; lado ∝ distancia cámara-objetivo
  const ll = map.getCenter();
  const [cx, cz] = ctxRef.toScene(ll.lng, ll.lat);
  const lo = CFG.zoneMin / 2, hi = CFG.zoneMax / 2;
  const hn = Math.min(hi, Math.max(lo, frame.camera.ctdM * CFG.zoneK / 2));
  const hs = [-sun.x / cosEl, -sun.z / cosEl];                 // dirección horizontal de la sombra
  const rg = [sun.z / cosEl, -sun.x / cosEl];                  // eje "derecha" de la cámara de sombra, en el suelo

  if (box.on && !sunMoved) {
    const dx = cx - box.cg.x, dz = cz - box.cg.y;
    const shift = Math.max(Math.abs(dx * box.right.x + dz * box.right.y), Math.abs(dx * box.hs.x + dz * box.hs.y));
    const ok = hn <= box.hq * 1.1 && hn >= box.hq / (CFG.zoneStep * CFG.zoneStep) && shift + hn <= box.h * (1 - 2 * CFG.edge);
    if (ok) return false;
  }

  // caja nueva
  const step = CFG.zoneStep;
  const hq = lo * Math.pow(step, Math.max(0, Math.round(Math.log(hn / lo) / Math.log(step))));
  const h = Math.min(hi * 1.2, hq * CFG.margin);
  const size = rtSize;
  box.sun.copy(sun);

  // base de la luz (misma convención que Object3D.lookAt de una cámara)
  _dir.copy(sun).normalize();
  _m.lookAt(_dir, _zero, _up);
  const te = _m.elements;
  _right.set(te[0], te[1], te[2]); _upL.set(te[4], te[5], te[6]);

  // snapping al texel en el espacio de la luz: el centro salta de a texels enteros → las sombras no "nadan"
  const texX = 2 * h / size, texY = 2 * h * sinEl / size;
  _c.set(cx, terrain.active ? ctxRef.heightAtScene(cx, cz) * terrain.k : 0, cz);   // A6: el centro de la caja a la altura del suelo (con terreno el suelo no está en y = 0; × k: relieve en vivo)
  const px = _c.dot(_right), py = _c.dot(_upL);
  const dpx = Math.round(px / texX) * texX - px, dpy = Math.round(py / texY) * texY - py;
  _c.addScaledVector(_right, dpx).addScaledVector(_upL, dpy);   // centro de la cámara (3D, no necesariamente en el suelo)

  const D = h * 1.2 + 60;
  _eye.copy(_c).addScaledVector(_dir, D);
  shadowCam.left = -h; shadowCam.right = h; shadowCam.top = h * sinEl; shadowCam.bottom = -h * sinEl;   // cuadrado de lado 2h en el suelo
  shadowCam.near = Math.max(1, D - (h + 40)); shadowCam.far = D + h + 40;
  shadowCam.position.copy(_eye); shadowCam.up.copy(_up); shadowCam.lookAt(_c);
  shadowCam.updateProjectionMatrix(); shadowCam.updateMatrixWorld(true);
  U.uA3VP.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
  const range = shadowCam.far - shadowCam.near;
  U.uA3P.value.x = (CFG.biasM + 0.5 * texX) / range;

  // el cuadrado en el suelo que cubre la caja: centro = (cx,cz) corrido por el snapping (dpx a la derecha, dpy/sen a lo largo de la sombra)
  box.on = true; box.hq = hq; box.h = h; box.size = size;
  box.cg.set(cx + rg[0] * dpx + hs[0] * (dpy / sinEl), cz + rg[1] * dpx + hs[1] * (dpy / sinEl));
  box.right.set(rg[0], rg[1]); box.hs.set(hs[0], hs[1]);
  U.uA3Zone.value.set(box.cg.x, box.cg.y, h, CFG.edge);
  U.uA3Axes.value.set(rg[0], rg[1], hs[0], hs[1]);
  const ang = Math.atan2(-rg[1], rg[0]);
  for (const s of Object.values(S)) {
    if (!s) continue;
    s.recv.position.set(box.cg.x, terrain.active ? 0 : 0.02, box.cg.y);
    s.recv.rotation.set(0, ang, 0); s.recv.scale.set(h, 1, h);
    if (terrain.active) fitReceiver(s.recv, h, ang);   // A6
  }

  // cerca/lejos por celda (según la distancia al centro de la caja): tarjetas o impostor. Con texels grandes las hojas no se resuelven: todo impostor.
  const cardsOk = 2 * h / size <= CFG.cardMaxTexel;
  for (const s of Object.values(S)) if (s) for (const e of s.casters.list) {
    const d = Math.hypot(e.cx - box.cg.x, e.cz - box.cg.y) - e.r;
    const out = d > h * 1.5 + 40;
    const near = !out && cardsOk && d < CFG.cardDist;
    for (const m of e.near) m.visible = near;
    e.far.visible = !out && !near;
  }
  return true;
}

function renderPass() {
  const gl = renderer.getContext();
  renderer.resetState();                 // MapLibre dejó su estado en el contexto compartido
  const t0 = TIMING ? (gl.finish(), performance.now()) : 0;
  renderer.setRenderTarget(rt);
  renderer.clear(false, true, false);    // solo profundidad
  renderer.render(shadowScene, shadowCam);
  renderer.setRenderTarget(null);
  if (TIMING) { gl.finish(); pass.ms = performance.now() - t0; }
  const ri = renderer.info.render;       // el render principal reinicia renderer.info: se toma ahora
  pass.calls = ri.calls; pass.tris = ri.triangles; pass.renders++;
  let cells = 0, near = 0, far = 0;
  for (const s of Object.values(S)) if (s && s.casters.group.visible) for (const e of s.casters.list) {
    if (e.far.visible) { far++; cells++; } else if (e.near[0] && e.near[0].visible) { near++; cells++; }
  }
  pass.cells = cells; pass.near = near; pass.far = far;
}

const MAPLIBRE_SHADOW_LAYERS = { inicial: "ini-tree-shadows", multi: "multi-tree-shadows" };

export default {
  id: "shadows",

  /* El host le pasa el renderer y la escena (una línea comentada "A3" en host.js). */
  onRenderer(r, scene) {
    renderer = r;
    ensureTarget();
    // el pasto recibe sombra (por mata): se engancha acá porque el host ya parchó sus materiales
    if (ENABLED && CFG.grass !== "off" && !FORCE_BLOBS && quality.shadows >= (CFG.grass === "ultra" ? 4096 : 2048)) {
      const seen = new Set();
      scene.traverse(o => {
        const m = o.isInstancedMesh && o.material;
        if (m && m.userData && m.userData.adChunks && m.userData.adChunks.wind && !seen.has(m)) { seen.add(m); patchGrassReceive(m); grassPatched = true; }
      });
    }
  },

  build(ctx, key) {
    ctxRef = ctx;
    const group = new THREE.Group();
    if (!ENABLED) { S[key] = null; return { object3d: group, materials: [] }; }
    const casters = trees.casters(key);
    const recvMat = multiplyMaterial(terrain.active ? RECV_VS_R : RECV_VS, RECV_FS, withRel({ uFade: scenarioFade[key] }), { SOFT_PCF: CFG.soft ? "true" : "false" });
    // A6: con terreno el receptor es una grilla (alturas por caja, ver updateBox) con depth test; sin terreno el plano de siempre
    const recv = new THREE.Mesh(terrain.active ? new THREE.PlaneGeometry(2, 2, GRID, GRID).rotateX(-Math.PI / 2) : new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), recvMat);
    if (terrain.active) { recvMat.depthTest = true; recvMat.polygonOffset = true; recvMat.polygonOffsetFactor = -2; recvMat.polygonOffsetUnits = -4; }
    recv.renderOrder = -9; recv.frustumCulled = false; recv.visible = false;
    group.add(recv);
    let blobs = null, cs = { group: new THREE.Group(), list: [], mats: [] };
    if (casters) {
      cs = buildCasters(key, casters);
      if (terrain.active && terrain.k < 1) fitSpheres(cs.group);   // A6 relieve en vivo: arranca apagado
      blobs = buildBlobs(casters);
      if (blobs) {
        blobs.material = multiplyMaterial(terrain.active ? BLOB_VS_R : BLOB_VS, BLOB_FS, withRel({ uFade: scenarioFade[key], uA3G: { value: terrain.active ? new THREE.Vector2(0, 1) : new THREE.Vector2(1, 0) } }));
        if (terrain.active) { blobs.material.depthTest = true; blobs.material.polygonOffset = true; blobs.material.polygonOffsetFactor = -2; blobs.material.polygonOffsetUnits = -4; }
        blobs.userData.g = key;
        group.add(blobs);
      }
    }
    S[key] = { group, recv, recvMat, blobs, casters: cs, nBlobs: blobs ? blobs.count : 0 };
    dirty = true;
    return { object3d: group, materials: [] };    // materiales propios: sin patch de niebla/follaje del host
  },

  /* host.setOpacity corre DESPUÉS de applyOpacity (layers.js): acá se apagan las manchas GeoJSON de MapLibre. */
  setOpacity(key, o) {
    const s = S[key]; if (!s) return;
    const vis = o > 0.02;
    if (s.casters.group.visible !== vis) { s.casters.group.visible = vis; dirty = true; }
    if (CFG.hideMapLibre) { const id = MAPLIBRE_SHADOW_LAYERS[key]; if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", 0); }
  },

  setGrowth(key, t) {
    const s = S[key]; if (!s) return;
    const g = Math.max(t, 0.0001);
    if (terrain.active) { if (s.blobs) s.blobs.material.uniforms.uA3G.value.x = g; dirty = true; return; }   // A6: crecimiento por shader (growthU lo escribe el host)
    if (s.casters.group.scale.y !== g) { s.casters.group.scale.y = g; dirty = true; }
  },

  onQuality() { ensureTarget(); dirty = true; },

  /* A6 relieve en vivo: en cada paso de la transición el suelo y los árboles cambian de altura (los shaders restan (1-k)·g), así que el mapa de
     sombras y su caja (centro a la altura del suelo × k) se rehacen en cada paso. Solo dura lo que la transición (~1,2 s). */
  setRelief() {
    if (!terrain.active) return;
    for (const k in S) if (S[k]) fitSpheres(S[k].casters.group);   // esferas de culling de la cámara de sombra, bajadas con el suelo
    box.on = false; dirty = true;
  },

  update(frame) {
    if (!ENABLED) return;
    // blobs: dirección y elevación del sol (siempre; barato)
    const sun = uniforms.uSunDir.value;
    const sinEl = Math.max(0.12, sun.y), cosEl = Math.max(1e-3, Math.hypot(sun.x, sun.z));
    U.uA3Sun.value.set(-sun.x / cosEl, -sun.z / cosEl, sinEl / cosEl, sinEl);
    U.uA3On.value = grassOn() ? 1 : 0;

    const useMap = mapOn();
    for (const s of Object.values(S)) { if (s) s.recv.visible = useMap && s.group.visible; }
    if (!useMap) { U.uA3Zone.value.z = 0; return; }

    if (updateBox(frame)) dirty = true;
    if (dirty) {
      shadowScene.updateMatrixWorld(true);
      renderPass();
      dirty = false;
    }
  },

  stats(key) {
    const s = S[key];
    if (!s) return { shadows: { enabled: false } };
    return { shadows: { map: mapOn() ? rtSize : 0, blobs: s.nBlobs, boxHalfM: Math.round(box.h), passRenders: pass.renders,
      passDraws: pass.calls, passTris: pass.tris, cellsNear: pass.near, cellsFar: pass.far, grassReceive: grassOn(), passMs: pass.ms } };
  },

  dispose() {
    if (rt) { rt.depthTexture.dispose(); rt.dispose(); rt = null; }
    for (const s of Object.values(S)) if (s) { s.recvMat.dispose(); if (s.blobs) s.blobs.material.dispose(); for (const m of s.casters.mats) m.dispose(); }
  }
};
