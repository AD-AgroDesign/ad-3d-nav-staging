# hidro-render · F4 (vista Diferencia, diales a HIDRO, móvil)

## Resumen
Las constantes `// → HIDRO` de `runoff*.js` ahora leen `HIDRO.vis.*` (mismos valores: diff 0 % en natural y velocidad). El presupuesto de
estelas se multiplica por `particulas.factorMovil` con `IS_MOBILE`. Nueva vista **Diferencia**: mapa de `dlog = log2(v_multi/v_ini)` divergente
(azul frena / naranja-rojo acelera, transparente bajo el umbral) y traza punteada del diseño (contorno de corredores y parches del multi) con la raya
medida en píxeles de pantalla. Extra en Diferencia: **+2 draw calls**, **~1,8 MB** de texturas/buffers propios.

## Qué cambió
- `js/render/systems/runoff-particulas.js`, `runoff-velocidad.js`, `runoff.js`: constantes → `HIDRO.vis.velocidad / particulas` (`liftDist`, `liftDistDesdeM`
  —el 600.0 de los tres shaders—, `liftFijoM`, `haloM`, `idleMaxDistM`, `yExtraM`, `pesoFuera`, `pesoRapidez`, `fadeInS/OutS`, `distAlfa`, `distFrac`,
  `rasante`, `pasoColaM`, `giroColaCos`, `subdivBaja`). Móvil: `Math.round(presupuesto × factorMovil)` también para `estaticasBaja`.
- `js/render/systems/runoff-diferencia.js` (nuevo): shader del mapa, textura R32F de dlog, traza.
- `js/render/systems/runoff.js`: malla `dmesh` (reusa `vgeom` y el índice con halo de Velocidad) y `tmesh` por escenario; `ensureDif/releaseDif`; stats.
- Sin tocar `config.js`, `js/hydro/**`, UI, host ni qa-api.

## Decisiones
- **Una sola capa, igual en inicial y multi** (compara los dos escenarios, así que no depende de cuál se mira; lo contrario confundiría al conmutador).
  El host oculta el grupo de un escenario con fade ≤ 0,02, así que hay una malla en cada grupo pero se dibuja solo una: la del grupo "inicial" mientras
  sea visible, y la del "multi" cuando ya no. Evita el doble alfa en el cruce (0,85 → 0,98, un pulso feo). `uFade` = `min(1, fadeInicial + fadeMulti)`
  (= opacidad del diseño; no baja a la mitad en la mitad del fundido).
- dlog: textura R32F de **referencia** al `Float32Array dlog` del resultado (sin copia, creada recién al mostrar Diferencia, liberada al salir). 0,54 MB.
  Bilineal manual (NEAREST), mezcla de colores en sRGB y misma salida que Velocidad (el color en pantalla = degradé de `colFrena/colAcelera`).
  Saturación simétrica en `|saturacion|`. Alfa: rampa de `umbral` a `umbral·1,7` (constante local `RAMP = 0,7`, ver Pedidos) para no tener borde duro.
- Halo de 300 m y borde de grilla: los mismos (`haloTex` + `bordeSuaveCeldas`) que Velocidad.
- **Traza**: cinta de 4 vértices por tramo expandida en el vertex shader (como las estelas), 1 draw call con una geometría compartida por los dos escenarios.
  Los tramos se subdividen cada 10 m para apoyarse en el relieve (colineal: la línea es la del GIS, no se simplifica nada). Altura = misma grilla que el mapa
  + `yExtraM`; bajada viva a6Low y subida por distancia en el shader; polygonOffset (−3, −6) sobre el mapa (−2, −4), renderOrder −9,4.
- **Raya en píxeles de pantalla real**: cuando cambia la cámara o el lienzo, la CPU proyecta los puntos (`viewProj`) y acumula el largo en píxeles por contorno en un
  `Float32Array` preasignado → atributo `aU`. Con la distancia en metros el punteado se apretaba con la perspectiva y se cortaba en cada tramo; así es
  parejo en cenital y rasante y continúa en las esquinas. Costo: O(puntos) solo en frames con cámara en movimiento, cero en reposo. Las puntas se alargan medio ancho (sin huecos en esquinas).
- Sin estelas en Diferencia (el modo no despierta el idleDriver).

## Diales
Todos de `HIDRO.vis.diferencia` (`umbral`, `saturacion`, `colFrena`, `colAcelera`, `opacidad`, `traza.{clases,color,alfa,rayaPx,huecoPx,anchoPx}`) y
`velocidad.haloM/bordeSuaveCeldas`, `particulas.yExtraM/factorMovil`. Locales (candidatos a HIDRO): `RAMP` 0,7 (rampa de alfa sobre el umbral), `MAX_SEG_M` 10 (subdivisión de la traza).

## Verificación (campo sintético, SwiftShader, puerto 8200; harness en scratch, nada en `dev/qa`)
- **Diff 0 %** antes/después del cambio a HIDRO: Agua natural Alta (home y conf-obl, inicial y multi) y Velocidad Baja (estelas estáticas, deterministas):
  4 + 4 pares, 0 px, `runoffTris/Particles/TexMB` idénticos (185574 / 2824 / 3,33 MB). Velocidad Alta no se compara píxel a píxel: las estelas animadas no son deterministas (ver F3).
- **Simulador apagado vs `dev/qa/baseline`**: peor 0,184 % (multi-rasante-medio, ruido conocido), resto ≤ 0,0004 %. `stats()` sin claves `runoff*` nuevas; las únicas diferencias son de generación de pasto
  asíncrona en cuatro vistas de multi (no runoff).
- **Diferencia, draw calls**: +2 en todas las vistas (home 7→9 inicial / 11→13 multi; de cerca 1→3). `runoffTexMB` 3,81 (inicial) + 2,06 (multi) ≈ 5,9 MB ≤ 16. Tris de la capa: 70 702.
- **Histograma de dlog dentro del campo** (21 494 celdas): **61 % exactamente 0**; frena |dlog| < 0,03: 19 %; 0,03–0,06: 3,8 %; 0,06–0,12: 2,6 %; 0,12–0,25: 2,1 %; 0,25–0,5: 2,8 %; 0,5–1,15: 7,2 %; ≥ 1,15: 1,7 %.
  Acelera: 0 celdas (mín −1,94; máx 0). No hay moteado por diferencias chicas: lo coloreado (16,5 % del campo) son los corredores y su entorno inmediato. El umbral 0,06 no hace falta tocarlo.
- Capturas (Baja y Alta, relieve prendido; relieve apagado en Baja; home, cenital, conf-cen, conf-ras, conf-alt, conf-obl; inicial y multi) en el scratch:
  `/tmp/claude-0/-home-user-ad-3d-nav/6bb04ed0-9a05-5107-be41-83527c75b459/scratchpad/o/{dif-baja,dif-alta,dif-sinrelieve,dif1}`. El azul queda sobre los corredores y se abre unos metros aguas abajo; sin z-fighting en rasante, cenital ni sin relieve.
- Consola: solo avisos de GPU stall de SwiftShader (ReadPixels), sin errores.

## Riesgos y deuda
- En el sintético el diseño solo frena (sin celdas aceleradas): el degradé naranja-rojo no está verificado visualmente con datos reales (el shader es simétrico).
- Los corredores del sintético cruzan pocas vaguadas, así que "azul aguas abajo" se lee sobre el propio corredor y un halo corto; la lectura de la demo real puede diferir.
- La proyección de la traza ignora a6Low y la subida por distancia (error de píxeles despreciable, solo afecta la fase de la raya).
- Segmentos que cruzan el plano cercano de la cámara se descartan (la cámara no entra en un campo a ras en el vuelo normal).
- Los contornos se arman al primer mostrar Diferencia y si cambia la grilla; no se re-arman si cambian los datos GIS en caliente (hoy no ocurre).
- La leyenda de Diferencia es de la UI: los colores deben leerse de `HIDRO.vis.diferencia` (mezcla en sRGB, no lineal).

## Pedidos a otros dueños
- Motor/config: agregar `vis.diferencia.rampa` (hoy local `0,7 × umbral`) y `vis.diferencia.trazaSegM` (hoy 10 m) si el dueño quiere tocarlos.
- UI: leer `HIDRO.vis.diferencia.umbral/saturacion` para la leyenda (mezcla en sRGB entre `colX[0]` y `colX[1]`).

## Preguntas
- ¿Se quiere que Diferencia muestre también la lámina o la velocidad por debajo (hoy es solo la diferencia sobre el satélite)? Recomendación: no.

## Opacidad propia del simulador (pedido del dueño)
- `js/render/systems/runoff-fade.js` (nuevo): `simFade[key]` = `min(1, scenarioFade[key] / designOpacity) · getState().opacity`. Lo escribe `runoff.update()` en cada
  cuadro (dos divisiones; `designOpacity` protegido con `max(0,05, …)`). Los shaders de Natural, Velocidad y estelas leen `simFade` como `uFade`; Diferencia
  usa `DIF_FADE = min(1, (fadeIni + fadeMulti) / designOpacity) · opacity` (sigue siendo una sola capa visible).
- El evento `"runoff"` con cambio `"opacity"` hace `map.triggerRepaint()` si el simulador se ve (sin rAF propio). Simulador apagado: `update` sale antes, cero costo.
- Verificación (home, `?fixture=demo_relieve&qa&terreno=1`): diseño 30 % + simulador 100 % → Natural y Diferencia idénticos a diseño 100 % (0,2 % de píxeles, ruido
  de animación); Velocidad igual salvo estelas en movimiento y los árboles del diseño (que sí se aclaran). Diseño 100 % + simulador 40 % → simulador más transparente.
  Fundido inicial↔multi con diseño 50 %: simFade pasa 1→0 / 0→1 sin dip. Apagado: diff 0 % contra `dev/qa/baseline`. Consola sin errores (solo avisos de driver GL).
