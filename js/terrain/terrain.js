/* ============ Terreno 3D real + sombreado de relieve (A6-2) ============
   Dueño: A6. Contrato con el resto (§6.3):
     - `terrain.active`      ¿hay terreno 3D en este campo? (se decide UNA vez al cargar, no cambia en caliente)
     - `heightAt(lon, lat)`  altura del suelo en metros de escena (m·exageración); 0 con terreno apagado.
                             Es lo que expone el host como ctx.heightAt: TODA altura Three pasa por acá.
     - `initTerrain(...)`    carga el DEM, decide la activación, agrega la fuente raster-dem + el hillshade
                             y, si corresponde, map.setTerrain(). Se llama desde app.js antes de armar las capas.

   Cómo se alinean Three y la malla de MapLibre (spike A6-1, handoffs/a6-spike.md):
     la Y de escena es la altura ABSOLUTA × exageración y host.sceneMatrix() resta map.transform.elevation en
     cada frame (el centro de la vista cambia de elevación). heightAt coincide con la malla a ±0,05 m con el
     mismo zoom de DEM (A6_TERRAIN.demZoom) y la convención de píxel "esquina" (heightfield.js).

   Fuente y licencia: ver config.js (A6_TERRAIN) y handoffs/a6-terreno.md. */
import * as THREE from "three";
import { A1_CAMPOS, A1_SUN, A6_TERRAIN as C } from "../core/config.js?v=20261201";
import { emit, on } from "../core/events.js?v=20261201";
import { pointInPolygon, ringBBox } from "../core/geo.js?v=20261201";
import { params, state } from "../core/state.js?v=20261201";
import { quality, terrainEnabled } from "../core/quality.js?v=20261201";
import { chainShader, reliefHook } from "../render/systems/chunks.js?v=20261201";
import { loadHeightfield } from "./heightfield.js?v=20261201";

const DBG = params.has("debug") || params.has("qa");

/* Estado público. `info` queda para el handoff/QA (window.__terrain con ?debug/?qa).
   Relieve en vivo (2026-11-13): el relieve se prende y apaga SIN recargar, con transición. Niveles:
     - `available`  el campo admite relieve (no es llano y el DEM cargó). Decide la UI (conmutador).
     - `active`     ESTRUCTURAL: los sistemas Three se armaron con alturas (heightAt real horneado) y las capas drapeadas son `fill`.
                    Vale `available` y no cambia en toda la sesión: lo que cambia en vivo es `k`, no la estructura.
     - `on` / `k`   relieve pedido (bool) y factor vigente 0..1 (la exageración efectiva = exag·k). Con k = 0 la escena Three queda
                    plana (los shaders restan (1-k)·altura del suelo, ver GLSL_DECL) y con `mesh` en false MapLibre no paga la malla.
     - `mesh`       la malla de terreno de MapLibre está prendida (map.setTerrain). Con k = 0 estable se apaga (setTerrain(null)). */
export const terrain = {
  active: false,      // ESTRUCTURAL: Three con alturas horneadas + capas drapeadas (no cambia en caliente; ver arriba)
  available: false,   // el campo admite relieve (no llano, DEM cargado)
  on: false,          // relieve pedido (destino de la transición)
  k: 0,               // factor de relieve vigente 0..1 (animado)
  mesh: false,        // malla de terreno de MapLibre prendida
  animating: false,
  autoOff: false,     // la red de seguridad lo apagó en esta sesión
  unavailable: "",    // motivo cuando available = false: "llano" | "sin-dem"
  exag: 1,            // exageración vigente
  hf: null,           // Heightfield (null si no se pudo cargar el DEM)
  hillshade: false,   // capa de sombreado de relieve agregada
  reason: "",         // por qué quedó así (auto / config del campo / URL)
  stats: null,        // reliefStats() del campo (filtradas)
  loadMs: 0           // ms de carga del DEM (red + decodificación)
};
if (DBG) window.__terrain = terrain;

/* Altura del suelo (m de escena) en lon/lat con el relieve COMPLETO (k = 1): es la que se HORNEA en los sistemas Three.
   Sin terreno estructural: 0 (los campos llanos quedan idénticos). El factor vivo `k` NO se aplica acá: lo restan los shaders
   (a6Low en GLSL_DECL), para que apagar el relieve no obligue a reconstruir nada. */
export function heightAt(lon, lat) {
  return terrain.active && terrain.hf ? terrain.hf.heightAt(lon, lat) * terrain.exag : 0;
}

/* Nombre de la propiedad de opacidad de las capas "ex-extrusión" (herb-ext, woody-base): con terreno activo son
   `fill` drapeados (T14), sin terreno siguen siendo fill-extrusion. Lo usan layers.js y ground.js. */
export const extOpacityProp = () => (terrain.active ? "fill-opacity" : "fill-extrusion-opacity");

/* A6 · Crecimiento de escenario con terreno. Sin terreno el host escala el grupo del escenario en Y
   (group.scale.y = t): equivale a escalar sobre el suelo porque el suelo está en y = 0. Con terreno el
   suelo de cada instancia está a su altura (y = g) y escalar el grupo hundiría los árboles en las lomas
   durante los 1800 ms. Solución: con terreno el grupo NO se escala y cada material de instancias escala la
   altura LOCAL de su geometría por `uA6Grow` (transformed.y *= t, antes de la matriz de instancia, que ya
   lleva y = g). Resultado: y_mundo = g + t·(altura local), o sea crecer APOYADO en el suelo de cada instancia
   (sin terreno g = 0 y es idéntico al scale.y de antes). Los sistemas con vértices en coordenadas de mundo
   (suelo y surcos de A4) no lo usan: manejan su propio crecimiento (revelado / lift) en ground.js.
   Aproximación conocida: el impostor lejano (copa de 32 tris, centrado en la copa) se achata alrededor de su
   centro en vez de su base: dura 1,8 s y a más de 480 m (sub-píxel), lo cual no se ve. */
export const growthU = { inicial: { value: 1 }, multi: { value: 1 } };

/* ---------- Relieve vivo en los shaders (relieve encendido/apagado sin reconstruir) ----------
   Todo lo que está horneado en Three trae la altura COMPLETA del suelo (y = g·exag + offsets). Para mostrar el relieve al
   factor k (0..1) el shader RESTA (1-k)·g(x,z), con g leída de una textura R32F con la grilla del DEM (la MISMA que heightAt, con la
   misma interpolación bilineal y el mismo recorte al borde: coincide al 1e-3 m). Con k = 1 no se resta nada (rama por uniforme) y con
   k = 0 todo queda exactamente a y = offsets, como antes de que existiera el relieve. Sirve para instancias (se resta de la traslación
   de la instancia: base del árbol/mata, un único g por instancia, el árbol no se deforma) y para vértices en coordenadas de mundo
   (suelo, surcos, agua, receptor de sombras).
     uA6H  textura de alturas del DEM (m, sin exagerar)      uA6P  afín escena→píxel de la grilla: fx = x·P.x + P.y ; fy = z·P.z + P.w
     uA6L  (1-k)·exag = metros a restar por metro de DEM      uA6K  k (para atenuar normales: la pendiente escala con k) */
export const reliefU = { uA6H: { value: null }, uA6P: { value: new THREE.Vector4(1, 0, 1, 0) }, uA6L: { value: 0 }, uA6K: { value: 1 } };
export const GLSL_DECL = `
#ifndef A6_RELIEF
#define A6_RELIEF
uniform sampler2D uA6H;
uniform vec4 uA6P;
uniform float uA6L;
uniform float uA6K;
float a6Hf(vec2 xz) {
  ivec2 sz = textureSize(uA6H, 0);
  vec2 f = clamp(vec2(xz.x * uA6P.x + uA6P.y, xz.y * uA6P.z + uA6P.w), vec2(0.0), vec2(sz) - 1.0001);
  ivec2 i = ivec2(floor(f));
  vec2 t = f - vec2(i);
  float a = texelFetch(uA6H, i, 0).r, b = texelFetch(uA6H, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uA6H, i + ivec2(0, 1), 0).r, d = texelFetch(uA6H, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
float a6Low(vec2 xz) { return uA6L > 0.0001 ? uA6L * a6Hf(xz) : 0.0; }
#endif
`;
/* Materiales estándar de Three con instancias (árboles, pasto, fauna, casters de sombra): `instanceMatrix` pasa a ser una función que
   devuelve la matriz con la traslación Y ya bajada. Así lo toman solos el proyecto, la normal, el viento, el LOD por distancia, la
   niebla y la sombra del pasto (todos leen instanceMatrix). La función cachea el resultado por vértice. */
const GLSL_INST = `
#ifdef USE_INSTANCING
mat4 a6Im; bool a6ImOk = false;
mat4 a6Inst() { if (!a6ImOk) { a6Im = instanceMatrix; a6Im[3].y -= a6Low(a6Im[3].xz); a6ImOk = true; } return a6Im; }
#define instanceMatrix a6Inst()
#endif
`;
/* Une los uniforms del relieve a los de un shader. */
export const withReliefU = u => Object.assign(u, reliefU);

export function patchGrowth(mat, key) {
  chainShader(mat, "a6grow", sh => {
    sh.uniforms.uA6Grow = growthU[key];
    withReliefU(sh.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uA6Grow;\n" + GLSL_DECL + GLSL_INST)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.y *= uA6Grow;");
  });
}

/* Para materiales con shader propio (suelo): solo agrega la declaración y los uniforms; la resta la escribe quien lo usa. */
export function patchReliefDecl(mat, tag) {
  chainShader(mat, tag || "a6rel", sh => {
    withReliefU(sh.uniforms);
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\n" + GLSL_DECL);
  });
}

/* Espejo en JS de a6Low (GLSL_DECL): metros que el suelo está bajado en (x, z) de escena respecto de lo horneado = (1-k)·exag·DEM(x, z). 0 con
   el relieve completo (rápido) o sin terreno. Lo usan las decisiones por CPU que miden distancias contra posiciones horneadas (LOD por celda,
   viento en reposo, fauna, agua) para que coincidan con lo que dibujan los shaders. */
export function lowAt(x, z) {
  const hf = terrain.hf;
  if (!terrain.active || !hf || terrain.k >= 0.9999) return 0;
  const P = reliefU.uA6P.value;
  const fx = Math.min(Math.max(x * P.x + P.y, 0), hf.w - 1.0001), fy = Math.min(Math.max(z * P.z + P.w, 0), hf.h - 1.0001);
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, g = hf.data, w = hf.w, k = j * w + i;
  const h = (g[k] * (1 - tx) + g[k + 1] * tx) * (1 - ty) + (g[k + w] * (1 - tx) + g[k + w + 1] * tx) * ty;
  return (1 - terrain.k) * terrain.exag * h;
}
reliefHook.low = lowAt;

/* Esferas envolventes de las InstancedMesh (frustum culling de Three): están calculadas con las alturas horneadas, así que con relieve parcial
   quedarían muy por encima de lo dibujado y el culling descartaría objetos visibles al borde de la pantalla. Se bajan con el suelo en el centro de
   cada esfera (+ holgura mientras k < 1 por el desnivel dentro de la celda). Idempotente: guarda la esfera horneada en userData. */
export function fitSpheres(root, slackM = 15) {
  if (!terrain.active) return;
  const k = terrain.k;
  root.traverse(o => {
    if (!o.isInstancedMesh) return;
    if (!o.boundingSphere) o.computeBoundingSphere();
    const bs = o.boundingSphere, u = o.userData;
    if (u.a6by === undefined) { u.a6by = bs.center.y; u.a6r = bs.radius; }
    bs.center.y = u.a6by - lowAt(bs.center.x, bs.center.z);
    bs.radius = u.a6r + slackM * (1 - k);
  });
}

/* Textura de alturas + afín escena→píxel. La llama el host en onAdd (origen y metros→mercator de la escena). */
export function bindReliefFrame(originX, originY, scale) {
  const hf = terrain.hf;
  if (!terrain.active || !hf) return;
  if (!reliefU.uA6H.value) {
    const t = new THREE.DataTexture(hf.data, hf.w, hf.h, THREE.RedFormat, THREE.FloatType);
    t.internalFormat = "R32F"; t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.flipY = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.unpackAlignment = 4; t.needsUpdate = true;
    reliefU.uA6H.value = t;
  }
  const K = 256 * Math.pow(2, hf.z), off = hf.pixelCenter ? 0.5 : 0;   // mercator normalizado → píxel global del DEM (lonLatToPixel)
  reliefU.uA6P.value.set(scale * K, originX * K - hf.px0 - off, scale * K, originY * K - hf.py0 - off);
  reliefU.uA6L.value = (1 - terrain.k) * terrain.exag; reliefU.uA6K.value = terrain.k;
}


/* ---------- disponibilidad del relieve ----------
   Devuelve { available, why }: ¿el campo admite relieve? (no si es llano). Es la regla de siempre (?terreno= URL > campo.terreno >
   A6_TERRAIN.campos > automática); lo que cambió es que "ON/OFF inicial" ya no sale de acá sino de la preferencia (ver initTerrain). */
function decidir(stats) {
  const campo = state.campo || {};
  const url = params.get("terreno");
  if (url === "1" || url === "0") return { available: url === "1", why: "URL ?terreno=" + url };
  if (!C.enabled) return { available: false, why: "A6_TERRAIN.enabled = false" };
  if (typeof campo.terreno === "boolean") return { available: campo.terreno, why: "campo.terreno = " + campo.terreno };
  const cfg = C.campos[campo.id];
  if (cfg && typeof cfg.terreno === "boolean") return { available: cfg.terreno, why: "config del campo (A6_TERRAIN.campos)" };
  const a = C.auto;
  const porRegla = stats.desvioResidual > a.desvioResidual || stats.pendienteP95 > a.pendienteP95;
  const available = C.todos || porRegla;
  return { available, why: (C.todos ? "todos los campos (regla auto: " + (porRegla ? "con relieve" : "llano") + ") · " : "") + `auto: desvío residual ${stats.desvioResidual.toFixed(2)} m (umbral ${a.desvioResidual}), pendiente p95 ${stats.pendienteP95.toFixed(2)} % (umbral ${a.pendienteP95})` };
}

/* Máscara "adentro de algún polígono del campo" (como en la calibración del spike). */
function maskDe(fc) {
  const polys = [];
  for (const f of fc.features) for (const poly of f.geometry.coordinates) polys.push({ bb: ringBBox(poly[0]), poly });
  return (lon, lat) => {
    const pt = [lon, lat];
    for (const p of polys) {
      const b = p.bb;
      if (lon < b[0] || lat < b[1] || lon > b[2] || lat > b[3]) continue;
      if (pointInPolygon(pt, p.poly)) return true;
    }
    return false;
  };
}

/* ---------- MapLibre: fuente raster-dem, hillshade y malla ---------- */
function agregarFuenteYHillshade(map) {
  const fuente = (attribution, over = {}) => ({ type: "raster-dem", tiles: [C.demUrl], encoding: "terrarium", tileSize: 256, maxzoom: C.demZoom, ...(attribution ? { attribution } : {}), ...over });
  // G2: el hillshade usa una fuente propia más gruesa (menos teselas y menos píxeles a sombrear por frame que con z13)
  const hsz = DBG && params.get("hsz") ? parseInt(params.get("hsz"), 10) : C.hillshade.maxzoom;
  const hsTs = DBG && params.get("hsts") ? parseInt(params.get("hsts"), 10) : C.hillshade.tileSize;
  // MapLibre avisa (warning en consola) si el hillshade y el terreno comparten fuente: van dos fuentes con las mismas teselas
  // (el navegador las sirve de su caché HTTP; la de relieve lleva la atribución).
  if (!map.getSource("dem")) map.addSource("dem", fuente(C.attribution));
  const hs = DBG ? params.get("hillshade") : null;   // ?hillshade=0|1: solo ?qa/?debug
  if ((hs === "1" || (hs !== "0" && C.hillshade.enabled)) && !map.getLayer("hillshade")) {
    if (!map.getSource("dem-hs")) map.addSource("dem-hs", fuente(null, { maxzoom: hsz, tileSize: hsTs }));
    const campoCfg = A1_CAMPOS[(state.campo || {}).id] || {};
    const h = C.hillshade;
    // justo arriba del satélite y debajo de todo lo demás (las capas de escenario se agregan después)
    map.addLayer({
      id: "hillshade", type: "hillshade", source: "dem-hs",
      paint: {
        "hillshade-illumination-direction": campoCfg.sunAzimuth ?? A1_SUN.defaultAzimuth,   // = azimut HACIA el sol de A1
        "hillshade-illumination-anchor": "map",
        "hillshade-exaggeration": DBG && params.get("hse") ? parseFloat(params.get("hse")) : h.exaggeration,   // ?hse= solo ?debug/?qa (calibración)
        "hillshade-shadow-color": h.shadow, "hillshade-highlight-color": h.highlight, "hillshade-accent-color": h.accent
      }
    });
    terrain.hillshade = true;
  }
}

/* Ola 4 · 4.2: palancas de costo de la malla/RTT de MapLibre 4.7.1 (campos internos de map.terrain; si cambian, se ignoran sin romper). */
function ajustarCosto(map) {
  try {
    const P = { ...C.perf };
    if (DBG && params.get("rtt")) P.rttQuality = params.get("rtt") === "auto" ? "auto" : parseFloat(params.get("rtt"));
    // "auto": 1 textura-px por px de pantalla (pixelRatio del mapa entre 1 y 2); MapLibre usa siempre 2 (4× los píxeles en pantallas 1×)
    if (P.rttQuality === "auto") P.rttQuality = Math.min(2, Math.max(1, map.getPixelRatio ? map.getPixelRatio() : (window.devicePixelRatio || 1)));
    if (DBG && params.get("mesh")) P.meshSize = parseInt(params.get("mesh"), 10);
    if (DBG && params.get("pool")) P.rttPool = parseInt(params.get("pool"), 10);
    const t = map.terrain, rtt = map.painter && map.painter.renderToTexture;
    if (!t || !rtt || !rtt.pool) return;
    if (DBG && params.has("scale")) P.scaleThrottleMs = parseInt(params.get("scale"), 10);
    limitarEscala(map, P.scaleThrottleMs);
    if (P.meshSize && !t._mesh) t.meshSize = P.meshSize;                       // la malla se crea en el primer frame
    if (P.rttPool) rtt.pool._size = P.rttPool;                                  // texturas de RTT cacheadas (MapLibre: 30)
    if (P.rttQuality && rtt.pool._objects.length === 0) {                       // el pool crea sus texturas a demanda
      t.qualityFactor = P.rttQuality;
      rtt.pool._tileSize = Math.round(t.sourceCache.tileSize * P.rttQuality);
    }
  } catch (e) { console.warn("A6: no se pudo ajustar el costo del terreno:", e.message || e); }
}

/* Ola 4 · 4.2: la ScaleControl de MapLibre llama 2 veces a map.unproject en CADA 'move' y, con terreno, cada unproject hace un
   readPixels síncrono sobre el framebuffer de coordenadas del terreno: la CPU espera a la GPU 2 veces por frame y se pierde el
   solapamiento CPU/GPU (en la HD 520 son ~46 ms/frame en órbita, perfil CDP). Se limita a una actualización cada `ms` ms (con la
   última 300 ms después de quedar quieta). La barra de escala se ve igual, solo se refresca menos durante el movimiento. */
function limitarEscala(map, ms) {
  const ctl = (map._controls || []).find(c => c && c._container && c._container.classList.contains("maplibregl-ctrl-scale") && (c._onMove || c._a6Orig));
  if (!ctl) return;
  if (!(ms > 0)) {   // restaurar (el relieve se apagó en vivo: la barra vuelve a refrescarse en cada 'move', como en MapLibre)
    if (ctl._a6Orig) { map.off("move", ctl._onMove); clearTimeout(ctl._a6Timer); ctl._onMove = ctl._a6Orig; map.on("move", ctl._a6Orig); delete ctl._a6Orig; }
    return;
  }
  if (ctl._a6Orig) return;
  const orig = ctl._onMove;
  let last = 0;
  /* jumpTo/setBearing (órbita, tour) disparan move Y moveend en cada llamada: no sirve moveend. Se usa "reposo de 300 ms": mientras
     haya movimiento continuo solo se refresca cada `ms`; 300 ms después del último 'move' se refresca con el valor exacto. */
  const lim = () => {
    clearTimeout(ctl._a6Timer);
    if (performance.now() - last >= ms) { last = performance.now(); orig(); }
    ctl._a6Timer = setTimeout(() => { ctl._a6Timer = 0; last = performance.now(); orig(); }, 300);
  };
  map.off("move", orig);
  ctl._a6Orig = orig; ctl._onMove = lim;
  map.on("move", lim);
}

/* ---------- Relieve en vivo: malla, factor k y transición ---------- */
let _map = null, _skyPrev = null, _animTok = 0;
const _stepFns = [];
/* Los sistemas Three que dependan de k fuera de los shaders (hoy: la caja del mapa de sombras) se enteran por acá. fn(k, final). */
export const onReliefStep = fn => { _stepFns.push(fn); return () => { const i = _stepFns.indexOf(fn); if (i >= 0) _stepFns.splice(i, 1); }; };
const _listeners = new Set();
/* Callback de estado (además del evento "relief:state" del bus): fn(estado). Devuelve la función para desuscribirse. */
export const onRelief = fn => { _listeners.add(fn); return () => _listeners.delete(fn); };
export const reliefState = () => ({ active: terrain.on, available: terrain.available, reason: terrain.available ? "" : terrain.unavailable, k: terrain.k, animating: terrain.animating, autoOff: terrain.autoOff });
function emitirEstado() {
  const st = reliefState();
  for (const f of _listeners) { try { f(st); } catch (e) { console.warn("A6 onRelief:", e); } }
  emit("relief:state", st);
}
const smooth01 = p => p * p * (3 - 2 * p);

/* Aplica el factor k de relieve a TODO a la vez (un solo paso de JS, así MapLibre y Three quedan sincronizados en el mismo frame):
     · exageración de la malla de MapLibre (map.terrain.exaggeration: setTerrain por frame recrearía la malla y el caché de RTT) y la
       elevación del centro de la vista (map.transform.elevation): la cámara sube con el suelo del centro, así la vista no pega un salto vertical;
     · uniformes de los shaders Three (resta (1-k)·g) y los sistemas que escuchan onReliefStep;
     · intensidad del hillshade. */
function aplicarK(k, final = false) {
  const map = _map;
  terrain.k = k;
  reliefU.uA6K.value = k; reliefU.uA6L.value = (1 - k) * terrain.exag;
  if (map && terrain.mesh && map.terrain) {
    const t = map.terrain, tr = map.transform;
    t.exaggeration = Math.max(1e-3, k * terrain.exag);
    /* 2026-11-18: MapLibre solo redibuja su framebuffer de coordenadas del terreno (con el que traduce el puntero a un punto del suelo) si
       cambia la cámara. Con la cámara quieta quedaba el de k≈0 y el primer arrastre tras encender saltaba ~600 m y 1,5 niveles de zoom. */
    if (map.painter && map.painter.terrainFacilitator) map.painter.terrainFacilitator.dirty = true;
    tr.minElevationForCurrentTile = t.getMinTileElevationForLngLatZoom(tr.center, tr.tileZoom);
    tr.elevation = t.getElevationForLngLatZoom(tr.center, tr.tileZoom);
  }
  if (map && terrain.hillshade && map.getLayer("hillshade")) {
    map.setPaintProperty("hillshade", "hillshade-exaggeration", (DBG && params.get("hse") ? parseFloat(params.get("hse")) : C.hillshade.exaggeration) * k);
  }
  if (map && terrain.mesh) aplicarSky(map, k);
  for (const f of _stepFns) f(k, final);
  if (map) map.triggerRepaint();
}

/* Niebla del sky de MapLibre interpolada con k (G4-fix): de los valores "llanos" del estilo (k = 0) a los del relieve (k = 1). Antes se
   cambiaba de golpe al crear/destruir la malla y el horizonte pegaba un destello blanco al encender/apagar. Las propiedades se pasan a
   transición 0 (sin los 300 ms por defecto de MapLibre) para que sigan a k cuadro a cuadro. */
function aplicarSky(map, k) {
  if (!_skyPrev || !map.getSky) return;
  const tr = map.style && map.style.sky && map.style.sky._transitionable;
  if (tr && !tr._a6NoTr) { for (const n of ["fog-ground-blend", "horizon-fog-blend"]) tr.setTransition(n, { duration: 0, delay: 0 }); tr._a6NoTr = true; }
  const lerp = (a, b) => (a ?? b) + (b - (a ?? b)) * k;
  map.setSky({ ...map.getSky(), "fog-ground-blend": lerp(_skyPrev.g, C.sky.fogGroundBlend), "horizon-fog-blend": lerp(_skyPrev.h, C.sky.horizonFogBlend) });
}

/* Malla de MapLibre: se crea al empezar a encender (con exageración ~0) y se destruye al terminar de apagar (costo cero de ahí en más). */
function prenderMalla(map) {
  if (terrain.mesh) return;
  if (!_skyPrev && map.getSky) { const sk = map.getSky() || {}; _skyPrev = { g: sk["fog-ground-blend"], h: sk["horizon-fog-blend"] }; }
  map.setTerrain({ source: "dem", exaggeration: Math.max(1e-3, terrain.k * terrain.exag) });
  terrain.mesh = true;
  ajustarCosto(map);
  aplicarSky(map, terrain.k);   // niebla de MapLibre sobre la malla, interpolada con k (la capa atmo-fog de A1 se apaga mientras haya malla: render/atmo.js)
}
function apagarMalla(map) {
  if (!terrain.mesh) return;
  if (map.getTerrain && map.getTerrain()) map.setTerrain(null);
  terrain.mesh = false;
  limitarEscala(map, 0);   // la barra de escala vuelve a refrescarse en cada 'move'
  if (_skyPrev && map.getSky) map.setSky({ ...map.getSky(), "fog-ground-blend": _skyPrev.g, "horizon-fog-blend": _skyPrev.h });   // k = 0: ya estaba igual (aplicarSky)
  if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "none");
}

/* Cuelgue del 2026-11-18 (Mike: "al reactivar o mover la escena salta la cámara y se queda tildado"). La red de seguridad apaga el relieve
   justo mientras el usuario arrastra, y setTerrain(null) en medio del gesto rompe MapLibre 4.7.1: el HandlerManager termina el arrastre
   con transform.recalculateZoom(map.terrain) y map.terrain ya es null → TypeError DENTRO de su cola de tareas de render, que queda marcada
   "en ejecución" para siempre ("Attempting to run(), but is already running") y el mapa no vuelve a dibujar.
   (1) La malla se quita recién con el mapa quieto (sin gesto, inercia ni animación). (2) blindarColaRender: si alguna tarea de esa cola
   falla, se libera la cola y se sigue (red de seguridad general: cualquier excepción así congelaba todo sin remedio). */
function apagarMallaQuieta(map) {
  return new Promise(res => {
    const t0 = performance.now();
    const intentar = () => {
      if (terrain.on || terrain.k > 0) { res(false); return; }        // lo reencendieron mientras tanto: la malla se queda
      const h = map.handlers;
      if ((map.isMoving() || (h && h._terrainMovement)) && performance.now() - t0 < 30000) { setTimeout(intentar, 120); return; }
      apagarMalla(map); res(true);
    };
    intentar();
  });
}
function blindarColaRender(map) {
  const q = map && map._renderTaskQueue;
  if (!q || q._a6Safe || typeof q.run !== "function") return;
  const run = q.run;
  q.run = function (t) {
    try { return run.call(this, t); }
    catch (e) {
      this._currentlyRunning = false;   // sin esto, todos los cuadros siguientes abortan y el visor queda congelado
      console.warn("[mapa] una tarea de render falló y se recuperó:", (e && e.message) || e);
    }
  };
  q._a6Safe = true;
  /* Al terminar un arrastre con terreno MapLibre llama transform.recalculateZoom(map.terrain): deja la CÁMARA quieta en el espacio y corre el
     centro adonde la mirada toca el suelo nuevo. Si el relieve está en transición (el suelo sube o baja ~100 m), a 79° de inclinación eso es un
     salto de ~600 m y 1,5 niveles de zoom. Durante la transición manda aplicarK (centro y zoom fijos, la cámara acompaña al suelo), así que el
     recálculo se omite; también sin terreno (map.terrain null: el TypeError que congelaba el mapa). */
  /* En el PROTOTIPO: el gestor de gestos trabaja sobre copias de la cámara (transform.clone()) y recién después las aplica. */
  const trP = map.transform && Object.getPrototypeOf(map.transform);
  if (trP && typeof trP.recalculateZoom === "function" && !trP._a6Safe) {
    const rz = trP.recalculateZoom;
    trP.recalculateZoom = function (t) { if (!t || terrain.animating) return; return rz.call(this, t); };
    trP._a6Safe = true;
  }
  /* Mismo problema por otra vía (medido con la pila del cambio de zoom 17,7 → 16,3): al soltar el arrastre, _applyUpdatedTransform llama a
     _elevateCameraIfInsideTerrain, que con el suelo a medio camino y la elevación congelada por el gesto cree que la cámara quedó enterrada y
     la "levanta" cambiando zoom y centro. Durante la transición del relieve no corre. */
  if (typeof map._elevateCameraIfInsideTerrain === "function" && !map._a6SafeElev) {
    const ec = map._elevateCameraIfInsideTerrain;
    map._elevateCameraIfInsideTerrain = function (t) { return terrain.animating || !this.terrain ? {} : ec.call(this, t); };
    map._a6SafeElev = true;
  }
}

/* Espera (tope `ms`) a que las teselas DEM de la vista estén cargadas: si no, el relieve "crecería" sobre una malla vacía. */
function esperarDem(map, ms) {
  return new Promise(res => {
    const t0 = performance.now();
    const chk = () => { if (!map.isSourceLoaded || map.isSourceLoaded("dem") || performance.now() - t0 > ms) res(); else setTimeout(chk, 60); };
    chk();
  });
}

function animarK(target, ms) {
  const from = terrain.k, tok = ++_animTok;
  const dur = ms * Math.abs(target - from);
  return new Promise(res => {
    if (!(dur > 16) || document.hidden) { aplicarK(target, true); res(true); return; }
    const t0 = performance.now();
    const step = now => {
      if (tok !== _animTok) { res(false); return; }   // lo pisó otro pedido
      const p = Math.min(1, (now - t0) / dur);
      aplicarK(from + (target - from) * smooth01(p), p >= 1);
      if (p < 1) requestAnimationFrame(step); else res(true);
    };
    requestAnimationFrame(step);
  });
}

/* API pública (async). on: encender/apagar; animate (true): el relieve crece/se hunde en ~1,2 s (A6_TERRAIN.relief.transitionMs), con
   smoothstep y todo sincronizado; false = salto directo. opts.auto: lo pidió la red de seguridad. Devuelve el estado final. */
export async function setRelief(on_, { animate = true, auto = false } = {}) {
  const map = _map;
  if (!map || !terrain.available || !terrain.active) return reliefState();
  on_ = !!on_;
  if (on_ === terrain.on && !terrain.animating && terrain.k === (on_ ? 1 : 0)) return reliefState();
  terrain.on = on_;
  if (!on_ && auto) terrain.autoOff = true;
  const ms = !animate ? 0 : DBG && params.get("reliefms") ? parseFloat(params.get("reliefms")) : C.relief.transitionMs;
  terrain.animating = true;
  emitirEstado();
  if (on_) {
    agregarFuenteYHillshade(map);
    if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "visible");
    prenderMalla(map);
    aplicarK(terrain.k);   // fija exageración/elevación con el k actual (puede venir de un apagado a medias)
    await esperarDem(map, 6000);
    if (!terrain.on) { terrain.animating = false; return reliefState(); }   // lo apagaron mientras cargaba
    _warmReset();
  }
  const fin = await animarK(on_ ? 1 : 0, ms);
  if (!fin) return reliefState();   // otro pedido tomó el mando: él cierra el estado
  if (!on_) {
    await apagarMallaQuieta(map);   // k = 0 ya se ve plano; la malla se suelta cuando el mapa está quieto (ver arriba)
    if (terrain.on) return reliefState();   // lo reencendieron mientras esperaba: ese pedido cierra el estado
  }
  terrain.animating = false;
  emitirEstado();
  return reliefState();
}

/* Solo QA (?debug/?qa): fija el factor k a mano (malla prendida) sin animar, para capturar cuadros intermedios reproducibles. */
export function qaSetK(k) {
  if (!DBG || !_map || !terrain.active) return;
  terrain.animating = false; _animTok++;
  if (k > 0) prenderMalla(_map);
  aplicarK(k, true);
  if (k <= 0) apagarMalla(_map);
}

/* ---------- red de seguridad ----------
   Con el relieve activo (estable, sin transición), si el p50 del tiempo de frame EN MOVIMIENTO supera ~33 ms lo apaga con transición y emite
   "relief:auto-off" (A1 muestra el aviso). Mismo criterio que la autodegradación de Ultra (core/quality.js): descarta los primeros 10 s de la
   página, los primeros 6 s de movimiento acumulado y los frames > 250 ms; ventana de 240 frames en movimiento evaluada cada 60. Una vez por
   sesión: si el usuario vuelve a encenderlo, no se apaga de nuevo. Con ?qa NO corre salvo ?reliefsafe=1 (?reliefms2=<ms> umbral, ?reliefsafefast=1 espera corta). */
const AQ_QA = params.has("qa");
const SAFE_ON = !AQ_QA || params.get("reliefsafe") === "1";
const SAFE_FAST = AQ_QA && params.get("reliefsafefast") === "1";
const SAFE_THR = (AQ_QA && Number(params.get("reliefms2"))) || C.relief.safetyMs;
const SAFE_PAGE_MS = SAFE_FAST ? 0 : 10000, SAFE_WARM_MS = SAFE_FAST ? 0 : 6000, SAFE_WIN = SAFE_FAST ? 60 : 240, SAFE_STEP = SAFE_FAST ? 20 : 60;
export const safety = { on: SAFE_ON, fired: false, samples: 0, lastP50: null, thr: SAFE_THR };
const sf = { dts: [], moveMs: 0, since: 0, prev: new Float64Array(16) };
function _warmReset() { sf.dts.length = 0; sf.moveMs = 0; sf.since = 0; }
function safetyFrame(f) {
  const e = f.viewProj.elements;
  if (!terrain.on || terrain.animating || terrain.k < 1 || safety.fired || terrain.autoOff) { for (let i = 0; i < 16; i++) sf.prev[i] = e[i]; return; }
  let d = 0;
  for (let i = 0; i < 16; i++) { d += Math.abs(e[i] - sf.prev[i]); sf.prev[i] = e[i]; }
  if (!(d > 1e-9) || document.hidden || !(f.dt > 0) || f.dt > 250 || f.now < SAFE_PAGE_MS) return;
  if (sf.moveMs < SAFE_WARM_MS) { sf.moveMs += f.dt; return; }
  sf.dts.push(f.dt); if (sf.dts.length > SAFE_WIN) sf.dts.shift();
  safety.samples++;
  if (sf.dts.length < SAFE_WIN || ++sf.since < SAFE_STEP) return;
  sf.since = 0;
  const q = sf.dts.slice().sort((a, b) => a - b);
  safety.lastP50 = q[q.length >> 1];
  if (safety.lastP50 > SAFE_THR) setTimeout(autoOff, 0);   // fuera del render del host
}
async function autoOff() {
  if (safety.fired || !terrain.on) return;
  safety.fired = true;
  /* 2026-11-18: se espera a que el usuario suelte la escena (sin gesto, inercia ni animación de cámara). Apagar en medio del arrastre hacía
     saltar el zoom al soltar (MapLibre recalcula la altura de la cámara sobre un suelo que se está aplanando) y quitaba la malla a mitad del gesto. */
  const map = _map, t0 = performance.now();
  while (map && (map.isMoving() || (map.handlers && map.handlers._terrainMovement)) && performance.now() - t0 < 60000) await new Promise(r => setTimeout(r, 150));
  if (!terrain.on) return;   // el usuario lo apagó a mano mientras tanto
  const reason = "fluidez: p50 " + safety.lastP50.toFixed(1) + " ms > " + SAFE_THR + " ms en movimiento";
  console.info("[relieve] apagado automático (" + reason + ")");
  await setRelief(false, { animate: true, auto: true });
  emit("relief:auto-off", { reason });
}
if (SAFE_ON) on("frame", safetyFrame);

/* Carga el DEM del campo, decide y deja todo listo ANTES de armar las capas de escenario y el host.
   bbox = state.bbox ([[oeste,sur],[este,norte]]); data = FeatureCollection del escenario inicial (máscara de las
   estadísticas). Si el DEM no carga (sin red, bloqueo), el campo sigue como siempre (terreno y hillshade apagados).
   Relieve en vivo: el DEM se carga SIEMPRE (salvo ?terreno=0): hace falta para saber si el campo admite relieve y para tener las alturas
   horneadas (los sistemas Three se arman con relieve completo y el factor k los aplana en vivo). El estado inicial (on/off) sale de:
   ?terreno=1/0 > preferencia guardada (localStorage ad_relieve, la escribe A1) > terrainEnabled(quality) (default del nivel). */
export async function initTerrain(map, bbox, data) {
  const t0 = performance.now();
  _map = map;
  blindarColaRender(map);
  /* ?terreno=0 apaga TODO lo de A6 (terreno, hillshade y hasta la descarga del DEM): el visor queda idéntico al de antes
     del terreno (sirve de interruptor de comparación). ?hillshade=0|1 fuerza solo el sombreado de relieve. */
  if (params.get("terreno") === "0") { terrain.reason = "URL ?terreno=0 (todo apagado)"; terrain.unavailable = "sin-dem"; emitirEstado(); return terrain; }
  if (!C.enabled && !C.hillshade.enabled) { terrain.unavailable = "sin-dem"; emitirEstado(); return terrain; }
  if (DBG && params.get("demz")) C.demZoom = parseInt(params.get("demz"), 10) || C.demZoom;   // ?demz=: zoom del DEM (fuente + heightAt), solo ?debug/?qa
  try {
    const m = 0.01;   // margen (°) para que el borde del campo no quede pegado al límite de la grilla
    terrain.hf = await loadHeightfield([bbox[0][0] - m, bbox[0][1] - m, bbox[1][0] + m, bbox[1][1] + m], { z: C.demZoom, url: C.demUrl });
    terrain.hf.bbox = [bbox[0][0], bbox[0][1], bbox[1][0], bbox[1][1]];
    terrain.stats = terrain.hf.reliefStats({ mask: maskDe(data), baselineM: C.auto.baselineM });
    const d = decidir(terrain.stats);
    terrain.reason = d.why;
    terrain.available = d.available;
    if (!d.available) terrain.unavailable = "llano";
    const campoCfg = C.campos[(state.campo || {}).id] || {};
    let exag = campoCfg.exag ?? C.exaggeration;
    if (DBG && params.get("exag")) exag = parseFloat(params.get("exag")) || exag;
    terrain.exag = exag;
    const url = params.get("terreno");
    let pref = null; try { const v = localStorage.getItem("ad_relieve"); pref = v === "1" ? true : v === "0" ? false : null; } catch (e) { /* sin localStorage */ }
    const quiere = url === "1" ? true : pref !== null ? pref : terrainEnabled(quality);
    const onIni = d.available && quiere;
    terrain.on = onIni;
    terrain.active = d.available;   // estructural: ya con alturas horneadas aunque arranque apagado
    terrain.k = onIni ? 1 : 0;
    reliefU.uA6L.value = (1 - terrain.k) * exag; reliefU.uA6K.value = terrain.k;
    // hillshade: como siempre en campos llanos con calidad que lo admite; en campos con relieve solo si arranca encendido (si no, al encender)
    if (onIni || (!d.available && (url === "1" || terrainEnabled(quality)))) agregarFuenteYHillshade(map);
    if (onIni) prenderMalla(map);
  } catch (e) {
    console.warn("A6: no se pudo cargar el relieve (DEM); el campo queda sin terreno:", e.message || e);
    terrain.hf = null; terrain.active = false; terrain.available = false; terrain.on = false; terrain.k = 0; terrain.reason = "error DEM: " + (e.message || e);
    terrain.unavailable = "sin-dem";
    if (map.getLayer("hillshade")) map.removeLayer("hillshade");
    if (map.getSource("dem")) map.removeSource("dem");
    if (map.getSource("dem-hs")) map.removeSource("dem-hs");
  }
  terrain.loadMs = Math.round(performance.now() - t0);
  _warmReset();
  emitirEstado();
  // solo QA (?debug/?qa): ?reliefoff=<ms> apaga el relieve en vivo (con transición) a los <ms> ms de cargar (medir el costo "después de apagar")
  if (DBG && params.has("reliefoff") && terrain.on) setTimeout(() => setRelief(false, { animate: true }), Number(params.get("reliefoff")) || 0);
  return terrain;
}
