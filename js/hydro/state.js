/* hydro/state.js · ÚNICA fuente de verdad del simulador de escorrentía (hilo principal).
   La UI y el render solo LEEN este estado (getState / evento "runoff") y llaman a las funciones de abajo.

   Costo con el simulador apagado: cero. Importar este módulo no crea el worker ni baja nada; el worker se crea (y el DEM de la
   cuenca se baja) recién en el primer ensureComputed(), que setMode("natural"|"velocidad"|"diferencia") dispara solo.

   Estado:   mode      "off" | "natural" | "velocidad" | "diferencia"
             rainMmH   intensidad pedida (mm/h)
             available ¿el campo tiene relieve que el DEM pueda resolver? (terrain.stats + umbrales de MODELO §4)
             reason    "llano" | "sin-dem" | "calculando" | ""      (motivo de no disponible, o "calculando" mientras corre)
             computing hay un cálculo en vuelo
             result    null o el resultado (ver más abajo); su rainMmH puede ir atrás de `rainMmH` mientras recalcula
             error     "" o el mensaje del último fallo
             opacity   opacidad visual de las capas del simulador (HIDRO.vis.opacidad; no calcula nada)
   Evento "runoff" (core/events.js): payload = getState() + { cambio: "mode"|"rain"|"availability"|"computing"|"result"|"error"|"opacity" }. */
import { HIDRO, A6_TERRAIN } from "../core/config.js?v=20261201";
import { state as appState } from "../core/state.js?v=20261201";
import { emit } from "../core/events.js?v=20261201";
import { terrain } from "../terrain/terrain.js?v=20261201";
import { cargarEntradaGrilla } from "./load.js?v=20261201";
import { sceneToCell } from "./grid.js?v=20261201";
import { paramsMotor } from "./params.js?v=20261201";

export { paramsMotor };

export const MODES = ["off", "natural", "velocidad", "diferencia"];

const S = { mode: "off", rainMmH: HIDRO.rain.default, available: false, reason: "sin-dem", computing: false, result: null, error: "", opacity: HIDRO.vis.opacidad.default };

let worker = null, seq = 0, tieneCache = false, primerCalculoEnCurso = null;
const pendientes = new Map();   // id → { resolve, reject }

/* ---------- disponibilidad (MODELO §4): con terrain.stats, NO con terrain.available ---------- */
function disponibilidad() {
  const st = terrain.stats;
  if (S.error || !terrain.hf || !st || terrain.unavailable === "sin-dem" || !appState.data.inicial || !appState.data.multi) return { available: false, reason: "sin-dem" };
  const u = HIDRO.disponibilidad;
  if (!(st.desvioResidual > u.desvioResidual || st.pendienteP95 > u.pendienteP95)) return { available: false, reason: "llano" };
  return { available: true, reason: S.computing ? "calculando" : "" };
}

export function getState() {
  const d = disponibilidad();
  S.available = d.available; S.reason = d.reason;
  return { mode: S.mode, rainMmH: S.rainMmH, available: S.available, reason: S.reason, computing: S.computing, result: S.result, error: S.error, opacity: S.opacity };
}
function avisar(cambio) { emit("runoff", { ...getState(), cambio }); }

/* ---------- funciones públicas ---------- */

/* Cambia la vista. Si el campo no admite simulador, no hace nada y devuelve false. Prender dispara el cálculo. */
export function setMode(mode) {
  if (!MODES.includes(mode)) throw new Error("hydro.setMode: modo inválido " + mode);
  if (mode !== "off" && !getState().available) return false;
  if (S.mode === mode) return true;
  S.mode = mode;
  avisar("mode");
  if (mode !== "off") ensureComputed();
  return true;
}

/* Lluvia en mm/h. commit=false mientras se arrastra el deslizador (solo actualiza el valor y avisa); commit=true (default, al
   soltar) pide el recálculo al worker si el simulador está prendido. */
export function setRain(mmh, commit = true) {
  const r = HIDRO.rain;
  S.rainMmH = Math.min(r.max, Math.max(r.min, Number(mmh) || r.default));
  avisar("rain");
  if (commit && S.mode !== "off") ensureComputed();
  return S.rainMmH;
}

/* Opacidad visual de agua / velocidades / diferencia, acotada a HIDRO.vis.opacidad. Solo avisa: no calcula ni crea el worker. */
export function setOpacity(v) {
  const o = HIDRO.vis.opacidad, n = Number(v);
  S.opacity = Math.min(o.max, Math.max(o.min, Number.isFinite(n) ? n : o.default));
  avisar("opacity");
  return S.opacity;
}

/* Promesa del resultado vigente para `rainMmH` (lo calcula si falta). Resuelve null si el campo no admite simulador o falló.
   También sirve para precalentar sin mostrar nada (p. ej. desde ?qa). */
export function ensureComputed() {
  if (S.result && S.result.rainMmH === S.rainMmH) return Promise.resolve(S.result);
  if (!getState().available) return Promise.resolve(null);
  if (!tieneCache) {
    if (!primerCalculoEnCurso) primerCalculoEnCurso = primerCalculo().finally(() => { primerCalculoEnCurso = null; });
    return primerCalculoEnCurso;
  }
  return recalcular();
}

/* Afín escena → celda del resultado vigente (forma de reliefU.uA6P): ci = x·a + b ; cj = z·c + d. null sin resultado. */
export function sceneAffine(originX, originY, scale) {
  return S.result ? sceneToCell(S.result.meta, originX, originY, scale) : null;
}

/* Libera el worker (no hace falta en uso normal; sirve a los tests). */
export function dispose() {
  if (worker) worker.terminate();
  worker = null; tieneCache = false; S.result = null; S.computing = false;
  for (const p of pendientes.values()) p.resolve(null);
  pendientes.clear();
}

/* ---------- internos ---------- */
function bboxCampo() {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of appState.data.inicial.features) {
    const g = f.geometry;
    if (!g) continue;
    for (const poly of g.type === "Polygon" ? [g.coordinates] : g.coordinates) for (const p of poly[0]) {
      if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1];
    }
  }
  return [w, s, e, n];
}
const featuresDe = key => appState.data[key].features.filter(f => f.geometry)
  .map(f => ({ cls: f.properties._cls, type: f.geometry.type, coordinates: f.geometry.coordinates }));

function crearWorker() {
  worker = new Worker(new URL("./worker.js?v=20261201", import.meta.url), { type: "module" });
  worker.onmessage = (ev) => {
    const m = ev.data, p = pendientes.get(m.id);
    if (!p) return;
    pendientes.delete(m.id);
    if (m.type === "error") p.reject(new Error(m.message)); else p.resolve(m);
  };
  worker.onerror = (ev) => {
    const err = new Error("worker: " + (ev.message || "error"));
    for (const p of pendientes.values()) p.reject(err);
    pendientes.clear();
  };
}
function pedir(msg, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => { pendientes.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer || []); }).then(m => ({ id, ...m }));
}

function empezar() { S.computing = true; avisar("computing"); }
function terminar(res, extra) {
  S.computing = false;
  if (res) { S.result = { ...res.result, msWorker: res.ms, ...extra }; S.error = ""; avisar("result"); }
}
function fallar(e) {
  console.warn("hydro: el cálculo falló:", e.message || e);
  S.computing = false; S.error = String(e.message || e);
  avisar("error");
  return null;
}

async function primerCalculo() {
  empezar();
  try {
    const P = paramsMotor();
    const entrada = await cargarEntradaGrilla(bboxCampo(), terrain.hf, P, A6_TERRAIN.demUrl);
    if (!worker) crearWorker();   // recién ahora: con el simulador apagado no hay worker
    const features = { inicial: featuresDe("inicial"), multi: featuresDe("multi") };
    const res = await pedir({ type: "compute", rainMmH: S.rainMmH, params: P, meta: entrada.meta, raw: entrada.raw, features }, [entrada.raw.buffer]);
    tieneCache = true;
    terminar(res, { fuenteDem: entrada.fuente, msDem: entrada.msDem });
    // si el deslizador se movió mientras tanto, se pide el recálculo liviano
    if (S.result.rainMmH !== S.rainMmH) return recalcularAhora();
    return S.result;
  } catch (e) { return fallar(e); }
}

let recalculoEnCurso = null;
function recalcular() {
  // uno solo en vuelo: si el deslizador se mueve de nuevo, el que está corriendo vuelve a mirar `rainMmH` al terminar
  if (!recalculoEnCurso) recalculoEnCurso = recalcularAhora().finally(() => { recalculoEnCurso = null; });
  return recalculoEnCurso;
}
async function recalcularAhora() {
  if (!S.computing) empezar();
  try {
    const res = await pedir({ type: "rain", rainMmH: S.rainMmH });
    terminar(res, { fuenteDem: S.result?.fuenteDem, msDem: S.result?.msDem });
    if (S.result.rainMmH !== S.rainMmH) return recalcularAhora();   // se movió otra vez durante el cálculo
    return S.result;
  } catch (e) { return fallar(e); }
}
