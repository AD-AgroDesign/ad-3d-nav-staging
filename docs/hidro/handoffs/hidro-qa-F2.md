# hidro-qa · F2 (compuerta G1)

Rama: `hidro/f2-natural`. Sin push. Servidor propio en 8160, Chromium preinstalado + SwiftShader, campo sintético
`?fixture=demo_relieve&qa&terreno=1&calidad=alta`, 1280x720, tiempo congelado (12,5), semilla 1.

## Resumen
**Veredicto G1 (parte QA): APROBADO.** Con el simulador apagado el visor es idéntico a la línea base (12 pares, peor 0,0004 %, mismo
ruido que en G0; `stats()` con mismos draws/tris/texturas/claves; sin worker). Prendido: +1 draw call (límite 6), texturas del simulador
4,25 MB (límite 16), cálculo de los dos escenarios 179 ms (límite 1,5 s), consola sin errores ni warnings nuevos, `stamp_version --check` OK.
Quedan para el dueño: fps (+~200 k triángulos por escenario visible) y la prueba con un campo real en staging.

## Qué cambió
- `dev/qa/runoff.mjs` (nuevo): antes/después (simulador off / "natural") de 6 vistas x 2 escenarios + relieve apagado (general62 y conf-obl),
  con `medidas.json` (draws, tris, texturas, `runoffTexMB`, worker, recálculos por lluvia, workers creados).
  Confluencia principal = celda de mayor Q (inicial) dentro del corredor C1: lon -59,26343, lat -37,40855 (cruce con V1, 494 ha de cuenca, Q ≈ 41 m3/s a 50 mm/h).
- `dev/qa/panel.mjs` (nuevo): bloque del simulador apagado/prendido/deshabilitado (`?terreno=0`) a 1440/830/500/375, con chequeo de desborde y hoja.
  A <= 500 px el panel arranca colapsado: el script lo abre con el botón ☰.
- `dev/qa/sheet.mjs`: `--pair A B` andaba mal (parseArgs se llevaba A como valor de `--pair`); ahora anda, con `--cols N` (varios pares por fila),
  `--quality` y rótulo "sin relieve · ...".
- `dev/qa/README.md`: comandos nuevos.
- `docs/hidro/compuertas/G1/hoja_g1.jpg` (609 KB, 16 pares) y `hoja_panel.jpg` (250 KB).

## Verificación
### 1. Simulador apagado = visor idéntico
`capture.mjs --hide-ui` vs `baseline`: 12 pares, peor 0,0004 % (4 px, multi-parche), dE <= 0,0003; límite 0,5 % -> OK. Igual al ruido de G0.
`stats()`: drawCalls, triangles y textures idénticos en las 12 vistas; mismas claves (sin `runoffTris` etc. mientras no hubo resultado).
Solo difieren campos de tiempo dentro de `instances` (buildMs, texMs, grassAtlasMs): ruido.
Worker: 0 workers de `hydro/worker.js` al abrir y mientras el simulador está apagado; se crea recién al prender (1). (Los pedidos de red a s3 los verificó plataforma: sin extras.)
Nota: los draws/tris de la línea base commiteada (p. ej. rasante 9/92 236) difieren de los citados en el handoff de F0 (6/58 584); la base es la fuente y coincide con hoy.

### 2-4. Apagado vs prendido (natural, 50 mm/h)
| vista | draws off → on | tris off → on | texturas off → on | runoffTexMB |
|---|---|---|---|---|
| inicial home / cenital / general62 | 10 → 11 (+1) | 31 875 → 234 131 | 9 → 15 | 4,25 |
| inicial conf-obl / conf-cen | 5 → 6 (+1) | 57 438 → 259 694 | 9 → 15 | 4,25 |
| inicial conf-ras | 10 → 11 (+1) | 59 472 → 261 728 | 9 → 15 | 4,25 |
| multi home / cenital / general62 | 14 → 15 (+1) | 59 027 → 261 695 | 11 → 15 | 4,25 |
| multi conf-obl / conf-cen | 5 → 6 (+1) | 84 869 → 287 537 | 11 → 15 | 4,25 |
| multi conf-ras | 22 → 23 (+1) | 110 507 → 313 175 | 11 → 15 | 4,25 |
(runoffTexMB = 2,19 inicial + 2,06 multi, ambos residentes. runoffTris 202 256 inicial / 202 668 multi.) Relieve apagado: mismos números.
Worker (`result.stats.ms.total`, ambos escenarios, primer cálculo): 179-215 ms entre corridas (< 1,5 s). Recálculo por lluvia (solo `evaluar`): 10 mm/h 60 ms, 50 mm/h 37 ms, 100 mm/h 47 ms.
Diferencia de píxeles antes/después (informativa): generales 0,6-1,2 %, cerca 8-10 %. Relieve apagado vs prendido (agua prendida) general62: 12,8 %: el relieve se apaga de verdad.
Consola: 4 warnings "GPU stall due to ReadPixels" (SwiftShader, iguales a `baseline/console.json`); 0 errores, 0 nuevos. Panel: consola sin mensajes nuevos en los 12 casos.
`node tools/stamp_version.mjs --check`: OK (200 especificadores, versión 20261121).

### Panel (hoja_panel.jpg)
Apagado / prendido / deshabilitado a 1440, 830, 500, 375: ningún elemento del bloque excede el panel, `scrollWidth == innerWidth`; deshabilitado dice "Sin modelo de terreno" con `aria-disabled`; prendido muestra segmentado, leyenda y "Ilustrativo · pico de una lluvia de 50 mm/h · no es un estudio hidrológico".

### Criterios de PLAN §5
| criterio | resultado |
|---|---|
| Apagado = visor idéntico (diff 0 %, stats iguales, sin worker) | cumple (0,0004 % = ruido; stats iguales) |
| Prendido <= +6 draw calls | cumple (+1) |
| Texturas del simulador <= 16 MB | cumple (4,25 MB) |
| Cálculo de ambos escenarios < 1,5 s | cumple (179-215 ms en el worker) |
| Fps >= 40 con partículas | no medible en la nube (y no hay partículas hasta F3) |
| Consola sin errores/warnings nuevos; stamp --check | cumple |
| Campos llanos deshabilitados con motivo | cumple en `?terreno=0` ("Sin modelo de terreno"); el caso "llano" no se probó (no hay campo llano sintético) |
| Español rioplatense; "ilustrativo" visible | cumple en el panel; en el visor 3D no hay rótulo sobre el mapa (ver observaciones) |

## Veredicto
**APROBADO** (parte QA de G1). Sin regresiones.

## Observaciones visuales para el orquestador
- El agua natural se lee bien: cauce principal azul que confluye, cintas finas en los tributarios, color somero → profundo; en la cenital las cintas se ven finas.
  En el rasante la lámina se ve pálida y granulada por el fresnel (esperado, igual que water.js).
- En multi el agua pasa **por encima** de los corredores (conf-obl/conf-cen/conf-ras multi): se ve el cauce cruzando la franja oscura sin ninguna diferencia. Es F2 (no hay efecto del diseño todavía), pero conviene que el dueño sepa que "Agua natural" no distingue inicial de multi a simple vista.
- Fuera del campo el agua sale atenuada (como decidió render): se ve el cauce que viene de la cuenca de aporte; en las generales ese halo celeste se suma al azul del campo y confunde un poco el límite.
- En conf-obl y conf-ras hay parches celestes difusos fuera del cauce (celdas con lámina fina, borde "orgánico"): ruido del DEM de 30 m, cubierto por el aviso "ilustrativo".
- Las generales (home/general62) muestran poca agua: cintas finas apenas visibles a esa escala; la cenital las muestra mejor. Posible pedido: más contraste/ancho mínimo a distancia.
- No hay rótulo "ilustrativo" ni leyenda en el visor mismo: solo en el panel (que a <= 500 px arranca colapsado). El criterio §5 dice "visible en todas las vistas"; decidir con el dueño si se agrega una marca sobre el mapa.
- 375 px prendido: el botón × del panel se superpone al selector "Calidad" cuando el panel está desplazado (preexistente en la hoja inferior, no del simulador).
- Triángulos x7 al prender (~200 k por escenario visible, 135 k vértices): el fps real hay que medirlo en el equipo del dueño con `?fps`, sobre todo en celular.
- Con el relieve apagado, el agua se ve pegada al suelo plano, sin z-fighting.

## Riesgos y deuda
- fps y tiempo del primer prendido (horneo de 135 k `heightAt` + compilación) no medibles en SwiftShader.
- Las imágenes dependen de las teselas de Esri/AWS de hoy; el diff antes/después contra capturas viejas puede moverse.
- Caso "campo llano" sin fixture para probarlo.
