import { HOME_VIEW, state } from "../core/state.js?v=20261201";
import { applyOpacity } from "../map/layers.js?v=20261201";
import { setScenario } from "../map/scenario.js?v=20261201";
import { map } from "../map/style.js?v=20261201";
import { quality, setQuality } from "../core/quality.js?v=20261201";
import { startOrbit, startTour, stopOrbit, stopTour } from "../tour/tour.js?v=20261201";
import { armarQualityDD } from "./quality-dd.js?v=20261201";

/* ---------- Selector de calidad (P-7): hoy sin efectos visibles ---------- */
const qualitySel = document.getElementById("quality-select");
qualitySel.value = quality.name;
qualitySel.addEventListener("change", () => setQuality(qualitySel.value));
armarQualityDD();   // ORQ G4: menú con la estética de la plataforma sobre el select oculto

/* ---------- UI ---------- */
document.getElementById("sw-inicial").addEventListener("click", () => setScenario("inicial"));
document.getElementById("sw-multi").addEventListener("click", () => setScenario("multi"));
document.getElementById("btn-panel").addEventListener("click", () =>
  document.getElementById("panel").classList.toggle("collapsed"));
/* ORQ G4 (pedido de Mike): en el celular, una cruz en el propio panel también lo cierra (el ☰ sigue igual). */
document.getElementById("panel-close").addEventListener("click", () =>
  document.getElementById("panel").classList.add("collapsed"));
document.getElementById("btn-tour").addEventListener("click", () =>
  state.tour.running ? stopTour() : startTour());
document.getElementById("btn-orbit").addEventListener("click", () =>
  state.orbit.running ? stopOrbit() : startOrbit());
document.getElementById("btn-reset").addEventListener("click", () => {
  stopTour(); stopOrbit();
  map.flyTo({ ...HOME_VIEW, duration: 3500, essential: true });
});

/* ---------- Captura de imagen (PNG de la vista actual) ---------- */
function captureImage() {
  // Forzar un render fresco y leer el buffer en el mismo frame
  map.once("render", () => {
    let url;
    try {
      url = map.getCanvas().toDataURL("image/png");
    } catch (err) {
      console.error("No se pudo capturar la imagen:", err);
      return;
    }
    const escena = state.scenario === "inicial" ? "paisaje-actual" : "paisaje-multifuncional";
    const campo = (state.campo && state.campo.id) || "campo";
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agrodesign-${campo}-${escena}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  map.triggerRepaint();
}
document.getElementById("btn-capture").addEventListener("click", captureImage);

/* ---------- Pantalla completa (útil para el iframe embebido) ---------- */
function toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  }
}
document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  document.getElementById("btn-fullscreen").classList.toggle("active", !!document.fullscreenElement);
});

/* ---------- Altura real del header (se ajusta automáticamente cuando
   envuelve a 2 o 3 líneas en pantallas angostas, para que el mapa y los
   controles nunca queden tapados debajo) ---------- */
const topbarEl = document.getElementById("topbar");
const syncTopbarHeight = () => {
  // Medir sin el valor inline: en escritorio el CSS fija la altura con la
  // misma variable, y medir con ella puesta la dejaría clavada al agrandar
  document.documentElement.style.removeProperty("--topbar-h");
  document.documentElement.style.setProperty("--topbar-h", `${topbarEl.offsetHeight}px`);
};
new ResizeObserver(syncTopbarHeight).observe(topbarEl);
window.addEventListener("resize", syncTopbarHeight);
syncTopbarHeight();

document.getElementById("btn-start").addEventListener("click", () => {
  document.getElementById("splash").classList.add("hidden");
  map.flyTo({ ...HOME_VIEW, duration: 5000, essential: true });
  setTimeout(startTour, 5200);
});

/* Dropdown de campos */
const campoDd = document.getElementById("campo-dd");
document.getElementById("campo-btn").addEventListener("click", e => {
  e.stopPropagation();
  campoDd.classList.toggle("open");
});
document.addEventListener("click", () => campoDd.classList.remove("open"));

/* Slider de opacidad del diseño */
const opSlider = document.getElementById("opacity-slider");
opSlider.addEventListener("input", () => {
  state.designOpacity = opSlider.value / 100;
  document.getElementById("opacity-val").textContent = `${opSlider.value}%`;
  applyOpacity(state.scenario, 1);
});

if (window.matchMedia("(max-width: 760px)").matches) {
  document.getElementById("panel").classList.add("collapsed");
}
