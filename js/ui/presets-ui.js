/* ============ UI de los modos de hora (A1 · Ola 3 · 3.1) ============
   G3: control segmentado compacto "Hora del día" bajo el selector de calidad: tres segmentos con ícono chico (sol alto / sol bajo / ocaso). El modo elegido viaja en la URL
   (?hora=dorada|atardecer; mediodía = sin parámetro) para compartir vistas. La lógica y la transición viven en render/lighting.js;
   acá solo se arma el DOM, se escucha "preset" (lo emite lighting.js, también desde la API de QA) y se actualiza la URL.
   D-5: el tour NO cambia de modo solo; lo elige el usuario. */
import { on } from "../core/events.js?v=20261201";
import { armarRelieve } from "./relief-ui.js?v=20261201";   // conmutador "Relieve del terreno" (debajo de la hora)
import { PRESET_NAMES, presetName, setPreset } from "../render/lighting.js?v=20261201";

const ICONOS = {
  // sol alto: disco con rayos
  mediodia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>',
  // sol bajo: medio disco sobre el horizonte con rayos cortos
  dorada: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6.5 16a5.5 5.5 0 0 1 11 0z" fill="currentColor"/><path d="M12 6v2.2M4.2 10.2l1.6 1.4M19.8 10.2l-1.6 1.4M2.5 16h19M5 19.5h14"/></svg>',
  // ocaso: sol hundiéndose en el horizonte
  atardecer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7.5 15a4.5 4.5 0 0 1 9 0" fill="currentColor"/><path d="M2.5 15h19M5 18.5h14M8.5 21.5h7M12 7.5V9.5M6.3 9.8l1.3 1.3M17.7 9.8l-1.3 1.3"/><path d="M9.5 4.5 12 2l2.5 2.5" /></svg>'
};
const TEXTOS = { mediodia: "Mediodía", dorada: "Hora dorada", atardecer: "Atardecer" };

function armar() {
  const qs = document.getElementById("quality-section");
  if (!qs || document.getElementById("hora-btns")) return;
  // G3: control segmentado compacto, dentro de la sección de calidad y debajo de su selector (la hora no es protagonista)
  const lab = document.createElement("span");
  lab.className = "hora-label"; lab.id = "hora-label"; lab.textContent = "Hora del día";
  const cont = document.createElement("div");
  cont.id = "hora-btns"; cont.setAttribute("role", "group"); cont.setAttribute("aria-labelledby", "hora-label");
  for (const name of PRESET_NAMES) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "hora-btn"; b.dataset.hora = name; b.title = TEXTOS[name];
    b.innerHTML = ICONOS[name] + "<span>" + TEXTOS[name] + "</span>";
    b.addEventListener("click", () => setPreset(name));
    cont.appendChild(b);
  }
  qs.appendChild(lab); qs.appendChild(cont);
  marcar(presetName);
}

function marcar(name) {
  for (const b of document.querySelectorAll("#hora-btns .hora-btn")) b.setAttribute("aria-pressed", String(b.dataset.hora === name));
}

/* ?hora= en la URL sin recargar ni ensuciar el historial (mediodía = sin parámetro). */
function url(name) {
  // se edita el texto de la query a mano: URLSearchParams reescribiría ?local como ?local= y otros parámetros del visor
  let q = location.search.replace(/([?&])hora=[^&]*(&|$)/, (m, a, z) => (z ? a : "")).replace(/[?&]$/, "");
  if (name !== "mediodia") q += (q.includes("?") ? "&" : "?") + "hora=" + name;
  history.replaceState(history.state, "", location.pathname + q + location.hash);
}

on("preset", ({ name }) => { marcar(name); url(name); });
armar();
armarRelieve();   // el conmutador de relieve va debajo de la hora
