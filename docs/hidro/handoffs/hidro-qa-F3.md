# hidro-qa · F3 (compuerta G2)

Rama: `hidro/f3-velocidad` (77f26ee). Sin push. Servidor propio en 8190 (y 8191 para un worktree de `claude/staging` = G1, 614d4d7), Chromium + SwiftShader,
`?fixture=demo_relieve&qa&terreno=1&calidad=alta`, 1280x720, `freezeTime(12.5)`, `seed(1)`. Versión de caché 20261122.

## Resumen
**Veredicto G2 (parte QA): APROBADO**, con dos avisos para el orquestador (ver Observaciones). Con el simulador apagado el visor es idéntico a la línea base:
los diffs de 0,003-0,013 % de F3 son ruido del propio visor (la rama de G1 da lo mismo) y no hay cambio real. Prendido en Velocidad: +2 draw calls (+4 durante el fundido; límite 6),
texturas del simulador 8,7 MB sumando escenarios (límite 16), cálculo de ambos escenarios 199 ms (límite 1,5 s), recálculo por lluvia 34-81 ms en el worker, consola sin errores ni
warnings nuevos, `stamp_version --check` y `hydro.test.mjs` en verde. Los fps los tiene que medir el dueño (~4-5 ms de CPU por frame en las estelas en SwiftShader).

## Qué cambió
- `dev/qa/velocidad.mjs` (nuevo; en vez de inflar `runoff.mjs`, que sigue siendo el de Agua natural/G1): Velocidad apagado/prendido en home, cenital, conf-obl, conf-cen y conf-ras (inicial y multi, Alta),
  segunda toma de 3 vistas (ruido de estelas), Baja (home, conf-obl), lluvia 10 y 100 mm/h (home), relieve apagado (home, conf-obl), Agua natural (home, cenital), fundido de escenarios
  (draw calls cada 100 ms durante 3,5 s con apagado / natural / velocidad), tick de estelas, tiempos de lluvia. Salida `medidas.json`, `console.json`.
- `dev/qa/panel_g2.mjs` (nuevo): panel en Agua natural y Velocidad a 1440/830/500/375 con chequeo de desborde, marca "Ilustrativo" (posición vs. atribución, "campo sintético" y panel), prueba del deslizador con teclado y hoja.
- `dev/qa/sheet.mjs`: rótulos `Baja · ...` y `N mm/h` (nombres `*-NNmmh.png`). `dev/qa/README.md`: comandos nuevos.
- `docs/hidro/compuertas/G2/`: `hoja_g2.jpg` (723 KB, 14 pares antes/después: 10 Alta + Baja + sin relieve), `hoja_lluvia.jpg` (258 KB, 10/50/100 mm/h inicial y multi),
  `hoja_panel.jpg` (377 KB), `hoja_natural_lift.jpg` (227 KB, Agua natural G1 vs hoy).

## Verificación
### 1. Simulador apagado = visor idéntico
`capture.mjs --hide-ui` (12 vistas) cuatro corridas: rama F3 x2 y G1 (`claude/staging`) x2, contra `dev/qa/baseline` y entre sí.
| comparación | peor par | resto |
|---|---|---|
| baseline vs F3 corrida A | 0,0128 % (118 px, multi-rasante-medio) | <= 0,0004 % |
| baseline vs F3 corrida B | 0,003 % (28 px, multi-rasante-medio) | <= 0,0004 % |
| F3 A vs F3 B | 0,0098 % (90 px, multi-rasante-medio) | 0 % |
| baseline vs G1 corrida A | 0,0004 % | idem |
| baseline vs G1 corrida B | 0,003 % (28 px, multi-rasante-medio) | <= 0,0004 % |
| G1 A vs G1 B | 0,003 % (28 px, multi-rasante-medio) | 0 % |
| G1 A vs F3 A | 0,0128 % | |
Conclusión: el único par que se mueve es multi-rasante-medio (pasto/instancias que dependen del orden de generación entre cuadros), y se mueve igual en la rama vieja de G1 entre dos corridas
(0 a 0,003 %). Las tres vistas 0,18 % que vio UI no se reprodujeron en 4 corridas; no hay cambio real con el simulador apagado. Todo bajo el límite 0,5 %.
`stats()` vs `baseline/stats.json`: F3 A idéntico (draws, triángulos, texturas, claves); F3 B difiere en multi-rasante (18 → 17 draws, 135 985 → 129 703 tris, `geometries`), y G1 A/B también
(19/17 draws en multi-rasante; B además multi-rasante-medio 36 → 31): variación del streaming de pasto, igual en G1. Sin claves `runoff*` con el simulador apagado. Worker: 0 al abrir.

### 2. Vistas (hoja_g2.jpg, hoja_lluvia.jpg)
Estelas no deterministas: dos tomas del mismo encuadre (home, cenital, conf-obl inicial) difieren 3,3 % / 6,9 % / 10,8 % de píxeles (dE 1,2 / 2,6 / 4,2). Es esperable (el dt viene de frames reales; solo el
reaparecer usa el rng con semilla). No se cuenta como regresión; el mapa de colores sí es determinista.

### 3-4. Apagado vs prendido (Velocidad, 50 mm/h, Alta)
| vista | draws off → vel | tris off → vel | texturas off → vel | runoffTris | estelas | runoffTexMB |
|---|---|---|---|---|---|---|
| inicial home | 10 → 12 (+2) | 31 875 → 296 521 | 9 → 16 | 264 646 | 14 120 | 4,80 |
| inicial cenital | 10 → 12 (+2) | 31 875 → 264 797 | 9 → 16 | 232 922 | 11 854 | 4,80 |
| inicial conf-obl / conf-cen | 5 → 7 (+2) | 57 438 → 334 404 | 9 → 16 | 276 966 | 15 000 | 4,80 |
| inicial conf-ras | 10 → 12 (+2) | 59 472 → 336 438 | 9 → 16 | 276 966 | 15 000 | 4,80 |
| multi home | 14 → 16 (+2) | 59 027 → 323 673 | 11 → 16 | 264 646 | 14 120 | 3,91 |
| multi cenital | 14 → 16 (+2) | 59 027 → 291 949 | 11 → 16 | 232 922 | 11 854 | 3,91 |
| multi conf-obl / conf-cen | 5 → 7 (+2) | 84 869 → 361 835 | 11 → 16 | 276 966 | 15 000 | 3,91 |
| multi conf-ras | 22 → 24 (+2) | 110 507 → 387 473 | 11 → 16 | 276 966 | 15 000 | 3,91 |
- Texturas del simulador: 4,80 + 3,91 = **8,71 MB** (escenarios residentes). Baja: 3,33 MB. Agua natural: mismos 4,80/3,91.
- Fundido de escenarios inicial → multi (máximo de draw calls en 3,5 s, home): apagado 24, natural 26 (+2), **velocidad 28 (+4)**.
- Baja (3 000 estelas estáticas, sin animación): home 7 → 9 draws, 3 528 → 110 030 tris; conf-obl 1 → 3, 882 → 109 848; 2 → 5 texturas.
- Relieve apagado: mismos draws (+2) y ~335-362 k tris; el mapa y las estelas siguen el suelo plano.
- Estelas al apagar: `runoffParticles` 0 en ambos escenarios (la memoria se devuelve).
- Worker: primer cálculo de ambos escenarios 199 ms (`stats.ms.total`; relleno 37, pesos 28, dirección/pendiente 31, acumulación 24, clases 3), pared desde `set("velocidad")` hasta `ready` 474 ms.
  Recálculo por lluvia (`evaluar`): 10 mm/h 46 ms, 100 mm/h 81 ms; ciclos de ida y vuelta 34-44 ms. Tiempo de pared del `rain()` hasta `ready` en SwiftShader: 530-610 ms (incluye halo CPU y subida de texturas; no es el worker).
  Solo se crea 1 worker, recién al prender.
- CPU de estelas por frame (`particleTiming()` desde afuera, home, Alta, SwiftShader compartiendo CPU): 4,0-4,3 ms (6 muestras, escenario inicial); 2,4-5,3 ms según vista y momento. Coincide con el handoff de render (4,4-5,6 ms).
  Los fps de SwiftShader no sirven (los rAF dan ~60 con o sin simulador porque el cuello es el rasterizado por software: no informo fps).
- Consola: 4 warnings "GPU stall due to ReadPixels" (SwiftShader, iguales a `baseline/console.json`); 0 errores, 0 nuevos. Panel: sin mensajes nuevos.
- `node tools/stamp_version.mjs --check`: OK (212 especificadores, versión 20261122). `node dev/test/hydro.test.mjs`: 61 ok, 0 fallas.

### Panel y marca (hoja_panel.jpg)
1440/830/500/375: sin desborde (`scrollWidth == innerWidth`; las marcas de la leyenda terminan 10-22 px dentro del panel), leyenda de Velocidad con barra turbo y marcas 0,02 / 0,05 / 0,1 / 0,2 / 0,5 / 1 / 1,5, deslizador 10-100 con `aria-valuetext`,
dos pasos de teclado llevan el deslizador y `rainMmH` a 60 en los 4 anchos. Marca "Ilustrativo · no es un estudio hidrológico" visible sobre el mapa en Agua natural y Velocidad; no pisa la atribución (compacta, y a <= 830 sobre ella),
ni "campo sintético", ni el panel (con el panel cerrado a <= 830; con la hoja inferior abierta la tapa, por diseño).

### Agua natural vs G1 (LIFT) — hoja_natural_lift.jpg
Diferencia de píxeles G1 vs hoy: home inicial 1,50 %, cenital inicial 1,01 %, home multi 0,62 %, cenital multi 0,93 % (incluye la marca "Ilustrativo" nueva y el LIFT). En la cenital los cauces salen continuos (antes cortados en tramos): mejora visible.
En home la lámina se ve algo más tenue que en G1 (a distancia el LIFT la despega del suelo y la mezcla de profundidad cambia); conviene que el dueño lo confirme.

### Criterios de PLAN §5
| criterio | resultado |
|---|---|
| Apagado = visor idéntico (diff, stats, sin worker) | cumple (<= 0,013 %, ruido reproducido en G1; stats iguales salvo variación de pasto igual a la de G1; 0 workers) |
| Prendido <= +6 draw calls | cumple (+2; +4 en el fundido) |
| Texturas <= 16 MB | cumple (8,71 MB; 5 MB en Baja) |
| Cálculo < 1,5 s | cumple (199 ms; recálculo 34-81 ms) |
| Fps >= 40 con partículas | no medible en la nube (CPU de estelas ~4-5 ms/frame y ~265 k tris de mapa + ~210 k de estelas para el dueño) |
| Consola; stamp --check | cumple |
| Campos llanos deshabilitados | cumple en `?terreno=0` (sin campo llano sintético) |
| Español; "ilustrativo" visible en todas las vistas | cumple: marca sobre el mapa mientras está prendido + rótulo del panel |

## Veredicto
**APROBADO** (parte QA de G2). Sin regresiones.

## Observaciones visuales para el orquestador
- Baja: en conf-obl se ven polilíneas angulares largas (quebradas rectas que cruzan el mapa) entre las estelas estáticas: las colas de 8 puntos de las estelas fijas parecen demasiado espaciadas; se ve feo de cerca. A lo lejos (home) no se nota.
- Velocidad se lee bien: cauces naranja-rojo, laderas verde-azul, estelas largas y densas en los cauces. Desde la home el campo es un óvalo con halo de 300 m (la forma del campo no se reconoce, solo el halo); en la cenital igual.
- Multi: los corredores oscuros (azul) se ven poco en home/cenital; en conf-obl multi no se distingue el corredor del resto. Es F4 (Diferencia) pero el mensaje inicial-vs-multi aún no se lee en Velocidad.
- Lluvia 10 mm/h: todo violeta-azul; 100 mm/h: cauces naranja-amarillo; el cambio se lee bien en la hoja.
- Con relieve apagado casi no cambia la imagen respecto de con relieve (esperable: el color no depende de la altura).
- En conf-ras las estelas se ven como líneas horizontales largas y el cielo/horizonte queda limpio; bien.
- La marca "Ilustrativo" tiene poco contraste sobre satélite claro (sobre todo a 500 y 375 px, donde además queda pegada al cartel de atribución desplegado).
- Mi lectura de pasto/draws: multi-rasante-medio es la vista que se mueve entre corridas con el simulador apagado (también en G1).

## Riesgos y deuda
- Fps y primer prendido en celular no medibles acá; la CPU de las estelas (4-5 ms en esta máquina) en un celular medio puede ser varias veces mayor.
- Las estelas no son deterministas: no hay diff pixel a pixel posible en Velocidad; se compara la paleta y la forma.
- Las capturas dependen de las teselas de hoy.

## Repasada final (rama hidro/f3-velocidad en 8cbd3ee, caché 20261123)
Mismos scripts, servidor propio en 8190, Chromium + SwiftShader, 1280x720, `freezeTime(12.5)`, `seed(1)`. Cambió solo `velocidad.mjs`: la constante `VERS` de `particleTiming()` quedó en 20261122 y devolvía `{}` (import duplicado); ahora 20261123.
Hojas regeneradas (pisan las anteriores): `hoja_g2.jpg` (14 pares), `hoja_lluvia.jpg`, `hoja_panel.jpg`. `hoja_natural_lift.jpg` sin cambios (Agua natural no se tocó).

**Veredicto: APROBADO.**

| punto | resultado |
|---|---|
| Apagado vs `baseline` (12 vistas) | peor 0,1487 % (1 370 px, multi-rasante-medio, la vista del pasto que ya se movía); resto <= 0,0004 %. Repetida sola, esa vista da 0 % contra la base: ruido de orden de pasto, no cambio. Límite 0,5 % OK |
| `stats()` apagado | draws y triángulos idénticos salvo multi-rasante (18 → 17; 135 985 → 129 703) y multi-rasante-medio (36 → 34), variación de streaming de pasto ya vista en G1; sin claves `runoff*`; 0 workers al abrir |
| Draw calls prendido (Velocidad, Alta) | +2 en todas las vistas (límite 6); en el fundido inicial → multi: apagado 24, natural 26, velocidad 28 (+4) |
| runoffTris Alta | 232 922 (cenital) a 276 966 (confluencia); home 264 646. Estelas 11 854-15 000 |
| runoffTris Baja | home 185 574 (2 824 estelas), conf-obl 192 966 (3 000). Antes ~110 k: las curvas suaves suman triángulos (costo de la ronda 3) |
| runoffTexMB | Alta 4,80 + 3,91 = 8,71 MB (límite 16); Baja 3,33 |
| Worker | primer cálculo `total` 215 ms (relleno 38, pesos 26, dir/pendiente 39, acumulación 24, clases 3); pared hasta `ready` 626 ms. Recálculo por lluvia 46-57 ms (10, 50, 100 mm/h). 1 solo worker |
| CPU de estelas `particleTiming()` | 5,05 ms (inicial) y 5,13 ms (multi) por frame en home Alta, SwiftShader compartiendo CPU; referencia relativa, vs 4,0-4,3 en la pasada anterior (+~0,8 ms). Fps: los mide el dueño |
| Consola | solo los 4 warnings "GPU stall due to ReadPixels" de SwiftShader (idénticos a la base); 0 errores, 0 nuevos |
| `stamp_version --check` | OK, 212 especificadores, versión única 20261123 |
| `hydro.test.mjs` | 61 ok, 0 fallas |
| Panel 1440/830/500/375 | `scrollWidth == innerWidth`; marcas de la leyenda terminan 10-22 px dentro del panel; el chequeo heurístico lista `.runoff-marcas` por `scrollWidth` interno (rótulos de la regla), no es desborde visible. Deslizador 10-100 con aria |

Confirmaciones visuales (Alta/Baja, capturas en `dev/qa/out/final`, no commiteadas):
- Polilíneas angulares en Baja: **se fueron**. En conf-obl las estelas fijas son curvas suaves. Quedan unas pocas largas y casi rectas (arriba a la izquierda y abajo), sin quiebres.
- Manchitas oscuras en conf-cen: **se fueron** (mapa limpio, solo un rayado muy leve en el borde izquierdo).
- Banda blanca al horizonte en conf-ras: **se fue**; cielo y horizonte limpios, las estelas se atenúan al rasante.
- Marca "Ilustrativo": ahora es una píldora oscura con texto blanco; se lee sobre el satélite claro a 1440 y 375 px (con el panel cerrado), sin pisar la atribución ni "campo sintético". A 375 px queda justo encima del cartel de atribución desplegado, sin solaparse.

Para el dueño: fps con estelas en su equipo y en celular (CPU de estelas ~5 ms/frame acá; Baja ahora ~190 k triángulos de estelas+mapa).
