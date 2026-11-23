/* hydro/grid.js · parte PURA de la grilla del simulador (sin Three, sin DOM, sin MapLibre: corre en el worker y en Node).
   La carga del DEM (red) vive en load.js. Especificación: docs/hidro/MODELO.md §1.

   Convención (igual que la referencia Python y que terrain.hf): la celda (i, j) es el píxel global (gx0 + i, gy0 + j) del DEM
   terrarium a zoom z. El valor del DEM está en la ESQUINA superior izquierda del píxel (convención de MapLibre, ver
   heightfield.js `pixelCenter:false`), pero la clase (polígono) se evalúa en el CENTRO (+0,5): es lo que hace la referencia
   y queda una diferencia de medio píxel (~7 m) que está por debajo de la resolución real del SRTM (30 m). */

const TS = 256;
const D2R = Math.PI / 180;

/* lon/lat → píxel global flotante (misma fórmula que heightfield.js lonLatToPixel) */
export function lonLatToPx(lon, lat, z) {
  const n = TS * Math.pow(2, z);
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
  return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
export function pxToLonLat(x, y, z) {
  const n = TS * Math.pow(2, z);
  return [x / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / D2R];
}

/* Metadatos de la grilla para el bbox del campo [oeste, sur, este, norte] + margen de cuenca.
   Alineada a píxeles z exactamente como la referencia: gx0 = floor(x0), nx = ceil(x1) − gx0. */
export function gridMeta(bboxCampo, P) {
  const [w, s, e, n] = bboxCampo;
  const z = P.zoom, margen = P.margenCuencaM;
  const latc = (s + n) / 2;
  const dlat = margen / 110574, dlon = margen / (111320 * Math.cos(latc * D2R));
  const [x0, y0] = lonLatToPx(w - dlon, n + dlat, z);
  const [x1, y1] = lonLatToPx(e + dlon, s - dlat, z);
  const gx0 = Math.floor(x0), gy0 = Math.floor(y0);
  const nx = Math.ceil(x1) - gx0, ny = Math.ceil(y1) - gy0;
  const cell = P.metrosPorPx0 / Math.pow(2, z) * Math.cos(latc * D2R);
  return {
    z, gx0, gy0, nx, ny, cell, area: cell * cell, latc,
    bboxCampo: [w, s, e, n],
    bboxMargen: [w - dlon, s - dlat, e + dlon, n + dlat],   // lo que hay que pedirle a loadHeightfield
    margenM: margen
  };
}

/* Recorta de un mosaico de DEM (fila mayor, origen px0/py0 en píxeles globales) la ventana de la grilla.
   null si el mosaico no la cubre entera (entonces hay que cargar uno propio). */
export function cropDem(data, w, h, px0, py0, meta) {
  const ox = meta.gx0 - px0, oy = meta.gy0 - py0;
  if (ox < 0 || oy < 0 || ox + meta.nx > w || oy + meta.ny > h) return null;
  const out = new Float32Array(meta.nx * meta.ny);
  for (let j = 0; j < meta.ny; j++) out.set(data.subarray((oy + j) * w + ox, (oy + j) * w + ox + meta.nx), j * meta.nx);
  return out;
}

/* Mediana 3×3 con borde replicado (np.pad "edge" de la referencia): mata picos aislados del SRTM. Devuelve Float64Array. */
export function medianFilter(raw, nx, ny) {
  const H = new Float64Array(nx * ny), b = new Float64Array(9);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let c = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj < 0 ? 0 : j + dj >= ny ? ny - 1 : j + dj;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di < 0 ? 0 : i + di >= nx ? nx - 1 : i + di;
          const v = raw[jj * nx + ii];
          // inserción ordenada (9 elementos)
          let p = c++;
          while (p > 0 && b[p - 1] > v) { b[p] = b[p - 1]; p--; }
          b[p] = v;
        }
      }
      H[j * nx + i] = b[4];
    }
  }
  return H;
}

/* Longitud y latitud de los CENTROS de celda (la lon solo depende de la columna y la lat solo de la fila). */
export function cellCenters(meta) {
  const lon = new Float64Array(meta.nx), lat = new Float64Array(meta.ny);
  for (let i = 0; i < meta.nx; i++) lon[i] = pxToLonLat(meta.gx0 + i + 0.5, meta.gy0, meta.z)[0];
  for (let j = 0; j < meta.ny; j++) lat[j] = pxToLonLat(meta.gx0, meta.gy0 + j + 0.5, meta.z)[1];
  return { lon, lat };
}

/* Afín escena → celda para el render (misma forma que reliefU.uA6P de terrain.js):
     ci = x·a + b ;  cj = z·c + d      (x este, z sur, en metros de escena; ci, cj en celdas, con el valor en la esquina)
   originX/originY = MercatorCoordinate del centro de escena y scale = meterInMercatorCoordinateUnits (host.js). */
export function sceneToCell(meta, originX, originY, scale) {
  const K = TS * Math.pow(2, meta.z);
  return [scale * K, originX * K - meta.gx0, scale * K, originY * K - meta.gy0];
}
