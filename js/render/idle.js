/* ============ idleDriver: lazo único de repintado en reposo (Ola 4) ============
   Reemplaza los tres lazos independientes que tenían fauna.js, water.js y chunks.js (windIdle).
   Con la cámara quieta MapLibre no repinta solo; los sistemas con animación por shader (aves, mariposas,
   agua, viento de árboles y pasto) piden repintados acotados a quality.idleFps:
       idleDriver.bind(map)                  una vez (host.onAdd)
       idleDriver.frame(now, uTime)          una vez por frame, al inicio del render (host.render)
       idleDriver.request(owner, active)     cada sistema avisa si tiene algo animado en cuadro y cerca
   Corre solo si algún owner está activo; no suma en movimiento (repinta solo si el último frame fue hace más de un
   intervalo); apagado con idleFps = 0 (Baja), document.hidden o uTime congelado (freezeTime de QA: 2 frames iguales).
   Vive en su propio módulo (y host.idleDriver lo expone) para que los sistemas lo importen sin ciclo con host.js. */
import { quality } from "../core/quality.js?v=20261201";

const on = new Map();                       // owner → bool
let map = null, timer = 0, lastUT = NaN, sameT = 0, hook = false;
const any = () => { for (const v of on.values()) if (v) return true; return false; };
const fps = () => quality.idleFps | 0;

/* El temporizador se rearma en CADA frame (frame()) a un intervalo del inicio de ese frame: en movimiento los frames
   llegan cada ~16 ms y nunca vence (no suma repintados); en reposo vence un intervalo después del último frame.
   (Medido: con un temporizador libre a período fijo el muestreo contra el vsync hacía caer ~30 % la cadencia). */
function step() {
  timer = 0;
  const f = fps();
  if (!map || !f || document.hidden || !any()) return;   // request() lo re-arma
  if (sameT < 2) map.triggerRepaint();                   // congelado (freezeTime): nada que animar
  timer = setTimeout(step, 1000 / f);                    // si el repintado no llegó a dibujar, reintenta
}
function arm() { const f = fps(); if (map && f > 0 && !document.hidden && any()) { clearTimeout(timer); timer = setTimeout(step, 1000 / f); } }

export const idleDriver = {
  bind(m) {
    map = m;
    if (!hook) { hook = true; document.addEventListener("visibilitychange", () => { if (!document.hidden && map && any()) { arm(); map.triggerRepaint(); } }); }
  },
  frame(now, uTime) {
    sameT = uTime === lastUT ? sameT + 1 : 0; lastUT = uTime;
    arm();   // reinicia el temporizador: vence solo si pasa un intervalo sin frames
  },
  request(owner, active) {
    on.set(owner, !!active && fps() > 0);
    if (any()) { if (!timer) arm(); } else if (timer) { clearTimeout(timer); timer = 0; }
  }
};
