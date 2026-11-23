# Programa "Simulador de escorrentía" — plan maestro

> Fuente de verdad del programa. Si algo de acá contradice al código, manda el código: anotalo en el informe de compuerta.
> Documentos hermanos: `ARQUITECTURA.md` (mapa del código), `MODELO.md` (el cálculo y sus límites), `PROMPTS.md` (cómo se
> arranca y se aprueba cada fase). Reglas permanentes del repo: `/CLAUDE.md`.

## 1. Qué se construye
Un **modo simulador de escorrentía** en el visor 3D, para los campos con relieve suficiente:

- **Vista "Agua natural"**: dónde corre el agua en el pico de una lluvia, dibujada como agua (el shader de agua del visor,
  con la corriente animada en la dirección del flujo). Se ve en el paisaje **inicial** y en el **multifuncional**, y el
  conmutador de escenario existente hace el fundido entre los dos.
- **Vista "Velocidad"**: mapa de color de la velocidad del escurrimiento (paleta *turbo*, escala logarítmica, leyenda en
  m/s) con **partículas animadas tipo Windy** cuya estela es más larga cuanto más rápido va el agua.
- **Vista "Diferencia"** (F4): dónde el diseño multifuncional frena el agua respecto del inicial.
- **Deslizador de lluvia** (mm/h) que recalcula.

El objetivo visual son las demos aprobadas por el dueño (hojas `hoja_velocidad.jpg` y `hoja_escorrentia.jpg`, que el dueño
adjunta en el chat; **no** están en el repo porque muestran un campo de cliente). Descripción en `MODELO.md §6`.

El mensaje que el producto tiene que transmitir, con honestidad: **el diseño multifuncional frena el agua donde corre**
(corredores de pasto denso y monte cruzando las líneas de escurrimiento). No "el campo deja de escurrir".

## 2. Roles

### Orquestador — la sesión principal (modelo **Opus**)
- Lee `CLAUDE.md`, este plan, `ARQUITECTURA.md` y `MODELO.md` completos al empezar cada sesión.
- Parte cada fase en tareas y las **delega con el tool Agent** a los subagentes `hidro-*` (definidos en `.claude/agents/`).
  Cada subagente arranca en frío: el pedido tiene que traer **rama, archivos que le pertenecen, contexto mínimo,
  criterio de terminado y formato de entrega** (§7). Puede lanzar varios en paralelo si no comparten archivos.
- Revisa cada diff (no da por bueno un handoff sin mirar el código), integra, resuelve conflictos, corre o hace correr la QA.
- Es el único que mergea a la rama de preview y el único que estampa la versión (`tools/stamp_version.mjs`).
- Escribe el informe de cada compuerta (`docs/hidro/compuertas/GN.md`) y lo resume en el chat para el dueño.
- **Nunca pushea a `main`.** Producción = Pull Request que mergea el dueño (F5).
- Si una decisión no está en este plan y cambia lo que ve el dueño, **pregunta** en vez de suponer.

### Subagentes — modelo **Sonnet**
| Agente | Dueño de | Fases |
|---|---|---|
| `hidro-plataforma` | `fixtures/**`, `dev/fixtures/**`, modo fixture en `js/auth.js`, `.github/workflows/**`, `tools/stamp_version.mjs`, el registro `host.register(runoff)` en `js/render/host.js`, `EVENTS` en `js/core/events.js`, extensiones de `js/debug/qa-api.js` | F0, integraciones puntuales |
| `hidro-motor` | `js/hydro/**`, `dev/test/**`, la sección `HIDRO` de `js/core/config.js` | F1, F3 (recálculo), F4 (diferencia) |
| `hidro-render` | `js/render/systems/runoff*.js`; en `js/render/systems/water.js` **solo** puede agregar `export` a funciones existentes (`getWaveTex`, `refineLongest`) sin cambiar su comportamiento | F2, F3, F4 |
| `hidro-ui` | `js/ui/runoff-ui.js`, la sección `/* === HIDRO === */` de `css/style.css`, el bloque del simulador en `index.html` (si hace falta), la sección del README | F2, F3, F4 |
| `hidro-qa` | `dev/qa/**`, capturas y hojas en `docs/hidro/compuertas/**`. **No edita la app.** | todas |

Archivos que no están en la tabla: no se tocan sin pedido explícito del orquestador (y el orquestador avisa al dueño si es
algo de la lista "no se tocan" de `CLAUDE.md`).

## 3. Ramas y publicación
- `main` — producción. Intocable.
- `hidro/f0-plataforma`, `hidro/f1-motor`, `hidro/f2-natural`, `hidro/f3-velocidad`, `hidro/f4-pulido` — una por fase,
  salen de `staging` (o de `main` en F0). Los subagentes commitean ahí (no pushean si el orquestador no lo pide).
- `staging` — rama de preview. El orquestador mergea la fase y pushea: el workflow `.github/workflows/staging.yml` publica en
  el repo de staging (**https://3d-staging.agrodesign.site**, ~1–2 min). Si el entorno de la nube solo permite pushear ramas
  con prefijo `claude/`, usar `claude/staging` (el workflow se dispara con cualquier rama cuyo nombre contenga `staging`).
- F5 — Pull Request de `staging` → `main` con la versión estampada. Lo mergea el dueño.

## 4. Fases

### F0 · Plataforma (hidro-plataforma + hidro-qa) → compuerta G0
1. **Campo sintético `fixtures/demo_relieve/`** (`inicial.geojson`, `multifuncional.geojson`) + `fixtures/campos.fixture.json`
   (mismo formato que `data/campos.local.json`: `[{id, nombre, cliente, maxzoom, pathInicial, pathMulti}]`), generados por
   `dev/fixtures/gen_demo_relieve.mjs` (Node, sin dependencias; puede bajar tiles terrarium para elegir el lugar).
   - Lugar: zona agrícola con relieve **sin relación con clientes**; candidatos: alrededores de Tandil, Balcarce o el pie de
     Sierra de la Ventana (provincia de Buenos Aires). Elegir el que dé, sobre la grilla del campo, `desvioResidual > 2,7 m`
     o `pendienteP95 > 2,5 %` con `Heightfield.reliefStats()` (`js/terrain/heightfield.js`). Tamaño 400–600 ha.
   - Inicial: lotes agrícolas (`UNIDAD: "ag-secano"`), 2–3 montes chicos (`"parche-le"`), un casco (`"instalaciones"`),
     un camino (`"camino"`).
   - Multifuncional: los mismos lotes como macroambientes (`"ag-secano-z1"`, `"-z2"`, `"-z3"`) + corredores herbáceos
     (`"corr-herb"`, 30–60 m de ancho) y leñosos (`"corr-le"`) y parches (`"parche-herb"`, `"parche-le"`). **Los corredores
     tienen que cruzar las vaguadas principales** (calcularlas con el DEM) para que el efecto se vea.
   - Polígonos válidos (sin autointersecciones), `MultiPolygon`, propiedad `Sup` en ha. Todo inventado: nada copiado de datos reales.
2. **Modo `?fixture=<id>` en `js/auth.js`**: igual que `arrancarLocal()` pero lee `fixtures/campos.fixture.json` y
   `signedUrlFor(path)` devuelve `fixtures/${path}`. Permitido si `HOST_DEV` o `location.hostname === "3d-staging.agrodesign.site"`;
   **en 3d.agrodesign.site no hace nada** (sigue el login). Misma marca discreta, con el texto "campo sintético".
3. **Harness `dev/qa/`** (ya viene un esqueleto): `npm ci && npx playwright install chromium` (con `--with-deps` si faltan
   librerías del sistema). WebGL por software (SwiftShader). Capturas deterministas sobre
   `http://localhost:8080/?fixture=demo_relieve&qa&terreno=1&calidad=alta` (servidor: `python3 -m http.server 8080` en la raíz).
   **Línea base** de las vistas canónicas (`window.__nav3d.views()`) en ambos escenarios, guardada en `dev/qa/baseline/`
   (es del campo sintético: se puede commitear).
4. **Workflow de staging** probado (push a `staging` → sitio de staging actualizado) y `noindex` en el staging.
5. **G0**: el dueño abre el campo sintético en staging, abre un campo real con relieve con su login (`?campo=<id>`) y confirma que
   staging es idéntico a producción.

### F1 · Motor (hidro-motor) → sin compuerta visual; el orquestador revisa tests
Port del modelo de `docs/hidro/referencia/velocidad.py` a JS puro (sin Three), según `MODELO.md`:
- `js/hydro/grid.js` — grilla del campo desde `terrain.hf` (bbox del campo + margen de cuenca 1,5 km; si `terrain.hf` no
  cubre el margen, cargar un Heightfield propio con `loadHeightfield(bbox, {z: 13})`). Mediana 3×3 (como `reliefStats`).
- `js/hydro/fill.js` — priority-flood con épsilon (Barnes 2014) con una cola de prioridad binaria propia.
- `js/hydro/flow.js` — pesos MFD (p = 3, largos de contorno de Quinn), dirección media suavizada, pendiente local suavizada.
- `js/hydro/classes.js` — rasterizado de `_cls` por escenario (`pointInPolygon` de `js/core/geo.js`) → CN y n por celda.
- `js/hydro/runoff.js` — C, acumulación MFD, caudal racional, Manning (h, v), suavizado log, estadísticos.
- `js/hydro/worker.js` — Web Worker de módulo que corre los dos escenarios; devuelve `Float32Array` transferibles
  (`h`, `v`, `dirX`, `dirY`, `dlog` = log2(v_multi/v_inicial)) + `stats` + metadatos de la grilla (origen, tamaño de celda,
  afín escena↔celda). **Se crea recién cuando el usuario prende el simulador** (con el simulador apagado: costo cero).
- `js/hydro/state.js` — estado del simulador: `mode` (`"off" | "natural" | "velocidad" | "diferencia"`), `rainMmH`,
  `available`, `reason` (`"llano" | "sin-dem" | "calculando" | ""`), `result`; emite el evento `"runoff"` (pedir a
  hidro-plataforma que lo agregue a `EVENTS`).
- Config `HIDRO` en `js/core/config.js`, en su propia sección `/* === HIDRO: inicio === */ … /* === HIDRO: fin === */`.
- Tests `node dev/test/hydro.test.mjs` (sin dependencias): plano inclinado (dirección y v analíticas), V (concentración en el
  eje), pozo (el relleno drena), conservación (Σ aporte = salida por bordes ± 1e-6), y comparación con la referencia Python
  corrida sobre el campo sintético (tolerancias en `MODELO.md §5`).
- Tiempo: los dos escenarios del campo sintético en < 1,5 s dentro del worker (medir en la nube como referencia).

### F2 · Vista "Agua natural" + interruptor (hidro-render + hidro-ui) → compuerta G1
- `js/render/systems/runoff.js` (sistema del host, ver `ARQUITECTURA.md §2`):
  - En `build(ctx, key, …)` arma, por escenario, una **malla en grilla** que cubre el bbox del cálculo (≈ 1 vértice por
    celda, ~15 m) con `y = ctx.heightAt(lon, lat) + offset` y la bajada viva `a6Low` en el vertex shader. Sin datos
    todavía: queda invisible hasta que llega el resultado del worker (textura `R16F/R32F` o `RGBA8` empaquetada con h,
    dirección y v; elegir lo que funcione en WebGL2 sin extensiones de render a float).
  - Shader "agua natural": derivado del de `water.js` (fresnel con `uCamPos`, reflejo del cielo, destello del sol, niebla
    `GLSL_ADFOG`), con alfa por profundidad (visible desde h ≈ 2 cm, opaco hacia 15–25 cm; ver `MODELO.md §6`) y
    **flowmap**: las normales se desplazan según la dirección y velocidad del flujo, en dos fases cruzadas para que no se estiren.
  - `uniforms.uFade = scenarioFade[key]`, `materials: []` (maneja su propia niebla), `renderOrder` entre el suelo (−10) y el
    receptor de sombras (−9) para recibir sombras (o justificar otra elección), `polygonOffset` con relieve.
  - `update(frame)`: `idleDriver.request("runoff", visible && animando)`.
  - `onQuality(q)`: en Baja, sin animación de normales.
- `js/ui/runoff-ui.js`: bloque "Simulador de escorrentía" en el panel (patrón de `ui/relief-ui.js` y `ui/presets-ui.js`):
  interruptor + segmentado "Agua natural | Velocidad" (Velocidad deshabilitado hasta F3) + leyenda + rótulo "Ilustrativo · no
  es un estudio hidrológico". Si `available === false`, el bloque queda deshabilitado con el motivo ("campo llano: el
  relieve del modelo de terreno no alcanza", "sin modelo de terreno"). Al prender, si el relieve está apagado lo prende
  (`core/relief.js`) y lo avisa.
- `?qa`: `window.__nav3d.runoff = { set(mode), rain(mmh), ready (Promise), stats() }` (pedido a hidro-plataforma).
- **G1**: capturas del campo sintético (inicial/multi, general y de cerca, simulador apagado/prendido) + el dueño lo prueba
  en staging con un campo real con relieve.

### F3 · Vista "Velocidad" + partículas + lluvia (hidro-render + hidro-ui + hidro-motor) → compuerta G2
- Material "velocidad": *turbo* sobre `log10(v)` entre 0,02 y 1,5 m/s, opacidad ~0,85, mismo esquema de malla y fundido.
- **Partículas v1 en CPU** (robusto en celulares, sin render targets flotantes):
  - Advección con interpolación bilineal de dirección y velocidad (RK2), en metros de escena; reaparición aleatoria
    ponderada para cubrir el campo; vida 2–6 s.
  - Estela de 8 puntos por partícula en un `BufferGeometry` de líneas actualizado por frame, alfa decreciente hacia la cola,
    largo proporcional a la velocidad (velocidad visual exagerada y constante documentada en `HIDRO`).
  - Presupuesto: Ultra 20 000, Alta 15 000, Media 8 000; Baja: estelas estáticas precalculadas, sin animación.
  - Altura: sobre la malla (`heightAt` + `lowAt`), sin hundirse con el relieve vivo.
- Deslizador de lluvia (10–100 mm/h, default 50): al soltar, `state.js` pide recálculo al worker; al llegar, se reemplazan
  las texturas/atributos sin reconstruir el sistema; durante el cálculo, rótulo "Calculando…".
- **G2**: capturas + video corto opcional (si el entorno lo permite) + prueba del dueño en staging.

### F4 · Diferencia + pulido + rendimiento (todos) → compuerta G3
- Tercer estado "Diferencia": azul = el diseño frena el agua, rojo = acelera (paleta y umbrales en `MODELO.md §6`), con la
  traza de corredores y parches del diseño en línea punteada blanca. Métricas en el panel: ha con v > 0,3 m/s (inicial →
  multi), velocidad media, ha donde frena ≥ 16 %.
- Móvil (≤ 830 px): el bloque entra en el panel sin romper el layout; partículas a la mitad.
- Rendimiento y criterios de §5; consola limpia; `stamp_version --check` en verde.
- **G3** = candidato a producción.

### F5 · Producción
Solo con "aprobado G3" del dueño: el orquestador estampa la versión nueva, abre el PR `staging → main` con el resumen y la
lista de verificación, y espera. El dueño lo mergea. Después: verificar en https://3d.agrodesign.site (consola, simulador en
un campo con relieve, simulador deshabilitado en uno llano) y anotar el commit en `docs/hidro/compuertas/F5.md`.

## 5. Criterios de aceptación (todas las compuertas)
- **Simulador apagado = visor idéntico**: capturas de la línea base con diff 0 % (`dev/qa/diff.mjs`) y `stats()` iguales.
  El worker no se crea, no se baja nada extra.
- Simulador prendido: como máximo **+6 draw calls**; texturas del simulador ≤ 16 MB; cálculo de ambos escenarios < 1,5 s.
- Fps: lo mide el dueño en su equipo con `?fps` (la nube no tiene GPU; los números de SwiftShader no sirven para fps).
  Objetivo: ≥ 40 fps en un campo con relieve, calidad Alta, vista Velocidad con partículas.
- Consola sin errores ni warnings nuevos; `node tools/stamp_version.mjs --check` OK.
- Campos llanos: el simulador aparece deshabilitado con su motivo (nunca muestra un resultado que sea ruido del DEM).
- Textos en español rioplatense; rótulo "ilustrativo" visible en todas las vistas.

## 6. Informe de compuerta (`docs/hidro/compuertas/GN.md`)
1. Resumen en 3–5 líneas (qué ve el dueño ahora).
2. URLs para probar: `https://3d-staging.agrodesign.site/?fixture=demo_relieve` y
   `https://3d-staging.agrodesign.site/?campo=<id>` (con login), con los pasos (dónde está el interruptor, qué mirar).
3. Hoja de capturas antes/después (`dev/qa/sheet.mjs` o equivalente) commiteada en `docs/hidro/compuertas/GN/`.
4. `stats()` antes/después, tiempo del worker, consola.
5. Desvíos respecto del plan y por qué. Deuda conocida.
6. Preguntas para el dueño (cada una con opciones y una recomendación).

## 7. Formato de pedido a un subagente (lo arma el orquestador)
```
Rama: hidro/fN-… (creala desde X si no existe)
Te pertenece: <archivos>
No toques: <lo demás>; si necesitás algo de otro dueño, pedilo en tu entrega.
Contexto: leé CLAUDE.md, docs/hidro/PLAN.md §<n>, ARQUITECTURA.md §<n>, MODELO.md §<n>.
Tarea: <qué, con criterio de terminado medible>
Verificación: <tests / capturas / stats que tenés que traer>
Entrega: commits en la rama + handoff en docs/hidro/handoffs/<agente>-<fase>.md con:
  Resumen · Qué cambió · Decisiones · Diales · Verificación · Riesgos y deuda · Pedidos a otros dueños · Preguntas
```

## 8. Riesgos conocidos
- **El modelo de terreno es SRTM (~30 m)**: las pendientes salen suavizadas (velocidades absolutas por debajo de las reales),
  hay ruido de varios metros y los montes aparecen como lomitas. Por eso: solo campos con relieve, rótulo "ilustrativo",
  y la comparación inicial vs multi como mensaje principal (las dos usan el mismo terreno).
- Valores de n y CN por clase: de tabla (TR-55), pendientes de validación por un especialista; todos son diales de `HIDRO`.
- La nube no tiene GPU: el render se verifica con SwiftShader (lento pero fiel en color); el rendimiento lo mide el dueño.
- El sitio de staging es público (como el código): solo muestra datos reales a quien inicia sesión.
