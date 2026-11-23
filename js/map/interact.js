import { CLASS_META } from "../core/config.js?v=20261201";
import { pointInPolygon } from "../core/geo.js?v=20261201";
import { state } from "../core/state.js?v=20261201";
import { map } from "./style.js?v=20261201";
import { fmtHa } from "../ui/panel.js?v=20261201";

/* ---------- Interactividad ---------- */
export function setupInteractivity() {
  const CLICKABLE = {
    inicial: ["ini-woody-base", "ini-herb-ext", "ini-otros-fill", "ini-agua-fill"],
    multi: ["multi-woody-base", "multi-herb-ext", "multi-zona-fill", "multi-otros-fill", "multi-agua-fill"]
  };

  map.on("click", e => {
    const layers = CLICKABLE[state.scenario].filter(id => map.getLayer(id));
    let feats = map.queryRenderedFeatures(e.point, { layers });
    feats = feats.filter(f => f.properties._cls);
    if (!feats.length) {
      const src = state.scenario === "inicial" ? state.data.inicial : state.data.multi;
      const pt = [e.lngLat.lng, e.lngLat.lat];
      const hit = src.features.find(f =>
        f.geometry.coordinates.some(poly => pointInPolygon(pt, poly)));
      if (hit) feats = [{ properties: hit.properties }];
    }
    if (!feats.length) return;
    const p = feats[0].properties;
    const meta = CLASS_META[p._cls] || CLASS_META.otros;
    const elemento = p.elemento || p.Elemento || p.ELEMENTO || "";
    new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
      .setLngLat(e.lngLat)
      .setHTML(`
        <div class="popup-title">${meta.label}</div>
        <div class="popup-sub">${elemento ? "Elemento: " + elemento : (state.scenario === "inicial" ? "Paisaje actual" : "Diseño propuesto")}</div>
        <div class="popup-ha">Superficie: <b>${fmtHa(p._sup || 0)}</b></div>`)
      .addTo(map);
  });

  const hoverLayers = ["ini-woody-base", "ini-herb-ext", "multi-woody-base", "multi-herb-ext", "multi-zona-fill"];
  for (const id of hoverLayers) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
}
