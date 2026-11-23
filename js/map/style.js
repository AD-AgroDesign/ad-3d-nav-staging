import { HOME_VIEW } from "../core/state.js?v=20261201";
import { msaaEnabled, resolveQuality } from "../core/quality.js?v=20261201";
import { atm, lights, onAtmosphere, setRepaint } from "../render/lighting.js?v=20261201";   // A1 (3.1): modo de hora vigente (cielo y ráster los pone este archivo)

/* A1 (1.3, D): ajuste de color del satélite (raster-*) para que ráster y 3D parezcan la misma foto.
   Valores base en config.js A1_RASTER (mediodía); los modos de hora (3.1, lighting.js) los interpolan y vienen en `atm`. */
const _rgbCss = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
const _noTr = { duration: 0, delay: 0 };   // sin transición propia de MapLibre (300 ms por defecto): la animación de la hora la hace lighting.js
export function rasterPaint(r = atm) {
  return {
    "raster-saturation": r.rSat, "raster-contrast": r.rCon,
    "raster-brightness-min": r.rBMin, "raster-brightness-max": r.rBMax,
    "raster-hue-rotate": r.rHue
  };
}
/* Cielo de MapLibre según el modo de hora (el horizon-color es también el color de la niebla Three y de atmo-fog). */
export function skyPaint(r = atm) {
  return {
    "sky-color": _rgbCss(r.skyCol), "horizon-color": _rgbCss(r.horCol), "fog-color": _rgbCss(r.fogCol)
  };
}
/* map/data.js reconstruye la capa "satellite" (sin paint) cuando cambia el maxzoom del campo:
   se re-aplica el ajuste después (app.js lo llama tras loadCampos). */
export function applyRasterGrade(m, r = atm) {
  if (!m.getLayer("satellite")) return;
  for (const [k, v] of Object.entries(rasterPaint(r))) { m.setPaintProperty("satellite", k + "-transition", _noTr); m.setPaintProperty("satellite", k, v); }
}

/* ---------- Estilo base del mapa (sin terreno: llanura, evita
   artefactos de extrusiones cortadas en pendientes) ---------- */
export const mapStyle = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      // maxzoom por defecto; se ajusta por campo en loadCampos() según hasta
      // qué nivel Esri tiene imagen nativa (z18 en Monte Hermoso, z17 en
      // Silesia/El Carmen). Más allá, Esri devuelve "Map data not yet available",
      // así que reescalamos el último tile real en vez de pedir los inexistentes.
      maxzoom: 17,
      attribution: "Imagen satelital © Esri, Maxar, Earthstar Geographics | AgroDesign"
    }
  },
  layers: [{ id: "satellite", type: "raster", source: "esri", paint: rasterPaint() }],
  sky: {
    ...skyPaint(),   // sky-color / horizon-color (= color de la niebla) / fog-color según el modo de hora (?hora=; mediodía = los de siempre)
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.65,
    "fog-ground-blend": 0.85
  }
};

/* T3: el nivel de calidad se resuelve ANTES de crear el Map (antialias y pixelRatio se
   fijan al crear el contexto WebGL). Hoy no se consume ningún parámetro (sin cambios
   visibles); A1 conectará antialias/pixelRatio acá. */
export const QUALITY = resolveQuality();

export const map = new maplibregl.Map({
  container: "map",
  style: mapStyle,
  preserveDrawingBuffer: true,  // permite exportar la vista a PNG (botón capturar)
  center: HOME_VIEW.center,
  zoom: 11.4,
  pitch: 0,
  bearing: 0,
  maxPitch: 85,   // A5 4.2: 80 → 85 (tope de MapLibre 4.7.1); con maxZoom 20.5 la cámara manual baja a ~5 m sobre el suelo
  minZoom: 9.5,
  /* ORQ (G3, Mike "A"): 17.8 → 19.5 para acercarse en navegación manual (mariposas y detalle 3D de cerca).
     El tour y el rasante usan zooms fijos (RAZANTE_CAM 17.6) y no cambian; más allá del maxzoom de Esri el ráster se reescala. */
  maxZoom: 20.5,  // Mike 4.2: 20.5 (A5 probó 21: a ~3,5 m el pasto se ve en láminas); a pitch 80 ~10 m, a pitch 85 ~5 m
  attributionControl: { compact: true },
  /* ORQ (pedido A5): sin fundido de colocación de símbolos. El estilo no tiene capas symbol, pero en 4.7 cada
     repintado forzado en reposo disparaba 5-8 frames extra por ese fundido (fauna/agua en el lazo acotado). */
  fadeDuration: 0,
  /* A1 (1.3, A): antialias y pixelRatio según el nivel de calidad. Se fijan al crear el contexto
     (T3): el antialias queda el del arranque aunque cambie el nivel (sin recarga, quality.js setQuality); el pixelRatio sí se ajusta en caliente. msaa "gpu" (Alta, Media):
     sí, salvo GPU integrada o de gama baja (msaaEnabled en quality.js; ORQ 2026-11-10). */
  antialias: msaaEnabled(QUALITY) && !(/[?&](qa|debug)/.test(location.search) && new URLSearchParams(location.search).get("aa") === "0"),   // ?aa=0: solo para comparar capturas, y solo con ?qa/?debug
  pixelRatio: Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatioCap)
});
/* A1 (3.1): cada paso de la transición de hora vuelca el cielo, el ráster y el hillshade al mapa. */
let _lastAz = null;
onAtmosphere(s => {
  applyRasterGrade(map, s);
  const cur = map.getSky && map.getSky();
  if (cur) {
    /* El spec del sky no admite "*-transition" en el JSON: se las saca a la propiedad por dentro (maplibre-gl 4.7.1 está vendorizado,
       el campo es estable) para que el cielo siga EXACTO a la niebla Three durante la transición, sin el desfasaje de 300 ms. */
    const tr = map.style && map.style.sky && map.style.sky._transitionable;
    if (tr && !tr._adNoTr) { for (const k of ["sky-color", "horizon-color", "fog-color"]) tr.setTransition(k, _noTr); tr._adNoTr = true; }
    map.setSky({ ...cur, ...skyPaint(s) });   // conserva lo que agregue el terreno (fog-ground-blend, etc.)
  }   // conserva lo que agregue el terreno (fog-ground-blend, etc.)
  const hs = map.getLayer("hillshade");               // A6: el relieve se sombrea con la luz del modo vigente
  const az = ((lights.azimuth % 360) + 360) % 360;   // el spec pide 0..359
  if (hs && az !== _lastAz) { map.setPaintProperty("hillshade", "hillshade-illumination-direction", az); _lastAz = az; }
});
setRepaint(() => map.triggerRepaint());
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
map.touchZoomRotate.enableRotation();
