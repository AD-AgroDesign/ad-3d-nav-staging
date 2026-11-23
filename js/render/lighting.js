/* ============ Iluminación y uniforms globales compartidos ============
   Dueño desde la Ola 1: A1 (luz y atmósfera). Hoy es el mínimo de P-6:
   el reloj del viento y las luces actuales, con el valor de uniforms neutro
   para todo lo que todavía nadie consume (§6.3). Los materiales los toman por
   referencia (shaderlib.patch), así que cambiar `.value` los actualiza a todos. */
import * as THREE from "three";
import { A1_CAMPOS, A1_FOG, A1_HORAS, A1_LIGHT, A1_RASTER, A1_RENDER, A1_SKY, A1_SUN, A3_SHADOWS, A6_NIEBLA } from "../core/config.js?v=20261201";
import { emit, on } from "../core/events.js?v=20261201";
import { quality } from "../core/quality.js?v=20261201";

/* Color (1.3): ColorManagement ENCENDIDO. Las paletas del proyecto están definidas "a ojo" en
   sRGB (hex); Three las convierte a lineal, ilumina en lineal y host.js saca sRGB + tone mapping
   (applyRenderSettings). El multiplicador de color de vértice del pasto (tip/base/midCol) se
   re-expresa en shaderlib (srgbVC) para que el producto con el color de instancia conserve el
   tono diseñado. Va acá, antes de crear cualquier Color. */
THREE.ColorManagement.enabled = true;

/* Color sRGB "crudo": no se convierte a lineal. La niebla se mezcla después del tone mapping y de
   la conversión de salida (shaderlib), igual que lo que MapLibre dibuja en el canvas. */
function rawColor(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return new THREE.Color().setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, THREE.LinearSRGBColorSpace);
}

/* Uniforms globales (§6.3). Solo uTime se usa hoy (viento del pasto); el resto está
   declarado con valores neutros para que A1/A2/A4/A5 los consuman sin tocar el host. */
export const uniforms = {
  uTime:      { value: 0 },                        // reloj del viento (solo avanza cuando el mapa repinta)
  uCamPos:    { value: new THREE.Vector3() },      // posición de cámara en metros de escena (core/camera.js, P-7)
  uSunDir:    { value: new THREE.Vector3(-0.5, 1, -0.7).normalize() },
  uSunColor:  { value: new THREE.Color(0xfff3da) },
  uHemiSky:   { value: new THREE.Color(0xffffff) },
  uHemiGround:{ value: new THREE.Color(0xffffff) },
  uSunInt:    { value: A1_LIGHT.sunInt },           // intensidad de la luz directa (el color de uSunColor NO la trae; ver "Modos de hora")
  uFogColor:  { value: rawColor(A1_FOG.color) },           // = horizon-color del sky; valor sRGB CRUDO (se mezcla ya en espacio de salida)
  uFogNear:   { value: 1e9 },                      // se recalculan cada frame en updateFog(); 1e9 = sin niebla
  uFogFar:    { value: 1e9 },
  uFogMax:    { value: A1_FOG.max },               // opacidad máxima de la niebla (horizonte)
  uFogRel:    { value: new THREE.Vector4(1e9, 1e9, 0, 0) },   // A6 (G4-fix): niebla "con relieve" = (near px, far px, opacidad por pitch, peso k); peso 0 = curva plana pura
  uFade:      { value: 1 }                         // fade dither (A1): 1 = opaco
};

/* ---------- Luces: hemisférica + sol (1.3) ----------
   Reemplazan Ambient 0.55π + Directional 0.85π (paridad de la Ola 0). Cielo cálido arriba,
   suelo = color medio del satélite del campo abajo. La dirección del sol sale de azimut y
   elevación (brújula: 0 = N, 90 = E; escena X este, Y arriba, Z sur). */
export const lights = {};
const TONE = { none: THREE.NoToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping };
const _tm = new URLSearchParams(location.search);

/* Color de salida + tone mapping del renderer (host.js lo llama al crearlo). Con ?debug/?qa se
   puede probar otro con ?tm=aces|agx|neutral|none&exp=1.2. */
let _renderer = null, _baseExposure = A1_RENDER.exposure;
export function applyRenderSettings(renderer) {
  _renderer = renderer;
  const dbg = _tm.has("debug") || _tm.has("qa");
  const name = (dbg && _tm.get("tm")) || A1_RENDER.toneMapping;
  const exp = dbg && _tm.get("exp") ? parseFloat(_tm.get("exp")) : A1_RENDER.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = TONE[name] ?? THREE.NoToneMapping;
  renderer.toneMappingExposure = _baseExposure = exp;
  renderer.toneMappingExposure = _baseExposure * atm.expK;   // modo de hora vigente
}

export function setSun(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180;
  const d = uniforms.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  if (lights.sun) lights.sun.position.copy(d).multiplyScalar(100);
  lights.azimuth = azimuthDeg; lights.elevation = elevationDeg;
}

/* Azimut y color de suelo del campo (config.js A1_CAMPOS; default regional si no se midió). */
let _baseAz = A1_SUN.defaultAzimuth, _groundHex = A1_LIGHT.hemiGround;
export function applyCampoLighting(campoId) {
  const c = A1_CAMPOS[campoId] || {};
  _baseAz = c.sunAzimuth ?? A1_SUN.defaultAzimuth;
  _groundHex = c.groundColor || A1_LIGHT.hemiGround;
  applyAtmosphere();
}

export function createLights(scene) {
  const hemi = lights.hemi = new THREE.HemisphereLight(A1_LIGHT.hemiSky, A1_LIGHT.hemiGround, 1);
  const sun = lights.sun = new THREE.DirectionalLight(A1_LIGHT.sunColor, A1_LIGHT.sunInt);
  scene.add(hemi, sun);
  _scene = scene;
  /* OJO (contrato con A2/A4/A5): estos tres objetos Color y uSunDir se MUTAN en el lugar en cada paso de una
     transición de hora; nunca se reemplazan. Un shader que tome uniforms.uSunColor/uHemiSky/uHemiGround/uSunDir/uSunInt
     por referencia ve siempre el modo vigente. */
  uniforms.uSunColor.value = sun.color; uniforms.uHemiSky.value = hemi.color; uniforms.uHemiGround.value = hemi.groundColor;
  applyAtmosphere();
  return { sun, hemi };
}

/* ---------- Niebla por distancia real a la cámara (1.2) ----------
   Rango RELATIVO a la geometría del frame (spike A1, trampa 1): un rango absoluto vela toda
   la imagen en zooms altos y deja recorte en el rasante, porque MapLibre dibuja el suelo solo
   hasta su plano lejano (3,7 km en el rasante, 10 km a z15.8, 140 km a z12).
     far  = farFrac · distancia al suelo sobre la línea del sky → la niebla llega a 1 justo ahí
     near = max(near mínimo, nearK · distancia cámara-centro), tope nearMaxFrac · far
   La usan por igual la capa atmo-fog (suelo) y los objetos Three (shaderlib `fog`).
   Baja calidad: sin niebla (como hoy). */
export const fog = { enabled: quality.name !== "baja", near: 1e9, far: 1e9, dHor: 0, hNdc: 0 };
on("quality", q => { fog.enabled = q.name !== "baja"; });

/* `cam` = resultado de core/camera.js updateCamera(...) con rays (se pasa `matrix`);
   H = alto del canvas en px CSS. Devuelve `fog` (objeto reutilizado). */
const _qs = new URLSearchParams(location.search);
const _noFogRelieve = (_qs.has("qa") || _qs.has("debug")) && _qs.get("fogrelieve") === "0";   // QA: ?fogrelieve=0 = niebla plana también con relieve (comparar antes/después)
export function updateFog(cam, H, tr, kRel = 1) {
  const r = cam.rays;
  uniforms.uFogRel.value.w = 0;   // por defecto curva plana pura (la capa atmo-fog llama sin `tr`)
  if (!fog.enabled || !r) {
    fog.near = fog.far = uniforms.uFogNear.value = uniforms.uFogFar.value = 1e9;
    uniforms.uFogMax.value = A1_FOG.max;
    return fog;
  }
  /* A6 (G4-fix): la niebla es SIEMPRE la curva plana (uFogNear/Far/Max, como antes) más, con terreno (`tr` = map.transform), la curva de
     MapLibre sobre la malla en uFogRel (near = cameraToCenterDistance + elevación·px/m / cos(pitch), far = farZ en px, opacidad por pitch:
     0 hasta 60°, 1 desde 70°) con peso kRel = k del relieve. El shader (adFog, shaderlib.js) mezcla las dos curvas con kRel: así la niebla se
     interpola con continuidad al encender/apagar el relieve (antes saltaba de una a otra y el horizonte destellaba). */
  const rel = tr && !_noFogRelieve && tr.farZ > 0 && tr._pixelPerMeter > 0 && tr.cameraToCenterDistance > 0;
  if (rel) {
    const pitch = tr.pitch, op = pitch < 60 ? 0 : pitch < 70 ? (pitch - 60) / 10 : 1;
    const n = tr.cameraToCenterDistance + (tr.elevation || 0) * tr._pixelPerMeter / Math.cos(tr._pitch);
    uniforms.uFogRel.value.set(n, tr.farZ, op, kRel);
  }
  uniforms.uFogMax.value = A1_FOG.max;
  const hNdc = cam.horizonPx / (H / 2);
  // rayo (este, norte, arriba; m) de la línea del sky al centro horizontal de la pantalla
  const dx = r.d0[0] + hNdc * r.dy[0], dy = r.d0[1] + hNdc * r.dy[1], dz = r.d0[2] + hNdc * r.dy[2];
  const dHor = dz < -1e-6 ? (-cam.altitudeM / dz) * Math.hypot(dx, dy, dz) : 1e9;   // sin tope si el rayo no baja
  const far = dHor * A1_FOG.farFrac;
  const k = atm.fogK;   // modo de hora: < 1 = niebla más densa (empieza más cerca)
  const near = Math.min(Math.max(A1_FOG.near * k, A1_FOG.nearK * k * cam.ctdM) * A6_NIEBLA.nearMul, far * Math.min(0.9, A1_FOG.nearMaxFrac * A6_NIEBLA.nearMul));   // A6_NIEBLA: la niebla arranca más lejos (config.js)
  fog.near = near; fog.far = far; fog.dHor = dHor; fog.hNdc = hNdc;
  uniforms.uFogNear.value = near; uniforms.uFogFar.value = far;
  if (rel && kRel >= 1) { fog.near = uniforms.uFogRel.value.x; fog.far = fog.dHor = uniforms.uFogRel.value.y; fog.hNdc = 0; }   // consumidores JS (QA): con el relieve completo, la curva de relieve
  return fog;
}

/* ============ Modos de hora (Ola 3 · 3.1) ============
   Mediodía (el actual, por defecto) · hora dorada · atardecer. Un modo es un conjunto de parámetros (A1_HORAS en config.js;
   el mediodía sale de los diales de siempre, así que no cambia nada). `atm` es el estado VIGENTE, ya interpolado; applyAtmosphere()
   lo vuelca a todo lo que depende de la hora:
     · sol (azimut = el medido por campo + sunAz, T13; elevación), color e intensidad (lights.sun, uSunDir/uSunColor/uSunInt)
     · hemisférica (cielo y suelo del campo), exposición del tone mapping
     · niebla: uFogColor (= horizon-color del sky) y escala del inicio (fogK, updateFog)
     · sombras de A3: dirección y largo salen solos de uSunDir; la intensidad y el tinte se escriben en sus uniforms
     · lo que vive en MapLibre (sky, ráster satelital, hillshade) lo vuelca map/style.js, que se engancha con onAtmosphere()
   La transición (1,5 s, smoothstep) corre con SU PROPIO rAF y solo mientras dura: en reposo no hay lazo (T7). dt con clamp (T5). */
export const PRESET_NAMES = ["mediodia", "dorada", "atardecer"];
const _rgb = hex => { const n = parseInt(String(hex).replace("#", ""), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

const _SKY0 = { ...A1_SKY };   // el mediodía = los colores de config ANTES de que applyAtmosphere() empiece a reescribir A1_SKY
const _hex = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

/* Estado normalizado de un modo (colores como [r,g,b] sRGB 0..1; todo lo demás, números). */
export function presetDef(name) {
  if (name === "mediodia" || !A1_HORAS[name]) {
    return {
      sunElev: A1_SUN.elevation, sunAz: 0, sunCol: _rgb(A1_LIGHT.sunColor), sunInt: A1_LIGHT.sunInt,
      hemiSky: _rgb(A1_LIGHT.hemiSky), hemiSkyInt: A1_LIGHT.hemiSkyInt, gTint: [1, 1, 1], gInt: A1_LIGHT.hemiGroundInt,
      skyCol: _rgb(_SKY0.skyColor), horCol: _rgb(_SKY0.horizonColor), fogCol: _rgb(_SKY0.fogColor), fogK: 1, expK: 1,
      tint: [1, 1, 1], rSat: A1_RASTER.saturation, rCon: A1_RASTER.contrast, rBMin: A1_RASTER.brightnessMin, rBMax: A1_RASTER.brightnessMax, rHue: A1_RASTER.hueRotate,
      shStr: A3_SHADOWS.strength, shTint: A3_SHADOWS.tint.slice()
    };
  }
  const h = A1_HORAS[name];
  return {
    sunElev: h.sunElev, sunAz: h.sunAz, sunCol: _rgb(h.sunColor), sunInt: h.sunInt,
    hemiSky: _rgb(h.hemiSky), hemiSkyInt: h.hemiSkyInt, gTint: _rgb(h.gTint), gInt: h.gInt,
    skyCol: _rgb(h.skyColor), horCol: _rgb(h.horizonColor), fogCol: _rgb(h.fogColor), fogK: h.fogK, expK: h.expK,
    tint: _rgb(h.tint), rSat: h.rSat, rCon: h.rCon, rBMin: h.rBMin, rBMax: h.rBMax, rHue: h.rHue, shStr: h.shStr, shTint: h.shTint.slice()
  };
}

/* Modo inicial: ?hora=dorada|atardecer|mediodia (sin animación). */
const _horaQ = _tm.get("hora");
export let presetName = PRESET_NAMES.includes(_horaQ) ? _horaQ : "mediodia";
export const atm = presetDef(presetName);   // estado vigente (objeto único y mutable; lo leen style.js y los sistemas)

const _atmListeners = [];
/* Registra un callback que recibe `atm` en cada paso (style.js lo usa para el ráster y el cielo de MapLibre). */
export function onAtmosphere(fn) { _atmListeners.push(fn); }

let _scene = null, _shU = null;
const _tmpC = new THREE.Color();
/* Uniforms de las sombras de A3 (uA3P.w = intensidad, uA3Tint = tinte): se toman de su receptor en la escena. Hasta que
   shadows.js los exporte (pedido a A3), se buscan una vez recorriendo la escena. */
function shadowUniforms() {
  if (_shU || !_scene) return _shU;
  _scene.traverse(o => { if (!_shU && o.material && o.material.uniforms && o.material.uniforms.uA3P && o.material.uniforms.uA3Tint) _shU = o.material.uniforms; });
  return _shU;
}

export function applyAtmosphere() {
  const s = atm;
  setSun(_baseAz + s.sunAz, s.sunElev);
  uniforms.uSunInt.value = s.sunInt;
  if (lights.sun) { lights.sun.color.setRGB(s.sunCol[0], s.sunCol[1], s.sunCol[2], THREE.SRGBColorSpace); lights.sun.intensity = s.sunInt; }
  if (lights.hemi) {
    lights.hemi.color.setRGB(s.hemiSky[0], s.hemiSky[1], s.hemiSky[2], THREE.SRGBColorSpace).multiplyScalar(s.hemiSkyInt);
    lights.hemi.groundColor.set(_groundHex).multiply(_tmpC.setRGB(s.gTint[0], s.gTint[1], s.gTint[2], THREE.SRGBColorSpace)).multiplyScalar(s.gInt);
  }
  uniforms.uFogColor.value.setRGB(s.horCol[0], s.horCol[1], s.horCol[2], THREE.LinearSRGBColorSpace);   // sRGB crudo (ver rawColor)
  /* A4 (agua) lee A1_SKY.skyColor/horizonColor (hex) para su reflejo de cielo: se mantienen al día con el modo vigente. */
  A1_SKY.skyColor = _hex(s.skyCol); A1_SKY.horizonColor = _hex(s.horCol); A1_SKY.fogColor = _hex(s.fogCol);
  if (_renderer) _renderer.toneMappingExposure = _baseExposure * s.expK;
  const u = shadowUniforms();
  if (u) { u.uA3P.value.w = s.shStr; u.uA3Tint.value.set(s.shTint[0], s.shTint[1], s.shTint[2]); }
  for (const fn of _atmListeners) fn(s);
}

/* Las sombras de A3 se construyen después de createLights(): en el primer frame se vuelcan los valores del modo inicial. */
const _offFirst = on("frame", () => { _offFirst(); if (presetName !== "mediodia") applyAtmosphere(); });

const _smooth = t => t * t * (3 - 2 * t);
function _mix(a, b, t, out) {
  for (const k in b) {
    if (Array.isArray(b[k])) for (let i = 0; i < b[k].length; i++) out[k][i] = a[k][i] + (b[k][i] - a[k][i]) * t;
    else out[k] = a[k] + (b[k] - a[k]) * t;
  }
}
let _anim = null;
/* Cambia de modo. opts.instant = sin transición · opts.duration = ms (default A1_HORAS.duracionMs).
   Devuelve una promesa que se resuelve (true) al terminar la transición; false si el nombre no existe. */
export function setPreset(name, opts = {}) {
  if (!PRESET_NAMES.includes(name)) return Promise.resolve(false);
  const to = presetDef(name), from = JSON.parse(JSON.stringify(atm));
  if (_anim) { _anim.resolve(true); _anim = null; }
  const changed = name !== presetName;
  presetName = name;
  if (changed) emit("preset", { name });
  const dur = opts.instant ? 0 : (opts.duration ?? A1_HORAS.duracionMs);
  if (dur <= 0) { _mix(to, to, 1, atm); applyAtmosphere(); _repaint(); return Promise.resolve(true); }
  return new Promise(resolve => {
    const a = _anim = { resolve, t: 0, last: performance.now() };
    const step = now => {
      if (_anim !== a) return;                       // pisada por otra transición
      const dt = Math.max(0, now - a.last); a.last = now;   // T5: el primer timestamp de rAF puede ser anterior a performance.now()
      a.t = Math.min(1, a.t + dt / dur);
      _mix(from, to, _smooth(a.t), atm);
      applyAtmosphere(); _repaint();
      if (a.t >= 1) { _anim = null; resolve(true); } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
let _repaintFn = null;
/* style.js registra acá map.triggerRepaint (lighting.js no importa el mapa: evita ciclos). */
export function setRepaint(fn) { _repaintFn = fn; }
function _repaint() { if (_repaintFn) _repaintFn(); }
