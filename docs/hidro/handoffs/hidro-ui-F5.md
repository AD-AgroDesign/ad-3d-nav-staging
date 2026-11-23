# Handoff hidro-ui F5 · paneles exclusivos (simulador y ajustes)

## Resumen
Pedido explícito del dueño. El simulador sale de la tabla y tiene su botón (gota con flecha) y su panel; Calidad, Hora del día y Relieve pasan a un panel "Ajustes" con su botón. Paneles de la izquierda: tabla, simulador y ajustes, uno a la vez, mismo lugar y estilo que `#panel`, cada uno con su ×.

## Qué cambió
- `index.html`: botones `#btn-runoff` y `#btn-ajustes` (entre pantalla completa y ☰); `<aside id="runoff-panel">` y `<aside id="ajustes-panel">` (clase `panel-extra`); `#quality-section` movida tal cual al panel de ajustes (mismos ids, clases y textos); `#btn-panel` con `aria-controls`/`aria-expanded` (lo mantiene paneles-ui.js).
- `js/ui/paneles-ui.js` (nuevo): mecanismo genérico. MutationObserver sobre la clase `collapsed` de cada panel: cuando uno se abre, colapsa a los otros; sincroniza `active` y `aria-expanded` del botón. Incluye la tabla sin tocar `controls.js`.
- `js/ui/runoff-ui.js`: el bloque se inserta en `#runoff-panel`; puntito dorado (`.runoff-prendido`) con simulador prendido y panel cerrado; con `?escorrentia` el panel abre en escritorio (> 760 px, igual que el criterio de la tabla).
- `js/ui/quality-dd.js` (1 línea, imprescindible): el límite para abrir hacia arriba usaba `#panel`; ahora usa el `aside` que contiene al desplegable. Los otros dos módulos (presets, relieve) no se tocaron: buscan `#quality-section` por id.
- `css/style.css` (sección HIDRO): `.panel-extra` replica `#panel` (incl. hoja inferior y × ≤ 830 px), sin tocar reglas ajenas. En Ajustes, el menú de calidad abre siempre hacia abajo y el panel suma 150 px de relleno mientras está abierto (el panel es corto y recorta).
- `README.md`: sección del simulador actualizada.

## Decisiones
- Exclusión por observador de clase en vez de editar `controls.js`: ☰ y × de la tabla siguen intactos.
- El título del bloque dentro del panel repite el del panel ("Simulador de escorrentía"): se conservó el texto del interruptor por pedido de no cambiar el bloque.
- En escritorio los paneles nuevos tienen × solo ≤ 830 px, como `#panel-close`; el botón de la barra los cierra.

## Verificación
Capturas en `/tmp/claude-0/-home-user-ad-3d-nav/6bb04ed0-9a05-5107-be41-83527c75b459/scratchpad/f5/` (`<ancho>-barra|tabla|sim-apagado|sim-natural|sim-velocidad|sim-diferencia|alterna-tabla|ajustes|ajustes-calidad|puntito|deshabilitado|url.png`, anchos 1440/830/500/375). DOM: sin solapamientos entre botones/selector/conmutador en la barra a ningún ancho (375 incluido: 6 botones en una fila, conmutador abajo), `scrollWidth == innerWidth`. Alternancia correcta (abrir simulador cierra tabla, ☰ cierra simulador, ajustes cierra ambos), tabla sin Calidad/Hora/Relieve. Desplegable de calidad dentro del panel en los cuatro anchos. Deshabilitado (`?terreno=0`): `aria-disabled` + "Sin modelo de terreno". `?escorrentia=velocidad`: panel abierto y tabla cerrada en 1440 y 830; cerrado a 500 y 375. Consola sin errores (solo el aviso de rendimiento ReadPixels de SwiftShader). Diff contra `dev/qa/baseline` con UI oculta: peor 0,0004 % (límite 0,013 %). `stamp_version --check` OK (217, 20261125).
Los avisos de desborde de `.runoff-marcas`/`.runoff-sr` en velocidad/diferencia ya existían (marcas centradas sobre la barra y texto solo para lector de pantalla).

## Riesgos
- Quien busque `#quality-section` dentro de `#panel` (CSS/JS externos) ya no lo encuentra ahí.
- `:has()` para el relleno del desplegable (navegadores recientes; sin él solo aparecería scroll en el panel).
- La atribución de MapLibre queda debajo del panel en la hoja inferior móvil, como con la tabla.

## Preguntas
- ¿Querés que el interruptor del bloque cambie de rótulo (p. ej. "Mostrar simulación") ahora que el panel ya se titula igual?
- ¿Cerrar con Escape los paneles? No se hizo (no era obligatorio).

## Ajuste posterior (pedido del dueño)
- Interruptor ahora dice "Mostrar simulación" (el `aria-labelledby` apunta al mismo rótulo). Mayúscula tras "·": subtítulo del panel, rótulo del bloque y marca del mapa (`HIDRO.vis.marca.texto`, string autorizado).
- Scrollbar en Ajustes: la causa era el menú de calidad oculto (absoluto) que agrandaba el área desplazable de un panel con `overflow-y: auto`. `#ajustes-panel` pasa a `overflow: visible` (sin relleno de 150 px) y el menú se dibuja por encima del borde; escritorio abre hacia abajo, hoja móvil hacia arriba. El panel del simulador conserva scroll solo si no entra (a 375 px con 800 px de alto, el tope del 45 % de la hoja).

## Opacidad del diseño en el panel del simulador
Sección "Opacidad del diseño" arriba del bloque (`#runoff-opacity-slider` / `#runoff-opacity-val`, mismo h3, `.opacity-row`, rango 20–100). Sincronía con `#opacity-slider` por eventos, sin tocar `controls.js`: al mover el nuevo se escribe el valor allá y se despacha `input` (bandera `propio` evita el bucle); al moverse el de la tabla se refleja acá. Siempre visible. Verificado a 1440 y 375 px: mover uno actualiza el otro y `#opacity-val`.

## Ajustes: tres secciones separadas
Calidad / Hora del día / Relieve con la misma línea fina (`rgba(255,255,255,.08)`, a todo el ancho) y el mismo espaciado (16 px) que `.panel-section`. Solo CSS en la sección HIDRO sobre `#ajustes-panel` (margen negativo, porque los módulos agregan sus filas a `#quality-section` en runtime y no conviene envolver nodos). Desplegable de calidad y sin scrollbar verificados a 1440 y 375 px.

## Opacidad de la simulación (pedido del dueño, reemplaza la sección "Opacidad del diseño" del panel)
`#runoff-opacity-slider` ya no se sincroniza con `#opacity-slider` (sin vínculo con la opacidad del diseño; la tabla no cambia). Título "Opacidad de la simulación"; rango 10–100 % paso 5 (de `HIDRO.vis.opacidad`); `input` llama `setOpacity(v/100)`; refleja cambios externos en el evento `"runoff"`. Arriba de todo y siempre visible; con el simulador apagado o no disponible queda atenuado con `aria-disabled` (y fuera del tab). Verificado con Playwright a 1440 y 375 px: mover el slider da `getState().opacity = 0.4`, `#opacity-slider` sigue en 100, consola limpia.
