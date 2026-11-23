# hidro-plataforma · F0

Rama: `hidro/f0-plataforma` (desde `main` con el commit del plan). Sin push.

## Resumen
Campo sintético `demo_relieve` (492 ha, relieve ondulado cultivable al norte de Tandil) con su generador reproducible, modo
`?fixture=<id>` en `js/auth.js` (solo HOST_DEV y staging) y el sellador de versión extendido a `new URL("./x.js", import.meta.url)`.
El workflow de staging ya publicaba `fixtures/` y ponía `noindex`: no hizo falta tocarlo.

## Qué cambió
- `dev/fixtures/gen_demo_relieve.mjs` (nuevo): genera `fixtures/demo_relieve/{inicial,multifuncional}.geojson`,
  `fixtures/demo_relieve/meta.json` (stats, candidatos, vaguadas, corredores, zonas, validación) y `fixtures/campos.fixture.json`.
  Importa `loadHeightfield` y `reliefStats` de `js/terrain/heightfield.js` directamente en Node (no depende del DOM:
  usa fetch y DecompressionStream, que Node 22 trae) y `mulberry32`/`pointInPolygon` de `js/core/geo.js`. Para `classify()`
  extrae el texto de la función de `js/map/data.js` (ese módulo importa MapLibre) y lo evalúa: se prueba la función real.
- `js/auth.js`: `HOST_FIXTURE`, `FIXTURE_ID`, `MODO_FIXTURE`, `arrancarFixture()`, rama en `signedUrlFor` y en `doLogout`.
  El modo local y el login no se tocaron (si vienen `?local` y `?fixture`, manda `?local`).
- `tools/stamp_version.mjs`: nuevo `RE_URL` para `new URL("./x.js", import.meta.url)`; `--check` lo verifica.
- `.github/workflows/staging.yml`: sin cambios (ver Verificación).

## Decisiones
- **Lugar**: candidato `tandil-N` (centro -37.410, -59.250). Se evaluaron 9 rectángulos de 2,5 × 2,2 km con `reliefStats()`;
  la tabla completa está en `meta.json` y en la salida del script. El elegido da relieve franco sin ser sierra (rango p2-p98
  ~25 m). Sobre el polígono real del campo (con máscara): `desvioResidual` 4,60 m, `pendienteP95` 3,84 %, rango p2-p98 26,4 m,
  inclinación regional 0,82 %; sobre el bbox del campo: 4,80 m y 3,87 %. Pasa con ambos criterios (> 2,7 m y > 2,5 %).
- **Geometría convexa con semiplanos**: el contorno es un polígono convexo de 9 vértices y todas las operaciones (lotes,
  camino, corredores) son recortes por semiplano, así que la partición es exacta sin necesitar una librería de booleanas.
  Montes, casco y parches son huecos (anillos interiores) de un lote. Consecuencia: los corredores y el camino son franjas
  rectas de borde a borde; un campo real tendría trazados más curvos.
- **Cobertura = partición del campo** en ambos escenarios; prioridad camino > corredores > lotes. En el inicial solo el camino
  corta los lotes. En el multi, los lotes son `ag-secano-z1|z2|z3` por terciles de pendiente media sobre el DEM (z1 = más llano).
  Montes (`parche-le` ×3), casco y camino son los mismos en los dos escenarios; el multi suma 2 `parche-herb` en zonas de
  mayor acumulación y 3 corredores.
- **Vaguadas**: DEM a 30 m, mediana 3x3, priority-flood con épsilon y D8. Cauce = acumulación >= 100 celdas (9 ha). Principales =
  cuenca >= 25 ha: V1..V6 (V1 559 ha incluyendo cuenca aguas arriba fuera del campo, 3,6 km dentro). Cada corredor se eligió
  por barrido de ángulo y posición maximizando vaguadas distintas cruzadas con ángulo >= 30°.
- **Corredores (cruces comprobados sobre la geometría final, no solo sobre el eje)**:
  - C1 `corr-herb` 44 m: V1, V3, V4, V5, V6.
  - C2 `corr-le` 36 m: V1, V2, V3, V5.
  - C3 `corr-herb` 56 m: V1, V2, V4, V6.
  Todas las vaguadas principales quedan cruzadas por al menos un corredor, y V1 por los tres. Detalle (ángulo y cuenca en el
  cruce) en `meta.json`.
- Salida: `MultiPolygon`, `UNIDAD`, `Sup` (ha, calculada con la misma escala de `ringAreaHa`), más `Lote`/`Corredor` como
  etiquetas informativas. Exterior antihorario, huecos horarios. Coordenadas a 7 decimales.
- Marca "campo sintético": idéntica a la de "modo local" (mismo estilo).

## Diales
En el generador: `SEMILLA`, `CANDIDATOS` (marcar otro `elegido`), `AX/AY` (tamaño del campo, 400-600 ha forzado),
`UMBRAL_VAGUADA`, `LARGO_MIN_VAGUADA`, `CORR_DEF` (tipo y ancho de cada corredor), radios de montes/parches en `colocar(...)`.
Tamaño y forma salen de un tirón: cambiar la semilla cambia todo el diseño; el DEM no cambia.

## Verificación
- `node dev/fixtures/gen_demo_relieve.mjs` corre en ~1 s con red; dos corridas seguidas dan los mismos bytes (md5 igual).
- Validaciones dentro del script (si fallan, aborta): anillos sin autointersección, huecos dentro del exterior, `Sup` = área
  de la geometría, Σ Sup = área del campo (491,87 ha en ambos escenarios), muestreo cada 9,3 m (56 867 puntos): 0 puntos con
  cero o dos unidades, `classify()` real devuelve agri / zona1-3 / corr-herb / corr-le / parche-herb / parche-le /
  instalaciones / camino para cada `UNIDAD`.
- Áreas (ha). Inicial: ag-secano 478,6, parche-le 8,0, instalaciones 2,7, camino 2,4. Multi: z1 117,5, z2 183,7, z3 140,3,
  parche-le 8,0, parche-herb 4,1, instalaciones 2,7, camino 2,4, corr-herb 25,2, corr-le 8,1.
- Navegador (Playwright + Chromium + SwiftShader, `python3 -m http.server 8080`):
  - `http://localhost:8080/?fixture=demo_relieve&qa&terreno=1`: el visor arranca, `__nav3d.ready` resuelve, campo
    "Campo sintético (relieve)", marca visible, pide `fixtures/campos.fixture.json` y los dos GeoJSON, relieve activo
    (`relief.active === true`, `available === true`). Consola: solo avisos de SwiftShader ("GPU stall due to ReadPixels"), ningún error.
  - Mismo test con el host simulado `3d-staging.agrodesign.site` (resolución de host del navegador hacia localhost): idéntico.
  - Negativo con host simulado `3d.agrodesign.site`: sin marca, el overlay de login queda visible y NO se pide ningún
    recurso de `fixtures/`. Negativo `?fixture=no_existe` en localhost: mensaje de error en consola y tarjeta de login.
- `node tools/stamp_version.mjs --check`: OK, 165 especificadores, versión única 20261120 (mismo número que antes del cambio:
  los imports existentes no cambian de comportamiento). Con un árbol temporal (fuera del repo) con
  `new URL("./hydro/worker.js", import.meta.url)`: `--check` lo marca, el sellado lo estampa (también con comillas simples y
  `../`) y deja intacto `new URL("./foo.png", import.meta.url)`.
- Workflow: YAML parsea sin errores. Revisión de lectura: el `rsync` excluye `dev`, `.git`, `.github`, `.claude`, `_site` pero NO
  `fixtures`, así que el campo sintético se publica; mete `noindex` en `index.html` y `robots.txt` con `Disallow: /`; dispara
  solo en ramas `**staging**` (no `main`). No pude correrlo (falta el secreto y rsync no está instalado acá).

## Riesgos y deuda
- El workflow no está probado de punta a punta: falta `STAGING_DEPLOY_KEY` (lo configura el dueño) y un push a `staging`.
- Corredores y camino rectos: legibles pero poco naturales. Si el dueño lo pide, se pasa a trazos con quiebres (requiere
  booleanas de polígonos no convexos).
- Los cruces con vaguadas se calculan sobre SRTM de 30 m; con el relieve vivo el visor muestra MapLibre-terrain con el mismo
  DEM, así que coinciden, pero en tramos muy llanos la vaguada del D8 puede desplazarse unas celdas.
- `meta.json` queda publicado en `fixtures/` (sintético, sin problema).
- El generador necesita red a `s3.amazonaws.com` (tiles terrarium).

## Pedidos a otros dueños
- Orquestador: estampar versión nueva al cerrar G0 (no estampé). Configurar `STAGING_DEPLOY_KEY`.
- hidro-qa: el harness `dev/qa` ya usa `fixture=demo_relieve` por defecto; `hideUI` oculta la marca por texto "campo sint".
- Para F1 (hidro-motor): los GeoJSON sirven directo para el test comparativo con `docs/hidro/referencia/velocidad.py --geojson-dir fixtures/demo_relieve`.

## Preguntas
- ¿Prefieren corredores con trazo curvo (más realista, más trabajo) antes de G0, o alcanza con rectos?
- ¿Se quiere que la marca "campo sintético" también aparezca en el staging cuando se entra con login (no aplica hoy: el modo fixture es solo con `?fixture`)?

## F2 · integración

- `js/render/host.js`: import y `host.register(runoff)` después de fauna. `js/app.js`: import de `ui/runoff-ui.js` junto a presets-ui.
- `js/debug/qa-api.js`: `__nav3d.runoff = { set(mode), rain(mmh), ready (getter → ensureComputed()), stats() }` (stats sin arrays: mode, rainMmH, available, reason, computing, error, result.stats).
- `stamp_version --check`: OK (200 especificadores, versión 20261121).
- Verificación (Chromium + SwiftShader, `?fixture=demo_relieve&qa&terreno=1&calidad=alta`):
  - Apagado: bloque "Simulador de escorrentía" presente, interruptor `aria-checked=false`, `available=true`. El único Worker es el blob de MapLibre (ninguno de `hydro/worker.js`). Pedidos a s3.amazonaws.com: 23, todos del visor (DEM).
  - `set("natural")` → true; `await ready` trae resultado; `result.stats`: campoHa 495,2, celda 15,18 m (379×357), reducción de velocidad media 5,77 %, frena 58,2 ha, total 203 ms. Interruptor pasa a `true`, se crea `hydro/worker.js` recién ahí y no hay pedidos nuevos a s3.
  - Consola: sin errores; solo avisos de rendimiento de SwiftShader ("GPU stall due to ReadPixels").
