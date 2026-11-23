/* ============================================================
   AgroDesign 3D Navigator
   Mapa 3D navegable estilo vuelo de dron con conmutación entre
   paisaje actual y diseño multifuncional. Árboles low-poly
   instanciados en GPU (Three.js). Multi-campo y control de acceso vía
   Supabase: ver js/auth.js.
   ============================================================ */

import { loadCampos, loadData } from "./map/data.js?v=20261201";
import { addScenarioLayers, applyGrowth, applyOpacity } from "./map/layers.js?v=20261201";
import { applyRasterGrade, map } from "./map/style.js?v=20261201";
import { updatePanel } from "./ui/panel.js?v=20261201";
import { mapStyle } from "./map/style.js?v=20261201";
import { DEBUG, state } from "./core/state.js?v=20261201";
import { initTerrain } from "./terrain/terrain.js?v=20261201";   // A6: relieve (DEM terrarium), hillshade y terreno 3D automático
import "./render/atmo.js?v=20261201";   // A1: capa atmo-fog (se registra sola en host.registerBeforeLayer, antes de addScenarioLayers)
import "./ui/controls.js?v=20261201";
import "./ui/presets-ui.js?v=20261201";   // A1 (3.1): botones de modo de hora
import "./ui/runoff-ui.js?v=20261201";    // F2: bloque "Simulador de escorrentía" (se arma solo al importarse)
import "./debug/fps.js?v=20261201";
import "./debug/qa-api.js?v=20261201";

/* Con ?debug se exponen el mapa, su estilo y el estado en window (inspección desde
   la consola). Antes vivía junto a la creación del mapa en main.js. */
if (DEBUG) { window.__map = map; window.__mapStyle = mapStyle; window.__state = state; }

/* ---------- Arranque ----------
   El escenario ya no se carga junto con el mapa: espera a que haya sesión
   validada y campo elegido, porque cada GeoJSON se baja con una URL firmada.
   Son dos disparadores asíncronos —el "load" del mapa y el visto bueno de
   auth.js— y arranca el que llegue segundo. El mapa sí se construye enseguida:
   queda armándose detrás del overlay, así el satelital está listo cuando el
   usuario termina de entrar. */
let mapListo = false, accesoListo = false;

async function bootEscenario() {
  try {
    const pattern = map.loadImage("img/pastizal.jpg");
    const patternPardo = map.loadImage("img/pastizal-pardo.jpg");
    const patternVerde = map.loadImage("img/pastizal-verde.jpg");
    loadCampos();
    applyRasterGrade(map);   // A1: ajuste de color del satélite (loadCampos puede recrear la capa)
    await loadData();
    await initTerrain(map, state.bbox, state.data.inicial);   // A6: ANTES de las capas y del host (heightAt, fuente raster-dem, hillshade, setTerrain)
    map.addImage("pastizal", (await pattern).data);
    map.addImage("pastizal-pardo", (await patternPardo).data);
    map.addImage("pastizal-verde", (await patternVerde).data);
    addScenarioLayers();
    applyOpacity("inicial", 1); applyGrowth("inicial", 1);
    applyOpacity("multi", 0); applyGrowth("multi", 0);
    updatePanel();
    const btn = document.getElementById("btn-start");
    btn.disabled = false;
    document.getElementById("btn-start-label").textContent = "Iniciar simulación";
  } catch (err) {
    console.error("Error cargando datos del paisaje:", err);
    document.getElementById("btn-start-label").textContent = "Error al cargar datos";
  }
}

map.on("load", () => { mapListo = true; if (accesoListo) bootEscenario(); });
window.AD_BOOT = () => { accesoListo = true; if (mapListo) bootEscenario(); };

/* auth.js es un script clásico y corre ANTES que este módulo (los módulos son
   diferidos): si el acceso ya quedó validado, AD_BOOT todavía no existía y auth.js
   sólo dejó la bandera AD_ACCESS_READY. Se lo dispara acá, una única vez: si la
   bandera no estaba, auth.js encontrará AD_BOOT definido y lo llamará él. */
if (window.AD_ACCESS_READY) window.AD_BOOT();
