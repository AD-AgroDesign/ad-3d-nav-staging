/* hydro/load.js · carga del DEM de la grilla (la parte con red; el cálculo es puro y vive en grid.js / engine.js).
   Usa terrain.hf si ya cubre bbox + margen de cuenca; si no (lo normal: terrain.hf solo trae ~0,01° de margen), baja un
   Heightfield propio a z13 con la misma URL que el visor. Corre en el hilo principal (red + PNG; el cálculo va al worker). */
import { loadHeightfield } from "../terrain/heightfield.js?v=20261201";
import { gridMeta, cropDem } from "./grid.js?v=20261201";

/* bboxCampo = [oeste, sur, este, norte] (del escenario inicial). hf = terrain.hf o null. P = parámetros HIDRO. demUrl = A6_TERRAIN.demUrl.
   Devuelve { meta, raw: Float32Array nx·ny, fuente: "terrain.hf" | "propio", msDem } o lanza si no se pudo bajar el DEM. */
export async function cargarEntradaGrilla(bboxCampo, hf, P, demUrl) {
  const meta = gridMeta(bboxCampo, P);
  const t0 = performance.now();
  if (hf && hf.z === P.zoom && !hf.pixelCenter) {
    const raw = cropDem(hf.data, hf.w, hf.h, hf.px0, hf.py0, meta);
    if (raw) return { meta, raw, fuente: "terrain.hf", msDem: 0 };
  }
  const propio = await loadHeightfield(meta.bboxMargen, { z: P.zoom, url: demUrl });
  const raw = cropDem(propio.data, propio.w, propio.h, propio.px0, propio.py0, meta);
  if (!raw) throw new Error("hydro: el DEM cargado no cubre la grilla");
  return { meta, raw, fuente: "propio", msDem: performance.now() - t0 };
}
