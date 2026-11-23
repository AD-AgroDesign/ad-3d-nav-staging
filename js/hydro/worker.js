/* hydro/worker.js · Web Worker de módulo del simulador. Se crea recién cuando el usuario prende el simulador (state.js).
   No importa config.js (toca window): los parámetros llegan en el mensaje (`params`, armados por state.js desde HIDRO).

   Entrada (postMessage):
     { type: "compute", id, rainMmH, params, meta, raw: Float32Array (TRANSFERIDO), features: { inicial: [...], multi: [...] } }
         features[k] = [{ cls, type: "Polygon"|"MultiPolygon", coordinates }]   (lo que hay en state.data[k].features)
     { type: "rain", id, rainMmH }          recalcula con la lluvia nueva sobre lo ya calculado (Manning + suavizado)
   Salida:
     { type: "result", id, result, ms }     result = ver engine.js resultadoDe; todos los Float32Array/Uint8Array van transferidos
                    (inicial.{h,v,Q} y multi.{h,v,Q}: h = altura m, v = velocidad m/s suavizada, Q = caudal pico m³/s; los dos escenarios siempre)
     { type: "error", id, message }
   Un mensaje a la vez; si llega otro mientras tanto, queda en la cola del worker y state.js descarta las respuestas viejas por id. */
import { correrTodo, resultadoDe } from "./engine.js?v=20261201";

let cache = null, params = null;

function buffers(r) {
  const out = [];
  for (const k of ["inicial", "multi"]) out.push(r[k].h.buffer, r[k].v.buffer, r[k].Q.buffer);
  out.push(r.dlog.buffer, r.dirX.buffer, r.dirY.buffer, r.inside.buffer);
  return out;
}

self.onmessage = (ev) => {
  const m = ev.data, t0 = performance.now();
  try {
    if (m.type === "compute") {
      params = m.params;
      cache = null;
      const { cache: c, resultado } = correrTodo(m.raw, m.meta, m.features, m.rainMmH, params);
      cache = c;
      self.postMessage({ type: "result", id: m.id, result: resultado, ms: performance.now() - t0 }, buffers(resultado));
    } else if (m.type === "rain") {
      if (!cache) throw new Error("rain antes de compute");
      const r = resultadoDe(cache, m.rainMmH, params);
      self.postMessage({ type: "result", id: m.id, result: r, ms: performance.now() - t0 }, buffers(r));
    }
  } catch (e) {
    self.postMessage({ type: "error", id: m.id, message: String((e && e.message) || e) });
  }
};
