/* hydro/params.js · los diales de HIDRO que necesita el cálculo, en un objeto plano clonable (postMessage).
   Es el único módulo de hydro/ (además de state.js) que importa config.js: el worker y los módulos puros reciben esto por parámetro. */
import { HIDRO } from "../core/config.js?v=20261201";

export function paramsMotor() {
  const H = HIDRO;
  return structuredClone({
    zoom: H.zoom, metrosPorPx0: H.metrosPorPx0, margenCuencaM: H.margenCuencaM, pCn: H.pCn, epsFill: H.epsFill, mfdP: H.mfdP,
    contorno: H.contorno, sMin: H.sMin, pasadasDir: H.pasadasDir, pasadasPendiente: H.pasadasPendiente, eps: H.eps,
    claseFuera: H.claseFuera, clases: H.clases, stats: H.stats
  });
}
