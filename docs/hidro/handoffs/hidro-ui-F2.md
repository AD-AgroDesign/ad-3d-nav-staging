# hidro-ui · F2

Rama: `worktree-agent-ae709b66ba7d31b11` (desde `hidro/f2-natural` @ 6556a39; se hizo fast-forward porque el worktree nació en una base anterior sin `js/hydro/`). Sin push. Versión de caché: 20261121.

## Resumen
Bloque "Simulador de escorrentía" en el panel: interruptor, segmentado "Agua natural | Velocidad" (Velocidad deshabilitado, "próximamente"), leyenda
somero → profundo con la aclaración de la lámina exagerada, rótulo "Ilustrativo · pico de una lluvia de N mm/h · no es un estudio hidrológico",
estados Calculando… / no disponible con motivo / error. Persistencia opcional en `?escorrentia=natural`. La UI solo lee `getState()` / evento `"runoff"`
y llama `setMode`; el relieve se prende con `setReliefSession(true)` (solo esta visita) de `core/relief.js`.

## Qué cambió
- `js/ui/runoff-ui.js` (nuevo). Se arma solo al importarse y exporta `armarEscorrentia()` (idempotente).
- `css/style.css`: sección `/* === HIDRO: inicio === */ … fin` al final (ids `#runoff-*`, copiando el lenguaje de `#hora-btns` y `#relieve-sw`).
- `README.md`: sección "Simulador de escorrentía" y el parámetro `?escorrentia=`.

## Enganche (lo hace hidro-plataforma)
En `js/app.js`, junto a `presets-ui.js` (línea ~18):
`import "./ui/runoff-ui.js?v=20261121";`
No hay que llamar nada: al importarse crea un `<div class="panel-section" id="runoff-section">` dentro de `#panel`, justo antes de `.panel-footer`
(el `#panel` ya está en el HTML estático). Para probarlo localmente se agregó ese import SIN commitear.

## Decisiones
- **Bloque propio** (`panel-section` con borde, como "Calidad") y no dentro de `#quality-section`: no se toca el layout de lo existente.
- **Interruptor con `aria-disabled`** (no `disabled`) cuando no hay simulador: sigue en el orden de tab y el lector lee el motivo (`aria-describedby` → `#runoff-estado`). El click se ignora.
- **Estado = `getState()`** re-evaluado al armar y en `"runoff"`, `"scenario"` y en cada cambio de `relief` (por `onRelief`), por la asincronía de `terrain.stats`.
- **Al prender**: si `relief.active` es falso llama `setReliefSession(true)` (decisión del dueño: el relieve se prende solo para esa visita, no se guarda `ad_relieve`) y muestra "Prendimos el relieve del terreno para esta visita: el agua lo necesita para verse." Si después apaga el relieve con el simulador prendido, la nota avisa que el agua se ve mejor con relieve.
- **Error** (`getState().error`): "No se pudo calcular el escurrimiento. Probá de nuevo más tarde." en tono salmón sobrio; no se muestra el mensaje técnico (queda en consola por `state.js`).
- **Motivos**: `llano` → "Campo llano: el modelo de terreno no alcanza para simular el escurrimiento"; `sin-dem` (y cualquier otro) → "Sin modelo de terreno".
- **Velocidad** es un botón con `aria-disabled` y subtítulo "próximamente"; no llama a `setMode`.
- **`?escorrentia=`** se escribe con `history.replaceState` editando el texto de la query (como `?hora=`); si llega `?escorrentia=natural` se aplica apenas `available` pasa a true. Nada en localStorage salvo la preferencia de relieve ya existente.
- El rótulo lee `rainMmH` del estado (hoy 50); cuando F3 agregue el deslizador no hace falta tocarlo.

## Diales
Ninguno nuevo en `config.js`. Textos y el degradé de la leyenda (`#60a0c4 → #1e5280`) están como constantes arriba de `runoff-ui.js`.

## Verificación
Servidor `python3 -m http.server 8080` en la raíz del worktree, Playwright + Chromium (SwiftShader), `?fixture=demo_relieve&terreno=1&calidad=alta&qa`; no disponible con `terreno=0`.
Script: `/tmp/claude-0/-home-user-ad-3d-nav/6bb04ed0-9a05-5107-be41-83527c75b459/scratchpad/qa-ui.mjs` (fuera del repo).
- Capturas (panel completo) en `/tmp/claude-0/-home-user-ad-3d-nav/6bb04ed0-9a05-5107-be41-83527c75b459/scratchpad/caps/`: `<ancho>-1-apagado`, `-2-calculando`, `-3-prendido`, `-5-nodisponible` para 1440, 830, 500 y 375; `1440-4-foco`; `1440-6-…` y `375-6-…` (panel desplazado al fondo, prendido por URL).
- Medición con el DOM (en todos los estados y anchos): ningún elemento del bloque excede el panel ni tiene `scrollWidth > clientWidth`; el panel no tiene scroll horizontal.
- Estado: apagado `mode:"off"`, `available:true`; tras el click `mode:"natural"`, `computing:true`, texto "Calculando…"; luego `result` presente, `computing:false`, rótulo con "50 mm/h". Relieve ya prendido con `terreno=1`, así que la nota del relieve no apareció (el camino `setReliefSession` no se ejercitó en el navegador).
- No disponible (`terreno=0`): texto "Sin modelo de terreno", `aria-disabled="true"`, click no cambia `mode`, segmentado y leyenda ocultos. El caso `llano` no se probó con un campo real (solo comparte el camino con `MOTIVOS.llano`).
- Teclado: Space apaga, Enter prende, Tab llega a "Agua natural" y luego a "Velocidad" (aria-disabled, enfocable).
- Consola: limpia en 830, 500, 375 y en no disponible. En 1440 (primera carga con render) solo aparecen cuatro avisos de driver de SwiftShader "GPU stall due to ReadPixels", que no vienen de este módulo.

## Riesgos y deuda
- El camino "prender con relieve apagado" (`setReliefSession`) no se probó en navegador.
- En móvil el panel tiene `max-height: 45%` y el bloque queda al fondo del scroll del panel: hay que desplazar para verlo (no se tocaron los breakpoints).
- "Calculando…" se ve ~200 ms en el fixture (en la captura sale porque se sacó a los 40 ms del click).
- La leyenda dice "Agua natural: dónde se junta el agua en el pico de la lluvia"; revisar el texto con el dueño.
- Falta el deslizador de lluvia (F3) y la vista Diferencia/Velocidad.

## Pedidos a otros dueños
- hidro-plataforma: agregar el import de `runoff-ui.js` en `js/app.js` (ver "Enganche").
- hidro-render: nada por ahora; la UI no depende del render.

## Preguntas
- Resuelta por el dueño: al prender el simulador con el relieve apagado, el relieve se prende solo para esa visita (`setReliefSession`, commit 63f451d); no se guarda `ad_relieve`.
