# hidro-qa · F4 (compuerta G3)

Rama `hidro/f4-pulido` (a5bd023, caché 20261124). Sin push. Servidor propio en 8220 (G2 exportado de 163b4a2 en 8221, G0 de 41a9639 en 8223), Chromium + SwiftShader,
`?fixture=demo_relieve&qa&terreno=1&calidad=alta`, 1280x720, `freezeTime(12.5)`, `seed(1)`.

## Resumen
**Veredicto G3 (parte QA): APROBADO.** Apagado = visor idéntico (peor diff 0,0128 %, `stats()` igual salvo pasto de multi-rasante, 0 workers, 0 datos extra al abrir). Prendido: +1 a +2 draw calls
(+4 en el fundido con Velocidad; límite 6), texturas 8,71 MB como máximo por modo (límite 16), primer cálculo 196 ms (límite 1,5 s), recálculo por lluvia 39-54 ms. Natural y Velocidad iguales a G2
(Natural 0 px de diferencia; Velocidad 0 px en inicial y <= 0,50 % en multi, puntas de estelas, contra 3,6-7,6 % de ruido propio). Móvil: estelas a la mitad. Campo llano: deshabilitado con motivo. Consola limpia. Fps: los mide el dueño.

## Qué cambió
- `dev/qa/difer.mjs` (nuevo), `apertura.mjs`, `llano.mjs`, `movil.mjs`, `panel_g3.mjs` (nuevos); `lib.mjs`: `openViewer(..., ctxOpts)` para `isMobile/hasTouch`; `velocidad.mjs`: `VERS` 20261124; `README.md`.
- `docs/hidro/compuertas/G3/`: `hoja_g3.jpg` (631 KB, 16 pares Diferencia antes/después: home, cenital, conf-obl, conf-ras, inicial y multi, Baja y sin relieve), `hoja_vistas.jpg` (276 KB, confluencia C1xV1 en conf-cen y conf-obl, apagado/natural/velocidad/diferencia, inicial y multi), `hoja_panel.jpg` (421 KB).

## Verificación
### 1. Apagado = visor idéntico
`capture.mjs --hide-ui` (12 vistas) vs `dev/qa/baseline`: peor 0,0128 % (118 px, multi-rasante-medio), resto <= 0,0004 %. Límite 0,5 % OK.
`stats()`: igual en 8 de 12 vistas; multi-rasante 18 -> 20 draws y 135 985 -> 145 093 tris, y `geometries` +1 en 3 vistas de multi: streaming asíncrono de pasto (el mismo ruido de G1/G2), sin claves `runoff*`.
Red al abrir (apagado, F4 vs G0, `apertura.mjs`, 8 s de espera): 120 vs 110 pedidos; la diferencia son **10 módulos JS** (104 KB sin comprimir: `runoff-ui`, `hydro/{state,load,grid,params}`, `render/systems/runoff{,-turbo,-velocidad,-particulas,-diferencia}`), 0 datos (DEM, GeoJSON, teselas), 0 workers del simulador (el único worker es el de MapLibre, en ambas), modo `off`.
### 2. Prendido (Alta, 50 mm/h; "off" tomado con capture.mjs)
| vista | draws off -> nat / vel / dif | runoffTris nat / vel / dif | texMB (inicial + multi) nat / vel / dif |
|---|---|---|---|
| inicial home | 10 -> 11 / 12 / 12 | 202 256 / 264 646 / 70 702 | 2,19+2,06 / 4,80+3,91 / 5,65*+3,91 |
| inicial cenital | 10 -> 11 / 12 / 12 | idem | idem |
| inicial conf-obl, conf-cen | 5 -> 6 / 7 / 7 | 202 256 / 276 966 / 70 702 | idem |
| inicial conf-ras | 10 -> 11 / 12 / 12 | idem | idem |
| multi home | 14 -> 15 / 16 / 16 | idem | idem |
| multi conf-obl | 5 -> 6 / 7 / 7 | idem | idem |
(*) los modos se midieron en una misma sesión y los recursos quedan residentes: 5,65 = Velocidad 4,80 + 0,85 de Diferencia; total residente peor caso 4,80+3,91 (Velocidad) + ~0,9 = ~9,6 MB <= 16. Render midió Diferencia sola en 1,8 MB propios (5,9 MB con ambos escenarios).
Triángulos de estelas Velocidad 232-277 k; Diferencia 70 702 (sin estelas).
Fundido inicial -> multi (máximo de draws en 3,5 s, home): apagado 24, natural 26 (+2), velocidad 28 (+4), diferencia 26 (+2). Todos <= +6.
Baja: draws +2 (home 7 -> 9, conf-obl 1 -> 3); Diferencia baja home 13 draws en multi. Al apagar: `runoffParticles` 0 en ambos escenarios; `runoffTris` de las instancias queda reportado (geometría retenida, `stats()` de instancia), el total de triángulos del visor vuelve al valor apagado.
Worker (primer prendido, frío, Natural): pared 443 ms; `total` 196 ms (relleno 36, pesos 25, dir/pendiente 33, acumulación 25, clases 4, evaluar 46). Recálculo por lluvia: 10 mm/h 46 ms, 50 39 ms, 100 54 ms de worker (pared 350-390 ms con halo y texturas en SwiftShader). 1 solo worker.
### 3. Consola, stamp, tests
Consola: solo los 4 "GPU stall due to ReadPixels" de SwiftShader (idénticos a `baseline/console.json`) en Alta, Baja, sin relieve y en el panel a 1440; 0 en 830/500/375; 0 errores, 0 nuevos. `stamp_version --check`: OK, 216 especificadores, 20261124. `hydro.test.mjs`: 61 ok, 0 fallas.
### 4. Campo llano (`llano.mjs`, 1440 px)
No hay fixture llano. Dos simulaciones sin tocar la app: (a) `?terreno=0` -> `reason: "sin-dem"`; (b) tras cargar, pisar `terrain.stats` (módulo exportado) con desvío 0 y pendiente 0 -> `reason: "llano"`.
En ambos: `runoff.set('natural')` devuelve `false`, el modo sigue `off`, 0 workers, 0 pedidos de red tras el intento, sin marca sobre el mapa, interruptor `disabled`, texto del panel "Sin modelo de terreno" / "Campo llano: el modelo de terreno no alcanza para simular el escurrimiento", consola limpia. Control con relieve: set devuelve true, 1 worker, 7 pedidos (DEM de la cuenca).
No verificado: el cálculo de `terrain.stats` real sobre un DEM llano (el umbral `desvioResidual`/`pendienteP95` real); eso lo prueba el dueño con un campo llano real. Observación: los botones del segmentado y el deslizador no llevan `disabled` en el DOM (solo el interruptor); el bloque queda oculto/atenuado por CSS (ver captura del scratch `llano-forzado.png`: solo muestra interruptor y el motivo).
### 5. Móvil (`movil.mjs`, isMobile + hasTouch)
| caso | estelas inicial (home) / multi (home) | conf-obl |
|---|---|---|
| escritorio 1280 Alta | 14 713 / 15 000 | 15 000 |
| 500x900 móvil Alta | 2 625 / 7 500 | 7 500 |
| 375x812 móvil Alta | 2 625 / 7 500 | 7 500 |
| escritorio Media / 375 móvil Media | 7 847 / 8 000 | 8 000 / 4 000 |
| escritorio Baja / 375 móvil Baja | 2 943 / 3 000 | 3 000 / 1 500 |
Mitad exacta (15 000 -> 7 500, 8 000 -> 4 000, 3 000 -> 1 500). En la home del primer escenario móvil el recuento es menor (2 625) porque se muestra poca zona al arrancar; reponderar y culling, no es un desvío. Panel completo a 375/500 (`hoja_panel.jpg`): tres vistas, métricas, leyendas, sin desborde de página (`scrollWidth == innerWidth`); las marcas de las leyendas terminan 10-22 px dentro del panel (el chequeo heurístico lista `.runoff-marcas` y `#runoff-leyenda` por `scrollWidth` interno: rótulos de los extremos, no desborde visible). Segmentado de 3 botones en una línea en los 4 anchos; deslizador con teclado 50 -> 60 en los 4.
### 6. Rótulo "ilustrativo"
Marca "Ilustrativo · no es un estudio hidrológico" visible sobre el mapa en natural, velocidad y diferencia a 1440/830/500/375, sin pisar atribución, "campo sintético" ni el panel (panel cerrado a <= 830); rótulo del panel "pico de una lluvia de 50 mm/h · no es un estudio hidrológico" y "ilustrativo" en las métricas, en las tres vistas.
### 8. Natural y Velocidad vs G2 (163b4a2; `difer.mjs --base 8221`)
| | peor | resto |
|---|---|---|
| Natural (12 vistas) | 0 % (0 px) | 0 % |
| Velocidad inicial (6 vistas) | 0 % | 0 % |
| Velocidad multi (6 vistas) | 0,4964 % (conf-obl, dE 0,50) | 0,17-0,47 % |
| ruido propio de las estelas (F4 vs F4, 2.ª toma) | 7,60 % cenital, 6,54 % conf-obl, 3,56 % home | |
Las diferencias de Velocidad multi son solo las puntas de las estelas de un cuadro; los diales leídos desde HIDRO no cambiaron nada visible.

### Criterios de PLAN §5
| criterio | resultado |
|---|---|
| Apagado = visor idéntico (diff, stats, sin worker, sin red extra de datos) | cumple |
| Prendido <= +6 draw calls | cumple (+1/+2; +4 en el fundido con Velocidad) |
| Texturas <= 16 MB | cumple (<= ~9,6 MB residentes) |
| Cálculo < 1,5 s | cumple (196 ms; recálculo 39-54 ms) |
| Fps >= 40 con partículas | no medible en la nube |
| Consola; stamp --check | cumple |
| Campos llanos deshabilitados con motivo | cumple en simulación (sin-dem real; llano forzado); falta campo llano real |
| Español; "ilustrativo" visible en todas las vistas | cumple |
| Móvil: estelas a la mitad, panel sin romper | cumple |

## Veredicto
**APROBADO.** Sin regresiones.

## Lista de verificación para producción (dueño, en su equipo)
1. Fps con `?fps` en un campo real con relieve, Alta, Velocidad con estelas (objetivo >= 40) y en Diferencia; también en un celular medio (estelas a la mitad; la CPU de estelas ronda 5 ms/frame acá).
2. Campo real con relieve: que Diferencia muestre azul sobre corredores y parches coherente con la intuición (el sintético solo frena, 0 celdas aceleradas: el degradé naranja-rojo no se vio con datos).
3. Campo llano real: simulador deshabilitado con el motivo, sin worker ni descargas.
4. Primer prendido en red lenta (baja el DEM de la cuenca), y apagar/prender sin recargar; alternar relieve con el simulador prendido.
5. Panel en celular real: segmentado, leyenda de Diferencia y métricas; marca "Ilustrativo" sobre el cartel de atribución.

## Observaciones visuales para el orquestador
- Diferencia en el sintético: azul continuo sobre corredores con la traza punteada blanca nítida (también en rasante y con relieve apagado). Los bordes del azul son dentados (la grilla de ~15 m); a cerca se nota el escalonado. Cosmético.
- En home/cenital el azul fino de corredores se lee bien; los parches chicos salen como manchas azules aisladas. Buen mensaje inicial vs multi.
- A 500 y 375 px la atribución desplegada es grande y se pega a la marca "Ilustrativo" y a "campo sintético" (preexistente; ya se vio en G2).
- Con Velocidad, la lectura "multi frena" sigue siendo sutil; Diferencia la resuelve.
- `stats()` de instancia sigue informando `runoffTris`/`runoffTexMB` con el simulador apagado tras haberlo usado (recursos retenidos): no es un error, pero conviene saberlo al leer `stats()`.

## Riesgos y deuda
Fps y celular no medibles; estelas no deterministas; capturas dependen de las teselas de hoy; el estado llano real no se pudo reproducir sin fixture.
