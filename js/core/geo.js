/* ---------- Utilidades geométricas ---------- */
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt, polygon) {
  if (!pointInRing(pt, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(pt, polygon[i])) return false;
  return true;
}

export function ringAreaHa(ring, latRef) {
  const kx = 111320 * Math.cos((latRef * Math.PI) / 180), ky = 110574;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  }
  return Math.abs(a / 2) / 10000;
}

export function featureCentroid(feature) {
  let best = null, bestArea = -1;
  for (const poly of feature.geometry.coordinates) {
    const a = ringAreaHa(poly[0], poly[0][0][1]);
    if (a > bestArea) { bestArea = a; best = poly[0]; }
  }
  let sx = 0, sy = 0;
  for (const [x, y] of best) { sx += x; sy += y; }
  return [sx / best.length, sy / best.length];
}

export function blobRing(lon, lat, rMeters, rng, verts = 7, jitter = 0.5) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  const ring = [];
  const rot = rng() * Math.PI * 2;
  for (let i = 0; i < verts; i++) {
    const ang = rot + (i * Math.PI * 2) / verts;
    const r = rMeters * (1 - jitter / 2 + rng() * jitter);
    ring.push([lon + (Math.cos(ang) * r) / kx, lat + (Math.sin(ang) * r) / ky]);
  }
  ring.push(ring[0]);
  return [ring];
}

export function offsetRing(polygon, dxM, dyM, lat) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  return [polygon[0].map(([x, y]) => [x + dxM / kx, y + dyM / ky])];
}

/* Scatter determinístico dentro de los polígonos de ciertas clases */
export function scatterInClasses(fc, classes, seed, densityPerHa, maxTotal, minPerPoly) {
  const rng = mulberry32(seed);
  const polys = [];
  for (const f of fc.features) {
    if (!classes.includes(f.properties._cls)) continue;
    for (const poly of f.geometry.coordinates) {
      const bbox = ringBBox(poly[0]);
      const ha = ringAreaHa(poly[0], (bbox[1] + bbox[3]) / 2);
      if (ha > 0.003) polys.push({ polygon: poly, bbox, ha });
    }
  }
  const totalHa = polys.reduce((s, p) => s + p.ha, 0);
  const density = Math.min(densityPerHa, maxTotal / Math.max(totalHa, 0.001));
  const points = [];
  for (const wp of polys) {
    const n = Math.max(minPerPoly, Math.round(wp.ha * density));
    const [minX, minY, maxX, maxY] = wp.bbox;
    let placed = 0, attempts = 0;
    while (placed < n && attempts < n * 60) {
      attempts++;
      const pt = [minX + rng() * (maxX - minX), minY + rng() * (maxY - minY)];
      if (!pointInPolygon(pt, wp.polygon)) continue;
      placed++;
      points.push(pt);
    }
  }
  return { points, rng };
}

/* Todo el pipeline (superficies, centroides, dispersión de vegetación, ejes de
   corredor) asume MultiPolygon. Varios campos vienen con Polygon suelto y con
   features sin geometría (registros de tabla sin dibujo), así que normalizamos
   en memoria: los archivos GIS quedan tal cual los entregó el equipo. */
export function normalizeGeometry(fc) {
  fc.features = fc.features.filter(f =>
    f.geometry && f.geometry.coordinates && f.geometry.coordinates.length);
  for (const f of fc.features) {
    if (f.geometry.type === "Polygon") {
      f.geometry = { type: "MultiPolygon", coordinates: [f.geometry.coordinates] };
    }
  }
  return fc;
}
