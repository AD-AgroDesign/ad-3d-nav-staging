/* hydro/flow.js · flujo múltiple (MFD, Holmgren), dirección media y pendiente local. Puro. MODELO §2.2–2.4. */

/* Vecinas en el mismo orden que la referencia: (di, dj) con di = columnas (este +), dj = filas (sur +). */
export const NB_DI = [-1, 0, 1, -1, 1, -1, 0, 1];
export const NB_DJ = [-1, -1, -1, 0, 0, 1, 1, 1];
export const NB_DIST = NB_DI.map((di, k) => (di !== 0 && NB_DJ[k] !== 0 ? Math.SQRT2 : 1));

/* Caja 3×3 normalizada por las vecinas que existen (media de las celdas dentro de la grilla).
   La referencia rellena con ceros y divide por 9: en el borde de la grilla eso sesga el valor hacia 0 (en el DEM suavizado
   fabrica pendientes enormes en 2–3 celdas del borde; en log v lo tira hacia v = 1 m/s). Acá se corrige (ver handoff). */
export function box3(A, nx, ny) {
  const T = new Float64Array(nx * ny), out = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const r = j * nx;
    for (let i = 0; i < nx; i++) {
      let s = A[r + i], c = 1;
      if (i > 0) { s += A[r + i - 1]; c++; }
      if (i < nx - 1) { s += A[r + i + 1]; c++; }
      T[r + i] = s / c;   // media horizontal
    }
  }
  for (let j = 0; j < ny; j++) {
    const r = j * nx;
    for (let i = 0; i < nx; i++) {
      let s = T[r + i], c = 1;
      if (j > 0) { s += T[r - nx + i]; c++; }
      if (j < ny - 1) { s += T[r + nx + i]; c++; }
      out[r + i] = s / c;   // media de medias = media 3×3 (las filas tienen el mismo conteo horizontal)
    }
  }
  return out;
}
export function boxN(A, nx, ny, pasadas) {
  let X = A;
  for (let p = 0; p < pasadas; p++) X = box3(X, nx, ny);
  return X;
}

/* Pesos MFD sobre F: para cada una de las 8 vecinas más bajas w = (caída / (dist·cell))^p · L, normalizados a suma 1.
   W es Float64Array(8·n) con W[8·id + k] (k según NB_*). Celdas sin vecina más baja: toda su fila en 0 (salida de la grilla). */
export function mfdWeights(F, nx, ny, cell, P) {
  const n = nx * ny, W = new Float64Array(8 * n);
  const clen = NB_DI.map((di, k) => (di !== 0 && NB_DJ[k] !== 0 ? P.contorno.diagonal : P.contorno.cardinal));
  const p = P.mfdP;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const id = j * nx + i, f = F[id];
      let tot = 0;
      for (let k = 0; k < 8; k++) {
        const a = i + NB_DI[k], b = j + NB_DJ[k];
        if (a < 0 || a >= nx || b < 0 || b >= ny) continue;
        const drop = f - F[b * nx + a];
        if (drop > 0) { const w = Math.pow(drop / (NB_DIST[k] * cell), p) * clen[k]; W[8 * id + k] = w; tot += w; }
      }
      if (tot > 0) for (let k = 0; k < 8; k++) W[8 * id + k] /= tot;
    }
  }
  return W;
}

/* Dirección media del flujo (para el flowmap y las partículas): Σ w_k·(dx_k, dy_k)/dist_k, suavizada y normalizada.
   Devuelve Float32Array dirX (este +) y dirY (sur +): coinciden con X y Z de la escena. */
export function meanDirection(W, nx, ny, P) {
  const n = nx * ny, U = new Float64Array(n), V = new Float64Array(n);
  for (let id = 0; id < n; id++) {
    let u = 0, v = 0;
    for (let k = 0; k < 8; k++) { const w = W[8 * id + k]; if (w > 0) { u += w * NB_DI[k] / NB_DIST[k]; v += w * NB_DJ[k] / NB_DIST[k]; } }
    U[id] = u; V[id] = v;
  }
  const Us = boxN(U, nx, ny, P.pasadasDir), Vs = boxN(V, nx, ny, P.pasadasDir);
  const dirX = new Float32Array(n), dirY = new Float32Array(n);
  for (let id = 0; id < n; id++) {
    const m = Math.hypot(Us[id], Vs[id]) + P.eps.dir;
    dirX[id] = Us[id] / m; dirY[id] = Vs[id] / m;
  }
  return { dirX, dirY };
}

/* Pendiente local: gradiente por diferencias centrales del DEM SUAVIZADO (no de F), con piso sMin.
   El anillo exterior de la grilla (sin las dos vecinas) queda en sMin, como en la referencia. */
export function localSlope(H, nx, ny, cell, P) {
  const Hs = boxN(H, nx, ny, P.pasadasPendiente), S = new Float64Array(nx * ny).fill(P.sMin);
  const d = 2 * cell;
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const id = j * nx + i;
      const g = Math.hypot((Hs[id + 1] - Hs[id - 1]) / d, (Hs[id + nx] - Hs[id - nx]) / d);
      S[id] = g > P.sMin ? g : P.sMin;
    }
  }
  return S;
}
