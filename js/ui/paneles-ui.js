/* ============ Paneles exclusivos de la izquierda (HIDRO · F5) ============
   La tabla (#panel, ☰), el simulador y los ajustes comparten lugar: abre uno y se cierran los demás. No se toca controls.js:
   un MutationObserver sobre la clase "collapsed" de cada panel detecta cuándo uno se abre y colapsa a los otros, y deja el botón
   asociado en estado activo (aria-expanded). El ☰ y la × de la tabla siguen siendo de controls.js; acá solo se los observa. */
const paneles = [];   // { panel, boton }

function sincBoton(p) {
  if (!p.boton) return;
  const ab = !p.panel.classList.contains("collapsed");
  p.boton.classList.toggle("active", ab);
  p.boton.setAttribute("aria-expanded", String(ab));
}
function alCambiar(p) {
  const ab = !p.panel.classList.contains("collapsed");
  if (ab !== p.abierto) {
    p.abierto = ab;
    if (ab) for (const o of paneles) if (o !== p && !o.panel.classList.contains("collapsed")) o.panel.classList.add("collapsed");
  }
  sincBoton(p);
}
function agregar(panel, boton) {
  if (paneles.some(p => p.panel === panel)) return;
  const p = { panel, boton, abierto: !panel.classList.contains("collapsed") };
  paneles.push(p);
  new MutationObserver(() => alCambiar(p)).observe(panel, { attributes: true, attributeFilter: ["class"] });
  sincBoton(p);
}
export function abrirPanel(panel, abrir) { panel.classList.toggle("collapsed", !abrir); }

/* Registra un panel con botón propio y × propia. La tabla se registra sola (sin handlers: los pone controls.js). */
export function registrarPanel(panel, { boton, cerrar } = {}) {
  const tabla = document.getElementById("panel");
  if (tabla) agregar(tabla, document.getElementById("btn-panel"));
  agregar(panel, boton);
  if (boton) boton.addEventListener("click", () => abrirPanel(panel, panel.classList.contains("collapsed")));
  if (cerrar) cerrar.addEventListener("click", () => abrirPanel(panel, false));
}

/* El panel de ajustes no tiene lógica propia: solo botón, × y exclusividad */
const aj = document.getElementById("ajustes-panel");
if (aj) registrarPanel(aj, { boton: document.getElementById("btn-ajustes"), cerrar: document.getElementById("ajustes-panel-close") });
