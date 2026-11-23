/* ---------- Configuración de clases de paisaje ---------- */
export const CLASS_META = {
  "agri":          { label: "Agrícola Secano",            legend: "#d9c98a" },
  // Macroambientes del diseño (antes "Agrícola Secano · Zona 1/2/3"): label y
  // rampa cromática según los .qml del equipo GIS. Las claves zona1/2/3 quedan
  // como identificador interno para no romper datos ni filtros existentes.
  "zona1":         { label: "Macroamb. mayor PP",         legend: "#1a9641" },
  "zona2":         { label: "Macroamb. PP intermedio",    legend: "#60b856" },
  "zona3":         { label: "Macroamb. menor PP",         legend: "#a6d96a" },
  "parche-le":     { label: "Parche Leñoso",              legend: "#1b4020" },
  "corr-le":       { label: "Corredor Leñoso",            legend: "#2f5d33" },
  "parche-herb":   { label: "Parche Herbáceo",            legend: "#6a7c48" },
  "corr-herb":     { label: "Corredor Herbáceo",          legend: "#947c4a" },
  "bajo":          { label: "Bajo en Recuperación",       legend: "#7c9a80" },
  "ganaderia":     { label: "Ganadería",                  legend: "#a8bd72" },
  "agua":          { label: "Curso de Agua",              legend: "#5b8fb9" },
  "suelo-desnudo": { label: "Suelo Desnudo",              legend: "#c3ab86" },
  "instalaciones": { label: "Instalaciones",              legend: "#b8b3a4" },
  "camino":        { label: "Caminos",                    legend: "#c9bd9e" },
  "otros":         { label: "Otros",                      legend: "#9e9e9e" }
};
/* Orden canónico para leyendas (se muestran solo las clases presentes) */
export const CLASS_ORDER = ["agri", "zona1", "zona2", "zona3", "parche-le", "parche-herb",
  "corr-le", "corr-herb", "bajo", "ganaderia", "agua", "suelo-desnudo",
  "instalaciones", "camino", "otros"];
export const NATURE_CLASSES = ["parche-le", "corr-le", "parche-herb", "corr-herb"];
export const WOODY_CLASSES = ["parche-le", "corr-le"];
export const HERB_LIKE_CLASSES = ["parche-herb", "corr-herb", "bajo"];
export const MISC_CLASSES = ["otros", "instalaciones", "camino", "ganaderia", "suelo-desnudo"];

/* Paleta de copas de monte de espinal */
export const CROWN_PALETTE = [0x2a4f22, 0x33602a, 0x3e6d2f, 0x4a7434, 0x567c38, 0x6a7f3e];
export const WOODY_BASE = { color: "#2e5026", height: 1.2, opacity: 0.45 };
export const HERB_HEIGHT = 0.6;

export const IS_MOBILE = window.matchMedia("(max-width: 760px)").matches;

/* === A2: inicio === */
/* Chunking / LOD de vegetación (render/systems/chunks.js). Diales: ver handoffs/a2-chunks.md */
export const CHUNK_CELL_TREES = 500;       // m, lado de la celda de árboles (pocas instancias: celda más gruesa = menos draws)
/* G · Árboles nuevos (render/systems/trees.js + treegen.js). Decisión del dueño en G1 (2026-11-10):
   nativas del espinal (tala, algarrobo, chañar), sin eucalipto. La clase (parche-le / corr-le) no
   cambia la mezcla: el dato de árbol no la guarda y la ficha da la misma mezcla para las dos.
     mix        proporción (suma 1); la especie de cada árbol sale de un hash determinista de su dato
     h          rango de altura (m) al que se mapea la altura original (5-14 m) de cada árbol
     crownK     radio de copa / altura, según el radio original del árbol
     leaf/bark  colores en sRGB (como el resto de las paletas; el pipeline los pasa a lineal)
     cards      tarjetas de follaje por árbol (2 tris c/u); proxyK = tamaño del impostor (fracción
                del elipsoide de la copa); proxyFlat = factor de grosor vertical del impostor; proxyShade = oscurecimiento del impostor para empalmar con el follaje */
export const TREE_SPECIES = {
  tala:      { label: "Tala",      mix: 0.45, h: [6.25, 11.25], crownK: [0.42, 0.60], leaf: 0x436f31, bark: 0x6a5a48, cards: 44, proxyK: 0.95, proxyFlat: 1, proxyShade: 0.85 },
  algarrobo: { label: "Algarrobo", mix: 0.35, h: [7.5, 15], crownK: [0.50, 0.75], leaf: 0x6a8556, bark: 0x4a392b, cards: 60, proxyK: 0.92, proxyFlat: 1.7, proxyShade: 0.80 },
  chanar:    { label: "Chañar",    mix: 0.20, h: [3.75, 8.75], crownK: [0.42, 0.60], leaf: 0x9fac48, bark: 0x7a7552, cards: 34, proxyK: 0.85, proxyFlat: 1, proxyShade: 0.68 }
};
/* G2 (2026-11-11, decisión del dueño): alturas de las nativas ×1,25 (promedio ~7,2 → ~9,1 m; los árboles anteriores eran ~9,5 m),
   mismas proporciones (crownK) y misma variación por individuo (el rango se mapea desde la altura original 5-14 m).
   Boceto A de las tres especies (B y C descartados: eran solo para la revisión). */
export const TREE_ALPHA_TEST = 0.4;        // corte del alfa de las tarjetas (con MSAA se suaviza con alphaToCoverage)
export const TREE_LOD_BAND = 0.3;          // franja (fracción de treeCardDist) donde tarjetas e impostor se funden por dither
/* G2 · impostores: ya no son el elipsoide de 32 tris sino 3 quads cruzados (6 tris) con una textura horneada en el navegador
   desde el propio modelo de cada especie (treegen.buildImpostorAtlas). cardDistK agranda la distancia de las tarjetas
   (quality.treeCardDist × cardDistK; Baja sigue en 0 = solo impostor) porque el impostor nuevo es barato y se parece al árbol.
   shade = brillo del impostor para empalmar con el follaje cercano (el cercano usa normales esféricas y este normal +Y);
   alphaTest = corte del alfa horneado (bajo: los mipmaps adelgazan la silueta). */
export const TREE_IMPOSTOR = { cardDistK: 1.5, shade: 1, alphaTest: 0.32, alphaFar: [500, 2500], minSizeDist: 4000 };   // minSizeDist: desde esa distancia (m) el impostor crece ∝ d (tope ×3) para no desaparecer (1 px) en el home   // alphaFar = (m donde empieza, m donde llega) la baja del corte de alfa a 0,1 (los mipmaps adelgazan la silueta)
export const TREE_IMPOSTOR_CULL = false;   // true = respeta quality.treeImpostorDist finito (Media 1500 m): en cenital/home desaparecen todos los árboles; el impostor cuesta ~32 tris, por eso por defecto nunca se omite
export const TREE_SWAY = 0.035;            // vaivén de la copa (fracción de la altura en la punta); ≤ 1/3 del pasto
export const TREE_BAKE = { interior: 0.18, bottom: 0.14, trunk: 0.22 };   // oclusión horneada en el color de vértice (valores sRGB)
/* Ajuste en caliente de las especies (solo ?debug/?qa; para bocetos y pruebas):
   ?a2={"TREE_SPECIES":{"tala":{"cards":54,"leaf":4223793}}} se mezcla sobre TREE_SPECIES antes de construir. */
{
  const q = new URLSearchParams(location.search);
  if ((q.has("debug") || q.has("qa")) && q.get("a2")) {
    try {
      const o = JSON.parse(q.get("a2"));
      for (const k in (o.TREE_SPECIES || {})) if (TREE_SPECIES[k]) Object.assign(TREE_SPECIES[k], o.TREE_SPECIES[k]);
      if (o.TREE_IMPOSTOR) Object.assign(TREE_IMPOSTOR, o.TREE_IMPOSTOR);    // G2: ?a2={"TREE_IMPOSTOR":{"cardDistK":0.01}} = solo impostores
    } catch (e) { console.warn("a2: JSON inválido en ?a2"); }
  }
}
/* Viento en reposo (ajuste G3, 2026-11-11): con la cámara quieta, árboles y pasto siguen moviéndose si hay
   vegetación EN CUADRO a menos de WIND_IDLE_DIST m (distancia a la esfera de la celda). Rasante (~76 m) y de cerca: se
   mueve; vistas altas/cenitales (> ~250 m del follaje más cercano): no. Tope quality.idleFps (0 = apagado). */
export const WIND_IDLE_DIST = 250;
/* G5 · Pasto de corredores y parches (render/systems/grass.js + grassgen.js). Plan: realismo/PLAN_PASTO.md. Reemplazó a las matas viejas (retiradas).
     cell       lado (m) de la celda de generación bajo demanda, en coordenadas de escena
     density    plantas por m² con cobertura total (3,2); el factor por calidad la multiplica
     types      uno por tile del atlas (orden de grassgen.js): asp = ancho/alto de la tarjeta, h = rango de altura real (m)
     mix        proporción de plantas por clase, por tile (se modula con ruido de mundo cada `patchM` m, como en el boceto)
     scale      [×cerca, ×lejos, hasta m (cerca), desde m (lejos)]: rampa de escala en GPU (nunca llega a la altura de un árbol)
     fadeFrom   las plantas desaparecen entre fadeFrom·R y R (después solo queda el suelo de A4)
     nearM      hasta esa distancia (m) densidad completa; de ahí raleo por rango (aRank, chunks.js applyLod) ∝ (nearM/d)^lodPow (la escala ×2 y la desaparición en R compensan)
     innerM/K   raleo interior: dentro de innerM m la densidad baja suave hasta innerK (solo GPU; ronda de rendimiento a pie)
     byQuality  R (m) y factor de densidad por nivel; Baja = sin plantas (el suelo lo resuelve A4)
     budgetMs   tiempo máximo (ms) de generación por cuadro (siempre se genera al menos 1 celda si hay pendientes)
     maxCells   tope de celdas cacheadas por escenario (se reciclan las más lejanas)
     tiers      fracciones de la secuencia de candidatos que se generan según la distancia (las lejanas tienen menos instancias) */
export const A2_PASTO = {
  cell: 50, density: 3.2, patchM: 9,
  types: [
    { name: "gramíneas A",  asp: 1.0, h: [0.55, 0.95] },
    { name: "gramíneas B",  asp: 1.0, h: [0.55, 0.95] },
    { name: "achicoria",    asp: 0.9, h: [0.8, 1.2] },
    { name: "melilotos",    asp: 0.8, h: [0.8, 1.2] },
    { name: "alfalfa",      asp: 1.0, h: [0.6, 0.9] },
    { name: "estrato bajo", asp: 2.0, h: [0.25, 0.4] }
  ],
  //             grA   grB   achi  meli  alfa  bajo
  mix: {
    "corr-herb":   [0.38, 0.00, 0.22, 0.04, 0.16, 0.20],   // gramíneas A 38 %, achicoria 22 %, bajo 20 %, alfalfa 16 %, meliloto 4 %
    "parche-herb": [0.35, 0.35, 0.06, 0.02, 0.04, 0.18]    // gramíneas ~70 % (mitad A, mitad B), bajo ~18 %, achicoria ~6 %, alfalfa ~4 %, meliloto ~2 %
  },
  scale: [1.3, 2.0, 50, 300],
  fadeFrom: 0.75,
  nearM: 18,
  lodPow: 0.85,
  innerM: 20, innerK: 0.35,                 // raleo interior: dentro de innerM m la densidad baja suave hasta innerK (0/1 = apagado)
  lodBand: 0.15,
  byQuality: { ultra: { R: 450, dens: 1.0 }, alta: { R: 350, dens: 1.0 }, media: { R: 200, dens: 0.6 }, baja: { R: 0, dens: 0 } },
  budgetMs: 2.0,
  maxCells: 700,
  tiers: [0.125, 0.25, 0.5, 1],
  ao: { amount: 0.72, top: 0.75 }       // mismo oscurecimiento de la base que el boceto: mix(0,28, 1, smoothstep(0, 0,75, y))
};
/* === A2: fin === */

/* === A1: inicio === */
/* Niebla / perspectiva atmosférica unificada (suelo MapLibre vía capa atmo-fog + objetos Three).
   El color es el horizon-color del `sky` de map/style.js: la niebla "entra" en el degradado
   del cielo sin costura. Si un preset de hora cambia uno, cambia los dos a la vez. */
export const A1_SKY = {
  skyColor: "#87b9e0",
  horizonColor: "#dfe9d8",
  fogColor: "#e6ecdc"      // `fog-color` del sky de MapLibre (solo se ve con terreno activo, A6)
};
export const A1_FOG = {
  color: A1_SKY.horizonColor,
  near: 1200,       // m · inicio mínimo de la niebla
  nearK: 1.6,       // near >= nearK · (distancia cámara-centro): el entorno de la cámara queda nítido
  farFrac: 0.98,    // far = farFrac · distancia al suelo en la línea del sky (llega a 1 en el horizonte)
  nearMaxFrac: 0.6, // tope de near como fracción de far (garantiza rampa visible)
  max: 1.0,         // opacidad máxima de la niebla
  skyOverlapPx: 3   // la capa atmo se solapa ~3 px con la línea del sky (evita rendija oscura)
};
/* ---- 1.3: color, luz, sol, ráster (A1) ---- */
/* Render: tone mapping y exposición. Se elige con capturas (handoffs/a1-color.md).
   toneMapping: "none" | "aces" | "agx" | "neutral". */
export const A1_RENDER = { toneMapping: "agx", exposure: 1.75 };
/* Luz: hemisférica (cielo cálido / suelo = color medio del satélite del campo) + sol.
   Las intensidades están en unidades de r170 (Lambert/π ya compensado: ~1 = albedo pleno). */
export const A1_LIGHT = {
  hemiSky: "#cddbec", hemiSkyInt: 0.55,
  hemiGround: "#6d6a4c",       // default regional si el campo no tiene groundColor medido
  hemiGroundInt: 0.45,
  sunColor: "#fff1d6", sunInt: 2.2
};
/* Sol: elevación 50–55° por defecto; el azimut sale de las sombras horneadas del satélite
   (T13, método y valores en handoffs/a1-color.md). Brújula: 0 = N, 90 = E; es el azimut HACIA el sol. */
export const A1_SUN = { elevation: 52, defaultAzimuth: 40 };
/* Por campo: sunAzimuth (medido) y groundColor (color medio del satélite). */
export const A1_CAMPOS = {
  // sunAzimuth solo donde las sombras de las arboledas se midieron con confianza (a1_sun.mjs, ver handoff);
  // el resto usa A1_SUN.defaultAzimuth. groundColor = color medio del satélite crudo del campo (cenital del home).
  el_carmen: { sunAzimuth: 43, groundColor: "#6a5f45" },
  monte_hermoso: { groundColor: "#6b6247" },
  nikunihue: { groundColor: "#69604a" },
  chapa_i_iii_iv: { sunAzimuth: 19, groundColor: "#5d553e" },
  chapa_ii_v: { groundColor: "#5e5b41" },
  frente_planta_quinta_lima: { groundColor: "#55533a" },
  la_haydee: { sunAzimuth: 41, groundColor: "#5e5a3f" },
  silesia: { groundColor: "#635e42" },
};
/* Follaje: wrap lighting (cuánto "dobla" la luz del sol alrededor del volumen) y translucidez
   barata (luz que atraviesa el follaje desde atrás). 0 = Lambert puro. */
export const A1_FOLIAGE = { wrap: 0.35, trans: 0.25, lumMin: 0.09, shadow: 0 };   // copas oscuras (G1): lumMin = piso de luminancia del albedo (lineal), shadow = levantado de la cara sin sol; 0 = nada
/* Satélite (raster-*): lo lleva a la misma "foto" que el 3D. */
export const A1_RASTER = { saturation: 0.12, contrast: 0.06, brightnessMin: 0, brightnessMax: 1, hueRotate: 3 };
/* ---- 3.1: modos de hora (A1) ----
   `mediodia` NO se define acá: sale de los diales de arriba (A1_SUN, A1_LIGHT, A1_SKY, A1_RASTER, A1_RENDER, A3_SHADOWS) para que
   siga siendo exactamente la escena aprobada. Los otros modos son valores absolutos (colores sRGB hex) y se interpolan 1,5 s.
     sunElev / sunAz  elevación (°) y desplazamiento del azimut respecto del medido por campo (T13: el tope es ±35°)
     sunColor, sunInt luz directa · hemiSky/hemiSkyInt cielo del hemisferio · gTint/gInt multiplicador del color de suelo del campo
     skyColor, horizonColor, fogColor  `sky` de MapLibre (horizonColor = color de la niebla Three y de la capa atmo-fog)
     fogK             escala del inicio de la niebla (< 1 = más densa)
     expK             multiplicador de la exposición del tone mapping
     tint             multiplicador de color del suelo (pasada multiplicativa de la capa atmo-fog; "#ffffff" = nada)
     rSat, rCon, rBMin, rBMax, rHue   ajuste del ráster satelital (raster-*)
     shStr, shTint    intensidad y tinte de las sombras de los árboles (A3) */
export const A1_HORAS = {
  duracionMs: 1500,
  dorada: {
    label: "Hora dorada", sunElev: 18, sunAz: -20, sunColor: "#ffa850", sunInt: 3.4,
    hemiSky: "#8fa0c8", hemiSkyInt: 0.4, gTint: "#ffbb78", gInt: 0.45,
    skyColor: "#79aedb", horizonColor: "#f0dcb8", fogColor: "#f1ddbd", fogK: 0.85, expK: 1.0,
    tint: "#ffdcae", rSat: 0.24, rCon: 0.16, rBMin: 0, rBMax: 0.96, rHue: -4,
    shStr: 0.85, shTint: [0.42, 0.46, 0.58]
  },
  atardecer: {
    label: "Atardecer", sunElev: 8, sunAz: -35, sunColor: "#ff8a45", sunInt: 3.2,
    hemiSky: "#a99bb4", hemiSkyInt: 0.5, gTint: "#ff9c6a", gInt: 0.4,
    skyColor: "#6e84b4", horizonColor: "#f2b690", fogColor: "#efb08c", fogK: 0.6, expK: 1.1,
    tint: "#ffc79f", rSat: 0.25, rCon: 0.14, rBMin: 0, rBMax: 0.9, rHue: -6,
    shStr: 0.9, shTint: [0.46, 0.44, 0.58]
  }
};
/* Ajuste fino en caliente (solo ?debug/?qa): ?a1={"A1_RENDER":{"exposure":1.2}} mezcla sobre los diales. */
{
  const q = new URLSearchParams(location.search);
  if ((q.has("debug") || q.has("qa")) && q.get("a1")) {
    try {
      const o = JSON.parse(q.get("a1"));
      const T = { A1_RENDER, A1_LIGHT, A1_SUN, A1_FOLIAGE, A1_RASTER, A1_FOG, A1_SKY, A1_CAMPOS, A1_HORAS };
      for (const k in o) if (T[k]) Object.assign(T[k], o[k]);
    } catch (e) { console.warn("a1: JSON inválido en ?a1"); }
  }
}
/* === A1: fin === */

/* === A4: inicio === */
/* Suelo por shader (I) y surcos de cultivo (J): render/systems/ground.js. Diales: handoffs/a4-suelo.md y a4-g2.md.
   Colores base = §4 (pardo del corredor herbáceo, verde de los parches): NO se cambian. `dry`/`green` son
   variantes de pasto seco/verde de la MISMA tonalidad (±6° de matiz) que se mezclan con ruido fbm.
   Crecimiento: G2 (2026-11-11) eligió "revelado" (el suelo aparece desde el eje del polígono hacia los bordes,
   máscara por distancia al borde + tiempo). La variante "extrusión" (losa con paredes) se retiró en a4-g2: queda en
   el historial (commit 9d7ed10 de realismo-a4-suelo). */
export const A4_GROUND = {
  enabled: true,
  yOff: 0.04,          // m sobre la altura del suelo (heightAt)
  maxEdgeFlat: 300,    // m · arista máx. de la malla SIN terreno (la profundidad del revelado va en textura horneada: ~10x menos triángulos)
  maxEdge: 40,         // m · arista máx. CON terreno (la altura se pide por vértice, hay que refinar)
  /* G5 (manchas pardas con relieve): con terreno una arista > minL m también se parte si la altura real en su medio se aparta > tol m de la recta (flecha),
     y la malla se apoya a yOffRelief m (no yOff) sobre heightAt: margen contra la malla de terreno de MapLibre (±0,05 m). Chapa II-V: 17,7 k -> 49,6 k tris de suelo.
     QA: ?a4sag=<tol> (0 = como antes), ?a4minl=<m>, ?a4yoff=<m>. */
  sag: { tol: 0.15, minL: 8 },
  yOffRelief: 0.08,    // m · yOff CON terreno
  gain: 1.0,           // multiplicador de albedo (calibrado contra el suelo MapLibre anterior)
  noise: { fine: 0.10, mid: 0.13, coarse: 0.16 },   // amplitud de luminancia por escala (≈0,7 m / 4 m / 25 m)
  edgeAO: { width: 1.8, strength: 0.38 },           // m de la franja oscura hacia adentro y oscurecimiento máximo
  reveal: { soft: 0.10, jitter: 0.10 },             // suavidad del frente de revelado y ruido del frente
  /* G5 (pasto de corredores y parches, 2026-11-14): corr-herb y parche-herb se pintan con una textura de suelo generada en runtime (canvas 2D,
     pintores del boceto spikes/pasto.html: gris verdoso moteado, sombras entre matas, puntos celestes de achicoria y pocos blancos, violetas,
     amarillos y rosados). Es lo que se ve más allá del radio de las plantas de A2 (R = 450/350/200 m) y en calidad Baja (sin plantas). La
     textura se muestrea en coordenadas de MUNDO (periodo `period` m, mipmaps + anisotropía), una 2.ª vez rotada a `detailPeriod` m para
     romper la repetición (suma solo la desviación respecto de la media: no cambia el color promedio). Diales de calibración:
       gain  [corr, parche]  multiplicador de albedo RGB (calibrado contra el boceto: promedio de las plantas desde el dron / promedio del suelo = 0,76 0,85 1,0)
       tint                  amplitud del viraje seco/verde por ruido de 25 m (±)
       noiseK                fracción de la modulación de luminancia (n2, n3) que se conserva sobre la textura (el moteado ya lo da la textura)
       border/borderW        tinte multiplicativo (más verde) de la franja de borde junto al cultivo y cuánto se aplica (0 = nada)
       aoK                   fracción de la fuerza del AO de borde que se conserva (la franja ya no es solo oscura: es verde)
     Calidad Baja (`lowSoil`): sin plantas, el suelo NO se apaga: variante "simple" = una sola muestra de textura de 512², sin 2.ª muestra de
     detalle, sin ruido fino y sin la franja de AO (setDrawRange a las tapas). Ver handoffs/a4-pasto.md. */
  tex: {
    enabled: true,           // ?a4tex=0 (solo ?qa/?debug) vuelve al color plano anterior para comparar
    period: 16, detailPeriod: 27, detailAmp: 0.55,   // m
    gain: [[0.73, 0.90, 0.86], [0.74, 0.88, 0.95]], tint: 0.05, noiseK: 0.55,
    border: [0.80, 1.16, 0.70], borderW: 0.85, aoK: 0.5,
    size: { full: 1024, lite: 512 },
    /* Caminos (2026-11-17): textura de tierra y ripio (pintor ROAD_PAINT en ground.js). gain = albedo RGB; borderW = banquina verde en la franja de borde. */
    road: { gain: [1.0, 1.0, 1.0], borderW: 0.55 },
    /* Devolución G5 (Mike, 2026-11-16): el corredor/parche herbáceo se lee deslucido desde el aire; quiere un piso marrón oscuro tipo tierra arada que
       los destaque (protagonistas del rediseño). Ya no manda "mismo promedio que las plantas" sino el CONTRASTE contra los lotes. Variantes (pintores en
       ground.js): v0 = G5 original (comparar), v1 pardo oscuro como el viejo, v2 tierra arada húmeda, v3 intermedio con más verde. `variant` = la que sale
       por defecto; ?suelo=v0|v1|v2|v3 (solo ?qa/?debug). Por variante: gain [corr, parche] (albedo RGB sobre la textura) y colores de Baja (promedio de Alta). */
    variant: "v3",
    variants: {
      v0: { gain: [[0.73, 0.90, 0.86], [0.74, 0.88, 0.95]] },
      v1: { noiseK: 0.9, gain: [[1, 1, 1], [1, 1, 1]], soilK: { corr: [0.75, 0.76, 0.81], parche: [0.62, 0.72, 0.71] }, lowColor: { "corr-herb": "#51432b", "parche-herb": "#3b4623" }, lowColorExtr: { "corr-herb": "#392e1b", "parche-herb": "#2a3317" } },
      v2: { noiseK: 0.9, gain: [[1, 1, 1], [1, 1, 1]], soilK: { corr: [0.67, 0.69, 0.75], parche: [0.60, 0.67, 0.74] }, lowColor: { "corr-herb": "#332920", "parche-herb": "#283019" }, lowColorExtr: { "corr-herb": "#221c13", "parche-herb": "#1d2211" } },
      v3: { noiseK: 1.0, gain: [[1, 1, 1], [1, 1, 1]], soilK: { corr: [0.77, 0.78, 0.81], parche: [0.66, 0.79, 0.73] }, lowColor: { "corr-herb": "#4f502f", "parche-herb": "#405326" }, lowColorExtr: { "corr-herb": "#39391f", "parche-herb": "#2f3c19" } }
    }
  },
  lowSoil: true,             // Baja ya no dibuja plantas: el suelo cubre corredor y parche en vez de apagarse
  /* G5b: como se resuelve el suelo de Baja. "color" (por defecto) = SIN malla Three: se recolorean las capas MapLibre herb-ext (que Baja ya dibujaba)
     con el promedio de Alta de lejos (costo extra 0). "textura" = la variante "simple" anterior (malla + 1 textura 512²; +6 ms en la Intel HD 520). */
  lowSoilMode: "color",
  lowColor: { "corr-herb": "#6c7652", "parche-herb": "#6a754c", opacity: 1 },   // promedio de Alta de lejos (calibrado con tools/qa/a4_px.mjs); con terreno la capa es `fill` (sin luz)
  lowColorExtr: { "corr-herb": "#5a623e", "parche-herb": "#58623d" },          // sin terreno la capa es fill-extrusion: MapLibre la ilumina (~+13 %), se compensa
  classes: {
    "corr-herb":   { color: "#6b5d38", dry: "#75653a", green: "#655d38", alpha: 1.0,  tune: [0.54, 0.62, 1.02], tex: "corr" },     // G5: color/dry/green quedan de respaldo (?a4tex=0); el aspecto lo da la textura `tex`
    "parche-herb": { color: "#4d5c33", dry: "#565e34", green: "#485c34", alpha: 1.0,  tune: [0.61, 0.75, 1.06], tex: "parche" },
    "bajo":        { color: "#6f8a72", dry: "#788a70", green: "#6b8a76", alpha: 1.0,  tune: [0.62, 0.75, 0.52] },
    "parche-le":   { color: "#2e5026", dry: "#34502a", green: "#2b5028", alpha: 0.45, tune: [1.0, 1.08, 1.28] },
    "corr-le":     { color: "#2e5026", dry: "#34502a", green: "#2b5028", alpha: 0.45, tune: [1.04, 1.10, 1.26] },
    "camino":      { color: "#a8936f", dry: "#ad9672", green: "#a3906e", alpha: 1.0,  tune: [1, 1, 1], tex: "camino" }   // 2026-11-17: caminos con textura (ROAD_PAINT)
  }
};
export const A4_FURROWS = {
  enabled: true,                 // interruptor general (?surcos=0|1). Detalle inventado, no dato: decisión del dueño (D-3)
  spacing: 0.52,                 // m entre surcos (soja/maíz)
  rowAmp: 0.10,                  // modulación de luminancia (±) de los surcos
  bandAmp: 0.045,                // luminancia (±) de las bandas de 8 surcos que toman la posta a media distancia
  /* Antialias por derivadas: w = huella del píxel en períodos. El surco se funde (w en [lo,hi]) antes de acercarse al
     límite de Nyquist (w=0,5); las bandas (período ×8) igual con su propio w. Subir hi = surcos más lejos pero más moiré. */
  rowW: [0.10, 0.30], bandW: [0.05, 0.16],
  tramPeriod: 28, tramGauge: 2.8, tramWidth: 0.5, tramAmp: 0.16,   // huellas de pulverizadora
  rowFade: [350, 900],           // m · tope por distancia de los surcos (la frecuencia en pantalla suele apagarlos antes)
  tramFade: [700, 1500],         // m · huellas
  classes: ["agri", "zona1", "zona2", "zona3"],
  /* G5: dial por calidad. false = sin surcos en ese nivel (aunque `soil` sea "completo"). Hoy siguen en Ultra/Alta; se decide con la
     medición de A7 (paso 4 de PLAN_PASTO). Media ya no los dibuja (soil "sin-surcos") y Baja tampoco. ?surcos=1|0 (solo QA) pisa esto. */
  byQuality: { ultra: true, alta: true, media: false, baja: false }
};
/* Agua (M, Ola 3): render/systems/water.js. Base = #3f7fb5 (leyenda, §4): NO se cambia; somero/profundo son variantes
   de la misma tonalidad. Todo lo demás (ondulación, fresnel, destello, orilla) es textura de render, no dato. */
export const A4_WATER = {
  enabled: true,
  yOff: 0.03,                // m sobre la altura del suelo (heightAt); menor que A4_GROUND.yOff: con terreno el suelo leñoso queda encima
  shoreCell: 1.0,            // m · celda del mapa de distancia a la orilla (R8; sube sola si el agua se extiende > 2 km)
  maxEdge: 60,               // m · arista máx. de la malla (astillas del earcut de 3 km dan huecos de precisión en la GPU)
  maxEdgeRelief: 10,         // m · idem CON terreno (la altura se pide por vértice)
  color: "#3f7fb5",          // agua de profundidad media (leyenda)
  shallow: "#76a9bf",        // orilla: más clara y verdosa (se ve el fondo)
  deep: "#2c6290",           // centro del cauce
  rim: "#9ecbe8",            // reborde claro en la orilla (el mismo de la línea de MapLibre que reemplaza)
  alpha: [0.50, 0.86],       // opacidad somero → profundo (el satélite se transparenta en la orilla)
  shoreWidth: 3.2,           // m · de la orilla al "profundo"
  edgeSoft: 0.7,             // m · borde suave contra el suelo
  rimStrength: 0.30,         // intensidad del reborde claro
  waveScale: [8, 21],        // m · período de las dos capas de ondas (rotadas y con deriva distinta: sin repetición visible)
  drift: [0.030, 0.012, -0.016, 0.022],   // textura/s de cada capa (xy capa 1, xy capa 2)
  waveSlope: 0.22,           // pendiente máxima de las normales animadas
  waveFade: [220, 800],      // m · las ondas se aplanan con la distancia (sin parpadeo; el fresnel hace el resto)
  f0: 0.02,                  // reflectancia a incidencia normal (agua)
  gain: 0.82,                // calibración del cuerpo del agua (paridad de leyenda contra el agua anterior: ΔE de la media)
  reflection: 0.55,          // intensidad del cielo reflejado (cielo de MapLibre aproximado: zenit → horizonte/niebla)
  spec: [300, 0.8],          // brillo del destello del sol: exponente, intensidad
  lineOpacity: 0,            // opacidad de la línea `*-agua-line` de MapLibre cuando el shader está activo (0 = apagada)
  idleMaxDist: 1000,         // m · más lejos que esto no hace falta animar en reposo (lazo acotado, T7)
  /* Cursos angostos (G3: Chapa II-V, ~2,4 m, se leía como camino de tierra). Con semi-ancho local <= hw[0] el ajuste es total, con >= hw[1] no
     hay ajuste (Nikunihué y El Carmen no cambian). Ajuste: cuerpo azul oscuro y casi opaco, menos cielo reflejado, sin reborde claro y borde corto. */
  narrow: { enabled: true, hw: [1.4, 2.0], color: "#356fa0", alpha: 0.92, reflection: 0.35, rim: 0.15, edge: 0.3 }
};
/* === A4: fin === */

/* === A6: inicio === */
/* Presencia de la niebla (2026-11-13, pedido de Mike: "podría ser excesiva"). UN solo lugar para ajustarla en Three (curva plana y curva de
   relieve de lighting.js / shaderlib.js) y en MapLibre (sky fog-ground-blend y horizon-fog-blend con relieve). El horizonte NO se corta: la
   niebla sigue llegando al 100 % en el horizonte (curva plana) / en el plano lejano (relieve); solo se corre hacia allá y pesa menos a media distancia.
     nearMul   × el inicio de la niebla plana (near) y de su tope nearMaxFrac (1 = como antes)
     curvePow  exponente sobre la curva plana (smoothstep^p · max): > 1 = menos niebla a media distancia, igual en el horizonte (1 = como antes)
     groundBlend / horizonBlend   fog-ground-blend (la niebla de relieve arranca más lejos) y horizon-fog-blend (banda de bruma del cielo) con relieve
   `?niebla=<f>` (solo con ?qa/?debug, 0,5-1,5): 1 = valores de abajo; 1,5 = como antes de este ajuste; 0,5 = el doble de reducción. */
const _NB_OLD = { nearMul: 1, curvePow: 1, groundBlend: 0.3, horizonBlend: 0.5 };
const _NB_NEW = { nearMul: 1.3, curvePow: 1.7, groundBlend: 0.45, horizonBlend: 0.36 };
export const A6_NIEBLA = (() => {
  const q = new URLSearchParams(location.search);
  /* Mike 2026-11-13: eligió ?niebla=0.5 → es el valor por defecto (doble reducción respecto de A6 G4-fix). ?niebla= sigue para comparar (0.25–1.5; 1.5 = la de antes). */
  const NIEBLA_DEF = 0.5;
  const f = (q.has("qa") || q.has("debug")) && q.get("niebla") ? Math.min(1.5, Math.max(0.25, parseFloat(q.get("niebla")) || NIEBLA_DEF)) : NIEBLA_DEF;
  const R = (1.5 - f) / 0.5;   // 0 = antes, 1 = valores nuevos, 2 = doble reducción
  const m = n => _NB_OLD[n] + (_NB_NEW[n] - _NB_OLD[n]) * R;
  return { factor: f, nearMul: Math.max(1, m("nearMul")), curvePow: Math.max(1, m("curvePow")), groundBlend: Math.min(0.85, m("groundBlend")), horizonBlend: Math.max(0.1, m("horizonBlend")) };
})();
/* Terreno 3D real y sombreado de relieve: terrain/terrain.js + terrain/heightfield.js (A6-2).
   Diales y calibración: handoffs/a6-terreno.md. Fuente DEM: tiles "terrarium" de AWS (Mapzen/Tilezen
   Terrain Tiles, dataset abierto; en la zona sale de SRTM de 30 m). Autorizada por el dueño 2026-11-10. */
export const A6_TERRAIN = {
  enabled: true,            // interruptor general del terreno 3D (el hillshade tiene el suyo, abajo)
  demUrl: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  demZoom: 13,              // z13: ~0,5 MB por campo, error de malla ±0,05 m a zoom ≥ 15,6 (spike A6-1). Mismo valor en la fuente raster-dem y en heightAt
  exaggeration: 1.0,        // factor vertical del relieve (heightAt devuelve m·exag). 1 = fiel; también por campo (abajo) y con ?exag= (solo ?debug/?qa)
  /* Activación automática (calibrada con los 8 campos, spike A6-1): sobre una grilla de 30 m del DEM, con
     mediana 3×3 y pendiente con línea de base de `baselineM`, dentro de los polígonos del campo.
     Terreno ON si desvioResidual > X m (desvío tras restar el plano de mejor ajuste) o pendienteP95 > Y %. */
  auto: { desvioResidual: 2.7, pendienteP95: 2.5, baselineM: 240 },
  /* 2026-11-18 (Mike): TODOS los campos tienen relieve disponible (El Carmen tiene zonas onduladas que la regla automática daba por llano);
     el usuario lo apaga con el conmutador. La regla `auto` queda solo como dato (terrain.stats / terrain.reason). false = volver a la regla. */
  todos: true,
  /* Override por campo (id de campo): { terreno: true|false, exag: n }. Tiene menos prioridad que el campo
     `terreno` de campos.local.json / la tabla `campos`, y que ?terreno=0|1 en la URL (la más fuerte). */
  campos: {
    nikunihue: { terreno: true },   // G2 (Mike): forzado para que se vea el escarpe, donde el terreno esté activo por calidad (quality.terrain)
  },
  /* Sombreado de relieve (hillshade MapLibre), sutil y en TODOS los campos. La luz sale del azimut del sol de
     A1 (A1_CAMPOS[campo].sunAzimuth, o A1_SUN.defaultAzimuth). */
  hillshade: {
    enabled: true,
    maxzoom: 13, tileSize: 256,   // G2: fuente del hillshade (más barato con maxzoom menor / tileSize 512); ver handoffs/a6-calidad.md
    exaggeration: 0.4,      // 0..1: intensidad (0,5 es el default de MapLibre; 0,28 era imperceptible, dE<0,7; 0,6 ya moteaba el llano con el ruido del SRTM)
    shadow: "#26301a", highlight: "#fff6e0", accent: "#26301a"
  },
  /* Con terreno MapLibre aplica su PROPIA niebla sobre la malla (por profundidad real), así que la capa atmo-fog de A1
     (que supone suelo plano) se apaga en los campos con terreno y se ajusta la niebla de MapLibre para que se parezca
     (fog-ground-blend: 0 = la niebla arranca en el centro de la vista, 1 = recién en el horizonte). */
  sky: { fogGroundBlend: A6_NIEBLA.groundBlend, horizonFogBlend: A6_NIEBLA.horizonBlend },   // ver A6_NIEBLA (arriba)
  attribution: "Relieve: Terrain Tiles (AWS) · SRTM y GMTED2010 cortesía del USGS · ETOPO1 NOAA/NCEI",   // G4: va en la fuente raster-dem "dem": solo aparece con el relieve cargado
  /* Ola 4 · 4.2: costo del terreno en movimiento (handoffs/a6-ola4.md). Interruptores sobre MapLibre 4.7.1 (campos internos, versión vendorizada).
     Resultado de 4.2 (Intel HD 520, tour Chapa I-III-IV +41 → +12 ms): el costo no era el hillshade ni la malla sino (1) la ScaleControl
     (2 readPixels síncronos por 'move'), (2) el caché de RTT de 30 texturas con 32-34 teselas visibles en rasante (se recreaban todas
     por frame) y (3) texturas de 1024 px por tesela. Valores por defecto = los que convienen; los de MapLibre están entre paréntesis.
     rttQuality: factor de la textura de render-a-textura de cada tesela de terreno ("auto" = pixelRatio del mapa entre 1 y 2; MapLibre: 2 → 1024 px por tesela de 512).
     meshSize: lado de la grilla de la malla de terreno (MapLibre: 128 → 16 641 vértices por tesela). Con los valores de MapLibre no cambia nada.
     rttPool: cantidad de texturas de RTT que MapLibre guarda en caché (30; 48 cubre los 32-34 tiles del rasante con pitch alto). scaleThrottleMs: tope de refresco de la barra de escala de MapLibre durante el movimiento (0 = sin tope, como MapLibre; hallazgo de 4.2: con terreno cada refresco hace 2 readPixels síncronos). En QA: ?scale= ?rtt= ?mesh= ?pool= ?demz= . */
  perf: { rttQuality: "auto", meshSize: 128, rttPool: 48, scaleThrottleMs: 3000 },
  /* Relieve en vivo (2026-11-13, handoffs/a6-relieve-vivo.md). transitionMs: duración (smoothstep) de encender/apagar. safetyMs: umbral del p50
     de frame en movimiento con el relieve activo, por encima del cual se apaga solo (mismo criterio que la autodegradación de Ultra, quality.js). */
  relief: { transitionMs: 1200, safetyMs: 33 }
};
/* === A6: fin === */

/* === A3: inicio === */
/* Sombras reales de los árboles (render/systems/shadows.js). Diales y método: handoffs/a3-sombras.md.
   Pase propio de profundidad (cámara ortográfica ajustada a la zona útil, snapping al texel) +
   receptor multiplicativo sobre el suelo + blobs instanciados para lo lejano. */
export const A3_SHADOWS = {
  enabled: true,               // false = todo apagado (vuelven las manchas-sombra GeoJSON de MapLibre). También ?sombras=0
  hideMapLibre: true,          // apaga las capas *-tree-shadows (el dato GeoJSON no se toca)
  tint: [0.40, 0.48, 0.58],    // multiplicador RGB del color bajo sombra (en espacio de pantalla): azulado-verdoso
  strength: 0.80,              // 0..1 · cuánto del tinte se aplica en sombra plena (factor final ≈ 0,52/0,58/0,66 sobre lo que haya debajo)
  zoneK: 1.1,                  // lado de la zona útil = distancia cámara-objetivo × zoneK (~330 m en el rasante, ~1,4 km a z15)
  zoneMin: 160, zoneMax: 2400, // m · lado mínimo y máximo de la zona
  zoneStep: 1.25,              // el tamaño de la caja se cuantiza en pasos geométricos (evita que cambie de tamaño todo el tiempo)
  margin: 1.45,                // la caja del mapa de sombras = zona × margin: se recalcula solo cuando la cámara sale del margen
  edge: 0.06,                  // franja (fracción del mapa) donde la sombra real se funde con los blobs
  cardDist: 330,               // m · dentro de esta distancia al centro de la caja los árboles proyectan con tarjetas; más lejos, con el impostor
  cardMaxTexel: 0.6,           // m · si el texel del mapa es más grande que esto, todos proyectan con el impostor (las hojas no se resuelven)
  biasM: 0.12,                 // m · sesgo de profundidad del receptor (suelo plano: casi nada)
  soft: true,                  // 4 muestras de PCF por píxel en el suelo (false = 1 muestra)
  grass: "ultra",              // quién recibe sombra en las matas: "ultra" (solo Ultra) | "alta" (Ultra y Alta) | "off" (en este dato casi no se nota: ver handoff)
  blob: { strength: 0.80, centerK: 0.62, capOff: 3.2, capLen: 3.6 }   // intensidad, altura relativa del centro de copa, topes de desplazamiento (× altura) y largo (× radio)
};
/* Ajuste en caliente (solo ?debug/?qa): ?a3={"strength":0.5,"zoneK":0.9} se mezcla sobre A3_SHADOWS. */
{
  const q = new URLSearchParams(location.search);
  if ((q.has("debug") || q.has("qa")) && q.get("a3")) {
    try { Object.assign(A3_SHADOWS, JSON.parse(q.get("a3"))); } catch (e) { console.warn("a3: JSON inválido en ?a3"); }
  }
}
/* === A3: fin === */

/* === A5: inicio === */
/* Fauna (render/systems/fauna.js): aves en bandadas y polinizadores. Diales y método: handoffs/a5-fauna.md.
   Todo procedural (sin assets). Semilla fija: la misma fauna en cada carga (con ?qa y sin él). */
export const A5_FAUNA = {
  /* Anclas herbáceas (herbPoints en fauna.js): números heredados de las matas viejas (retiradas) para que la fauna caiga exactamente donde siempre.
     k = índice histórico de la clase (entra en la semilla). */
  herbAnchors: {
    "corr-herb":   { k: 0, density: IS_MOBILE ? 1000 : 1500, max: IS_MOBILE ? 100000 : 180000 },
    "parche-herb": { k: 1, density: IS_MOBILE ? 500 : 800,   max: IS_MOBILE ? 60000 : 120000 }
  },
  enabled: true,               // false = sin fauna. También ?fauna=0 (con ?qa/?debug)
  seed: 0xA5F0,                // semilla base (se suma 1 en inicial, 2 en multi)
  ratioInicial: 0.25,          // D-4: proporción inicial : multi = 1 : 4 (aves). Los polinizadores usan butterflyInicial
  birds: {
    treesPerBird: 25,          // el total de aves de multi sale de (árboles del escenario / esto), entre min y max
    min: 40, max: 130,
    flockSize: [8, 25],        // individuos por bandada
    anchorCell: 300,           // m · celda para buscar parches leñosos (centros de gravedad de los árboles)
    anchorMinTrees: 8,         // árboles mínimos en una celda para que sea un parche donde anidan
    corrNear: 350, corrBonus: 3,  // parches a < corrNear m de un corredor herbáceo valen ×corrBonus al elegir dónde van las bandadas (se ven desde el rasante)
    corrNear: 350, corrBonus: 3,  // parches a < corrNear m de un corredor herbáceo valen ×corrBonus al elegir dónde van las bandadas (se ven desde el rasante)
    anchorSep: 380,            // m · separación mínima entre recorridos de bandadas distintas
    orbit: [90, 190],          // m · radio del recorrido alrededor del parche (se suma la dispersión del parche)
    alt: [25, 56],             // m sobre el suelo · el piso se calcula también contra el árbol más alto (treeClear)
    treeClear: 7,              // m · colchón mínimo sobre la copa más alta de TREE_SPECIES (sin atravesar árboles)
    speed: [8, 13],            // m/s
    span: 2.2,                 // m · envergadura (G3: -35 % respecto de 3,4; escala estilizada, de 100-300 m se sigue leyendo gracias a farBoost)
    spanVar: 0.3,              // ± fracción
    flapHz: [2.0, 2.8],        // aleteo
    boostFrom: 180, farBoost: 2.2,   // desde boostFrom m el ave crece ∝ distancia (tope ×farBoost): a 400 m se sigue leyendo (≈ 20 px)
    maxDist: [900, 1400],     // m · se encogen a 0 entre estas distancias a la cámara (sub-píxel: no vale dibujarlas)
    palette: [[0x34373a, 0.58], [0x5d5249, 0.24], [0x85807a, 0.10], [0xe7e4da, 0.08]]   // [color sRGB, peso]
  },
  butterflies: {
    /* G3 (Mike): detalle de la escena, no protagonista. ~20 % de la cantidad anterior, mitad de tamaño, solo cerca
       de la cámara (navegación manual); en el rasante (~76 m) apenas. A cambio, geometría con forma (18 tris, 2 pares de alas). */
    tuftsPerButterfly: { "corr-herb": 130, "parche-herb": 1500 },   // 1 polinizador cada N matas (en multi): 5x más ralo que antes (26 / 300)
    max: 4000,                 // tope por escenario (solo se dibujan las celdas a < visDist de la cámara)
    inicial: 0,                // fracción de multi en el escenario inicial (casi ninguno: 0 = ninguno)
    cell: 120,                 // m · celda de instanciado (una InstancedMesh por celda; chica para descartar rápido las lejanas)
    visDist: [115, 185],       // m · se achican a 0 entre estas distancias. Con maxZoom 17.8/pitch 80 el suelo visible más cercano está a ~125 m (al pie del cuadro): ahí se ven; en el rasante (~155 m al pie) apenas
    farBoost: 1.8,             // entre 60 m y visDist[1] crecen hasta ×1,8 (antes ×2,2 hasta 260 m): a ~125 m (lo más cerca que llega la cámara) miden ~1,4 m = 15 px
    span: 1.0,                 // m · envergadura media (antes 2,2; con la variación individual 0,8-1,3 ×)
    alt: [1.6, 4.2],           // m · sobre el suelo (las matas miden 2-4,7 m; algunas vuelan entre ellas, otras por encima)
    wander: [4, 10],           // m · radio de vuelo errático alrededor de la mata
    palette: [[0xffc81e, 0.30], [0xf2761a, 0.30], [0xf4f1e6, 0.22], [0x4f8fe0, 0.18]]   // amarilla, naranja, blanca, azul
  }
};
/* Ajuste en caliente (solo ?debug/?qa): ?a5={"ratioInicial":0.5} se mezcla (superficial) sobre A5_FAUNA. */
{
  const q = new URLSearchParams(location.search);
  if ((q.has("debug") || q.has("qa")) && q.get("a5")) {
    try {
      const o = JSON.parse(q.get("a5"));
      for (const k in o) { if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) && A5_FAUNA[k]) Object.assign(A5_FAUNA[k], o[k]); else A5_FAUNA[k] = o[k]; }
    } catch (e) { console.warn("a5: JSON inválido en ?a5"); }
  }
  if ((q.has("debug") || q.has("qa")) && q.get("fauna") === "0") A5_FAUNA.enabled = false;
}
/* === A5: fin === */

/* === HIDRO: inicio === */
/* Simulador de escorrentía (js/hydro/**). Modelo y fuentes de cada número: docs/hidro/MODELO.md.
   Los módulos de cálculo (grid/fill/flow/classes/runoff) son puros y corren también en el worker y en Node, donde
   este archivo no se puede importar (toca window/location): reciben estos valores por parámetro (state.js los arma
   con `paramsMotor()` y los manda en el mensaje al worker). Nada de números mágicos en hydro/. */
export const HIDRO = {
  /* --- lluvia --- */
  rain: { default: 50, min: 10, max: 100, step: 5 },   // mm/h, intensidad en el pico (deslizador F3)
  pCn: 80,                  // mm · lámina de diseño con la que se calcula C = Q_cn(P)/P (MODELO §2.6)
  /* --- grilla --- */
  zoom: 13,                 // DEM terrarium z13 (mismo que A6_TERRAIN.demZoom)
  metrosPorPx0: 156543.03392,   // m/píxel a z0 en el ecuador (la celda es esto / 2^z · cos(lat))
  margenCuencaM: 1500,      // m · margen alrededor del campo: el agua viene de afuera del lote
  /* --- relleno y flujo --- */
  epsFill: 1e-4,            // m · épsilon del Priority-Flood (Barnes 2014)
  mfdP: 3,                  // exponente de Holmgren
  contorno: { cardinal: 0.5, diagonal: 0.354 },   // largos de contorno de Quinn
  sMin: 0.004,              // m/m · piso de la pendiente local
  pasadasDir: 2,            // cajas 3×3 sobre la dirección media
  pasadasPendiente: 2,      // cajas 3×3 sobre el DEM antes de derivar
  eps: { dir: 1e-9, hMin: 1e-6, vMin: 1e-4 },   // normalización de la dirección · piso de h en v=q/h · piso de v en log
  /* --- clases: _cls → CN (grupo B) y n de Manning (MODELO §3). "supuesto" = a validar por un especialista --- */
  claseFuera: "agri",       // lo que no cae en ningún polígono se trata como agrícola
  clases: {
    "agri":          { cn: 78, n: 0.10 },   // TR-55 cultivo en hileras
    "zona1":         { cn: 78, n: 0.10 },
    "zona2":         { cn: 78, n: 0.10 },
    "zona3":         { cn: 78, n: 0.10 },
    "otros":         { cn: 78, n: 0.10 },
    "corr-herb":     { cn: 61, n: 0.24 },   // TR-55 pastura buena, dense grasses
    "parche-herb":   { cn: 61, n: 0.24 },
    "corr-le":       { cn: 55, n: 0.40 },   // TR-55 bosque bueno, woods light underbrush
    "parche-le":     { cn: 55, n: 0.40 },
    "instalaciones": { cn: 86, n: 0.05 },   // supuesto
    "camino":        { cn: 82, n: 0.03 },   // TR-55 caminos de tierra
    "ganaderia":     { cn: 69, n: 0.15 },   // supuesto, a validar
    "suelo-desnudo": { cn: 86, n: 0.05 },   // supuesto, a validar
    "bajo":          { cn: 70, n: 0.24 },   // supuesto, a validar
    "agua":          { cn: 98, n: 0.03 }    // supuesto
  },
  /* --- disponibilidad (MODELO §4): mismos umbrales que la activación automática del terreno --- */
  disponibilidad: { desvioResidual: A6_TERRAIN.auto.desvioResidual, pendienteP95: A6_TERRAIN.auto.pendienteP95 },
  /* --- estadísticos --- */
  stats: { vAltaMs: 0.3, frenaDlog: -0.25 },   // ha con v > 0,3 m/s · "frena ≥ 16 %" = log2(v_multi/v_ini) < −0,25
  /* --- visualización (la usan render y UI; el motor solo la guarda) --- */
  vis: {
    opacidad: { default: 1, min: 0.1, max: 1, step: 0.05 },   // slider del panel: transparencia de las capas del simulador (independiente del diseño)
    vMinMs: 0.02, vMaxMs: 1.5,             // rango de la paleta turbo (log10) y de la leyenda
    marcasMs: [0.02, 0.05, 0.1, 0.2, 0.5, 1, 1.5],
    hVisibleM: 0.02, hOpacoM: 0.2,         // lámina desde la que se ve el agua / donde ya es opaca
    estelaSegundos: 320, estelaMinM: 45, estelaMaxM: 420,   // largo de estela ≈ v·320 s, acotado
    /* lámina de agua "natural" (sistema runoff.js; antes la constante NAT) */
    natural: {
      colShallow: "#60a0c4", colDeep: "#1e5280",   // somero → profundo (MODELO §6)
      yOff: A4_GROUND.yOffRelief + 0.04,           // m sobre heightAt: por encima del suelo y del margen de la malla de MapLibre
      alphaMin: 0.20,                              // alfa de la lámina recién visible (h ≈ hVisibleM)
      alphaMax: 0.95,                              // alfa con lámina ≥ hOpacoM
      edgeNoise: 0.6,                              // celdas · distorsión de dominio del borde (ruido estático)
      outside: 0.35,                               // alfa relativa fuera del campo (cuenca de aporte atenuada)
      gain: 0.82,                                  // calibración del cuerpo (igual que A4_WATER.gain)
      waveScale: [5, 11],                          // m · período de las dos capas de normales
      waveSlope: 0.30,                             // pendiente máx. de las normales
      waveFade: [160, 600],                        // m · las ondas se aplanan con la distancia
      cycle: 2.0,                                  // s · ciclo de las dos fases cruzadas del flowmap
      speedBase: 0.15, speedGain: 2.0,             // rapidez visual de las ondas (m/s) = base + gain·v
      reflection: 0.55, spec: [300, 0.8], f0: 0.02,   // reflejo, brillo especular [exponente, intensidad], reflectancia a 0°
      idleMaxDist: 1500                            // m · más lejos no hace falta animar en reposo
    },
    /* mapa de velocidad: turbo sobre log10(v) en [vMinMs, vMaxMs] */
    velocidad: {
      opacidad: 0.85,                              // alfa del mapa sobre el satélite
      bordeSuaveCeldas: 3,                         // celdas · difuminado del borde del campo
      /* subida del agua sobre el relieve (uLift; en runoff.js era LIFT/uLift0): y += liftDist·max(dist_cam − liftDistDesdeM, 0) + liftFijoM.
         liftDist (m por m) y liftDistDesdeM aplican a TODAS las capas (natural, velocidad, estelas); liftFijoM solo a velocidad y estelas (la natural no lo usa) */
      liftDist: 0.002, liftDistDesdeM: 600, liftFijoM: 0.4,
      haloM: 300                                   // m · el mapa se desvanece a 0 a esta distancia del borde del campo
    },
    /* partículas de flujo */
    particulas: {
      presupuesto: { ultra: 20000, alta: 15000, media: 8000, baja: 0 },   // partículas animadas por calidad
      vidaS: [2, 6],                               // s · vida de cada partícula (rango aleatorio)
      puntosEstela: 8,                             // puntos de la cola
      /* velocidad visual = v·exageracion m/s. La cola abarca ~2 s de historia, así que su largo es
         v·exageracion·2 = v·estelaSegundos (320) → exageracion = 160 */
      exageracion: 160,
      anchoPx: 1.75,                               // px · ancho de la estela
      alfaCabeza: 0.9,                             // alfa en la cabeza (la cola se desvanece)
      estaticasBaja: 3000,                         // estelas estáticas precalculadas en Baja (sin animación)
      factorMovil: 0.5,                            // × presupuesto de partículas con IS_MOBILE (G2-1a); lo aplica el render
      idleMaxDistM: 8000,                          // m · las estelas se animan en reposo hasta esta distancia de la cámara (la natural: 1500)
      yExtraM: 0.06,                               // m · sobre la grilla del mapa de velocidad
      pesoFuera: 0.05,                             // peso de reaparición de una celda fuera del campo vs una de adentro
      pesoRapidez: 2.0,                            // peso extra en celdas rápidas (cauces angostos)
      fadeInS: 0.4, fadeOutS: 0.6,                 // s · envolvente de alfa al nacer / al morir
      distAlfa: [1500, 5000, 0.5],                 // m · alfa pleno hasta [0], baja a [2]× hacia [1]
      distFrac: [2500, 7000, 0.35],                // m · fracción de estelas dibujadas: todas hasta [0], [2] hacia [1]
      rasante: [0.10, 0.55, 0.06],                 // seno de elevación de la vista: alfa × [2] bajo [0], pleno desde [1]
      pasoColaM: 6,                                // m · paso máximo al marchar la cola
      giroColaCos: 0.5,                            // coseno mínimo entre pasos de la cola (60°); si no, se corta
      subdivBaja: 3                                // subdivisiones por tramo en Baja (estelas fijas)
    },
    /* vista Diferencia (MODELO §6): log2(v_multi/v_ini) divergente; frena = azul, acelera = naranja/rojo */
    diferencia: {
      umbral: 0.06, saturacion: -1.15,             // única fuente (antes difUmbral/difSatura); saturado en −55 % de velocidad (log2(0,45) = −1,15)
      colFrena: ["#96cdff", "#1946c8"],            // de umbral a saturación, desaturando hacia el satélite
      colAcelera: ["#ffbe8c", "#c8321e"],
      opacidad: 0.85,                              // igual que velocidad
      traza: {                                     // contorno punteado del diseño (corredores y parches)
        clases: ["corr-herb", "corr-le", "parche-herb", "parche-le"],
        color: "#ffffff", alfa: 0.9, rayaPx: 8, huecoPx: 6, anchoPx: 1.5
      },
      /* métricas del panel: nombres exactos en result.stats (ver handoff F4) */
      metricas: ["inicial.haVMayor", "multi.haVMayor", "inicial.vMediaMs", "multi.vMediaMs", "frenaHa"]
    },
    marca: { texto: "Ilustrativo · No es un estudio hidrológico" }   // marca chica sobre el mapa mientras el simulador está prendido
  },
  /* --- worker --- */
  worker: { tiempoMaxMs: 1500 }            // objetivo de PLAN §5 (los dos escenarios); solo informativo
};
/* === HIDRO: fin === */
