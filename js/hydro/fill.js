/* hydro/fill.js · relleno de depresiones: Priority-Flood con épsilon (Barnes 2014). Puro. MODELO §2.1.
   Se siembran los bordes en una cola de prioridad; cada vecino sin visitar toma max(H_vecino, h_actual + ε).
   La cola es un montículo binario propio con desempate por índice de celda (= (fila, columna) lexicográfico, igual que las
   tuplas (F, j, i) de heapq en la referencia), así que el resultado es idéntico celda a celda. */

class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.id = new Int32Array(cap); this.n = 0; this.topK = 0; this.topId = 0; }
  less(ka, ia, kb, ib) { return ka < kb || (ka === kb && ia < ib); }
  push(key, id) {
    const K = this.k, I = this.id;
    let c = this.n++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.less(key, id, K[p], I[p])) break;
      K[c] = K[p]; I[c] = I[p]; c = p;
    }
    K[c] = key; I[c] = id;
  }
  pop() {
    const K = this.k, I = this.id;
    this.topK = K[0]; this.topId = I[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], id = I[n];
      let c = 0;
      for (;;) {
        let l = 2 * c + 1;
        if (l >= n) break;
        const r = l + 1;
        if (r < n && this.less(K[r], I[r], K[l], I[l])) l = r;
        if (!this.less(K[l], I[l], key, id)) break;
        K[c] = K[l]; I[c] = I[l]; c = l;
      }
      K[c] = key; I[c] = id;
    }
  }
}

const DI = [-1, 0, 1, -1, 1, -1, 0, 1], DJ = [-1, -1, -1, 0, 0, 1, 1, 1];

/* H: Float64Array nx·ny. Devuelve { F, order }: F = DEM drenable; order = celdas en el orden en que salieron de la cola, que es
   no decreciente en F (cada celda nueva entra con F > la que la descubrió), o sea que recorrido al revés es "de mayor a menor F"
   sin tener que ordenar (la acumulación lo usa). */
export function priorityFlood(H, nx, ny, eps) {
  const n = nx * ny;
  const F = Float64Array.from(H), done = new Uint8Array(n), order = new Int32Array(n);
  const heap = new Heap(n);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (i === 0 || i === nx - 1 || j === 0 || j === ny - 1) { const id = j * nx + i; heap.push(F[id], id); done[id] = 1; }
    }
  }
  let t = 0;
  while (heap.n > 0) {
    heap.pop();
    const id = heap.topId, h = heap.topK;
    order[t++] = id;
    const i = id % nx, j = (id - i) / nx;
    for (let d = 0; d < 8; d++) {
      const a = i + DI[d], b = j + DJ[d];
      if (a < 0 || a >= nx || b < 0 || b >= ny) continue;
      const nid = b * nx + a;
      if (done[nid]) continue;
      done[nid] = 1;
      const lim = h + eps;
      if (F[nid] < lim) F[nid] = lim;
      heap.push(F[nid], nid);
    }
  }
  return { F, order };
}
