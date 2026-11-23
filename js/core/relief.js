/* ============ Puente con el relieve de A6 (conmutadores sin recarga, 2026-11-13) ============
   TODO lo que depende del nombre exacto de la API de A6 vive ACÁ (un solo punto de enganche; si al mergear cambia, se ajusta
   solo este archivo). Interfaz asumida (se hace en paralelo en wt/a6, js/terrain/terrain.js):
     - export async function setRelief(on, { animate })   enciende/apaga el relieve (carga el DEM si hace falta)
     - terrain.available (bool, opcional)                  false en campos llanos; si falta se asume disponible
     - evento "relief:state"    payload { active, available, reason }   cada vez que cambia el estado
     - evento "relief:auto-off" payload { reason }                      A6 lo apagó sola por fluidez
   Motivos conocidos de "no disponible": "llano" (campo llano) y "error"/"sin-dem" (no se pudo cargar el DEM).
   Este módulo: decide el relieve deseado (override de sesión setReliefSession > preferencia ad_relieve > default del nivel), lo aplica cuando cambia el nivel de
   calidad y expone el estado a la UI (ui/relief-ui.js). */
import { on, EVENTS } from "./events.js?v=20261201";
import { quality, reliefPref, setReliefPref, terrainEnabled } from "./quality.js?v=20261201";
import * as TER from "../terrain/terrain.js?v=20261201";

for (const n of ["relief:state", "relief:auto-off"]) if (!EVENTS.includes(n)) EVENTS.push(n);   // el bus avisa si el evento no figura en EVENTS (events.js es de P)

let _act = null;
/* Estado visible para la UI. */
export const relief = {
  /* La verdad es la de A6: el último "relief:state" si ya hubo uno; antes de eso, terrain.active (initTerrain termina después de
     cargar este módulo, por eso no se copia al importar). */
  get active() { return _act === null ? !!TER.terrain.active : _act; },
  available: TER.terrain.available !== false,
  reason: "",
  autoOff: false      // A6 lo apagó por fluidez en esta sesión: no lo reencendemos solos al cambiar de calidad
};

const listeners = new Set();
export const onRelief = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const avisar = () => listeners.forEach(f => f(relief));

/* ---- punto de enganche con A6 ---- */
function apiSetRelief(on_, opts) {
  const f = TER.setRelief || (typeof window !== "undefined" && /[?&]qa/.test(location.search) && window.__reliefApi && window.__reliefApi.setRelief);   // __reliefApi: solo QA, para probar sin A6
  return f ? f(on_, opts) : Promise.resolve();
}

on("relief:state", s => {
  if (!s) return;
  if ("active" in s) _act = !!s.active;
  if ("available" in s) relief.available = s.available !== false;
  relief.reason = s.reason || "";
  avisar();
});
on("relief:auto-off", s => { relief.autoOff = true; _act = false; relief.reason = (s && s.reason) || "auto"; avisar(); });

/* Aplica el relieve deseado, de a uno por vez (si llega otro pedido mientras tanto, se re-evalúa al terminar). */
let busy = false, again = false;
export async function syncRelief({ animate = true } = {}) {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      const want = _sesion !== null ? _sesion : relief.autoOff && reliefPref() === null ? false : terrainEnabled(quality);
      if (relief.available !== false && want !== relief.active) {
        const r = apiSetRelief(want, { animate });
        if (r && r.then) await r;
        avisar();   // relief.active lee terrain.active (si el DEM falló, queda apagado)
      }
    } while (again);
  } catch (e) { console.warn("relief:", e.message || e); }
  busy = false;
}

/* Override SOLO de esta visita (en memoria, sin localStorage): lo usa el simulador de escorrentía para prender el relieve que
   el usuario tenía apagado sin pisar su preferencia ad_relieve; al recargar vuelve a lo de siempre. Manda sobre la preferencia
   y el default del nivel, y sobrevive a los cambios de calidad. */
let _sesion = null;
export function setReliefSession(on_) {
  _sesion = !!on_;
  if (_sesion) relief.autoOff = false;   // igual que setReliefUser: pedido explícito, se aplica aunque A6 lo haya apagado por fluidez
  return syncRelief({ animate: true });
}

/* El usuario toca el conmutador: se recuerda y se aplica (y borra el override de sesión: manda lo que toca). */
export function setReliefUser(on_) {
  _sesion = null;
  setReliefPref(!!on_);
  relief.autoOff = false;
  return syncRelief({ animate: true });
}

/* Cambio de nivel: si cambia el relieve deseado, se aplica (A6 hace el crecimiento/hundimiento). */
on("quality", () => syncRelief({ animate: true }));
