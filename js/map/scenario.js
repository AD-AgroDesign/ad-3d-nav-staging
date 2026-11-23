import { state } from "../core/state.js?v=20261201";
import { emit } from "../core/events.js?v=20261201";
import { applyGrowth, applyOpacity } from "./layers.js?v=20261201";
import { updatePanel } from "../ui/panel.js?v=20261201";

export const easeOutCubic = x => 1 - Math.pow(1 - x, 3);

/* ---------- Conmutación de escenario ---------- */
export function setScenario(next, animate = true) {
  if (next === state.scenario) return;
  const prev = state.scenario;
  state.scenario = next;
  emit("scenario", { key: next, prev });
  updatePanel();
  document.getElementById("sw-inicial").classList.toggle("active", next === "inicial");
  document.getElementById("sw-multi").classList.toggle("active", next === "multi");

  if (state.anim) cancelAnimationFrame(state.anim);
  if (!animate) {
    applyOpacity(prev, 0); applyGrowth(prev, 0);
    applyOpacity(next, 1); applyGrowth(next, 1);
    return;
  }

  const FADE_MS = 700, GROW_MS = 1800;
  const t0 = performance.now();
  const frame = now => {
    // El timestamp del primer rAF puede ser anterior a t0 (quirk de Chrome):
    // sin clamp, fade/grow dan negativos y MapLibre rechaza el valor con error
    const dt = Math.max(0, now - t0);
    const fade = Math.min(dt / FADE_MS, 1);
    const grow = easeOutCubic(Math.min(dt / GROW_MS, 1));
    applyOpacity(prev, 1 - fade);
    applyOpacity(next, fade);
    applyGrowth(prev, 1 - grow);
    applyGrowth(next, grow);
    if (dt < GROW_MS) state.anim = requestAnimationFrame(frame);
    else state.anim = null;
  };
  state.anim = requestAnimationFrame(frame);
}
