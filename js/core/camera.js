/* ============ Cámara real de MapLibre en metros de escena (trampa T1) ============
   La capa custom de Three usa una cámara "falsa" (toda la matriz de MapLibre va en
   camera.projectionMatrix), así que Three no sabe dónde está la cámara. Este módulo
   la calcula cada frame con API de MapLibre y la publica para la niebla, el fresnel
   del agua, el LOD y los billboards.

   OJO (hallazgo de A1): map.getFreeCameraOptions() NO existe en MapLibre 4.7.1.
   (a) map.transform.getCameraPosition() → { lngLat, altitude (m) } (API interna de 4.7.1;
       la versión está vendorizada y fija);
   (b) fallback con solo API pública: centro, zoom, pitch, bearing y alto del canvas
       (fov fijo 0,6435 rad). Coinciden a < 0,11 m (medido por A1 en 52 tomas).
   Escena en metros: X = este, Y = arriba, Z = sur, origen = centro del campo. */
import * as THREE from "three";

const FOV = 0.6435011087932844;                     // transform._fov por defecto de MapLibre 4.7.1
const info = {};                                    // último resultado (objeto reutilizado)
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();   // A6: matriz mercator→clip con la elevación del terreno restada
const _v = new THREE.Vector4();

/* Posición de la cámara en coordenadas Mercator { x, y, z } (z = altitud en unidades mercator). */
export function cameraMerc(map) {
  const t = map.transform;
  if (t && typeof t.getCameraPosition === "function") {
    const cp = t.getCameraPosition();
    const m = maplibregl.MercatorCoordinate.fromLngLat(cp.lngLat, cp.altitude);
    return { x: m.x, y: m.y, z: m.z };
  }
  return cameraMercPublic(map);
}

/* Fallback con API pública (exportado para poder verificar que coincide con la (a)). */
export function cameraMercPublic(map) {
  const c = map.getCenter(), z = map.getZoom();
  const pitch = map.getPitch() * Math.PI / 180, brg = map.getBearing() * Math.PI / 180;
  const H = map.getCanvas().clientHeight;
  const ctd = 0.5 / Math.tan(FOV / 2) * H;           // px, cameraToCenterDistance
  const cm = maplibregl.MercatorCoordinate.fromLngLat(c, 0);
  const dMerc = ctd / (512 * Math.pow(2, z));        // distancia centro-cámara en unidades mercator
  const h = Math.sin(pitch) * dMerc;                 // distancia horizontal centro-cámara
  return { x: cm.x - Math.sin(brg) * h, y: cm.y + Math.cos(brg) * h, z: Math.cos(pitch) * dMerc };
}

/* Calcula y devuelve (objeto compartido, se pisa en cada llamada):
     camPosScene     [x, y, z] en metros de escena (lo que va a uCamPos)
     altitudeM       altura de la cámara sobre el suelo (m). A6: con terreno es la altura sobre el suelo del centro de la
                     vista (altitud absoluta − map.transform.elevation); sin terreno es la altitud de siempre
     elevM           A6: map.transform.elevation (m, ya con la exageración); 0 sin terreno. camPosScene[1] es ABSOLUTA
                     (la Y de escena es la altura sobre el nivel del mar × exageración, ver host.sceneMatrix)
     ctdPx / ctdM    distancia cámara-objetivo (cameraToCenterDistance) en px y en metros
     pxPerMeter      píxeles por metro en el centro de pantalla
     horizonPx       px sobre el centro de pantalla donde MapLibre pone la línea del sky
     rays            { d0, dx, dy } rayos del plano lejano en metros relativos a la cámara
                     (este, norte, arriba): dir(ndcX, ndcY) = d0 + ndcX·dx + ndcY·dy (afín en NDC);
                     solo si se pasa `matrix` (la matriz mercator→clip de la capa custom)
     invViewProj     THREE.Matrix4 inversa de `matrix` (solo con `matrix`)
   `origin` y `scale`: origen de la escena (MercatorCoordinate) y metros→mercator del host. */
export function updateCamera(map, origin, scale, matrix) {
  const cam = cameraMerc(map);
  info.camMerc = cam;
  info.camPosScene = [(cam.x - origin.x) / scale, cam.z / scale, (cam.y - origin.y) / scale];
  /* A6: con terreno, MapLibre pone la cámara a (altura sobre el centro) + elevación del centro; la Y de escena
     es absoluta, así que la altura sobre el suelo se obtiene restando esa elevación (0 sin terreno). */
  const E = (map.transform && map.transform.elevation) || 0;
  info.elevM = E;
  info.altitudeM = cam.z / scale - E;

  const H = map.getCanvas().clientHeight;
  const t = map.transform;
  info.ctdPx = (t && t.cameraToCenterDistance) || 0.5 / Math.tan(FOV / 2) * H;
  const mercPerM = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter(), 0).meterInMercatorCoordinateUnits();
  info.pxPerMeter = 512 * Math.pow(2, map.getZoom()) * mercPerM;
  info.ctdM = info.ctdPx / info.pxPerMeter;
  info.horizonPx = Math.tan(Math.PI / 2 - map.getPitch() * Math.PI / 180) * info.ctdPx * 0.85;

  if (matrix) {
    /* A6: los rayos se calculan en el mismo marco que camPosScene (alturas absolutas): la matriz de la capa
       custom no trae la traslación −elevación (ver host.sceneMatrix), se la agrega acá. Sin terreno E = 0. */
    _m.fromArray(matrix);
    if (E) _m.multiply(_inv.makeTranslation(0, 0, -E * scale));
    _inv.copy(_m).invert();
    info.invViewProj = _inv;
    const dirOf = (x, y) => {
      _v.set(x, y, 1, 1).applyMatrix4(_inv);
      return [(_v.x / _v.w - cam.x) / scale, -(_v.y / _v.w - cam.y) / scale, (_v.z / _v.w - cam.z) / scale];
    };
    const d0 = dirOf(0, 0), a = dirOf(1, 0), b = dirOf(0, 1);
    info.rays = { d0, dx: [a[0] - d0[0], a[1] - d0[1], a[2] - d0[2]], dy: [b[0] - d0[0], b[1] - d0[1], b[2] - d0[2]] };
  }
  return info;
}

/* Último resultado de updateCamera() (null antes del primer frame). */
export function getCamera() { return info.camPosScene ? info : null; }
