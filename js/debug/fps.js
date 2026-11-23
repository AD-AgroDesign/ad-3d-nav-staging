import { DEBUG, params } from "../core/state.js?v=20261201";
import { map } from "../map/style.js?v=20261201";

/* Medidor de FPS (?fps o ?debug): cuenta frames dibujados por segundo.
   En reposo marca 0 porque el mapa no repinta — mirarlo en movimiento. */
if (DEBUG || params.has("fps")) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;left:8px;bottom:34px;z-index:60;background:rgba(10,26,14,.78);" +
    "color:#e8d9a0;font:12px/1.7 monospace;padding:1px 9px;border-radius:6px;pointer-events:none";
  el.textContent = "– fps";
  document.body.appendChild(el);
  let frames = 0;
  map.on("render", () => frames++);
  setInterval(() => { el.textContent = `${frames} fps`; frames = 0; }, 1000);
}
