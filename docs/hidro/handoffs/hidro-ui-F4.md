# hidro-ui · F4

## Resumen
Segmentado de tres vistas (Agua natural | Velocidad | Diferencia), leyenda divergente de Diferencia y bloque de métricas inicial → multi en el panel. Rótulo y marca sobre el mapa siguen en todas las vistas.

## Qué cambió
- `js/ui/runoff-ui.js`: vista `diferencia` en `VISTAS` (también vale `?escorrentia=diferencia`); `leyendaDiferencia()`; `metricas()` (nuevo `#runoff-metricas`).
- `css/style.css` (solo sección HIDRO): estilos de métricas, de la línea punteada y del segmentado (`white-space: nowrap`, padding 5 px).
- `README.md`: sección del simulador.

## Decisiones
- Leyenda: "Acelera ← Igual → Frena". Barra con `colAcelera[1]→[0]`, centro gris translúcido (zona |dlog| < umbral) y `colFrena[0]→[1]`. Marcas en `dlog = ±saturación, ±16 %, 0`; `%=100·(2^dlog−1)` da **+122 %, +19 %, 0, −16 %, −55 %** (acelerar y frenar no son simétricos en %, sí en dlog). Supone que el render satura simétrico en ±`saturacion`.
- Textos: "Cambio de velocidad del agua", "Dónde el diseño multifuncional frena el agua respecto del paisaje actual.", "Línea punteada: corredores y parches del diseño".
- Métricas en las tres vistas (el resultado trae los dos escenarios siempre y el dato no depende de la vista; es lo que el dueño compara). Título "Paisaje Actual → Paisaje Multifuncional". Formato es-AR: ha con 1 decimal, m/s con 3. "≥ 16 %" sale de `HIDRO.stats.frenaDlog`, "0,3" de `HIDRO.stats.vAltaMs`. Mientras recalcula se conserva el último valor.
- Se agregó "de 495 ha" (`campoHa`) al renglón de frena, para dar contexto.

## Diales
Ninguno nuevo; lee `HIDRO.vis.diferencia` (colores, umbral, saturación), `HIDRO.stats`.

## Verificación
Servidor 8210, Chromium headless, campo sintético, a 1440/830/500/375 px (scratch `/tmp/claude-0/-home-user-ad-3d-nav/6bb04ed0-9a05-5107-be41-83527c75b459/scratchpad/f4/`: `<ancho>-<vista>-panel.png`, `<ancho>-lluvia.png`, `info.json`).
- Los tres botones caben en una línea (22 px de alto, sin texto cortado) en los cuatro anchos; sin scroll horizontal de página.
- Métricas (50 mm/h): 13,9 → 12,0 ha; 0,085 → 0,080 m/s; frena 58,2 ha de 495. A 65 mm/h con teclado: 17,1 → 15,1 ha; 0,095 → 0,089 (frenaHa no depende de la lluvia, es dlog).
- Consola limpia en los cuatro anchos (`consola` en `info.json`).
- Simulador apagado vs `dev/qa/baseline`: peor 0,0128 % (límite 0,15 %).
- Medición DOM: `.runoff-marcas` y la leyenda marcan `scrollWidth > clientWidth` porque las etiquetas de los extremos sobresalen de la barra (ya pasaba en Velocidad); siguen dentro del panel (ver capturas).
- Pendiente de ver: la vista Diferencia pintada en el mapa (render en paralelo), no la capturé acá.

## Riesgos y deuda
- Si el render no satura simétrico, las marcas +122 % / −55 % de la leyenda hay que ajustarlas.
- Capturas con el panel de 1440 px solo recortadas; no hice captura del mapa con Diferencia.

## Pedidos a otros dueños
- hidro-render: confirmar que la escala de Diferencia es log2 simétrica en ±`saturacion` y que usa el centro transparente para |dlog| < `umbral`.

## Preguntas
- ¿Preferís que las marcas muestren solo los lados "Frena" (−16 %, −55 %) y "Acelera" sin porcentajes?

- Ajuste post-integración: leyenda de Diferencia sin marca "0" (+122, +19, −16, −55 %) y degradé con los cortes del shader (alfa 0 hasta umbral, rampa 0,7·umbral, colX[0]→colX[1] hasta saturación); captura del mapa en `scratchpad/f4/dif-mapa.png`.
