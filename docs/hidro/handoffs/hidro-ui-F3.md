# Handoff · hidro-ui · F3 (Velocidad, lluvia y marca)

## Resumen
El bloque del simulador ahora tiene la vista **Velocidad** habilitada, leyenda por vista (turbo log para velocidad), deslizador de
lluvia (10–100 mm/h) y una marca "Ilustrativo · no es un estudio hidrológico" sobre el mapa mientras está prendido. "Diferencia" no aparece (F4).

## Qué cambió
- `js/ui/runoff-ui.js`: segmentado con Agua natural/Velocidad; leyenda armada según `mode` (natural = la de F2; velocidad = título "Velocidad del agua (m/s)",
  barra turbo, marcas de `HIDRO.vis.marcasMs` en escala log con coma decimal, línea "Estelas: más largas donde el agua va más rápido", texto solo-lector con el rango);
  deslizador `#runoff-lluvia-in` (`input` → `setRain(v,false)`, `change` → `setRain(v,true)`; `aria-valuetext` "N milímetros por hora"; el rótulo
  "pico de una lluvia de N mm/h" sigue al valor); "Calculando…" con 200 ms de demora (sin parpadeo); marca `#runoff-marca` creada/eliminada según prendido;
  `?escorrentia=velocidad` también se acepta al arrancar.
- `css/style.css` (sección HIDRO): estilos del slider, leyenda de velocidad y marca.
- `README.md`: sección del simulador actualizada.

## Decisiones
- **turboCss**: se importa de `js/render/systems/runoff-turbo.js` (ya aplica t' = 0,05 + 0,95·t adentro, igual que el shader); la copia local se eliminó. Barra y mapa comparados en `ui3/1440-velocidad.png`: mismos colores.
- **Marca sobre el mapa**: centrada abajo (`left:50%`, `bottom:36px`), no junto a "campo sintético": esa esquina queda debajo del panel en escritorio (la marca sintética ya lo pisa) y la nuestra pisaba el pie del panel.
  En ≤ 830 px sube a `bottom:78px` para quedar sobre la atribución desplegada (hasta 3 renglones). `z-index:20` (bajo el panel, 25): con el panel abierto en el celular la tapa la hoja. No toca la atribución ni "campo sintético" (medido con el DOM a 1440/830/500/375, con la atribución compacta y abierta).
- Apagado no existe en el DOM → línea base intacta.
- Persistencia: `?escorrentia=natural|velocidad` con `history.replaceState`, sin localStorage. La lluvia no se persiste.

## Diales
`HIDRO.rain` (min/max/step/default), `HIDRO.vis.vMinMs/vMaxMs/marcasMs`, `HIDRO.vis.marca.texto`. Nada nuevo en config.

## Verificación
- Capturas en `/tmp/claude-0/-home-user-ad-3d-nav/6bb04ed0-9a05-5107-be41-83527c75b459/scratchpad/ui3/` (`<ancho>-apagado|natural|velocidad|lluvia|mapa|cerrado-*.png`, anchos 1440/830/500/375).
- Spy de eventos: por cada paso del deslizador (teclado) `input` y `change` en ese orden; `setRain(v,false)` en input y `setRain(v,true)` en change; valor final del slider/rótulo = `getState().rainMmH` (60 tras dos pasos desde 50); `aria-valuetext` correcto.
- Sin desborde del panel (DOM) ni scroll horizontal a ningún ancho; marca sin superposición con atribución ni "campo sintético"; marca ausente tras apagar.
- Consola limpia (solo avisos de driver GL "GPU stall", preexistentes).
- Simulador apagado: `dev/qa/diff.mjs` contra `baseline`: 12 pares, peor 0,184 % (multi-rasante-medio, 1696 px; el resto ≤ 0,0004 %), bajo el límite 0,5 %. Re-corrido tras integrar con el render F3: peor 0,0128 % (118 px); dos corridas seguidas entre sí dan 0,0033 %. El 0,184 % anterior no vino del bloque (apagado no toca DOM ni CSS visibles): era ruido/estado previo a la integración.
- Nota: no capturé un estado "Calculando…" visible (el recálculo tarda ~50 ms y la demora de 200 ms lo oculta a propósito).

## Riesgos y deuda
- Rótulo del pie sigue siendo "Ilustrativo · pico de una lluvia de N mm/h · no es un estudio hidrológico" (más largo que lo pedido, conserva la frase obligatoria).
- Con la atribución desplegada en celular la marca queda ~14 px arriba de ella; si MapLibre le agrega renglones podría pisarse.
- `result.rainMmH` no lo leí desde la UI; se verificó solo `getState().rainMmH`.

## Pedidos a otros dueños
- Ninguno.

## Preguntas
- ¿Querés que la marca vaya pegada a "campo sintético" aun pisando el panel en escritorio? Hoy está centrada abajo.

- Marca sobre el mapa: más contraste (11,5 px, semibold, fondo rgba(10,18,12,.72), texto .95, sombra). Con el panel abierto en ≤ 830 px sigue debajo de la hoja (evitarlo implicaría pisar su texto); el panel ya trae el rótulo. Capturas: ui3/<ancho>-cerrado-compacto.png.
