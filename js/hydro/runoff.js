/* hydro/runoff.js · acumulación MFD, caudal racional, Manning, suavizado log y estadísticos. Puro. MODELO §2.6–2.11. */
import { boxN, NB_DI, NB_DJ } from "./flow.js?v=20261201";

/* Acumulación MFD de `peso` (Float64Array) recorriendo de mayor a menor F. `order` = orden de salida de la cola del relleno
   (no decreciente en F): al revés es el recorrido que hace falta. Devuelve Float64Array. */
export function acumular(W, order, peso, nx) {
  const n = peso.length, acc = Float64Array.from(peso);
  const offs = NB_DI.map((di, k) => NB_DJ[k] * nx + di);
  for (let t = n - 1; t >= 0; t--) {
    const k = order[t], a = acc[k];
    if (a === 0) continue;
    const b = 8 * k;
    for (let d = 0; d < 8; d++) { const w = W[b + d]; if (w > 0) acc[k + offs[d]] += a * w; }
  }
  return acc;
}

/* Σ de lo que sale de la grilla: acumulado de las celdas sin ninguna vecina más baja (solo bordes, gracias al relleno). */
export function salidaPorBordes(acc, W) {
  let s = 0;
  for (let id = 0; id < acc.length; id++) {
    let tiene = false;
    for (let d = 0; d < 8; d++) if (W[8 * id + d] > 0) { tiene = true; break; }
    if (!tiene) s += acc[id];
  }
  return s;
}

/* Caudal pico (método racional) y Manning con ancho = lado de celda. Ae en m², lluvia en mm/h.
   Devuelve { h (m), vRaw (m/s), qMax } sin suavizar. */
export function manning(Ae, S, nM, cell, rainMmH, P) {
  const n = Ae.length, i = rainMmH / 1000 / 3600;
  const h = new Float64Array(n), vRaw = new Float64Array(n);
  for (let id = 0; id < n; id++) {
    const q = i * Ae[id] / cell;                       // m²/s
    const hh = Math.pow(q * nM[id] / Math.sqrt(S[id]), 0.6);
    h[id] = hh;
    vRaw[id] = hh > 0 ? q / Math.max(hh, P.eps.hMin) : 0;
  }
  return { h, vRaw };
}

/* v = 10^(caja3×3(log10(max(v, vMin)))) */
export function suavizarLog(vRaw, nx, ny, P) {
  const n = vRaw.length, L = new Float64Array(n);
  for (let id = 0; id < n; id++) L[id] = Math.log10(Math.max(vRaw[id], P.eps.vMin));
  const B = boxN(L, nx, ny, 1);
  for (let id = 0; id < n; id++) B[id] = Math.pow(10, B[id]);
  return B;
}

/* dlog = log2(v_multi / v_inicial) */
export function diferenciaLog(vMulti, vIni, P) {
  const d = new Float32Array(vMulti.length);
  for (let id = 0; id < d.length; id++) d[id] = Math.log2(Math.max(vMulti[id], P.eps.vMin) / Math.max(vIni[id], P.eps.vMin));
  return d;
}

/* percentil lineal (como numpy.percentile) de un array ordenado */
function percentil(sorted, p) {
  const x = p * (sorted.length - 1), lo = Math.floor(x), hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

/* Estadísticos de un escenario dentro del campo (`inside` Uint8Array). Ae en m². */
export function estadisticos(v, Ae, inside, area, rainMmH, P) {
  let s = 0, cnt = 0, alta = 0, aeMax = 0;
  for (let id = 0; id < v.length; id++) {
    if (!inside[id]) continue;
    cnt++; s += v[id];
    if (v[id] > P.stats.vAltaMs) alta++;
    if (Ae[id] > aeMax) aeMax = Ae[id];
  }
  const dentro = new Float64Array(cnt);
  for (let id = 0, c = 0; id < v.length; id++) if (inside[id]) dentro[c++] = v[id];
  dentro.sort();
  return {
    vMediaMs: cnt ? s / cnt : 0,
    vP95Ms: cnt ? percentil(dentro, 0.95) : 0,
    haVMayor: alta * area / 1e4,
    qPicoMaxM3s: aeMax * rainMmH / 1000 / 3600
  };
}

/* ha donde el diseño frena (dlog < umbral) dentro del campo */
export function haFrena(dlog, inside, area, P) {
  let c = 0;
  for (let id = 0; id < dlog.length; id++) if (inside[id] && dlog[id] < P.stats.frenaDlog) c++;
  return c * area / 1e4;
}
