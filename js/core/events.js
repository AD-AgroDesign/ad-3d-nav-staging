/* ============ Bus de eventos mínimo ============
   Desacopla módulos sin imports cruzados. Eventos definidos (§6.2):
     "scenario"  payload: { key, prev }        al cambiar de escenario (map/scenario.js)
     "preset"    payload: { name }             modo de hora (A1, Ola 3; todavía nadie lo emite)
     "quality"   payload: quality              al cambiar el nivel de calidad (core/quality.js)
     "frame"     payload: frame                cada frame de la capa custom (render/host.js)
     "runoff"    payload: estado del simulador al cambiar lluvia/suelo/escenario (hydro/state.js) */
export const EVENTS = ["scenario", "preset", "quality", "frame", "runoff"];

const handlers = {};

/* Suscribe fn a `name`; devuelve la función para desuscribirse. */
export function on(name, fn) {
  if (!EVENTS.includes(name)) console.warn("events.on: evento desconocido:", name);
  (handlers[name] || (handlers[name] = [])).push(fn);
  return () => off(name, fn);
}

export function off(name, fn) {
  const h = handlers[name];
  if (h) handlers[name] = h.filter(f => f !== fn);
}

/* Camino rápido sin oyentes (importa para "frame", que se emite en cada render). */
export function hasListeners(name) {
  const h = handlers[name];
  return !!(h && h.length);
}

export function emit(name, payload) {
  const h = handlers[name];
  if (!h || !h.length) return;
  for (const fn of h.slice()) fn(payload);
}
