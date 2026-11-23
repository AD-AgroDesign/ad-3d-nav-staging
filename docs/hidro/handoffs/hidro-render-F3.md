# hidro-render · F3

Rama: la del worktree (sale de `hidro/f3-velocidad`, c05a2ae). Sin push. Versión de caché 20261122.

## Resumen
Vista "Velocidad" del sistema `runoff`: mapa turbo sobre `log10(v)` (0,02 → 1,5 m/s) sobre toda la cuenca, con el campo
resaltado y lo de afuera atenuado como en la natural, más hasta 15 000 estelas blancas animadas (partículas en CPU, advección RK2)
en un solo draw call por escenario. Cauces naranja-rojo, laderas verde-azul, corredores azul oscuro, estelas más largas donde corre
más. Con el simulador apagado: diff 0 % contra la línea base y `stats()` sin claves nuevas.

## Qué cambió
- `js/render/systems/runoff.js`: `NAT` ahora es `HIDRO.vis.natural` (diff 0 % en natural contra antes). Orquesta los 3 materiales
  (natural / velocidad / estelas), índice completo perezoso para velocidad, visibilidad por modo, ticks de partículas, `stats`.
  Exporta además `turboCss` (re-export) y `particleTiming()` (solo para medir).
- `js/render/systems/runoff-turbo.js` (nuevo, sin dependencias): `turboCss(t)` y `GLSL_TURBO`, MISMOS coeficientes.
- `js/render/systems/runoff-velocidad.js` (nuevo): shader del mapa de velocidad.
- `js/render/systems/runoff-particulas.js` (nuevo): simulación CPU, textura de puntos, shader de cintas.
- `water.js`, `host.js`, `config.js`, `qa-api.js`: sin tocar.

## Firma de `turboCss` (para hidro-ui)
```js
import { turboCss } from "../render/systems/runoff-turbo.js?v=20261122";   // sin dependencias (también re-exportada desde runoff.js, que arrastra three: no usar esa)
turboCss(t)   // t ∈ [0, 1] (se clampa) → "rgb(r, g, b)" (enteros 0–255, sRGB = lo que se ve en pantalla)
// t de una velocidad v (m/s): (Math.log10(v) − Math.log10(HIDRO.vis.vMinMs)) / (Math.log10(HIDRO.vis.vMaxMs) − Math.log10(HIDRO.vis.vMinMs))
```
Leyenda: barra `linear-gradient(to right, turboCss(0), …, turboCss(1))` con N paradas; las marcas `HIDRO.vis.marcasMs` van en
`t(v)` (escala log, no lineal). El mapa pasa por la misma fórmula, así que el color de la leyenda y el del mapa coinciden.

## Decisiones
- **Paleta**: polinomio de Mikhailov (Google 2019, Apache 2.0). Cae a casi negro (35, 23, 27) para t < 0,03, y los corredores
  (v ≈ 0,005–0,02) se veían como agujeros negros. Se usa desde T0 = 0,05 (azul oscuro 70, 54, 153): `t' = 0,05 + 0,95·t`, en JS y GLSL.
  Efecto: 0,02 m/s = azul oscuro (como pide MODELO §6) y los corredores se leen en azul.
- **Malla de velocidad**: misma grilla de vértices (posiciones compartidas con la natural, sin duplicar) y un ÚNICO índice
  completo (3,2 MB, Uint32) armado perezosamente al primer "velocidad" y compartido por los dos escenarios. La natural conserva su
  índice recortado a los cuadros con agua. Textura `tD` compartida con la natural (cero memoria extra de datos). 269 k triángulos
  por escenario visible (toda la cuenca de 5,7 × 5,4 km, margen incluido, para mostrar la cuenca de aporte atenuada).
- **Color**: `v` interpolada en log10 con el bilineal manual (suavizado) de la natural; salida sRGB→lineal→`colorspace_fragment` y sin
  tone mapping (es un mapa de datos), niebla `adFog` al final. Fuera del campo alfa × `HIDRO.vis.natural.outside` (0,35); borde del
  campo difuminado con promedio 3×3 de `tIn` separado `bordeSuaveCeldas` (3) celdas; rampa del mismo ancho en el borde de la grilla.
- **Anti z-fighting con la malla de MapLibre**: en la cenital desde varios km la malla de terreno (LOD grueso) tapaba el mapa a
  manchones aunque tuviera `polygonOffset` y `yOff`. Solución: el vertex shader sube las capas de velocidad y estelas
  `LIFT · distancia a la cámara` (LIFT = 0,002: 0,001 ya alcanzaba, se dejó el doble de margen). Medido con 0 / 0,001 / 0,003 / 0,01.
  En el rasante son centímetros; en la cenital el desplazamiento vertical no se ve. **La lámina natural (F2) NO lo usa** (se pidió diff 0 %)
  pero tiene el mismo latente en la cenital (ver deuda).
- **Estelas, simulación** (todo CPU, buffers preasignados, cero asignación por frame): posiciones/edad/vida en `Float32Array`;
  RK2 (punto medio) con bilineal de `dirX/dirY/v` en metros de escena; velocidad visual = `v·exageracion` (160). Reaparición por
  tabla acumulada (búsqueda binaria) con peso 1 dentro del campo, 0,05 fuera, y hasta ×3 en celdas rápidas (los cauces son angostos y
  las partículas salen enseguida); se rehace sin reconstruir al llegar un resultado nuevo (lluvia): solo cambian las referencias.
- **Cola**: 8 puntos armados por distancia: cada vez que la cabeza se aleja `largo/7` del primer punto de historia, la historia se
  corre un lugar; `largo = clamp(v·estelaSegundos, estelaMinM, estelaMaxM)` (45–420 m). Al nacer la cola se marcha aguas arriba por
  la misma grilla (nace completa) y la envolvente de alfa la hace entrar en 0,4 s y salir en 0,6 s. Nota: con la velocidad visual
  `v·160` y vida 2–6 s, en zonas lentas (v < 0,1) la cola no alcanza los 45 m (llega a ~v·160·edad): el mínimo es un piso del largo
  objetivo, no un largo garantizado.
- **Render de estelas**: una sola malla instanciada (instancia = partícula, 2·NP vértices en tira, `gl_VertexID/gl_InstanceID`);
  los puntos viven en una textura RGBA32F de solo lectura (2048 de ancho; `texelFetch` en el vertex shader, sin extensiones de
  render a float). La cinta se expande en pantalla (`anchoPx` en píxeles de lienzo = CSS · devicePixelRatio, con 0,6 px de
  suavizado). Alfa `alfaCabeza · envolvente · (1 − k/7)^1,2`: cola transparente. Blanco, niebla al final, atenuadas fuera del campo.
  Altura: la grilla de vértices del mapa (ya `heightAt + yOff`) interpolada bilineal + 0,06 m, y `a6Low` en el vertex shader (sigue
  el factor vivo `k`; verificado con el relieve apagado).
- **Orden de dibujo**: mapa de velocidad `renderOrder −9,5` (como la natural: encima del suelo, antes del receptor de sombras),
  estelas −9,4 con `polygonOffset(−3, −6)`; todos `depthWrite` apagado. Encima de los polígonos `agua` (decisión G1).
- **Fundido de escenarios**: durante el fundido se simulan y dibujan los DOS conjuntos de estelas, cada uno con su `uFade`: se cruzan
  igual que el mapa (queda lo mejor visualmente, medido en `fundido.png`). Costo transitorio: dos ticks (~+3 ms por ~1 s).
- **Calidad**: Ultra 20 000 / Alta 15 000 / Media 8 000 animadas; Baja: 3 000 estelas estáticas (sin animación, `idleFps = 0`).
  Cambiar de calidad en caliente reasigna (verificado Alta → Baja → Media → Alta). La memoria de las estelas se pide recién al mostrarlas
  y se devuelve con el simulador apagado.
- **Reposo**: `idleDriver.request("runoff", …)` solo cuando cambia; en velocidad el criterio de "cerca y en cuadro" usa 8 km
  (`PART_IDLE_MAX`) en vez de los 1500 m de la natural: las estelas se ven y se mueven desde la vista home (~2 km de altura).
  `dt = Math.max(0, frame.dt)/1000`, tope 0,1 s. Sin rAF propio. Simulador apagado: grupos invisibles, `update` sale antes de tocar nada.

## Diales
De `HIDRO.vis` se leen: `natural.*` (ahora todo), `vMinMs`, `vMaxMs`, `velocidad.opacidad` (0,85), `velocidad.bordeSuaveCeldas` (3),
`particulas.presupuesto/vidaS/puntosEstela/exageracion/anchoPx/alfaCabeza/estaticasBaja`, `estelaMinM/estelaMaxM/estelaSegundos`.
Constantes locales marcadas `// → HIDRO` (pedir a hidro-motor):
- `runoff.js`: `LIFT` 0,002 (m por m), `PART_IDLE_MAX` 8000 m.
- `runoff-particulas.js`: `Y_EXTRA` 0,06 m, `OUTSIDE_W` 0,05, `SPEED_W` 2,0, `FADE_IN` 0,4 s, `FADE_OUT` 0,6 s, `DT_MAX` 0,1 s, `FEATHER` 0,6 px, `TEXW` 2048.
- `runoff-turbo.js`: `T0` 0,05 (piso de la paleta).

## Verificación
Servidor 8170, Playwright (`dev/qa`), `?fixture=demo_relieve&qa&terreno=1&calidad=alta`, 1280×720, SwiftShader. Prendido con
`__nav3d.runoff.set("velocidad")`. Capturas en
`/tmp/claude-0/-home-user-ad-3d-nav/6bb04ed0-9a05-5107-be41-83527c75b459/scratchpad/f3/` (script: `cap.mjs` en la misma carpeta):
- `alta/{inicial,multi}-{home,cenital,conf-med,conf-obl,conf-cen,conf-ras}.png`: Alta, relieve prendido.
- `alta-sinrel/{inicial,multi}-{home,conf-obl,conf-ras}.png`: Alta, relieve apagado (k = 0): las estelas y el mapa siguen la superficie.
- `baja/{inicial,multi}-{home,conf-med,conf-obl,conf-ras}.png`: Baja (3 000 estelas fijas).
- `lluvia10/` y `lluvia100/` (`inicial-{home,conf-med}.png`); `fundido.png` (cruce de escenarios a mitad del fundido);
  `lift0/`, `lift0.001/`, `lift0.003/`, `lift0.01/` (cenital: la prueba del z-fighting); `anim/{a,b}.png` (1 s de diferencia: 3,7 % de píxeles cambian).
- Lectura: cauces en naranja-rojo, laderas verde-azul, corredores del multi en azul oscuro, estelas largas y densas en los cauces y
  cortas en las laderas; con 100 mm/h todo se corre hacia amarillo/naranja, con 10 mm/h hacia azul.
- **Simulador apagado**: `capture.mjs --hide-ui` vs `dev/qa/baseline`: 12 pares, peor 0,0004 % (≤ 4 px, ruido de SwiftShader). `stats()` sin
  claves nuevas (`{}` por escenario). **Natural**: antes/después del cambio NAT → HIDRO: 4 pares, 0 %.
- **Prendido (home, inicial)**: draw calls 10 → 12 (+2: mapa + estelas); en el fundido de escenarios +4 (límite 6). Triángulos +479 k
  (269 k del mapa + 210 k de estelas, Alta). `runoffTris 479136, runoffParticles 15000, runoffTexMB 7,12` (inicial) / `3,91` (multi):
  11 MB entre los dos, ≤ 16 MB. Natural: 202 k tris, 0 partículas. Baja: 311 k tris, 3000 estelas, 5,65 / 2,44 MB. Media: 8000.
- **CPU de las partículas** (`performance.now()` en `tick`, media móvil, home, SwiftShader compartiendo CPU): Alta (15 000) 4,4–5,6 ms por
  frame; Ultra (20 000) 6,7 ms; Media (8 000) 4,0 ms (ruidoso). Más la subida de ~1,9 MB de textura por frame (no medible acá). Ver riesgos.
- Comportamiento: natural ↔ velocidad ↔ off sin fugas (estelas en 0 fuera de velocidad); lluvia 100 reemplaza el campo sin reconstruir;
  calidad en caliente Alta → Baja → Media → Alta; con el simulador apagado ninguna llamada a `idleDriver.request("runoff", true)`.
- Consola: sin errores ni warnings (salvo los "GPU stall due to ReadPixels" de SwiftShader). `node tools/stamp_version.mjs --check`: OK (210 especificadores).

## Riesgos y deuda
- **CPU de las partículas**: ~4–6 ms/frame en esta máquina; en un celular de gama media serían varias veces más. Palancas: bajar
  `presupuesto` (los diales ya están), mover la simulación al worker del motor (`SharedArrayBuffer`/transferibles) o a WASM en F4. El
  fps real hay que medirlo en el equipo del dueño con `?fps` (objetivo ≥ 40 fps en Alta con partículas).
- **Triángulos**: el mapa cubre toda la cuenca (269 k/escenario) y es la mayor parte del costo de GPU. Si pesa: indexar cada 2×2 celdas
  (÷4, la DEM de origen es de 30 m), o recortar la cuenca de aporte fuera de `inside` en Media/Baja.
- **Z-fighting de la natural en la cenital** (latente desde F2, no se tocó por el diff 0 %): se puede arreglar con el mismo `uLift` (una línea
  en su vertex shader). Pedido: que el orquestador decida si se incluye en F4.
- Dos conjuntos de estelas simultáneos en el fundido (≈ +3 ms ~1 s). Aceptable; si molesta, simular solo el visible y mostrar el otro quieto.
- Con muchas partículas en un sumidero del modelo (depresiones sin salida) se acumulan estelas radiales: es el campo del motor (celdas sin
  drenaje), no un error de dibujo; si se quiere atenuar, ponderar el peso de reaparición por distancia a sumideros o `dlog`.
- En el rasante muy rasante las estelas se ven como líneas horizontales largas (la cinta es de ancho fijo en pantalla, como pide el plan).
- La textura de puntos se sube entera (RGBA32F) cada frame: en celulares conviene `presupuesto.media` ≤ 8 000 (ya es así).

## Pedidos a otros dueños
- **hidro-ui** (`js/ui/runoff-ui.js`): importar `turboCss` de `js/render/systems/runoff-turbo.js` (firma arriba) para la leyenda.
- **hidro-motor** (`config.js`): pasar a `HIDRO.vis` las constantes marcadas `// → HIDRO` (sección Diales): `liftDist`, `idleMaxDistVelocidad`,
  `particulas.{yExtraM, pesoFuera, pesoVelocidad, fadeInS, fadeOutS}`, `turboT0`.
- **hidro-plataforma** (`qa-api.js`, opcional): exponer `__nav3d.runoff.particleTiming()` si se quiere medir sin importar el módulo
  (hoy: `import('/js/render/systems/runoff.js?v=20261122').then(m => m.particleTiming())`).

## Preguntas
- ¿Las estelas fuera del campo (atenuadas ×0,35) están bien, o prefieren que no haya (peso 0)? Hoy ~20 % de las partículas nacen afuera.
- ¿Se arregla también la natural en la cenital con el `uLift` (rompe el "diff 0 %" de la natural solo en vistas lejanas)?
- ¿Aceptan 4–6 ms de CPU en Alta como punto de partida a validar con `?fps` en su equipo?

## Ronda 2 (decisiones del orquestador)
1. **Densidad por distancia (estelas)**: alfa × `mix(1, 0,5, smoothstep(1500, 5000 m, distancia))` en el vertex shader (`DIST_ALFA`), y fracción
   dibujada `1 → 0,35` entre 2500 y 7000 m (`DIST_FRAC`, rango de instancias del draw, sin reasignar; también se simulan solo las dibujadas).
   Home: 14 120 de 15 000; cenital: 11 854. Primer intento (1200/4000/0,3) dejaba las estelas casi invisibles en la cenital; quedó 1500/5000/0,5.
   En la home se lee el mapa de colores con las estelas como textura fina encima.
2. **Halo del campo en Velocidad**: `inside` → distancia chamfer 3-4 en CPU al llegar cada resultado (`buildHalo`, 135 k celdas, dos pasadas) →
   textura R8 lineal (1 dentro, 0 a `HALO_M` = 300 m del borde) que reemplaza a `tIn` en el mapa de velocidad y las estelas (alfa fuera ya no usa
   `natural.outside`). El índice de Velocidad ahora solo incluye los cuadros con halo > 0 (269 k → 233–265 k tris según vista; ~106 k en Baja) y se
   rehace por resultado. Las estelas nacen dentro del campo (peso 1) o en el halo (peso 0,05 × halo). Natural no cambia (35 % fuera).
3. **LIFT también en Agua natural**, pero ahora arranca a 600 m de la cámara: `y += 0,002 · max(dist − 600, 0)` (en los tres shaders). Con la versión
   anterior (desde 0) de cerca a 300 m levantaba 0,6 m y movía el agua (0,77 % de diff en conf-obl); con el umbral, de cerca ~0,07 %.
   Cambio visual de natural, documentado: en la cenital desaparecen los manchones (antes el agua se cortaba en tramos; ahora los cauces salen
   continuos). Diff natural antes/después: home 0,35 %, cenital 0,74 %, conf-obl 0,07 % (todo por el LIFT, es una mejora a propósito).
4. Constantes `// → HIDRO` quedan en mis archivos hasta F4 (nuevas: `HALO_M`, `DIST_ALFA`, `DIST_FRAC`).

Verificación: capturas en `.../scratchpad/f3/r2/` (`alta/{inicial,multi}-{home,cenital,conf-obl}.png`, `baja/inicial-home.png`,
`nat-antes/` y `nat-despues/` {home,cenital,conf-obl} de la natural, `apagado/`). Simulador apagado vs `dev/qa/baseline`: 12 pares, peor 0,0095 %
(ruido), `stats()` sin claves nuevas. Prendido Alta home: 12 draws, 14 120 estelas, `runoffTexMB` 4,80 / 3,91. Consola sin errores (salvo GPU stall).
Deuda: el halo se mide al borde de `inside` del motor (celdas de 15 m): borde con la forma del campo, no un círculo.

## Ronda 3
1. **Baja, "polilíneas angulares"**: eran las cuerdas de la cola (8 puntos, hasta 60 m entre puntos en los cauces rápidos) que doblan en las curvas
   de confluencia. Dos arreglos: (a) la cola se marcha con pasos RK2 cortos (`STEP_M` = 6 m, menos de media celda) y se corta si el rumbo gira más
   de 60° entre pasos (`TURN_COS` 0,5: zigzags de celdas sin salida); (b) el vertex shader dibuja cada tramo como spline Catmull-Rom (`SUB`
   subdivisiones por tramo, `STATIC_SUB` = 3 en Baja y 1 en las animadas): curvas suaves que pasan por los puntos. Costo: +95 k tris en Baja
   (3000 · 7 · 3 · 2 = 126 k de estelas).
2. **Manchitas oscuras ovaladas en la cenital de cerca**: son del simulador, no de otro sistema. Ocultando mallas una por una desaparecen solo al
   ocultar el mapa de velocidad: son la malla de terreno de MapLibre asomando por encima de la capa a < 0,3 m (patrón regular = teselado de la
   malla; las veía solo en la cenital cerca porque el LIFT empieza a 600 m). Arreglo: subida fija `uLift0` = 0,4 m en el mapa y las estelas
   (probado 0,1: quedan puntitos; 0,3: casi limpio; 0,4 de margen). La natural no la usa (sin cambio).
3. **Rasante**: alfa de las estelas × `mix(0,06, 1, smoothstep(0,10, 0,55, seno de la elevación de la vista))` (`GRAZE`): el horizonte deja de ser una
   banda blanca; el mapa de colores sigue igual.
Verificación (`.../scratchpad/f3/r3/`): `antes/` y `despues/` (conf-cen, conf-ras inicial/multi, Alta), `antes-baja/` y `despues-baja/` (home y conf-obl),
`off-baja/` (Baja sin simulador, para ver los polígonos), `who/` (diagnóstico de las manchitas). Simulador apagado vs baseline: 12 pares, peor 0,0128 %
(ruido). Consola limpia (salvo GPU stall). `stamp_version --check` OK. Constantes nuevas `// → HIDRO`: `uLift0`, `STEP_M`, `TURN_COS`, `GRAZE`, `STATIC_SUB`.
