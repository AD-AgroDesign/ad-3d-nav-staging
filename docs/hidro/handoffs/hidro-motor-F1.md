# hidro-motor · F1

Rama: `hidro/f1-motor` (desde `claude/staging` con G0). Sin push. Versión de caché usada: 20261121.

## Resumen
Port a JS del modelo de `docs/hidro/referencia/velocidad.py`: módulos puros, worker, estado del simulador y tests.
Sobre el campo sintético, JS y Python coinciden al nivel del redondeo (F idéntica, Ae rel 3e-15, v 1e-12 %, estadísticos dentro
del 0,5 %: la diferencia es el redondeo de `meta_vel.json`). Los dos escenarios corren en **~250 ms en Node 22** y **~185 ms
dentro del worker en Chromium** (≈ 6 veces por debajo del límite de 1,5 s). Cambiar la lluvia recalcula en ~30–60 ms.

## Qué cambió
- `js/core/config.js`: sección `/* === HIDRO: inicio === */ … fin` con `HIDRO` (lluvia, P_cn, p, S_min, ε, margen, tabla de clases,
  umbrales de disponibilidad, escala/estelas/umbrales de visualización para render y UI).
- `js/hydro/` (todo nuevo):
  - `grid.js` (puro) metadatos de grilla alineada a píxeles z13 como la referencia, recorte de DEM, mediana 3×3, centros de celda, afín escena→celda.
  - `load.js` (con red) `cargarEntradaGrilla`: usa `terrain.hf` si cubre bbox+margen, si no baja un `loadHeightfield` propio (z13, misma URL).
  - `fill.js` Priority-Flood con épsilon, montículo binario propio con desempate por índice (= `heapq` de la referencia).
  - `flow.js` MFD (p=3, Quinn), dirección media suavizada, pendiente local.
  - `classes.js` rasterizado de `_cls` por filas (scanline even-odd) → CN, n, C. `pointInPolygon` de `core/geo.js` es la regla de referencia; el test verifica que da lo mismo.
  - `runoff.js` acumulación MFD, Manning, suavizado log, `dlog`, estadísticos.
  - `engine.js` orquestación pura (la usan el worker y los tests). `params.js` arma el objeto plano de parámetros desde `HIDRO`.
  - `worker.js` Web Worker de módulo. `state.js` estado + API para render/UI.
- `dev/test/hydro.test.mjs` (59 chequeos; sin dependencias) y `dev/test/ref_to_bin.py` (convierte `grid.npz` a binarios planos; el test lo invoca solo).

## Decisiones
- **Los módulos puros no importan `config.js`** (tiene `window.matchMedia` al importarse: rompe en el worker y en Node). Reciben `P` por
  parámetro; `params.js`/`state.js` son los únicos que lo importan. En los tests se simulan `window` y `location` para poder leer `HIDRO`.
- **Precisión**: H, F, pesos, Ae y S son `Float64Array` internos (con Float32 los saltos de ε = 1e-4 m en zonas llanas se cuantizan y los
  pesos cambian). Lo que sale es `Float32Array`.
- **Sin ordenar**: la acumulación recorre al revés el orden de salida de la cola del relleno (no decreciente en F), que equivale al
  `argsort(-F)` de la referencia sin el costo del sort.
- **Ae no depende de la lluvia** (C se calcula a P = 80 mm fijos). El worker guarda terreno + Ae por escenario; un cambio de lluvia solo
  repite Manning + suavizado (`{type:"rain"}`), sin tocar el relleno ni el flujo ni los polígonos.
- **Clases en el worker** (el rasterizado de 2 escenarios cuesta ~3 ms en el sintético, pero con polígonos de campos reales puede ser mucho más).
  El hilo principal solo baja el DEM (si hace falta), recorta y manda `features` (clon estructurado de la geometría, sin copias intermedias).
- **Disponibilidad** con `terrain.stats` y `HIDRO.disponibilidad` (que apunta a `A6_TERRAIN.auto`), no con `terrain.available`.
  `sin-dem` también cuando falta `terrain.hf`, `terrain.unavailable === "sin-dem"`, no hay datos de los dos escenarios o el cálculo falló.
- En el campo sintético `terrain.hf` **sí** cubría el margen de 1,5 km (el mosaico de tiles z13 se pasa del bbox del campo), así que no
  hizo falta la segunda descarga; el camino del DEM propio quedó probado en Chromium aparte (30 ms).
- Se calcula sobre el bbox del escenario `inicial` (igual que la referencia, que usa la unión de sus polígonos).
- El mensaje del worker no trae `Ae`/`Q`; si F3/F4 los necesitan (por ejemplo ancho de cinta según caudal) se agregan.

## Errores de la referencia Python (no copiados) y corrección propuesta
1. **Cajas 3×3 con relleno de ceros en el borde de la grilla** (`box()` suma `shift(..., 0)` y divide por 9 siempre). Efectos en
   las 2–3 celdas exteriores: (a) el DEM suavizado `Hs` se sesga hacia 0 y el gradiente del anillo 1 sale enorme (pendiente falsa);
   (b) el suavizado de `log10 v` se sesga hacia 0 (v → 1 m/s). Está a 1,5 km del campo y no toca los estadísticos del campo, pero
   contamina `h`, `v` y `dlog` del borde. **JS**: la caja promedia las vecinas que existen (`flow.js box3`). Para la dirección no cambia nada
   (se normaliza). Por eso el test compara contra Python en el interior (excluyendo 3 celdas de borde); en la grilla entera hay celdas del
   borde con error relativo grande (p99,9 = 83 %), todas en esa franja. **Propuesta**: aplicar la misma corrección a `velocidad.py`.
2. El anillo exterior (sin las dos vecinas) queda con `S = S_min` por el NaN de `shift`; se mantuvo (es inocuo, está en el borde).
3. Menor: `ha_v_mayor_0_3` y compañía se redondean a 2–4 decimales en `meta_vel.json`, así que las comparaciones de estadísticos tienen ese piso.

## Diales (`HIDRO` en `js/core/config.js`)
`rain {default 50, min 10, max 100, step 5}`, `pCn 80`, `zoom 13`, `metrosPorPx0`, `margenCuencaM 1500`, `epsFill 1e-4`, `mfdP 3`,
`contorno {0,5 · 0,354}`, `sMin 0,004`, `pasadasDir 2`, `pasadasPendiente 2`, `eps {dir, hMin, vMin}`, `claseFuera "agri"`,
`clases {_cls: {cn, n}}` (tabla de MODELO §3), `disponibilidad` (= `A6_TERRAIN.auto`), `stats {vAltaMs 0,3 · frenaDlog −0,25}`,
`vis {vMinMs 0,02 · vMaxMs 1,5 · marcasMs · hVisibleM 0,02 · hOpacoM 0,2 · estelaSegundos 320 · estelaMinM 45 · estelaMaxM 420 · difUmbral 0,06 · difSatura −1,15}`
(`vis` y `worker.tiempoMaxMs` solo los guarda el motor; los usa render/UI).

## Verificación
Entorno: nube, Linux x64, Node 22.23, Chromium de Playwright (SwiftShader), `python3 -m http.server 8080`.
- `node dev/test/hydro.test.mjs`: **59 ok · 0 fallas** (1,4 s; baja 16 tiles de AWS para comprobar la mediana contra el DEM real).
  Sin la referencia (`HIDRO_REF_DIR` inexistente) corre los 29 chequeos analíticos y avisa que salta la comparación; `HIDRO_SIN_RED=1` no usa la red.
  Referencia: `python3 docs/hidro/referencia/velocidad.py --geojson-dir fixtures/demo_relieve --out /tmp/hidro-ref --dump` (por defecto el test mira `/tmp/hidro-ref`).
- Casos analíticos: plano inclinado (dirección este, S = s, Ae = C·A·(i+1) con error 1e-15, v de Manning = analítica 1e-9, suavizado = media
  geométrica), V (Ae del eje 1388·A vs 11·A a 2 celdas; dirección sur sobre el eje, hacia el eje en las laderas), pozo (el fondo sube de
  86,5 a 90,0 m; sin sumideros interiores), terreno ruidoso, conservación Σ C·A = salida por bordes (rel ≤ 1e-12 en todos y sobre el campo real).
- JS vs Python (grilla 379×357, celda 15,179 m, 495,21 ha):

| | JS | Python |
|---|---|---|
| DEM + mediana vs `H` | max\|Δ\| 0 | |
| `F` | max\|Δ\| 0 (100 % ≤ 1e-3) | |
| `Ae` (celdas > 10·A) | rel máx 2,8e-15 | |
| `v` (interior) mediana / p95 rel | 3e-13 % / 1,6e-12 % | |
| celdas dentro del campo | 0 distintas de 135 303 | shapely `contains_xy` |
| v media inicial / multi (m/s) | 0,0852 / 0,0803 | 0,0852 / 0,0803 |
| v p95 inicial / multi (m/s) | 0,2163 / 0,1974 | 0,216 / 0,197 |
| ha v > 0,3 inicial / multi | 13,92 / 12,03 | 13,92 / 12,03 |
| ha donde frena ≥ 16 % | 58,20 | 58,2 |
| Q pico máx inicial / multi (m³/s) | 42,787 / 41,424 | 42,787 / 41,424 |
| reducción de v media | 5,77 % | 5,75 % |

- Estadísticos del campo sintético, inicial vs multi (50 mm/h): v media 0,0852 → 0,0803 m/s (−5,8 %); ha con v > 0,3 m/s 13,9 → 12,0;
  ha donde frena ≥ 16 %: 58,2; Q pico máx 42,8 → 41,4 m³/s. Con 100 mm/h: v media 0,112 → 0,106; ha v > 0,3: 23,0 → 20,0; Q pico 85,6 → 82,8.
  (Los valores absolutos son menores que los de la demo del cliente: el relieve sintético es más suave y el corredor no cruza como en el real.)
- Tiempo: pipeline completo (mediana, relleno, pesos, dirección, pendiente, clases ×2, acumulación ×2, Manning ×2) **251 ms en Node**
  (relleno 41, pesos 40, dir+pendiente 47, acumulación ×2 26, evaluar 73). **En el worker de Chromium 184 ms** (compute) y 204 ms desde `setMode`
  hasta el resultado; recálculo por lluvia 33 ms (worker) / 34 ms (ida y vuelta). < 1,5 s con holgura.
- Navegador: `http://localhost:8080/?fixture=demo_relieve&qa&terreno=1`, `import("/js/hydro/state.js?v=20261121")` desde `page.evaluate`: `getState()` con el
  simulador apagado (`available: true`, sin result), `setMode("natural")` → `ensureComputed()` → resultado correcto, `setRain(100)` →
  recálculo; eventos `runoff` en orden mode, computing, result, rain, computing, result. Consola sin errores ni warnings (solo los avisos
  de SwiftShader, que se filtraron). Antes de `setMode` no se pidió el worker; las únicas requests nuevas fueron módulos `.js` del propio repo.
- `node tools/stamp_version.mjs --check`: OK, 183 especificadores, versión única 20261121 (incluye `new URL("./worker.js?v=…", import.meta.url)`).
- No probé el estado "llano" en navegador (el único campo disponible acá tiene relieve); la lógica es una comparación de `terrain.stats` con los umbrales.

## API para render y UI (F2)
### `js/hydro/state.js`
```js
export const MODES = ["off", "natural", "velocidad", "diferencia"];
getState() -> { mode, rainMmH, available, reason, computing, result, error }   // snapshot; `reason` ∈ "llano" | "sin-dem" | "calculando" | ""
setMode(mode) -> boolean          // false si available === false (no hace nada). Prender dispara ensureComputed(); apagar no libera nada.
setRain(mmh, commit = true) -> number   // clampa a HIDRO.rain.min/max. commit=false: solo actualiza y avisa (mientras se arrastra); true: pide recálculo si mode !== "off"
ensureComputed() -> Promise<result | null>   // resultado vigente para rainMmH; null si no disponible o falló (state.error). Sirve para precalentar o para `__nav3d.runoff.ready`
sceneAffine(originX, originY, scale) -> [a, b, c, d] | null   // ci = x·a + b ; cj = z·c + d (celdas, valor en la esquina). Misma forma que reliefU.uA6P
paramsMotor() -> objeto plano con los parámetros del cálculo
dispose()                          // termina el worker (tests)
```
Evento `"runoff"` (core/events.js ya lo tiene): payload `{...getState(), cambio}` con `cambio` ∈ `"mode" | "rain" | "computing" | "result" | "error"`.
`computing` es true durante el primer cálculo (DEM + worker) y en cada recálculo; el rótulo "Calculando…" sale de ahí (`reason === "calculando"`).
Con el simulador apagado importar `state.js` no crea el worker ni baja nada.

### `result` (en `getState().result`)
```
meta   { z: 13, gx0, gy0, nx, ny, cell (m), area (m²), latc, bboxCampo [w,s,e,n], bboxMargen, margenM }
rainMmH, msWorker, msDem, fuenteDem ("terrain.hf" | "propio")
stats  { rainMmH, campoHa, cellM, nx, ny,
         inicial: { vMediaMs, vP95Ms, haVMayor, qPicoMaxM3s }, multi: { ... }, frenaHa, reduccionVMediaPct, ms: {...} }
inicial { h: Float32Array (m), v: Float32Array (m/s) }     // nx·ny, fila mayor, fila 0 = norte
multi   { h, v }
dlog    Float32Array   // log2(v_multi / v_inicial); azul < 0 frena, rojo > 0 acelera
dirX, dirY  Float32Array  // dirección media unitaria del flujo; dirX = este (+X de la escena), dirY = sur (+Z de la escena). Compartida por los dos escenarios
inside  Uint8Array     // 1 = celda dentro del campo (centro dentro de algún polígono del inicial)
```
Celda (i, j) = píxel global (gx0 + i, gy0 + j) de z13. Los valores están en la ESQUINA del píxel (misma convención que `terrain.hf`, `pixelCenter:false`):
posición de escena de la muestra (i, j) = invertir la afín, o `ctx.toScene(...pxToLonLat(gx0 + i, gy0 + j))`. Para armar una textura y muestrear en un shader
usar exactamente el patrón de `a6Hf`: `uv = (floor-clamped(ci, cj) + 0,5) / (nx, ny)`. Las clases (y `inside`) se evaluaron en el centro del píxel (+0,5), como la
referencia; la diferencia (medio píxel, ~7 m) está por debajo de la resolución del SRTM. `pxToLonLat`, `lonLatToPx`, `sceneToCell` están exportadas de `grid.js`.
Los `Float32Array` ya llegan transferidos (no hay copia); `state.js` los reemplaza enteros en cada resultado (no los muta): el render puede subirlos a textura y soltar la referencia.

### Mensaje del worker (`js/hydro/worker.js`)
```
-> { type: "compute", id, rainMmH, params, meta, raw: Float32Array nx·ny (TRANSFERIDO, DEM crudo sin mediana), features: { inicial: [...], multi: [...] } }
      features[k] = [{ cls, type: "Polygon"|"MultiPolygon", coordinates }]  (state.data[k].features con geometría; cls = properties._cls)
-> { type: "rain", id, rainMmH }                               // sobre lo ya calculado; error si no hubo compute antes
<- { type: "result", id, ms, result }  result como arriba; h/v/dlog/dirX/dirY/inside transferidos
<- { type: "error", id, message }
```
Un mensaje a la vez (cola FIFO del worker); `state.js` junta recálculos en vuelo y vuelve a mirar `rainMmH` al terminar.

## Riesgos y deuda
- El clon de `features` hacia el worker corre en el hilo principal; para polígonos con cientos de miles de vértices podría notarse
  (no medido con datos reales; el repo es público y no los tengo). Si pasa, se aplanan a `Float64Array`.
- Memoria del worker: `W` son 8 doubles por celda (~1 MB cada 16 mil celdas). Un campo de 5 000 ha con margen ronda 700×700 celdas ≈ 31 MB: bien.
  Un campo de varios miles de ha más grande queda en la decena de MB; no hay tope.
- Diferencia con la referencia en el borde de la grilla (ver arriba): es una corrección deliberada.
- Si el worker falla (módulo sin soporte), `state.error` se llena y `available` pasa a false con `sin-dem`; no hay plan B en el hilo principal.
- Pendiente de F3/F4: `Ae`/`Q` por celda no se devuelven (agregarlos es trivial); el estado no guarda "qué vista ve cada escenario".

## Pedidos a otros dueños
- hidro-plataforma: nada nuevo (el evento `runoff` ya estaba). Para `window.__nav3d.runoff` en `?qa` usar `getState()`, `setMode`, `setRain`, `ensureComputed()` (`ready`) y `getState().result.stats` (`stats()`).
- hidro-render: leer `result` solo por `getState()`/evento; la malla debe cubrir `meta.bboxMargen` o, mejor, recortarse con `inside`/h visible.
  El `host.register(runoff)` no depende de este módulo hasta que el sistema lo importe.
- Orquestador: `dev/test/hydro.test.mjs` necesita la salida de la referencia en `/tmp/hidro-ref` (o `HIDRO_REF_DIR`) y red a AWS; si falta la salta con aviso.
  Conviene que la QA/CI la genere con el comando de arriba.

## Preguntas
- ¿Se quiere que el corredor del sintético cruce más vaguadas para que la reducción se parezca a la demo real (−38 % en una confluencia)? Hoy el campo
  baja la v media solo un 5,8 % y 58 ha frenan ≥ 16 %. No es un problema del motor, es del campo de prueba.
- ¿Guardamos `Ae`/`Q` en el resultado para poder dibujar el ancho de los cauces por caudal en F3? Recomendación: sí, solo `Q` del escenario visible (Float32, 0,5 MB).

---

# F2 (Motor): borde corregido en la referencia y caudal `Q` en el resultado

## Qué cambió
- `docs/hidro/referencia/velocidad.py`: `box()` promedia solo las vecinas que existen (suma / cantidad de vecinas dentro de la grilla), igual que
  `flow.js box3`. Antes rellenaba con ceros y dividía por 9. Quedó documentado en el docstring de `box()` y en el del script. Nada más cambió.
- `dev/test/hydro.test.mjs`: se quitó la banda de 3 celdas; `S`, dirección, `v`, `h` y `dlog` se comparan en la grilla COMPLETA con las tolerancias de MODELO §5.
  Se sumaron dos chequeos de `Q` (tipo y tamaño en ambos escenarios; `Q = i·Ae` por celda y máximo dentro del campo = `qPicoMaxM3s`).
- `js/hydro/engine.js` (`evaluar`, `resultadoDe`) y `js/hydro/worker.js` (lista de transferibles): `inicial.Q` y `multi.Q`.

## JS vs Python en grilla completa (referencia regenerada, 379×357 celdas, campo sintético)
| Comparación (grilla completa) | Resultado | Tolerancia MODELO §5 |
|---|---|---|
| F: celdas con \|Δ\| ≤ 1e-3 m | 100 %, max 0 | ≥ 99,9 % |
| S: rel p99 | 2,3e-13 | (≤ 1e-6) |
| dirección media: \|Δ\| p99 | 3,7e-8 | (≤ 1e-5) |
| v inicial / multi: mediana · p95 rel | 3e-13 % · 1,5e-12 % | ≤ 2 % · ≤ 5 % |
| h inicial / multi: mediana rel | 6,8e-13 % | ≤ 2 % |
| dlog: \|Δ\| p99 | 1,3e-8 | ≤ 0,02 |
| Ae donde Ae > 10·A: max rel | 2,8e-15 | ≤ 1 % |
| Estadísticos (v media, ha v > 0,3, ha frena, Q pico) | rel ≤ 0,41 % (reducción de v media), el resto ≤ 0,14 % | ≤ 2 % |
Los números del campo no cambian respecto de F1 (v media 0,0852 → 0,0803 m/s, ha v > 0,3: 13,92 → 12,03, frena ≥ 16 %: 58,2 ha, Q pico 42,79 → 41,42 m³/s):
el borde está fuera del campo. Pipeline completo 244 ms (node 22, linux/x64); recálculo por lluvia ~56 ms. Test: 61 ok, 0 fallas. `stamp_version --check` OK.

## Formato actualizado del resultado
`result.inicial` y `result.multi` = `{ h, v, Q }`, los tres `Float32Array(nx·ny)` TRANSFERIDOS por el worker (los dos escenarios siempre, para el fundido):
`h` altura de lámina (m), `v` velocidad suavizada (m/s), `Q` caudal pico por celda (m³/s) = `rainMmH/3.6e6 · Ae` (el mismo que usa Manning; cambia con la lluvia y se
recalcula en el mensaje `rain`). Fuera del campo también hay `Q` (la cuenca aguas arriba aporta); el `qPicoMaxM3s` de `stats` es solo dentro del campo.
Costo: ~0,5 MB por escenario en el campo sintético. `state.js` no necesita cambios (`result` pasa tal cual).

## Qué habría que cambiar en MODELO.md (no lo edité)
- §3 punto 3/4/10 (cajas 3×3): aclarar "normalizada por las vecinas que existen en el borde de la grilla".
- §5: agregar que la comparación es sobre la grilla completa y, si se quiere, `S` y dirección con las tolerancias de arriba.
- Formato del resultado (si lo describe): sumar `Q` a `inicial`/`multi`.

## Pendiente
- Quedó resuelta la pregunta de F1 sobre `Q`: se devuelve en ambos escenarios (decisión del dueño). La deuda "Ae/Q no se devuelven" queda cerrada para `Q`; `Ae` sigue sin devolverse.

## F3 (diales nuevos en `HIDRO.vis`)
Valores existentes sin cambios. Se agregó:
- `natural`: los mismos valores que `NAT` de `runoff.js` (render puede reemplazar la constante por `HIDRO.vis.natural`; `yOff = A4_GROUND.yOffRelief + 0.04`).
- `velocidad`: `opacidad` 0.85, `bordeSuaveCeldas` 3 (turbo sobre log10(v) en `[vMinMs, vMaxMs]`).
- `particulas`: `presupuesto` {ultra 20000, alta 15000, media 8000, baja 0}, `vidaS` [2, 6], `puntosEstela` 8, `exageracion` 160, `anchoPx` 1.75, `alfaCabeza` 0.9, `estaticasBaja` 3000.
  Cuenta de `exageracion`: la cola abarca ~2 s de historia a velocidad visual v·exageracion, entonces largo = v·exageracion·2 = v·320 (`estelaSegundos`) → 160.
- `marca.texto`: "Ilustrativo · no es un estudio hidrológico".

## F4 (diales de pulido en `HIDRO.vis`)
Valores existentes sin cambios; el render los lee después (no toqué `js/render/**`).

| Constante del render | Clave de HIDRO | Valor |
|---|---|---|
| `LIFT` (runoff.js) | `vis.velocidad.liftDist` | 0.002 (m por m; aplica a natural, velocidad y estelas) |
| el `600.0` del shader | `vis.velocidad.liftDistDesdeM` | 600 |
| `uLift0` | `vis.velocidad.liftFijoM` | 0.4 (solo velocidad y estelas; la natural no lo usa) |
| `HALO_M` | `vis.velocidad.haloM` | 300 |
| `PART_IDLE_MAX` | `vis.particulas.idleMaxDistM` | 8000 |
| `Y_EXTRA` | `vis.particulas.yExtraM` | 0.06 |
| `OUTSIDE_W` | `vis.particulas.pesoFuera` | 0.05 |
| `SPEED_W` | `vis.particulas.pesoRapidez` | 2.0 |
| `FADE_IN` / `FADE_OUT` | `vis.particulas.fadeInS` / `fadeOutS` | 0.4 / 0.6 |
| `DIST_ALFA` | `vis.particulas.distAlfa` | [1500, 5000, 0.5] |
| `DIST_FRAC` | `vis.particulas.distFrac` | [2500, 7000, 0.35] |
| `GRAZE` | `vis.particulas.rasante` | [0.10, 0.55, 0.06] |
| `STEP_M` | `vis.particulas.pasoColaM` | 6 |
| `TURN_COS` | `vis.particulas.giroColaCos` | 0.5 |
| `STATIC_SUB` | `vis.particulas.subdivBaja` | 3 |
| (nuevo, G2-1a) | `vis.particulas.factorMovil` | 0.5 (× presupuesto con `IS_MOBILE`; lo aplica el render) |

Vista Diferencia: `vis.diferencia` = `umbral` 0.06, `saturacion` -1.15 (única fuente: `vis.difUmbral`/`difSatura` se eliminaron, nadie los usaba), `colFrena` [#96cdff, #1946c8], `colAcelera` [#ffbe8c, #c8321e], `opacidad` 0.85, `traza` {clases corr-herb/corr-le/parche-herb/parche-le, color #ffffff, alfa 0.9, rayaPx 8, huecoPx 6, anchoPx 1.5}.

Stats para la UI (en `result.stats`, ya existentes; `HIDRO.vis.diferencia.metricas` los lista):
- ha con v > 0,3 m/s: `stats.inicial.haVMayor` → `stats.multi.haVMayor`
- velocidad media: `stats.inicial.vMediaMs` → `stats.multi.vMediaMs` (m/s); también `stats.reduccionVMediaPct`
- ha donde frena ≥ 16 %: `stats.frenaHa`; total del campo: `stats.campoHa`

## F5 (opacidad del simulador)
- `HIDRO.vis.opacidad = { default: 1, min: 0.1, max: 1, step: 0.05 }`.
- `state.js`: `export function setOpacity(v): number` (acota a [min, max], emite `"runoff"` con `cambio: "opacity"`, devuelve el valor). `getState().opacity` y el payload del evento lo incluyen. Solo visual: no calcula ni crea worker. El render la aplica a agua, velocidades/estelas y diferencia; el diseño sigue con el slider de la tabla.
