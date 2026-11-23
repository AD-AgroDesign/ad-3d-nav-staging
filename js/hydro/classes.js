/* hydro/classes.js · rasterizado de la clase (`_cls`) por celda y escenario → CN y n. Puro. MODELO §2.5 y §3.
   Se evalúa el CENTRO de cada celda. Para no probar celda por celda contra cada polígono se rasteriza por filas (scanline,
   even-odd con los huecos como anillos del mismo polígono): es la misma regla que `pointInPolygon` de core/geo.js
   (un cruce cuenta si x < xint con el criterio (yi > y) !== (yj > y)), así que da lo mismo, pero cuesta O(aristas + celdas).
   Los polígonos van en orden y el último gana (como la referencia); lo que no cae en ninguno es `claseFuera`. */

/* Tablas por clase. Devuelve { nombres, id (nombre→índice), cn, n, C } con arrays paralelos. */
export function tablaClases(P) {
  const nombres = Object.keys(P.clases);
  const id = Object.create(null);
  nombres.forEach((k, i) => { id[k] = i; });
  const cn = Float64Array.from(nombres, k => P.clases[k].cn);
  const n = Float64Array.from(nombres, k => P.clases[k].n);
  const C = Float64Array.from(cn, c => coefEscurrimiento(c, P.pCn));
  return { nombres, id, cn, n, C };
}

/* SCS-CN: S = 25400/CN − 254 ; Ia = 0,2·S ; Q = (P − Ia)² / (P + 0,8·S) si P > Ia, si no 0. En mm. */
export function lamina(cn, Pmm) {
  const S = 25400 / cn - 254, Ia = 0.2 * S;
  return Pmm > Ia ? (Pmm - Ia) * (Pmm - Ia) / (Pmm + 0.8 * S) : 0;
}
/* Coeficiente de escurrimiento C = Q_cn(P)/P */
export function coefEscurrimiento(cn, Pmm) { return lamina(cn, Pmm) / Pmm; }

/* Rasteriza una lista de features [{ cls, type: "Polygon"|"MultiPolygon", coordinates }] sobre la grilla.
   `centros` = cellCenters(meta). Devuelve { cls: Uint8Array (índice en tabla.nombres), cubierto: Uint8Array (1 = cae en algún polígono) }. */
export function rasterizarClases(features, centros, tabla, P) {
  const { lon, lat } = centros, nx = lon.length, ny = lat.length;
  const cls = new Uint8Array(nx * ny).fill(tabla.id[P.claseFuera]);
  const cubierto = new Uint8Array(nx * ny);
  let cruces = new Float64Array(64);
  for (const f of features) {
    const idc = tabla.id[f.cls] ?? tabla.id["otros"] ?? tabla.id[P.claseFuera];
    const polys = f.type === "Polygon" ? [f.coordinates] : f.coordinates;
    for (const poly of polys) {
      // filas que toca el polígono (lat decrece con j) y aristas totales
      let minY = Infinity, maxY = -Infinity, ne = 0;
      for (const ring of poly) { ne += ring.length; for (const p of ring) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; } }
      if (ne < 3) continue;
      if (cruces.length < ne) cruces = new Float64Array(ne);
      let j0 = lowerBoundDesc(lat, maxY), j1 = lowerBoundDesc(lat, minY);   // primera fila con lat <= maxY, primera con lat < minY
      for (let j = j0; j < j1; j++) {
        const y = lat[j];
        let m = 0;
        for (const ring of poly) {
          for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
            const yi = ring[a][1], yj = ring[b][1];
            if ((yi > y) !== (yj > y)) cruces[m++] = (ring[b][0] - ring[a][0]) * (y - yi) / (yj - yi) + ring[a][0];
          }
        }
        if (m < 2) continue;
        const cs = cruces.subarray(0, m).sort();
        for (let q = 0; q + 1 < m; q += 2) {
          // adentro para lon en [cs[q], cs[q+1]) (x < xint cuenta el cruce): primera columna con lon >= c
          const i0 = lowerBoundAsc(lon, cs[q]), i1 = lowerBoundAsc(lon, cs[q + 1]);
          const r = j * nx;
          for (let i = i0; i < i1; i++) { cls[r + i] = idc; cubierto[r + i] = 1; }
        }
      }
    }
  }
  return { cls, cubierto };
}

/* primer índice con a[i] >= x (a creciente) */
function lowerBoundAsc(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
/* primer índice con a[i] <= x (a decreciente) */
function lowerBoundDesc(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] > x) lo = m + 1; else hi = m; } return lo; }
