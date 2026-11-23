# hidro-qa · F0

Rama: `hidro/f0-plataforma`. Sin push.

## Resumen
Harness `dev/qa` funcionando en la nube (Chromium preinstalado + SwiftShader), línea base de las 6 vistas canónicas x 2
escenarios del campo sintético, determinismo medido (dos corridas = 0 % de diferencia en los 12 pares), hojas de contacto y
chequeo de anchos. **Veredicto G0 (parte QA): APROBADO.** Queda la parte del dueño (staging vs producción con un campo real).

## Qué cambió
- `dev/qa/package.json`: `playwright` fijado en `1.63.0` (el Chromium 1243 preinstalado es el de esa versión; antes `^1.64.0`
  no habría andado sin descargar navegador) + `package-lock.json` (`npm ci` reproducible). `.gitignore` ya excluía `node_modules/` y `out/`.
- `capture.mjs`: opción `--size` (default 1280x720; antes 1600x900 fijo, 19 MB de base vs 13 MB).
- `sheet.mjs` (nuevo): hoja de contacto JPG con rótulo "vista · escenario"; `--pair A B` arma pares antes/después.
- `anchos.mjs` (nuevo): `home` con UI a 1440/900/830/500/375 px, chequea desborde horizontal y consola.
- `baseline/`: 12 PNG + `stats.json` (stats por vista, GPU, URL) + `console.json` + `views.json`.
- `docs/hidro/compuertas/G0/hoja_linea_base.jpg`, `hoja_anchos.jpg`.
- README del harness actualizado.

## Decisiones
- Chromium vía `QA_CHROME=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` (no se descargó nada). En el equipo del dueño
  `npx playwright install chromium` baja el que corresponde a 1.63.0.
- 1280x720 en vez de 1600x900 para no inflar el repo público.
- Sin cambios al determinismo del harness: ya alcanzaba (`?qa`, `freezeTime(12.5)`, `seed(1)`, espera 1500 ms).

## Diales
`--size`, `--wait`, `--views`, `--scenario`, `QA_CHROME`, `QA_GPU`; `sheet.mjs --cols --cell`; `anchos.mjs --widths --view --scenario`.

## Verificación
- Diff entre dos corridas independientes (y contra la base commiteada): 12 pares, peor 0 %, dE <= 0,0001; límite 0,5 % -> OK.
- Tiempo de captura: ~90 s para las 12 vistas (SwiftShader; sin valor como fps).
- Stats (draws / tris) inicial: cenital 10/31 875, home 10/31 875, rasante 6/58 584, rasante-medio 9/92 236, parche 13/93 124,
  horizonte 17/111 512. Multi: 14/59 027, 14/59 027, 23/120 173, 29/170 389, 22/151 631, 27/168 173. (Referencia para el criterio "+6 draw calls".)
- Consola: 0 errores. Solo 4 warnings de SwiftShader ("GPU stall due to ReadPixels"), esperables sin GPU, a ignorar en las
  compuertas siguientes (comparar contra esta lista).
- Anchos 1440/900/830/500/375: `scrollWidth == innerWidth` en todos, ningún elemento fuera de pantalla; el panel pasa a
  hoja inferior en 830 y 500 como corresponde. Consola sin errores.
- `node tools/stamp_version.mjs --check`: OK.
- Lo que se ve en la hoja base: el satélite cargó completo (sin teselas negras ni faltantes); el relieve se nota en las vistas
  oblicuas y de horizonte (lomas, horizonte ondulado), en la cenital naturalmente no; el contorno del campo y los lotes se ven
  sin polígonos rotos ni z-fighting; en multi los tres corredores (franjas oscuras rectas) cruzan el campo en diagonal y en
  `rasante`/`rasante-medio multi` el corredor se ve de frente; el monte de `parche` se ve bien. La nube con sombra aparece en
  las vistas altas (es parte del visor). Las vaguadas en sí no se ven a simple vista en la base (el simulador aún no existe).

## Riesgos y deuda
- `rasante` y `rasante-medio` inicial son casi iguales (cámara muy cerca del suelo, borrosa por la resolución del satélite): poco poder de detección ahí.
- Las vistas de la línea base no incluyen una "de cerca en la confluencia principal" ni la "general a pitch ~62°" del simulador:
  hay que agregarlas a `__nav3d.views()` o pasarlas por `--views` en F2 (coordenadas de V1 en `fixtures/demo_relieve/meta.json`).
  Al agregarlas, regenerar la base sólo de esas vistas.
- A 500 y 375 px la atribución de MapLibre se muestra desplegada y tapa la marca "CAMPO SINTÉTICO" (la marca queda debajo del
  recuadro). Cosmético; podría ser un efecto del headless. A 830 px la marca también queda pegada al borde del panel.
- No hay ΔE por máscara de clase (deuda ya anotada en diff.mjs).
- La base depende de las teselas de Esri/AWS de hoy: si el proveedor las actualiza, hay que regenerarla.
- fps: no medibles en la nube.

## Pedidos a otros dueños
- hidro-plataforma / orquestador: decidir si las vistas del simulador se agregan a `views()` en `js/debug/qa-api.js`.
- hidro-ui (menor): marca "CAMPO SINTÉTICO" tapada por la atribución en anchos <= 500.

## Preguntas
- El dueño confirma G0: staging idéntico a producción con un campo real (no medible acá).
