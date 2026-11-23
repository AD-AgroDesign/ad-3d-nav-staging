# hidro-render · F2

Rama: `worktree-agent-a84044c3cb3ac108e` (sale de `hidro/f2-natural`, 6556a39). Sin push. Versión de caché 20261121.

## Resumen
Sistema `runoff` del host con la vista "Agua natural": la lámina `h` del motor se dibuja como cintas de agua que confluyen
hacia los cauces, con flowmap de dos fases cruzadas según la dirección y la velocidad. Un draw call por escenario visible (+1 en
`stats()`), datos en texturas que solo se leen (WebGL2 sin extensiones de render a float), cero costo con el simulador apagado
(diff 0 % contra la línea base). El registro en `host.js` NO está commiteado: lo hace hidro-plataforma (ver "Pedidos").

## Qué cambió
- `js/render/systems/runoff.js` (nuevo): sistema completo (malla, texturas, shader, animación en reposo, `stats`).
- `js/render/systems/water.js`: solo `export function getWaveTex()` (antes privada). Diff de capturas del agua: 0 %.

## Decisiones
- **Malla**: una grilla de 1 vértice por celda (379×357 en el sintético), horneada una vez en el primer resultado y compartida
  por los dos escenarios. `x,z` son lineales en la escena (Mercator), así que salen de dos llamadas a `ctx.toScene` (no hace
  falta `sceneAffine`, ni el origen del host); `y = ctx.heightAt(lon, lat) + 0,12 m` con lon por columna y lat por fila; en el
  vertex shader `w.y -= a6Low(w.xz)` (relieve vivo). Muestras en la esquina del píxel z13, igual que `terrain.hf`.
- **Índice dinámico**: por escenario se reescribe en cada resultado (lluvia incluida) y solo incluye los cuadros que pueden
  mostrar agua (alguna esquina con h ≥ 1 cm, dilatado 1 celda por la distorsión de dominio). Sin eso serían 270 k triángulos de
  agua inexistente; con eso ~200–240 k según la lluvia (50 → 100 mm/h: 202 k → 240 k). Ver deuda.
- **Texturas**: `tD` RGBA32F NEAREST por escenario (h, v, dirX, dirY; 2,1 MB cada una) con bilineal manual en el fragment shader
  (suavizado con smoothstep para redondear el borde); `tIn` R8 LINEAR compartida (`inside`). La dirección bilineal se pesa por la
  lámina (las celdas secas no la tuercen). Los resultados llegan como arrays nuevos: se copian a un buffer preasignado y
  `needsUpdate`; no se reconstruye nada.
- **Borde orgánico**: la escalera de 15 m del umbral se rompe con distorsión de dominio (ruido estático de la textura de ondas
  a 41 m, ±0,6 celdas) y un poco de ruido sobre `h` (±25 % a 9 m). Es estático: no parpadea.
- **Alfa/color** (MODELO §6): borde `smoothstep(0,6·hVis, 1,25·hVis)`, cuerpo `smoothstep(hVis, hOpaco, h)`; alfa 0,20 → 0,95; color
  `#60a0c4` → `#1e5280` con `pow(body, 0,75)`; fresnel sube el alfa en el rasante. `hVis`/`hOpaco` salen de `HIDRO.vis`.
- **Flowmap**: dos fases (ciclo 2 s, pesos triangulares) sobre las dos capas de `getWaveTex()`; rapidez visual
  `0,15 + 2·v` m/s (la v real, de 0,02–1,5 m/s, se vería inmóvil), pendiente de normales crece con v.
- **Fuera del campo (inside = 0)**: se muestra **atenuado** (alfa × 0,35, borde suave por el filtrado lineal de `tIn`), no
  recortado: da contexto de a dónde va el agua de la cuenca de aporte (se ve que el cauce del campo viene de afuera) sin
  competir con lo que está dentro del campo. Si el dueño prefiere recortar: `NAT.outside = 0`.
- **Orden de dibujo**: `renderOrder = −9,5` (después del suelo −10, antes del receptor de sombras −9: recibe sombras de árboles
  gratis), `depthTest` + `polygonOffset(−2, −4)` + `yOff` 0,12 m (= `A4_GROUND.yOffRelief` + 0,04). Todos los de esa lista tienen
  `depthWrite` apagado: el desempate entre ellos es solo el orden. Mezcla `SrcAlpha/OneMinusSrcAlpha` con alfa destino
  preservado, igual que water.js. Nota: water.js usa −11 (antes del suelo), por eso el agua natural se dibuja encima del agua
  de los polígonos `agua`, no debajo.
- **Visibilidad**: solo `mode === "natural"` (evento `runoff`); `velocidad`/`diferencia` ocultan el grupo hasta F3/F4. Sin
  `terrain.active` no se muestra (el motor ya declara el simulador no disponible).
- **Reposo**: `idleDriver.request("runoff", visible && fade > 0,02 && caja de la cuenca en cuadro y a < 1500 m)`, llamando solo
  cuando cambia el valor; `onQuality`: con `idleFps = 0` (Baja) las ondas quedan en fase fija (`uFlowOn = 0`) y se baja el pedido.
- **`stats(key)`**: `{ runoffTris, runoffParticles: 0, runoffTexMB }` solo si ya hubo un resultado (`{}` antes: así `stats()` con el
  simulador apagado es idéntico al de antes, sin claves nuevas). `runoffTexMB` cuenta `tD` + `tIn` (esta última atribuida a `inicial`).

## Diales
Constante `NAT` al tope de `runoff.js`, marcada `// → HIDRO` (proponer `HIDRO.vis.natural` en la próxima ronda del motor):
`colShallow #60a0c4`, `colDeep #1e5280`, `yOff 0,12`, `alphaMin 0,20`, `alphaMax 0,95`, `edgeNoise 0,6` (celdas), `outside 0,35`,
`gain 0,82`, `waveScale [5, 11]`, `waveSlope 0,30`, `waveFade [160, 600]`, `cycle 2,0`, `speedBase 0,15`, `speedGain 2,0`,
`reflection 0,55`, `spec [300, 0,8]`, `f0 0,02`, `idleMaxDist 1500`. De `HIDRO.vis` ya se usan `hVisibleM` y `hOpacoM`.

## Verificación
Entorno: nube, SwiftShader, Playwright con Chromium preinstalado, servidor propio en 8137 (el 8080 lo tenía otro proceso).
Campo sintético `?fixture=demo_relieve&qa&terreno=1&calidad=alta`, 1280×720, tiempo congelado (12,5). Prendido con
`import('/js/hydro/state.js?v=20261121').then(m => m.setMode('natural'))` y un registro temporal en `host.js` (revertido).
Capturas (fuera del repo), todas en `/tmp/claude-0/-home-user-ad-3d-nav/6bb04ed0-9a05-5107-be41-83527c75b459/scratchpad/s/capturas/`:
- general oblicuo y cenital, inicial: `inicial-home.png`, `inicial-cenital.png`; multi: `multi-home.png`, `multi-cenital.png`
- de cerca en la confluencia (centro del campo): `inicial-conf-obl.png`, `inicial-conf-cen.png`, `inicial-conf-ras.png` (pitch 79);
  multi: `multi-conf-obl.png`, `multi-conf-cen.png`
- relieve apagado (k = 0): `relieve-apagado-inicial-{home,cenital,conf-obl,conf-ras}.png`
- k animando: `inicial-conf-obl-k-animando.png` (k ≈ 0,0003 → 1; el agua sigue la superficie, sin z-fighting ni huecos; el oscuro es el
  satélite de MapLibre recargando durante la transición, no el agua).
- Lectura visual: se leen cintas que confluyen hacia el cauce principal, ondas que corren aguas abajo, color somero → profundo.
  Con 100 mm/h (`/scratchpad/s/behav/lluvia100.png`) las cintas se ensanchan; con 10 mm/h se reducen a los cauces.
  En el rasante (pitch 79) el cuerpo se ve pálido por el fresnel (refleja el horizonte): es el mismo comportamiento de water.js.
- **Simulador apagado**: `capture.mjs --hide-ui` vs `dev/qa/baseline` con el registro puesto: 12 pares, peor 0,0004 % (≤ 4 px,
  ruido de SwiftShader), umbral 0,5 % OK. `stats()`: mismas claves y mismos draw calls/triángulos (el multi-rasante varía 18 ↔ 20
  draws entre corridas por el pasto, también sin el registro).
- **Simulador prendido (home, inicial)**: 10 → 11 draw calls (+1; con los dos escenarios visibles en un fundido serían +2, límite 6).
  Triángulos +~200 k (inicial, 50 mm/h). `runoffTexMB` 2,19 (inicial) / 2,06 (multi).
- Comportamiento: apagado = ninguna llamada a `idleDriver.request("runoff")`; prendido → `true`; velocidad → `false` y grupo oculto;
  Baja en caliente → `false`. Cambio de lluvia 50 → 100 → 10 reemplaza datos in situ (tris 202 k → 240 k), sin reconstruir.
  Animación: dos tiempos congelados (12,5 y 13,1) difieren 0,26 % de los píxeles (las ondas se mueven).
- Consola: sin errores ni warnings salvo los "GPU stall due to ReadPixels" de SwiftShader (los de siempre).
- `node tools/stamp_version.mjs --check`: OK (194 especificadores, versión única 20261121).

## Riesgos y deuda
- **Triángulos**: ~200–240 k por escenario visible y 135 k vértices. En SwiftShader no se mide fps; en un celular de gama baja
  conviene medirlo. Salidas baratas si hace falta: subir el umbral del índice, mallar por bloques de 2×2 celdas lejos de la
  cámara, o recortar la cuenca de aporte (fuera de `inside`) en Media/Baja.
- Primera vez que se prende hay un pico: horneo de posiciones (135 k llamadas a `heightAt`) + compilación del shader + subida de
  4 MB de texturas. No medido en navegador real; si molesta se puede precompilar con `renderer.compile` al llegar el resultado.
- Los bordes de la lámina son piecewise del DEM de 30 m remuestreado a 15 m: el ruido estático los disimula pero no es
  precisión (el aviso "ilustrativo" de la UI cubre esto).
- Si el motor llegara a entregar una grilla con otro tamaño/origen, `setResult` rehornea todo (previsto); `meta` hoy es fijo.
- En el rasante el agua natural cubre al agua de los polígonos `agua` (orden −9,5 vs −11): se ven las dos juntas si coinciden.
- Con `terrain.hf` que no cubre el margen (DEM propio del motor), `heightAt` clampa al borde: solo afecta las celdas del margen.

## Pedidos a otros dueños
- **hidro-plataforma, `js/render/host.js`**: agregar el import junto a los otros imports de sistemas (después de
  `import fauna from "./systems/fauna.js?v=20261121";`, línea ~33):
  `import runoff from "./systems/runoff.js?v=20261121";   // hidro: escorrentía`
  y el registro **al final del archivo, después de `host.register(fauna);`** (debe ir último: dibuja con renderOrder propio, el
  orden de construcción no importa pero así no cambia el de los demás):
  `host.register(runoff);   // hidro: simulador de escorrentía`
  Después `node tools/stamp_version.mjs <AAAAMMDD>` y `--check`.
- hidro-motor: (a) proponer `HIDRO.vis.natural` con los diales de `NAT`; (b) para F3, `Q` por celda (ancho de cinta por caudal) cuando esté.
- hidro-ui: nada. La vista se muestra sola con `getState().mode === "natural"`.
- hidro-plataforma (`qa-api.js`): `__nav3d.runoff.stats()` puede leer también `__nav3d.stats().instances.<key>.runoffTris`.

## Preguntas
- ¿Fuera del campo, atenuado (como está) o recortado? Cambia con un dial (`NAT.outside`).
- ¿Se acepta que el agua natural se vea sobre el agua de los polígonos `agua` (orden −9,5)? Alternativa: −11,5 para que quede debajo.
