/* hydro/engine.js · orquestación PURA del cálculo (la usan el worker y los tests). Sin Three/DOM/MapLibre.
   Todo lo que depende de la lluvia está aparte (`evaluar`) del resto, porque Ae = acumulación de C·A no depende de la lluvia:
   un cambio del deslizador solo repite Manning + suavizado (milisegundos), no el relleno ni el flujo. */
import { medianFilter, cellCenters } from "./grid.js?v=20261201";
import { priorityFlood } from "./fill.js?v=20261201";
import { mfdWeights, meanDirection, localSlope } from "./flow.js?v=20261201";
import { tablaClases, rasterizarClases } from "./classes.js?v=20261201";
import { acumular, manning, suavizarLog, diferenciaLog, estadisticos, haFrena } from "./runoff.js?v=20261201";

const ahora = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/* Parte del terreno (sin escenarios): H → relleno → pesos MFD → dirección y pendiente. */
export function prepararTerreno(H, meta, P) {
  const { nx, ny, cell } = meta, ms = {};
  let t = ahora();
  const { F, order } = priorityFlood(H, nx, ny, P.epsFill); ms.relleno = ahora() - t; t = ahora();
  const W = mfdWeights(F, nx, ny, cell, P); ms.pesos = ahora() - t; t = ahora();
  const { dirX, dirY } = meanDirection(W, nx, ny, P);
  const S = localSlope(H, nx, ny, cell, P); ms.dirPendiente = ahora() - t;
  return { meta, H, F, order, W, dirX, dirY, S, ms };
}

/* Un escenario: clases → C, n → Ae. features = [{ cls, type, coordinates }]. */
export function prepararEscenario(terreno, features, centros, P) {
  const { meta, W, order } = terreno, n = meta.nx * meta.ny;
  const tabla = tablaClases(P);
  let t = ahora();
  const { cls, cubierto } = rasterizarClases(features, centros, tabla, P);
  const msClases = ahora() - t; t = ahora();
  const peso = new Float64Array(n), nM = new Float64Array(n);
  for (let id = 0; id < n; id++) { peso[id] = tabla.C[cls[id]] * meta.area; nM[id] = tabla.n[cls[id]]; }
  const Ae = acumular(W, order, peso, meta.nx);
  return { cls, cubierto, nM, peso, Ae, nombresClase: tabla.nombres, ms: { clases: msClases, acumulacion: ahora() - t } };
}

/* Todo lo que depende de la lluvia. Devuelve el resultado listo para transferir (Float32Array). */
export function evaluar(terreno, esc, rainMmH, P) {
  const { meta } = terreno, { nx, ny } = meta;
  const t = ahora();
  const { h, vRaw } = manning(esc.Ae, terreno.S, esc.nM, meta.cell, rainMmH, P);
  const v = suavizarLog(vRaw, nx, ny, P);
  const iMs = rainMmH / 1000 / 3600, Q = new Float64Array(h.length);   // caudal pico por celda (m³/s) = i · Ae, el mismo que usa Manning
  for (let id = 0; id < Q.length; id++) Q[id] = iMs * esc.Ae[id];
  return { h, v, Q, ms: ahora() - t };
}

const f32 = a => Float32Array.from(a);

/* Corre todo: raw (Float32Array del DEM de la grilla), features por escenario. Devuelve { terreno, esc, resultado }.
   `resultado` = { meta, rainMmH, h/v/Q por escenario, dlog, dirX, dirY, inside, stats }. */
export function correrTodo(raw, meta, featuresPorEscenario, rainMmH, P) {
  const t0 = ahora();
  const H = medianFilter(raw, meta.nx, meta.ny);
  const terreno = prepararTerreno(H, meta, P);
  const centros = cellCenters(meta);
  const ini = prepararEscenario(terreno, featuresPorEscenario.inicial, centros, P);
  const mul = prepararEscenario(terreno, featuresPorEscenario.multi, centros, P);
  const cache = { terreno, esc: { inicial: ini, multi: mul }, inside: ini.cubierto, centros };
  const resultado = resultadoDe(cache, rainMmH, P);
  resultado.stats.ms.total = ahora() - t0;
  resultado.stats.ms.relleno = terreno.ms.relleno; resultado.stats.ms.pesos = terreno.ms.pesos; resultado.stats.ms.dirPendiente = terreno.ms.dirPendiente;
  resultado.stats.ms.clases = ini.ms.clases + mul.ms.clases; resultado.stats.ms.acumulacion = ini.ms.acumulacion + mul.ms.acumulacion;
  return { cache, resultado };
}

/* Resultado para una lluvia dada a partir de lo ya calculado (sirve también para el recálculo del deslizador). */
export function resultadoDe(cache, rainMmH, P) {
  const { terreno, esc, inside } = cache, { meta } = terreno;
  const t = ahora();
  const ei = evaluar(terreno, esc.inicial, rainMmH, P), em = evaluar(terreno, esc.multi, rainMmH, P);
  const dlog = diferenciaLog(em.v, ei.v, P);
  const insideU8 = Uint8Array.from(inside);
  const si = estadisticos(ei.v, esc.inicial.Ae, insideU8, meta.area, rainMmH, P);
  const sm = estadisticos(em.v, esc.multi.Ae, insideU8, meta.area, rainMmH, P);
  let nIn = 0; for (let id = 0; id < insideU8.length; id++) nIn += insideU8[id];
  const stats = {
    rainMmH, campoHa: nIn * meta.area / 1e4, cellM: meta.cell, nx: meta.nx, ny: meta.ny,
    inicial: si, multi: sm,
    frenaHa: haFrena(dlog, insideU8, meta.area, P),
    reduccionVMediaPct: si.vMediaMs ? 100 * (1 - sm.vMediaMs / si.vMediaMs) : 0,
    ms: { evaluar: ahora() - t }
  };
  return {
    meta, rainMmH, stats,
    inicial: { h: f32(ei.h), v: f32(ei.v), Q: f32(ei.Q) },
    multi: { h: f32(em.h), v: f32(em.v), Q: f32(em.Q) },
    dlog, dirX: terreno.dirX.slice(), dirY: terreno.dirY.slice(), inside: insideU8   // copias: lo que se transfiere se desprende y el cache tiene que seguir vivo
  };
}
