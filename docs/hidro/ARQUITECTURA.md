# Arquitectura del visor — lo que importa para el simulador

Relevado del código el 2026-11-20 (versión de caché `20261120`, commit `b386383`). Si algo cambió, manda el código.
Rutas relativas a la raíz del repo.

## 1. Mapa de archivos
```
index.html            panel estático (#panel, .panel-section, #quality-section) + importmap ("three" → vendor/three.module.js)
js/auth.js            script clásico (no módulo): login Supabase, window.AD_AUTH, modo ?local, window.AD_BOOT()
js/app.js             entrada ES: bootEscenario() → loadCampos, loadData, initTerrain, addScenarioLayers, updatePanel
js/core/
  config.js           TODOS los diales, en secciones por dueño (/* === A4: inicio === */ … fin)
  state.js            state {scenario, campo, data{inicial,multi}, bbox, …}, params, DEBUG, HOME_VIEW (binding vivo)
  events.js           bus: on/off/emit/hasListeners; EVENTS = ["scenario","preset","quality","frame", …]
  quality.js          LEVELS ultra/alta/media/baja, objeto `quality` mutable, setQuality → emit("quality")
  relief.js           puente UI ↔ terreno (relieve prendido/apagado, preferencia en localStorage "ad_relieve")
  geo.js              mulberry32, pointInPolygon, ringBBox, ringAreaHa, scatterInClasses, normalizeGeometry
  camera.js           updateCamera / getCamera (cámara real)
js/map/
  style.js            crea `map` (maplibregl.Map) y mapStyle
  data.js             loadCampos, loadData, classify(props) → `_cls`, computeHomeView, generateTreeData
  layers.js           capas MapLibre por escenario (SCENARIO_LAYERS, applyOpacity, applyGrowth); host.addToMap(map)
  scenario.js         setScenario(next, animate): emit("scenario") + fundido 700 ms / crecimiento 1800 ms
js/render/
  host.js             capa custom "veg-3d" que contiene los sistemas (registro al final del archivo)
  idle.js             idleDriver: repintado en reposo acotado (request(owner, activo))
  shaderlib.js        niebla (GLSL_FOG_UNIFORMS, GLSL_ADFOG), fade dither, patch/patchExtra, scenarioFade
  lighting.js         uniforms globales (uTime, uCamPos, sol, hemisferio, niebla), lights, presets de hora
  systems/            trees, grass, ground (+ dedupRing, triangulatePoly), water, shadows, fauna, chunks (chainShader)
js/terrain/
  terrain.js          relieve: terrain{…}, heightAt, reliefU, GLSL_DECL/a6Low, lowAt, setRelief, onReliefStep
  heightfield.js      loadHeightfield(bbox,{z}), class Heightfield, lonLatToPixel, reliefStats()
js/ui/                controls.js (botones, conmutador, slider opacidad), panel.js, presets-ui.js, relief-ui.js, quality-dd.js
js/debug/qa-api.js    window.__nav3d (solo con ?qa o ?debug)
tools/stamp_version.mjs   sella ?v= en todo el grafo de módulos
vendor/               maplibre-gl 4.7.1, three.module.js r170, supabase.js
```
Unidades de escena: **metros**, X = este, Y = arriba, Z = sur, centrado en `HOME_VIEW.center`.

## 2. Contrato de un sistema de render (`js/render/host.js`)
Un sistema es un objeto `export default { … }` con:
- `id` (string) y `build(ctx, scenarioKey, data, veg) → { object3d, materials }` — **obligatorios**.
- Opcionales: `setOpacity(key, o)`, `setGrowth(key, t)`, `update(frame)`, `onQuality(q)`, `setRelief(k, final)`,
  `onRenderer(renderer, scene)`, `stats(key)`, `dispose()`.

`ctx = { THREE, toScene(lon,lat)→[x,z], toLngLat(x,z), heightAt(lon,lat), heightAtScene(x,z), quality, shaderlib, uniforms, config, rng }`.

`frame = { now, dt, camPosScene (Vector3), viewProj, camera, quality, preset }`.

**Ciclo de vida**
- `host.onAdd` construye **una sola vez por carga de página**, para `["inicial","multi"]` y para cada sistema registrado,
  llamando `build(ctx, key, state.data[key], state.veg[key])`; agrega el resultado a `host.groups[key]`.
- **No hay reconstrucción**: cambiar de campo recarga la página; cambiar de escenario solo hace el fundido.
  Un sistema que necesita datos asíncronos (el worker) crea en `build` objetos vacíos/invisibles y los completa después.
- Cada material de `built.materials` recibe `patchExtra(m, {fog:true…})` (+ `patchGrowth` con relieve). Los sistemas con
  ShaderMaterial propio (agua, suelo) devuelven `materials: []` y manejan su niebla y fade.
- Por frame (`host.render`): uniforms globales → `idleDriver.frame()` → `sys.update(frame)` de cada sistema →
  `emit("frame")` → `renderer.render`.
- Registro: al final de `host.js`, `host.register(x)` en orden (trees, grass, ground, water, shadows, fauna). El simulador
  agrega `import runoff from "./systems/runoff.js?v=…"` y `host.register(runoff)` (dueño: hidro-plataforma).

**Fundido de escenarios**: `setScenario` → `layers.applyOpacity` → `host.setOpacity(key, o)`, que escribe
`scenarioFade[key].value = o` (`shaderlib.js`), llama `sys.setOpacity` y oculta el grupo con `o ≤ 0,02`. Un ShaderMaterial
propio pone `uFade: scenarioFade[key]` en sus uniforms y multiplica el alfa (así lo hace `water.js`).

**Orden de dibujo** (todo en la lista opaca, con mezcla a medida): surcos −20, suelo −10, **receptor de sombras −9**
(multiplica lo que ya está dibujado), agua −11. Lo que dibuje antes de −9 recibe las sombras de los árboles gratis.

## 3. Reposo, calidad y eventos
- `idleDriver` (`js/render/idle.js`): cada sistema animado llama `idleDriver.request("<id>", activo)` en su `update`.
  El driver repinta a `quality.idleFps` (Ultra/Alta 30, Media 20, Baja 0) solo con la cámara quieta, la pestaña visible y el
  tiempo sin congelar. **Nunca un `requestAnimationFrame` propio.**
- `quality` (`js/core/quality.js`): objeto único y mutable; campos `msaa, pixelRatioCap, shadows, soil, fauna, water
  ("shader"|"plano"), idleFps, terrain…`. Los sistemas lo leen directo y reaccionan en `onQuality(q)`.
- Eventos (`js/core/events.js`): `on(name, fn)` devuelve la función para desuscribirse. **Un evento nuevo se agrega a
  `EVENTS`** (hoy: scenario, preset, quality, frame, más relief:state y relief:auto-off que agrega `core/relief.js`).

## 4. Terreno (`js/terrain/terrain.js`, `js/terrain/heightfield.js`)
- `terrain` (estado): `active` (estructural, fijo en la sesión), `available`, `on`, `k` (factor vivo 0..1), `mesh`,
  `unavailable` ("llano" | "sin-dem"), `exag`, `hf` (Heightfield o null), `stats` (reliefStats del campo), `reason`.
- `heightAt(lon, lat)`: altura **completa** (k = 1) × exageración; 0 sin terreno. Es lo que se hornea en las mallas.
- Relieve vivo: el shader resta `(1-k)·exag·DEM` con `a6Low(xz)`; en CPU el espejo es `lowAt(x, z)`.
  - `GLSL_DECL`: declara `uA6H` (textura R32F del DEM), `uA6P` (afín escena→píxel: `fx = x·P.x + P.y`, `fy = z·P.z + P.w`),
    `uA6L`, `uA6K`, `a6Hf(xz)` y `a6Low(xz)`. Uso típico en un vertex shader propio: `w.y -= a6Low(w.xz);`
    (ver `water.js`). `withReliefU(uniforms)` mezcla esos uniforms.
  - `onReliefStep(fn)` / `sys.setRelief(k, final)`: para lo que se decida en CPU.
- `Heightfield`: `data` (Float32Array en metros, sin exagerar, fila mayor `w × h`), `z` (13), `px0`, `py0` (origen en
  píxeles globales a zoom z), `bbox`, `heightAt(lon,lat)` bilineal, `reliefStats({stepM, baselineM, despeckle, mask})`.
  `lonLatToPixel(lon, lat, z)` está exportada. El DEM se carga con 0,01° de margen alrededor del campo: para la cuenca de
  1,5 km puede hacer falta un `loadHeightfield` propio (mismo z13, misma URL `A6_TERRAIN.demUrl`).
- `terrain.hf` es null con `?terreno=0` o si el DEM falló → el simulador queda no disponible ("sin-dem").
- Disponibilidad del simulador: usar `terrain.stats` con el criterio de `A6_TERRAIN.auto` (desvío residual > 2,7 m o
  pendiente p95 > 2,5 %), **no** `terrain.available` (hoy vale true en todos los campos por decisión del dueño).

## 5. El agua actual (`js/render/systems/water.js`) — qué reutilizar
- Malla de los polígonos `agua` en metros de escena (earcut con huecos vía `triangulatePoly`, refinado `refineLongest`),
  vértices a `heightAt + offset`; textura de orilla `bakeShore`.
- `ShaderMaterial` propio: normales animadas de dos capas de `getWaveTex()` (ruido periódico 256², mipmaps), fresnel de
  Schlick con `uCamPos`, reflejo cielo cenit→horizonte (= color de niebla), destello del sol (Blinn-Phong) con `uSunDir`,
  `uSunColor` y la intensidad de `lights.sun`, difusa hemisferio + sol, niebla `GLSL_FOG_UNIFORMS + GLSL_ADFOG` después del
  tone mapping, `uFade`. Color base del agua de la leyenda `#3f7fb5`.
- Render: `renderOrder = -11`, mezcla `SrcAlpha/OneMinusSrcAlpha` con alfa de destino preservado, `depthTest` + `polygonOffset(-2,-4)` con relieve, `DoubleSide`, `frustumCulled = false`.
- Animación en reposo: caja por celdas de 250 m (bajadas con `lowAt`) → `idleDriver.request("water", enCuadro)`.
- `getWaveTex`, `refineLongest`, `bakeShore` son privadas: hidro-render puede **agregarles `export`** (sin cambiarlas).

## 6. Datos del campo
- `state.data[key]` = FeatureCollection con `properties._cls` (resultado de `classify()`) y `_sup` (ha). Geometrías
  normalizadas a MultiPolygon (`normalizeGeometry`). `state.bbox = [[w,s],[e,n]]`.
- Clases (`_cls`): `agri`, `zona1|zona2|zona3` (macroambientes = agrícola), `corr-herb`, `parche-herb`, `corr-le`,
  `parche-le`, `instalaciones`, `camino`, `agua`, `bajo`, `ganaderia`, `suelo-desnudo`, `otros`.
  `classify()` lee `UNIDAD`/`Unidad` (texto) o `RASTER` (código). El campo sintético usa `UNIDAD`.
- Carga: `auth.js` decide el modo y expone `AD_AUTH.signedUrlFor(path)`; `map/data.js` `loadData()` baja inicial y multi.
  - Producción: login Supabase → tabla `campos` (RLS) → URL firmada del bucket privado `gis3d`.
  - `?local` (solo `HOST_DEV`: localhost, 127.0.0.1, [::1], *.localhost): `data/campos.local.json` + `data/<path>`.
  - **`?fixture=<id>`** (lo agrega F0): `fixtures/campos.fixture.json` + `fixtures/<path>`, en `HOST_DEV` y en el host de
    staging, nunca en producción.

## 7. UI del panel
- `index.html`: `<aside id="panel">` con `.panel-section`; la sección `#quality-section` aloja controles armados por JS.
- Patrón a copiar: `ui/presets-ui.js` (`armar()` arma el segmentado `#hora-btns` con `.hora-btn[aria-pressed]`) y
  `ui/relief-ui.js` (`armarRelieve()`: `button#relieve-sw[role=switch][aria-checked]` + nota de estado). La lógica vive
  aparte (`core/relief.js`); la UI solo refleja estado y llama funciones.
- CSS en `css/style.css` (estilos de `#hora-btns` y `#relieve-sw` ~líneas 428–465; dorado activo `--ad-gold`).
- Slider de referencia: opacidad del diseño en `ui/controls.js` (evento `input`).
- Breakpoint móvil 830 px (el panel cambia de layout); no se cambia.

## 8. API de QA (`js/debug/qa-api.js`, con `?qa` o `?debug`)
`window.__nav3d = { ready, map, setView({center,zoom,pitch,bearing}), setScenario(key,{animate}), freezeTime(s), seed(n),
stats(), frameTimes(ms,{force}), views(), startTour, stopTour, startOrbit, stopOrbit, camera(), presets, setPreset(name),
preset(), qualities, setQuality(name) }`. `?qa` además oculta el splash, apaga el fundido de teselas y espera reposo.
`views()` da las vistas canónicas: cenital, home, rasante, rasante-medio, parche, horizonte, agua (si hay).
`?debug` expone también `window.__map`, `__state`, `__terrain`. `?fps` muestra el medidor.
F2 agrega `__nav3d.runoff = { set(mode), rain(mmh), ready, stats() }`.

## 9. Versión de caché (`tools/stamp_version.mjs`)
- Reescribe `?v=` en `from "…"`, `import "…"` e `import("…")` con especificador relativo dentro de `js/**/*.js`, y en las
  referencias locales de `index.html`. `--check` sale con 1 si hay mezcla o faltantes.
- **Ojo con el worker**: `new Worker(new URL("../hydro/worker.js?v=…", import.meta.url), { type: "module" })` **no** lo cubre
  el sellador. hidro-plataforma extiende `stamp_version.mjs` para sellar también `new URL("./…js", import.meta.url)`, y
  `--check` debe verificarlo. Dentro del worker los `import` relativos llevan `?v=` como en cualquier módulo.

## 10. Parámetros de URL útiles
`?campo=<id>` · `?local` · `?fixture=<id>` (F0) · `?qa` · `?debug` · `?fps` · `?terreno=0|1` · `?calidad=ultra|alta|media|baja`
· `?hora=<preset>` · `?exag=<n>` (con ?qa/?debug).
