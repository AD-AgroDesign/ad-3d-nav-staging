/* ============ UI del Simulador de escorrentía (HIDRO · F2) ============
   Bloque propio, en su panel exclusivo #runoff-panel (botón #btn-runoff de la barra), separado de la tabla de contenidos. La UI NO calcula ni decide: lee el estado de hydro/state.js (getState y el
   evento "runoff") y llama setMode. El relieve se prende por core/relief.js (setReliefSession: solo esta visita, no pisa la preferencia guardada del conmutador de relieve).
   La disponibilidad depende de terrain.stats, que llega asíncrono: se re-evalúa al armar y en "runoff", "relief:state" y "scenario".
   Se arma solo al importarse (el #panel ya está en el HTML); también se exporta armarEscorrentia() por si hace falta llamarlo. */
import { on } from "../core/events.js?v=20261201";
import { relief, onRelief, setReliefSession } from "../core/relief.js?v=20261201";
import { getState, setMode, setRain, setOpacity } from "../hydro/state.js?v=20261201";
import { turboCss } from "../render/systems/runoff-turbo.js?v=20261201";   // misma paleta (y misma t) que el shader
import { registrarPanel, abrirPanel as abrirPanelExcl } from "./paneles-ui.js?v=20261201";
import { HIDRO } from "../core/config.js?v=20261201";

const MOTIVOS = {
  llano: "Campo llano: el modelo de terreno no alcanza para simular el escurrimiento",
  "sin-dem": "Sin modelo de terreno"
};
const VISTAS = [{ id: "natural", txt: "Agua natural" }, { id: "velocidad", txt: "Velocidad" }, { id: "diferencia", txt: "Diferencia" }];
const LEYENDA_GRAD = "linear-gradient(90deg, #60a0c4, #1e5280)";   // somero → profundo (MODELO §6)

const coma = n => String(n).replace(".", ",");
/* posición de una velocidad en la barra: escala log10 entre vMinMs y vMaxMs (la misma sobre la que el render pinta turbo) */
const posLog = v => (Math.log10(v) - Math.log10(HIDRO.vis.vMinMs)) / (Math.log10(HIDRO.vis.vMaxMs) - Math.log10(HIDRO.vis.vMinMs));

function leyendaVelocidad() {
  const stops = [];
  for (let i = 0; i <= 16; i++) stops.push(turboCss(i / 16) + " " + Math.round(i / 16 * 100) + "%");
  const marcas = HIDRO.vis.marcasMs.map((v, i, a) => {
    const p = Math.round(posLog(v) * 1000) / 10, borde = i === 0 ? " runoff-m-ini" : i === a.length - 1 ? " runoff-m-fin" : "";
    return '<span class="runoff-marca' + borde + '" style="left:' + p + '%"><i></i>' + coma(v) + "</span>";
  }).join("");
  return '<p class="runoff-titulo">Velocidad del agua (m/s)</p>' +
    '<div class="runoff-barra runoff-vel" style="background:linear-gradient(90deg, ' + stops.join(", ") + ')" aria-hidden="true"></div>' +
    '<div class="runoff-marcas" aria-hidden="true">' + marcas + "</div>" +
    '<p class="runoff-sr">De ' + coma(HIDRO.vis.vMinMs) + " a " + coma(HIDRO.vis.vMaxMs) + " metros por segundo, en escala logarítmica.</p>" +
    "<p>Estelas: más largas donde el agua va más rápido</p>";
}
/* Diferencia: log2(v_multi/v_ini). Barra divergente "Acelera ← Igual → Frena" con los colores de HIDRO.vis.diferencia; marcas en % de cambio
   de velocidad (%=100·(2^dlog − 1)) en dlog = ±saturación, ±|frenaDlog| y 0. Simétrica: el render pinta con la misma escala a ambos lados. */
const pct = d => { const p = Math.round(100 * (Math.pow(2, d) - 1)); return (p > 0 ? "+" : p < 0 ? "−" : "") + Math.abs(p) + (p === 0 ? "" : " %"); };
function leyendaDiferencia() {
  const D = HIDRO.vis.diferencia, sat = Math.abs(D.saturacion), um = Math.abs(D.umbral), f = Math.abs(HIDRO.stats.frenaDlog);
  const pos = d => Math.round((0.5 - d / (2 * sat)) * 1000) / 10;   // dlog > 0 (acelera) a la izquierda, < 0 (frena) a la derecha
  // mismo trazado que el shader (runoff-diferencia.js): color sRGB lineal en |dlog| de umbral a saturación (colX[0] → colX[1]);
  // alfa 0 hasta el umbral y rampa de 0,7·umbral por encima. La barra es lineal en dlog, así que los cortes coinciden.
  const x = d => Math.round((50 + d / sat * 50) * 10) / 10, rampa = um * 1.7;
  const c0 = hex => { const n = parseInt(hex.slice(1), 16); return "rgba(" + (n >> 16) + "," + (n >> 8 & 255) + "," + (n & 255) + ",0)"; };
  const stops = [D.colAcelera[1] + " 0%", D.colAcelera[0] + " " + x(-rampa) + "%", c0(D.colAcelera[0]) + " " + x(-um) + "%", c0(D.colFrena[0]) + " " + x(um) + "%", D.colFrena[0] + " " + x(rampa) + "%", D.colFrena[1] + " 100%"];
  const marcas = [sat, f, -f, -sat].map((d, i, a) => {
    const borde = i === 0 ? " runoff-m-ini" : i === a.length - 1 ? " runoff-m-fin" : "";
    return '<span class="runoff-marca' + borde + '" style="left:' + pos(d) + '%"><i></i>' + pct(d) + "</span>";
  }).join("");
  return '<p class="runoff-titulo">Cambio de velocidad del agua</p>' +
    '<div class="runoff-barra runoff-vel" style="background:linear-gradient(90deg, ' + stops.join(", ") + ')" aria-hidden="true"></div>' +
    '<div class="runoff-marcas" aria-hidden="true">' + marcas + "</div>" +
    '<div class="runoff-escala runoff-escala-dif" aria-hidden="true"><span>Acelera</span><span>Igual</span><span>Frena</span></div>' +
    '<p class="runoff-sr">Cambio de velocidad respecto del paisaje actual: a la izquierda donde el agua acelera, en el centro donde queda igual y a la derecha donde frena.</p>' +
    "<p>Dónde el diseño multifuncional frena el agua respecto del paisaje actual.</p>" +
    '<p class="runoff-traza"><i aria-hidden="true"></i>Línea punteada: corredores y parches del diseño</p>';
}
const nf = (n, d) => n.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
function metricas(s) {
  const st = s && s.result && s.result.stats;
  if (!st) return "";
  const f = Math.round(100 * (1 - Math.pow(2, HIDRO.stats.frenaDlog)));
  const fila = (t, v) => '<li><span>' + t + "</span><b>" + v + "</b></li>";
  return '<p class="runoff-titulo">Paisaje Actual → Paisaje Multifuncional</p><ul>' +
    fila("Agua rápida (&gt; " + coma(HIDRO.stats.vAltaMs) + " m/s)", nf(st.inicial.haVMayor, 1) + " ha → " + nf(st.multi.haVMayor, 1) + " ha") +
    fila("Velocidad media", nf(st.inicial.vMediaMs, 3) + " → " + nf(st.multi.vMediaMs, 3) + " m/s") +
    fila("El diseño frena ≥ " + f + " % en", nf(st.frenaHa, 1) + " ha" + (st.campoHa ? " de " + nf(st.campoHa, 0) + " ha" : "")) + "</ul>";
}
function leyendaNatural() {
  return '<div class="runoff-barra" style="background:' + LEYENDA_GRAD + '" aria-hidden="true"></div>' +
    '<div class="runoff-escala"><span>Somero</span><span>Profundo</span></div>' +
    "<p>Agua natural: dónde se junta el agua en el pico de la lluvia. La lámina está exagerada a propósito para que se vea.</p>";
}

let metr, metrDe = "", sw, seg, estado, leyenda, leyendaDe = "", lluvia, lluviaIn, lluviaVal, calcTimer = 0, calcVisible = false, marcaMapa, rotulo, nota, bloque, pedidoUrl = null, avisoRelieve = false, modoUrl = "off";   // "off" de arranque: apagado no toca la URL (cero efecto)

export function armarEscorrentia() {
  const panel = document.getElementById("runoff-panel");
  if (!panel || document.getElementById("runoff-section")) return;
  bloque = document.createElement("div");
  bloque.className = "panel-section"; bloque.id = "runoff-section";

  const fila = document.createElement("div");
  fila.id = "runoff-fila";
  const lab = document.createElement("span");
  lab.className = "runoff-label"; lab.id = "runoff-label"; lab.textContent = "Mostrar simulación";
  sw = document.createElement("button");
  sw.type = "button"; sw.id = "runoff-sw"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-labelledby", "runoff-label");
  sw.setAttribute("aria-describedby", "runoff-estado"); sw.innerHTML = '<span class="runoff-knob"></span>';
  sw.addEventListener("click", alternar);
  fila.append(lab, sw);

  estado = document.createElement("p");
  estado.id = "runoff-estado"; estado.setAttribute("role", "status"); estado.hidden = true;

  seg = document.createElement("div");
  seg.id = "runoff-seg"; seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Vista del simulador");
  for (const v of VISTAS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "runoff-btn"; b.dataset.vista = v.id; b.textContent = v.txt;
    b.addEventListener("click", () => setMode(v.id));   // setMode devuelve false si no está disponible
    seg.appendChild(b);
  }

  leyenda = document.createElement("div");
  leyenda.id = "runoff-leyenda";

  // lluvia: mismo patrón que el deslizador de opacidad (controls.js). `input` solo actualiza el valor; `change` (al soltar) recalcula
  const r = HIDRO.rain;
  lluvia = document.createElement("div");
  lluvia.id = "runoff-lluvia";
  const ll = document.createElement("label");
  ll.htmlFor = "runoff-lluvia-in"; ll.textContent = "Lluvia (mm/h)";
  lluviaVal = document.createElement("span");
  lluviaVal.id = "runoff-lluvia-val";
  lluviaIn = document.createElement("input");
  lluviaIn.type = "range"; lluviaIn.id = "runoff-lluvia-in"; lluviaIn.min = r.min; lluviaIn.max = r.max; lluviaIn.step = r.step; lluviaIn.value = r.default;
  lluviaIn.addEventListener("input", () => { setRain(Number(lluviaIn.value), false); });
  lluviaIn.addEventListener("change", () => { setRain(Number(lluviaIn.value), true); });
  const filaLl = document.createElement("div");
  filaLl.className = "runoff-lluvia-fila";
  filaLl.append(ll, lluviaVal);
  lluvia.append(filaLl, lluviaIn);

  rotulo = document.createElement("p");
  rotulo.id = "runoff-rotulo";

  nota = document.createElement("p");
  nota.id = "runoff-nota"; nota.setAttribute("role", "status"); nota.hidden = true;

  metr = document.createElement("div");
  metr.id = "runoff-metricas"; metr.setAttribute("aria-label", "Métricas del escurrimiento");

  bloque.append(fila, estado, seg, lluvia, leyenda, metr, rotulo, nota);
  panel.append(armarOpacidad(), bloque);
  armarPanel(panel);

  // ?escorrentia=natural|velocidad|diferencia: se aplica en cuanto el campo admita el simulador
  const m = location.search.match(/[?&]escorrentia=([^&]*)/);
  if (m && VISTAS.some(v => v.id === m[1])) pedidoUrl = m[1];
  if (pedidoUrl && !matchMedia("(max-width: 760px)").matches) abrirPanel(true);   // ?escorrentia: en escritorio el panel queda abierto
  pintar();
}

/* "Opacidad de la simulación": opacidad propia de las capas del simulador (agua / velocidades / diferencia), vía setOpacity de state.js.
   No tiene ningún vínculo con la opacidad del diseño (#opacity-slider de la tabla). Sin capas que mostrar no tiene efecto: se deshabilita (ver pintar). */
let opIn, opVal, opSec;
function armarOpacidad() {
  const o = HIDRO.vis.opacidad, pc = x => Math.round(x * 100);
  opSec = document.createElement("div");
  opSec.className = "panel-section"; opSec.id = "runoff-opacity-section";
  opSec.innerHTML = '<h3>Opacidad de la simulación</h3><div class="opacity-row"><input type="range" id="runoff-opacity-slider" min="' + pc(o.min) + '" max="' + pc(o.max) + '" step="' + pc(o.step) + '" value="' + pc(getState().opacity) + '" aria-label="Opacidad de la simulación"><span id="runoff-opacity-val"></span></div>';
  opIn = opSec.querySelector("input"); opVal = opSec.querySelector("#runoff-opacity-val");
  opVal.textContent = opIn.value + "%";
  opIn.addEventListener("input", () => { if (opIn.getAttribute("aria-disabled") === "true") return; opVal.textContent = opIn.value + "%"; setOpacity(Number(opIn.value) / 100); });
  return opSec;
}
function pintarOpacidad(s, deshabilitado) {
  if (!opIn) return;
  const v = String(Math.round(s.opacity * 100));
  if (opIn.value !== v) opIn.value = v;
  opVal.textContent = v + "%";
  opIn.setAttribute("aria-valuetext", v + " por ciento");
  opSec.classList.toggle("runoff-off", deshabilitado);
  if (deshabilitado) { opIn.setAttribute("aria-disabled", "true"); opIn.tabIndex = -1; } else { opIn.removeAttribute("aria-disabled"); opIn.removeAttribute("tabindex"); }
}

/* Panel propio (#runoff-panel): la exclusión con la tabla y los demás paneles y el estado del botón los resuelve paneles-ui.js */
let panelSim, btnSim;
function armarPanel(panel) {
  panelSim = panel; btnSim = document.getElementById("btn-runoff");
  registrarPanel(panel, { boton: btnSim, cerrar: document.getElementById("runoff-panel-close") });
  sincBoton();
}
function abrirPanel(abrir) { if (panelSim) abrirPanelExcl(panelSim, abrir); }
function sincBoton() {
  if (!btnSim) return;
  const s = getState();
  btnSim.classList.toggle("runoff-prendido", s.mode !== "off" && s.available);   // puntito dorado: prendido con el panel cerrado
}

/* Marca chica sobre el mapa mientras el simulador está prendido (HIDRO.vis.marca). Apagado no existe en el DOM.
   Centrada abajo y por encima de la fila de la atribución (abajo a la derecha) y de la marca "campo sintético" de auth.js (abajo a la izquierda), con su mismo estilo; z-index bajo el del panel para que el celular la tape en vez de pisar su texto. */
function marcarMapa(on) {
  if (on && !marcaMapa) {
    marcaMapa = document.createElement("div");
    marcaMapa.id = "runoff-marca"; marcaMapa.textContent = HIDRO.vis.marca.texto;
    document.body.appendChild(marcaMapa);
  } else if (!on && marcaMapa) { marcaMapa.remove(); marcaMapa = null; }
}

function alternar() {
  if (sw.getAttribute("aria-disabled") === "true") return;
  pedidoUrl = null; avisoRelieve = false;
  if (getState().mode !== "off") { setMode("off"); return; }
  prender();
}

function prender(vista = "natural") {
  if (!relief.active && relief.available !== false) { avisoRelieve = true; setReliefSession(true); }   // solo esta visita: no guarda ad_relieve
  setMode(vista);
}

function url(mode) {
  // se edita el texto de la query a mano (como ?hora=): URLSearchParams reescribiría otros parámetros del visor
  let q = location.search.replace(/([?&])escorrentia=[^&]*(&|$)/, (m, a, z) => (z ? a : "")).replace(/[?&]$/, "");
  if (mode !== "off") q += (q.includes("?") ? "&" : "?") + "escorrentia=" + mode;
  history.replaceState(history.state, "", location.pathname + q + location.hash);
}

function pintar(s) {
  if (!sw) return;
  s = s && s.mode ? s : getState();
  if (pedidoUrl && s.available && s.mode === "off") { const v = pedidoUrl; pedidoUrl = null; prender(v); s = getState(); }
  const bloqueado = !s.available && s.mode === "off";
  const prendido = s.mode !== "off" && s.available;
  const motivo = s.error ? "No se pudo calcular el escurrimiento. Probá de nuevo más tarde."
    : (!s.available && s.reason !== "calculando" ? (MOTIVOS[s.reason] || MOTIVOS["sin-dem"]) : "");
  sw.setAttribute("aria-checked", String(prendido));
  if (bloqueado) sw.setAttribute("aria-disabled", "true"); else sw.removeAttribute("aria-disabled");
  bloque.classList.toggle("runoff-off", bloqueado);
  const calc = prendido && s.computing;
  // "Calculando…" con demora: el recálculo tarda ~50 ms y mostrarlo al instante solo hace parpadear el bloque
  if (!calc) { clearTimeout(calcTimer); calcTimer = 0; calcVisible = false; }
  else if (!calcTimer && !calcVisible) calcTimer = setTimeout(() => { calcTimer = 0; calcVisible = true; pintar(); }, 200);
  estado.textContent = motivo || (calc && calcVisible ? "Calculando…" : "");
  estado.hidden = !estado.textContent;
  estado.classList.toggle("runoff-error", !!s.error);
  for (const b of seg.querySelectorAll(".runoff-btn")) b.setAttribute("aria-pressed", String(prendido && b.dataset.vista === s.mode));
  seg.hidden = leyenda.hidden = rotulo.hidden = lluvia.hidden = !prendido;
  if (prendido && leyendaDe !== s.mode) { leyendaDe = s.mode; leyenda.innerHTML = s.mode === "velocidad" ? leyendaVelocidad() : s.mode === "diferencia" ? leyendaDiferencia() : leyendaNatural(); }
  // métricas en las tres vistas (el resultado trae los dos escenarios siempre); se conserva el último valor mientras recalcula
  const mt = prendido ? metricas(s) : "";
  if (mt || !prendido) { if (mt !== metrDe) { metrDe = mt; metr.innerHTML = mt; } }
  metr.hidden = !metr.innerHTML;
  if (String(lluviaIn.value) !== String(s.rainMmH)) lluviaIn.value = s.rainMmH;
  lluviaVal.textContent = s.rainMmH + " mm/h";
  lluviaIn.setAttribute("aria-valuetext", s.rainMmH + " milímetros por hora");
  pintarOpacidad(s, !prendido);
  marcarMapa(prendido);
  sincBoton();
  bloque.setAttribute("aria-busy", String(!!calc));
  rotulo.textContent = "Ilustrativo · Pico de una lluvia de " + s.rainMmH + " mm/h · No es un estudio hidrológico";
  let n = "";
  if (prendido && !relief.active) n = "El relieve está apagado: el agua se ve mejor con el relieve del terreno prendido.";
  else if (prendido && avisoRelieve) n = "Prendimos el relieve del terreno para esta visita: el agua lo necesita para verse.";
  nota.textContent = n; nota.hidden = !n;
  if (modoUrl !== s.mode && !(pedidoUrl && s.mode === "off")) { modoUrl = s.mode; url(s.mode); }
}

on("runoff", pintar);
on("scenario", () => pintar());
onRelief(() => pintar());
armarEscorrentia();
