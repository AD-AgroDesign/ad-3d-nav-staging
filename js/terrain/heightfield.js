/* heightfield.js · A6 · Terreno (spike A6-1, pensado para pasar a app/js/terrain/ en la Ola 2)
 *
 * DEM terrarium (AWS) -> grilla de alturas del campo -> heightAt(lon,lat) bilineal + reliefStats().
 *
 * - Sin dependencias (ni Three ni MapLibre). Módulo ES.
 * - Terrarium: h = R*256 + G + B/256 - 32768 (metros sobre el nivel del mar, EGM96 aprox.).
 * - Fuente: Mapzen/Tilezen "Terrain Tiles" en el bucket público elevation-tiles-prod de AWS.
 *   Mezcla SRTM (1 arcseg, ~30 m), GMTED, ETOPO1. En esta zona (Argentina) sale de SRTM.
 *   Atribución exigida: ver ATTRIBUTION.
 *
 * Convención de píxel: el valor del píxel (i,j) se interpreta ubicado en (i+0.5, j+0.5) cuando
 * `pixelCenter` es true (centro del píxel) o en (i, j) cuando es false (DEFAULT: esquina superior izquierda,
 * que es lo que usa MapLibre en DEMData.getElevationAt). El spike midió cuál coincide con la malla.
 */

export const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const ATTRIBUTION =
  "Terrain Tiles: Mapzen/Tilezen sobre AWS Open Data. SRTM (NASA/USGS), GMTED2010 (USGS), ETOPO1 (NOAA). " +
  "https://github.com/tilezen/joerd/blob/master/docs/attribution.md";

const TS = 256;                     // tamaño de tile terrarium
const D2R = Math.PI / 180;

/* lon/lat -> píxel global (flotante) a zoom z, tiles de 256 px, Web Mercator */
export function lonLatToPixel(lon, lat, z) {
  const n = TS * Math.pow(2, z);
  const x = (lon + 180) / 360 * n;
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}

/* Decodificador PNG propio (8 bits, RGB / RGBA / paleta, sin entrelazado) con DecompressionStream.
   POR QUÉ (2026-11-17): Brave (y Firefox con resistFingerprinting) alteran a propósito lo que devuelve getImageData ("farbling") para
   evitar la huella digital del canvas. En terrarium un ±1 en el canal R son ±256 m: aparecían agujas de cientos de metros en el suelo,
   el agua y el pasto (las "torres"). Leyendo los bytes del PNG directamente no hay canvas de por medio. Devuelve null si el PNG no es de
   un tipo soportado (entonces se usa el canvas, como antes). */
async function decodePngRGB(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  if (typeof DecompressionStream === "undefined" || b.length < 33 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0, pal = null;
  const idat = [];
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), d0 = p + 8;
    if (type === "IHDR") { w = dv.getUint32(d0); h = dv.getUint32(d0 + 4); depth = b[d0 + 8]; ctype = b[d0 + 9]; inter = b[d0 + 12]; }
    else if (type === "PLTE") pal = b.subarray(d0, d0 + len);
    else if (type === "IDAT") idat.push(b.subarray(d0, d0 + len));
    else if (type === "IEND") break;
    p = d0 + len + 4;
  }
  const bpp = ctype === 2 ? 3 : ctype === 6 ? 4 : ctype === 3 ? 1 : 0;
  if (!bpp || depth !== 8 || inter !== 0 || w !== TS || h !== TS || (ctype === 3 && !pal) || !idat.length) return null;
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) return null;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, o = y * stride, up = o - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x], a = x >= bpp ? px[o + x - bpp] : 0, u = y ? px[up + x] : 0, c = (x >= bpp && y) ? px[up + x - bpp] : 0;
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + u;
      else if (f === 3) r = v + ((a + u) >> 1);
      else if (f === 4) { const q = a + u - c, pa = Math.abs(q - a), pb = Math.abs(q - u), pc = Math.abs(q - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c); }
      else return null;
      px[o + x] = r & 255;
    }
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    let R, G, B;
    if (ctype === 3) { const k = px[i] * 3; R = pal[k]; G = pal[k + 1]; B = pal[k + 2]; }
    else { const k = i * bpp; R = px[k]; G = px[k + 1]; B = px[k + 2]; }
    out[i] = R * 256 + G + B / 256 - 32768;
  }
  return out;
}

async function decodeTile(url) {
  // timeout: un tile colgado no debe frenar el arranque del visor (initTerrain cae a "sin terreno" si algo falla)
  const res = await fetch(url, { mode: "cors", signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error("terrarium " + res.status + " " + url);
  const blob = await res.blob();
  try { const direct = await decodePngRGB(await blob.arrayBuffer()); if (direct) return direct; }
  catch (e) { console.warn("terrarium: decodificación directa falló, uso canvas:", e.message || e); }
  // sin conversión de color ni premultiplicado: los canales son datos, no color
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const cv = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(TS, TS)
    : Object.assign(document.createElement("canvas"), { width: TS, height: TS });
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, TS, TS).data;
  const out = new Float32Array(TS * TS);
  for (let i = 0, k = 0; i < out.length; i++, k += 4) out[i] = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
  return out;
}

export class Heightfield {
  constructor(o) { Object.assign(this, o); }

  /* altura (m) en lon/lat, interpolación bilineal; fuera de la grilla cargada se clampa al borde */
  heightAt(lon, lat) {
    const p = lonLatToPixel(lon, lat, this.z);
    const off = this.pixelCenter ? 0.5 : 0;
    let fx = p.x - this.px0 - off, fy = p.y - this.py0 - off;
    fx = Math.min(Math.max(fx, 0), this.w - 1.0001);
    fy = Math.min(Math.max(fy, 0), this.h - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    const g = this.data, w = this.w, k = j * w + i;
    const a = g[k], b = g[k + 1], c = g[k + w], d = g[k + w + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /* Estadísticos de relieve sobre el bbox (o sobre los puntos que acepte `mask(lon,lat)`).
   *
   * El DEM (SRTM) tiene ruido vertical de varios metros en llanura (copas de árboles, edificios,
   * picos aislados de +10 m): sin filtrar, una pampa plana da "pendiente p95 = 8%". Por eso:
   *   1. se muestrea cada `stepM` m (30 = resolución nativa de SRTM);
   *   2. `despeckle` (default true): mediana 3x3 sobre esa grilla, mata los picos aislados;
   *   3. la pendiente es la diferencia central sobre una línea de base de `baselineM` m
   *      (default 120): mide el relieve del terreno, no el ruido de píxel a píxel.
   * Devuelve metros y % (pendiente = tan(ángulo)*100). Con despeckle=false y baselineM=stepM
   * se obtiene la versión "cruda" (útil solo para ver cuánto ruido hay). */
  reliefStats({ stepM = 30, mask = null, despeckle = true, baselineM = 120 } = {}) {
    const [w, s, e, n] = this.bbox;
    const latC = (s + n) / 2;
    const dLat = stepM / 110574, dLon = stepM / (111320 * Math.cos(latC * D2R));
    const nx = Math.max(5, Math.floor((e - w) / dLon)), ny = Math.max(5, Math.floor((n - s) / dLat));
    let H = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) H[j * nx + i] = this.heightAt(w + i * dLon, n - j * dLat);
    if (despeckle) {
      const M = new Float32Array(H), buf = new Float32Array(9);
      for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        let c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) buf[c++] = H[(j + dj) * nx + i + di];
        buf.sort(); M[j * nx + i] = buf[4];
      }
      H = M;
    }
    const kb = Math.max(1, Math.round(baselineM / stepM));
    const hs = [], sl = [], pts = [];
    for (let j = kb; j < ny - kb; j++) for (let i = kb; i < nx - kb; i++) {
      if (mask && !mask(w + i * dLon, n - j * dLat)) continue;
      const k = j * nx + i;
      hs.push(H[k]); pts.push(i, j);
      const gx = (H[k + kb] - H[k - kb]) / (2 * kb * stepM), gy = (H[k + kb * nx] - H[k - kb * nx]) / (2 * kb * stepM);
      sl.push(Math.hypot(gx, gy) * 100);
    }
    const N = hs.length;
    if (!N) return { n: 0, rango: 0, desvio: 0, pendienteP95: 0 };
    const q = (arr, p) => { const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))]; };
    let sum = 0; for (const v of hs) sum += v;
    const mean = sum / N;
    let v2 = 0; for (const v of hs) v2 += (v - mean) * (v - mean);
    const min = q(hs, 0), max = q(hs, 1);
    // Residuo respecto del mejor plano (inclinación regional): lo que queda es el relieve local.
    // Mínimos cuadrados 3x3 sobre (i, j, 1), centrado.
    let mi = 0, mj = 0; for (let t = 0; t < N; t++) { mi += pts[2 * t]; mj += pts[2 * t + 1]; } mi /= N; mj /= N;
    let sii = 0, sjj = 0, sij = 0, sih = 0, sjh = 0;
    for (let t = 0; t < N; t++) { const a = pts[2 * t] - mi, b = pts[2 * t + 1] - mj, c = hs[t] - mean; sii += a * a; sjj += b * b; sij += a * b; sih += a * c; sjh += b * c; }
    const det = sii * sjj - sij * sij || 1, ca = (sih * sjj - sjh * sij) / det, cb = (sjh * sii - sih * sij) / det;
    const res = hs.map((v, t) => v - mean - ca * (pts[2 * t] - mi) - cb * (pts[2 * t + 1] - mj));
    let r2 = 0; for (const v of res) r2 += v * v;
    let sm = 0; for (const v of sl) sm += v;
    return {
      n: N, stepM, baselineM, despeckle,
      min, max, media: mean,
      rango: max - min,                       // máximo - mínimo (de la grilla filtrada)
      rangoP2P98: q(hs, 0.98) - q(hs, 0.02),  // robusto a picos/hoyos aislados
      desvio: Math.sqrt(v2 / N),
      inclinacionRegionalPct: Math.hypot(ca, cb) / stepM * 100,   // pendiente del plano de mejor ajuste
      desvioResidual: Math.sqrt(r2 / N),                          // desvío tras restar ese plano
      rangoResidualP2P98: q(res, 0.98) - q(res, 0.02),
      pendienteMedia: sm / N,
      pendienteP95: q(sl, 0.95),
      pendienteMax: q(sl, 1)
    };
  }
}

/* Carga los tiles que cubren bbox=[oeste,sur,este,norte] a zoom z y arma el mosaico.
 * opts: { z=13 (recomendado: ver handoff A6-1; z14 pesa 4x más y no aporta información), url=TERRARIUM_URL, pixelCenter=false } */
export async function loadHeightfield(bbox, opts = {}) {
  const z = opts.z ?? 13, url = opts.url ?? TERRARIUM_URL;
  const pixelCenter = opts.pixelCenter ?? false;   // medido: la esquina (false) coincide con MapLibre al 100%
  const [w, s, e, n] = bbox;
  const a = lonLatToPixel(w, n, z), b = lonLatToPixel(e, s, z);
  const x0 = Math.floor((a.x - 2) / TS), x1 = Math.floor((b.x + 2) / TS);
  const y0 = Math.floor((a.y - 2) / TS), y1 = Math.floor((b.y + 2) / TS);
  const tw = x1 - x0 + 1, th = y1 - y0 + 1;
  const W = tw * TS, Hh = th * TS;
  const data = new Float32Array(W * Hh);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    jobs.push(decodeTile(url.replace("{z}", z).replace("{x}", tx).replace("{y}", ty)).then(t => {
      const ox = (tx - x0) * TS, oy = (ty - y0) * TS;
      for (let r = 0; r < TS; r++) data.set(t.subarray(r * TS, (r + 1) * TS), (oy + r) * W + ox);
    }));
  }
  await Promise.all(jobs);
  return new Heightfield({ bbox, z, pixelCenter, data, w: W, h: Hh, px0: x0 * TS, py0: y0 * TS, tiles: tw * th });
}
