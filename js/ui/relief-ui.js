/* ============ Conmutador "Relieve del terreno" (A1 · conmutadores sin recarga, 2026-11-13) ============
   Switch compacto de dos estados debajo de "Hora del día" (dentro de #quality-section). La lógica y el puente con A6 viven en
   core/relief.js; acá solo DOM, estados (activo / llano / aviso de apagado automático) y eventos. */
import { relief, onRelief, setReliefUser } from "../core/relief.js?v=20261201";
import { on } from "../core/events.js?v=20261201";

const TXT_LLANO = "Este campo es llano", TXT_SIN_DEM = "Relieve no disponible en este campo", TXT_AUTO = "Relieve desactivado para mejorar la fluidez";
let sw, nota, aviso = false;

/* Lo llama presets-ui.js DESPUÉS de armar "Hora del día": el conmutador va debajo. */
export function armarRelieve() {
  const qs = document.getElementById("quality-section");
  if (!qs || document.getElementById("relieve-sw")) return;
  const fila = document.createElement("div");
  fila.id = "relieve-fila";
  const lab = document.createElement("span");
  lab.className = "relieve-label"; lab.id = "relieve-label"; lab.textContent = "Relieve del terreno";
  sw = document.createElement("button");
  sw.type = "button"; sw.id = "relieve-sw"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-labelledby", "relieve-label");
  sw.innerHTML = '<span class="relieve-knob"></span>';
  sw.addEventListener("click", () => { if (sw.disabled) return; aviso = false; setReliefUser(!relief.active); });
  fila.appendChild(lab); fila.appendChild(sw);
  nota = document.createElement("p");
  nota.id = "relieve-nota"; nota.setAttribute("role", "status"); nota.hidden = true;
  qs.appendChild(fila); qs.appendChild(nota);
  pintar();
}

function pintar() {
  if (!sw) return;
  const no = relief.available === false;
  sw.setAttribute("aria-checked", String(!!relief.active && !no));
  sw.disabled = no;
  let t = "";
  if (no) t = /dem|error/i.test(relief.reason) ? TXT_SIN_DEM : TXT_LLANO;
  else if (aviso || relief.autoOff && !relief.active) t = TXT_AUTO;
  nota.textContent = t; nota.hidden = !t;
}

onRelief(pintar);
on("relief:auto-off", () => { aviso = true; pintar(); });
on("scenario", pintar);
