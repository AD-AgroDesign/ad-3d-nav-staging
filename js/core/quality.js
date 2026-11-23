/* ============ Niveles de calidad (§6.4) ============
   Ultra / Alta / Media / Baja. Se resuelven ANTES de crear el Map (T3: antialias y
   pixelRatio se fijan al crear el contexto WebGL). Desde 2026-11-13 el cambio de nivel NO recarga: pixelRatio va en caliente
   (map.setPixelRatio) y el MSAA queda el del arranque hasta la próxima carga (ver setQuality).
   Prioridad: ?calidad=<nivel> en la URL > localStorage ("ad_calidad") > detección.
   Consumidores: A1 (MSAA/pixelRatio), A2 (LOD), A3 (sombras), A4 (suelo/agua), A5 (fauna), A6 (terreno), idleDriver (render/idle.js). */
import { IS_MOBILE } from "./config.js?v=20261201";
import { emit, on } from "./events.js?v=20261201";

export const LEVELS = ["ultra", "alta", "media", "baja"];

/* Tabla de §6.4. Qué haría cada parámetro cuando lo consuma su dueño:
     msaa            antialias del contexto WebGL (true/false; "gpu" = sí salvo GPU de gama baja)
     pixelRatioCap   tope de devicePixelRatio del mapa
     treeCardDist    follaje en tarjetas hasta esa distancia; treeImpostorDist: impostor desde ahí
     shadows         tamaño del shadow map (0 = sombras blob actuales)
     soil / fauna / water   suelo por shader, fauna, agua por shader
     terrain         relieve por defecto del nivel (A6; true/false; "salvo-baja" = sí salvo GPU de gama baja). El usuario lo pisa con el
                     conmutador "Relieve del terreno" (localStorage ad_relieve), en cualquier nivel
     idleFps         tope del lazo de animación en reposo (0 = apagado) */
export const LEVEL_PARAMS = {
  ultra: { msaa: true,  pixelRatioCap: 2,    treeCardDist: 900, treeImpostorDist: Infinity, shadows: 4096, soil: "completo",   fauna: 1,   water: "shader", idleFps: 30, terrain: "salvo-baja" },   // conmutadores (Mike 2026-11-13): relieve por defecto salvo GPU de gama baja
  alta:  { msaa: "gpu", pixelRatioCap: 1.5,  treeCardDist: 600, treeImpostorDist: Infinity, shadows: 2048, soil: "completo",   fauna: 1,   water: "shader", idleFps: 30, terrain: "salvo-baja" },
  media: { msaa: "gpu", pixelRatioCap: 1.25, treeCardDist: 300, treeImpostorDist: 1500,     shadows: 1024, soil: "sin-surcos", fauna: 0.5, water: "shader", idleFps: 20, terrain: false },
  baja:  { msaa: false, pixelRatioCap: 1,    treeCardDist: 0,   treeImpostorDist: 0,        shadows: 0,    soil: "apagado",    fauna: 0,   water: "plano",  idleFps: 0, terrain: false }
};

const LS_KEY = "ad_calidad";

function lsGet() { try { return localStorage.getItem(LS_KEY); } catch (e) { return null; } }
function lsSet(v) { try { localStorage.setItem(LS_KEY, v); } catch (e) { /* sin localStorage: no se recuerda */ } }

/* GPUs de gama baja conocidas (lista corta; ver §6.4). Se pregunta con un contexto
   descartable: no se toca el del mapa. Las Intel HD/UHD de notebook NO se consideran baja. */
const GPU_BAJA = /Mali-4|Mali-T|Adreno \(TM\) [23]\d\d|PowerVR|SwiftShader|llvmpipe|Basic Render|Software/i;

function gpuRenderer() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    return String(r);
  } catch (e) { return ""; }
}

/* GPUs integradas de notebook (decisión de Mike, 2026-11-10): en la Intel HD 520 el MSAA cuesta
   ~1,8× el frame (El Carmen multi 54 → 30 fps). Con msaa "gpu" (Alta y Media) se apaga en estas y
   en las de gama baja; Ultra lo fuerza siempre. */
const GPU_INTEGRADA = /Intel.*(HD|UHD|Iris)|Radeon\(TM\) (Vega \d+ )?Graphics|AMD Radeon Graphics/i;
let _gpu = null;
const gpuName = () => (_gpu === null ? (_gpu = gpuRenderer()) : _gpu);

/* Resuelve el valor msaa de un nivel (true/false/"gpu") a un booleano. */
export function msaaEnabled(q) {
  if (q.msaa !== "gpu") return !!q.msaa;
  const g = gpuName();
  return !(GPU_BAJA.test(g) || GPU_INTEGRADA.test(g));
}

/* Relieve (A6) — conmutadores sin recarga (Mike 2026-11-13). Preferencia del usuario en localStorage "ad_relieve" ("1"/"0");
   sin preferencia vale el default del nivel de calidad (quality.terrain). Una GPU integrada común ya NO apaga el relieve:
   solo la gama baja conocida (GPU_BAJA) lo deja apagado por defecto. Override solo de QA: ?gpu=baja (con ?qa) simula esa GPU. */
const LS_RELIEVE = "ad_relieve";
export function reliefPref() {
  try { const v = localStorage.getItem(LS_RELIEVE); return v === "1" ? true : v === "0" ? false : null; } catch (e) { return null; }
}
export function setReliefPref(on) {
  try { if (on === null) localStorage.removeItem(LS_RELIEVE); else localStorage.setItem(LS_RELIEVE, on ? "1" : "0"); } catch (e) { /* sin localStorage */ }
}
/* Default del nivel (sin preferencia del usuario). */
export function terrainDefault(q) {
  if (q.terrain !== "salvo-baja") return !!q.terrain;
  const sim = new URLSearchParams(location.search);
  if (sim.has("qa") && sim.get("gpu") === "baja") return false;
  return !GPU_BAJA.test(gpuName());
}
/* ¿Debe haber relieve ahora? Preferencia del usuario si existe; si no, el default del nivel. */
export function terrainEnabled(q) {
  const p = reliefPref();
  return p === null ? terrainDefault(q) : p;
}

/* Detección inicial: IS_MOBILE, deviceMemory, hardwareConcurrency y GPU. */
export function detectLevel() {
  const mem = navigator.deviceMemory, cores = navigator.hardwareConcurrency;
  if (GPU_BAJA.test(gpuName())) return "baja";
  if ((mem && mem <= 2) || (cores && cores <= 2)) return "baja";
  if (IS_MOBILE) return "media";
  if (mem && mem <= 4) return "media";
  return "alta";
}

/* Objeto único y mutable: los módulos guardan la referencia y ven los cambios. */
export const quality = { name: "alta", ...LEVEL_PARAMS.alta, source: "default" };

/* Resuelve el nivel inicial. Se llama una sola vez, antes de crear el Map (map/style.js). */
export function resolveQuality() {
  const q = new URLSearchParams(location.search).get("calidad");
  let name, source;
  if (q && LEVELS.includes(q.toLowerCase())) { name = q.toLowerCase(); source = "url"; }
  else if (LEVELS.includes(lsGet())) { name = lsGet(); source = "localStorage"; }
  else { name = detectLevel(); source = "deteccion"; }
  Object.assign(quality, { name, ...LEVEL_PARAMS[name], source });
  return quality;
}

/* Cambio de nivel SIN recarga (Mike 2026-11-13). Qué pasa en caliente:
     - sombras, pasto, árboles, suelo, fauna, agua e idleFps: los sistemas escuchan "quality" (igual que en la autodegradación);
     - pixelRatio: map.setPixelRatio (applyPixelRatio);
     - relieve: core/relief.js escucha "quality" y llama a setRelief de A6 (animado);
     - MSAA: se fija al crear el contexto WebGL (T3) y NO se puede cambiar sin recrearlo. Queda el del arranque hasta la próxima
       carga (que ya arranca con el del nivel guardado). En integradas y gama baja ya está apagado (msaaEnabled), así que casi no se nota.
   opts.persist (true): lo recuerda en localStorage; opts.fade (por defecto = persist, o sea el selector del panel sí y la API de QA no): fundido cruzado de ~0,6 s
   desde la imagen previa del canvas. Devuelve false si el nombre no es válido. */
export const FADE_MS = 600;
let _applying = Promise.resolve();
export const qualityIdle = () => _applying;   // solo QA: espera a que termine el pixelRatio y el fundido

export async function applyPixelRatio() {
  try {
    const { map } = await import("../map/style.js?v=20261201");
    if (map.setPixelRatio) map.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
  } catch (e) { /* sin mapa: nada que ajustar */ }
}

export function setQuality(name, opts = {}) {
  name = String(name).toLowerCase();
  if (!LEVELS.includes(name)) return false;
  const fade = (opts.fade ?? opts.persist !== false) && !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  /* El relieve hace su propia transición (A6): si este cambio lo enciende o apaga, no se le suma el fundido. */
  const reliefCambia = terrainEnabled(quality) !== (reliefPref() === null ? terrainDefault(LEVEL_PARAMS[name]) : reliefPref());
  const snap = fade && !reliefCambia ? fadeCapture() : null;
  Object.assign(quality, { name, ...LEVEL_PARAMS[name], source: "usuario" });
  if (opts.persist !== false) lsSet(name);
  emit("quality", quality);
  _applying = applyPixelRatio().then(() => fadeRun(snap));
  return true;
}

/* ---- fundido cruzado: copia del canvas del mapa en un overlay que se desvanece (no bloquea clicks ni tapa la UI) ---- */
function fadeCapture() {
  try {
    const host = document.getElementById("map"), src = host && host.querySelector("canvas.maplibregl-canvas");
    if (!src || !src.width) return null;
    document.querySelectorAll(".quality-fade").forEach(n => n.remove());
    const c = document.createElement("canvas");
    c.className = "quality-fade"; c.width = src.width; c.height = src.height; c.setAttribute("aria-hidden", "true");
    c.getContext("2d").drawImage(src, 0, 0);   // preserveDrawingBuffer: true (map/style.js): el buffer sigue legible
    host.appendChild(c);
    return c;
  } catch (e) { return null; }
}
async function fadeRun(c) {
  if (!c || !c.isConnected) return;
  try {
    const { map } = await import("../map/style.js?v=20261201");
    /* el mapa ya muestra el nivel nuevo: se espera un frame con él antes de empezar a desvanecer */
    await new Promise(r => { const t = setTimeout(r, 400); map.once("render", () => { clearTimeout(t); r(); }); map.triggerRepaint(); });
    await new Promise(r => requestAnimationFrame(() => r()));
    c.style.transition = "opacity " + FADE_MS + "ms ease-out";
    c.style.opacity = "0";
    await new Promise(r => setTimeout(r, FADE_MS + 60));
  } catch (e) { /* sin mapa */ }
  c.remove();
}

/* ============ Ola 4 4.2: Ultra se degrada sola a Alta si la máquina no aguanta ============
   Mide el p50 del tiempo de frame SOLO con la cámara en movimiento (tour, órbita, arrastre), sin contar la carga ni el
   reposo: descarta los primeros 10 s de la página, los primeros 6 s de movimiento acumulado (teselas, compilación de shaders)
   y los frames de más de 250 ms (pestaña oculta, pausas). Ventana deslizante de 240 frames en movimiento, evaluada cada 60.
   Si el p50 de la ventana supera 33 ms (< 30 fps) y el usuario está en Ultra, baja a Alta:
     - en caliente: sombras (4096 → 2048), distancias de pasto y árboles, suelo, fauna (los sistemas escuchan "quality")
       y pixelRatio vía map.setPixelRatio (tope de Alta, 1,5);
     - para la próxima carga: el MSAA (se fija al crear el contexto, T3). Hasta recargar queda el del contexto actual.
   Nunca recarga la página. Persiste "alta" en localStorage (la próxima carga ya arranca en Alta, sin MSAA forzado ni pixelRatio 2)
   salvo que Ultra venga forzado por ?calidad= (esa URL no se persiste, igual que setQuality desde la URL).
   Una sola vez por sesión: si el usuario vuelve a elegir Ultra a mano, no se lo vuelve a degradar.
   Con ?qa NO corre, salvo ?autoq=1 (prueba). Solo con ?qa: ?autoqms=<ms> cambia el umbral y ?autoqfast=1 acorta las esperas. */
const _AQ = new URLSearchParams(location.search);
const AQ_QA = _AQ.has("qa");
const AQ_ON = !AQ_QA || _AQ.get("autoq") === "1";
const AQ_FAST = AQ_QA && _AQ.get("autoqfast") === "1";
const AQ_THR = (AQ_QA && Number(_AQ.get("autoqms"))) || 33;
const AQ_PAGE_MS = AQ_FAST ? 0 : 10000, AQ_WARM_MS = AQ_FAST ? 0 : 6000, AQ_WIN = AQ_FAST ? 60 : 240, AQ_STEP = AQ_FAST ? 20 : 60;
export const autoQ = { on: AQ_ON, degraded: false, optOut: false, samples: 0, lastP50: null, thr: AQ_THR };

const aq = { dts: [], moveMs: 0, since: 0, prev: null };

function aqAviso() {
  const sec = document.getElementById("quality-section");
  if (!sec) return;
  let el = document.getElementById("quality-aviso");
  if (!el) { el = document.createElement("p"); el.id = "quality-aviso"; el.setAttribute("role", "status"); sec.appendChild(el); }
  el.textContent = "Ultra no rinde en este equipo: pasamos a Alta.";
  const sel = document.getElementById("quality-select");
  if (sel) { sel.value = "alta"; sel.dispatchEvent(new Event("ad:sync")); sel.addEventListener("change", () => el.remove(), { once: true }); }
}

async function aqDegrade() {
  if (autoQ.degraded || autoQ.optOut || quality.name !== "ultra") return;
  autoQ.degraded = true;
  const persist = quality.source !== "url";
  setQuality("alta", { persist, fade: false });   // en caliente: sombras, pasto, árboles, suelo, fauna, pixelRatio; el MSAA queda hasta la próxima carga
  quality.source = "auto";
  aqAviso();
  console.info("[calidad] Ultra → Alta automático (p50 " + (autoQ.lastP50 && autoQ.lastP50.toFixed(1)) + " ms > " + AQ_THR + " ms)");
}

function aqFrame(f) {
  if (quality.name !== "ultra" || autoQ.degraded || autoQ.optOut) return;
  /* Movimiento = cambió la matriz de vista del frame (cubre traslación, zoom, inclinación y giro; un repintado de
     reposo por animación de fauna/agua la deja idéntica). */
  const e = f.viewProj.elements, pm = aq.prev || (aq.prev = new Float64Array(16));
  let d = 0;
  for (let i = 0; i < 16; i++) { d += Math.abs(e[i] - pm[i]); pm[i] = e[i]; }
  const moved = d > 1e-9;
  if (!moved || document.hidden || !(f.dt > 0) || f.dt > 250 || f.now < AQ_PAGE_MS) return;
  if (aq.moveMs < AQ_WARM_MS) { aq.moveMs += f.dt; return; }
  aq.dts.push(f.dt);
  if (aq.dts.length > AQ_WIN) aq.dts.shift();
  autoQ.samples++;
  if (aq.dts.length < AQ_WIN || ++aq.since < AQ_STEP) return;
  aq.since = 0;
  const s = aq.dts.slice().sort((a, b) => a - b);
  autoQ.lastP50 = s[s.length >> 1];
  /* Fuera del frame: el cambio recrea el shadow map y no puede pasar en medio del render del host. */
  if (autoQ.lastP50 > AQ_THR) setTimeout(aqDegrade, 0);
}

if (AQ_ON) {
  on("frame", aqFrame);
  /* El usuario vuelve a elegir Ultra a mano tras una degradación: se respeta (no se lo vuelve a degradar). */
  on("quality", q => { if (q.name === "ultra" && autoQ.degraded) autoQ.optOut = true; });
}
