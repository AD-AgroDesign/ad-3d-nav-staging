# AgroDesign · Navegador 3D

Escenario 3D georreferenciado y navegable estilo vuelo de dron sobre imagen satelital real,
que permite conmutar entre el **paisaje actual** del establecimiento y el **diseño de paisaje
multifuncional** propuesto por AgroDesign (corredores biológicos y parches de naturaleza).

El acceso es privado: cada cliente ve únicamente sus campos, con las mismas credenciales que
usa en el dashboard (`dashboard.agrodesign.site`).

## Uso

Sitio estático puro: no requiere build. Servir la carpeta con cualquier servidor HTTP
(p. ej. `python -m http.server`) o publicarla en GitHub Pages.

Los datos GIS **no** se sirven con el sitio: viven en el bucket privado `gis3d` de Supabase y
se descargan con URL firmada después del login. Por eso `data/` está en `.gitignore` — la
copia local es sólo la fuente para `tools/upload_gis.py`.

## Control de acceso

```
Supabase Auth  →  profiles (rol, cliente_id)  →  campos [RLS]  →  bucket gis3d [RLS]
```

- Las cuentas son las mismas del dashboard; no hay alta de usuarios acá.
- Quién ve qué lo decide Postgres, no el JavaScript: la policy `campos_select` filtra la lista
  de campos y `gis3d_read_by_role` filtra los archivos. Manipular el front no da acceso a nada.
- Un campo aparece en el visor sólo si tiene `campos.nav3d_slug` cargado.
- Los admin ven todos los campos publicados; un cliente, sólo los suyos.

## Estructura

- `index.html` — UI (acceso, splash, header, panel, controles de vuelo); carga MapLibre, supabase-js y, por importmap, Three.js r170
- `css/style.css` — tema AgroDesign, responsive
- `js/auth.js` — login, permisos, selector de campos, URLs firmadas (script clásico)
- `js/app.js` — punto de entrada ES (módulo diferido): arma mapa, capas, host de render, tour y UI
- `js/core/` — `config.js` (todos los diales), `quality.js` (niveles de calidad), `state.js`, `events.js`, `camera.js`, `geo.js`
- `js/map/` — estilo MapLibre y datos (`style.js`, `data.js`, `layers.js`, `scenario.js`, `interact.js`)
- `js/render/` — host de render y sistemas (ver abajo); `lighting.js` (luz, niebla, modos de hora), `atmo.js` (cielo y color), `shaderlib.js`
- `js/terrain/` — relieve (`terrain.js`, `heightfield.js`)
- `js/tour/`, `js/ui/`, `js/debug/` — vuelo de dron, panel y controles, API de QA (`__nav3d`, solo con `?qa`/`?debug`)
- `vendor/` — MapLibre GL 4.7.1, Three.js r170 (`three.module.js`, ES module), supabase-js 2.112.2 (sin CDN externos)
- `data/<campo>/*.geojson` — copia local de los datos, fuera de git

## Arquitectura del render (programa "Salto de realismo")

Three.js dibuja dentro de MapLibre como una capa custom (`js/render/host.js`, id `veg-3d`). El host no tiene lógica de
paisaje: contiene **sistemas** independientes registrados en `js/render/systems/`, cada uno con el mismo contrato
(`build`, `setOpacity`, `setGrowth`, `update(frame)`, `onQuality`, `dispose`; ver el comentario de cabecera de `host.js`):

| Sistema | Qué hace |
|---|---|
| `trees.js` + `treegen.js` | árboles procedurales por especie; follaje en tarjetas cerca e impostores lejos, instanciados por celda |
| `grass.js` | matas de pasto instanciadas por celda con LOD por distancia |
| `ground.js` | suelo por shader (con surcos en los lotes agrícolas) |
| `water.js` | agua por shader (orillas, brillo, animación) |
| `shadows.js` | sombras reales de los árboles (pase propio, receptor sobre el suelo, blobs para lo lejano) |
| `fauna.js` | aves y polinizadores, animados en el vertex shader |
| `chunks.js` | utilidades comunes de celdas, LOD y cadena de shaders |

Soporte compartido: `shaderlib.js` (fade dither entre escenarios, niebla, follaje), `lighting.js` (luz del campo, niebla,
modos de hora), `atmo.js` (cielo y corrección de color), `idle.js` (ver "Reposo").

**Calidad** (`js/core/quality.js`). Cuatro niveles: Ultra, Alta, Media, Baja. Se elige con `?calidad=`, luego el valor
guardado en el navegador (`ad_calidad`), luego una detección por GPU/memoria/móvil. Cada nivel fija MSAA y `pixelRatio`
(cambiarlos recarga la página), distancia de LOD del pasto, distancias de tarjetas/impostores, tamaño del mapa de sombras,
suelo, fauna, agua, terreno y tope de fps en reposo. En GPU integrada de notebook (p. ej. Intel HD/UHD) o de gama baja,
"Alta" y "Media" apagan el MSAA. El selector está en el panel.

**Terreno según calidad.** El relieve 3D (más el sombreado de relieve) se descarga y se activa solo en Ultra y en Alta con GPU
dedicada. En GPU integrada, Media y Baja el visor queda sin relieve (altura 0), idéntico al de antes del terreno. `?terreno=1|0`
lo fuerza o lo apaga.

**Modos de hora.** Mediodía (por defecto), hora dorada y atardecer: conjuntos de parámetros (`A1_HORAS` en `config.js`) que
cambian luz, cielo, niebla, color y sombras con transición. Se eligen en el panel o con `?hora=dorada|atardecer|mediodia`.

**Fauna, agua y viento.** Aves y polinizadores (fauna), agua y el viento de árboles y pasto se animan por shader con el reloj
`uTime`; no hay lógica por frame en JavaScript. Fauna: en Media la mitad, en Baja ninguna. Agua: shader en Ultra/Alta/Media;
en Baja queda el plano de MapLibre. Viento: lo aplican los materiales de árboles y pasto.

**Reposo.** Con la cámara quieta MapLibre no repinta solo. `js/render/idle.js` (`host.idleDriver`) es el lazo único que
repinta a `quality.idleFps` (30 Ultra/Alta, 20 Media, 0 Baja) y solo si algún sistema lo pide con
`idleDriver.request(owner, active)`: fauna o agua en cuadro y cerca, o vegetación en cuadro a menos de `WIND_IDLE_DIST` (250 m).
Vistas altas (home, cenital) no gastan nada; en movimiento no suma repintados; se pausa con la pestaña oculta o con el
tiempo congelado (QA).

## Parámetros de URL

Públicos:

| Parámetro | Efecto |
|---|---|
| `?campo=<slug>` | abre ese campo (si el usuario tiene permiso) |
| `?calidad=ultra\|alta\|media\|baja` | fuerza el nivel de calidad (no se guarda) |
| `?hora=dorada\|atardecer\|mediodia` | modo de hora inicial |
| `?terreno=1\|0` | fuerza o apaga el relieve 3D, sin importar la calidad |

Solo con `?qa` o `?debug`: `?qa` expone `window.__nav3d` y deja el visor determinista (sin
tour ni cámara automáticos); `?debug` expone `__nav3d`, `__map` y `__state` sin cambiar lo visible. Con alguno de los dos:
`?gpu=integrada|dedicada` (simula el tipo de GPU para el terreno según calidad), `?sombras=0|blobs`, `?surcos=0|1`,
`?agua=off`, `?a4=off`, `?fauna=0`, `?hillshade=0|1`, `?aa=0`, `?tm=` y `?exp=` (tone mapping), y los diales `?a1=`, `?a2=`, `?a3=`, `?a5=` (JSON). `?rasante=v1|v2|v3` (altura de la cámara del rasante) vale con `?qa`/`?debug` o con `?local` en un host de desarrollo.
`?local` carga los datos de `data/` en vez de Supabase y solo funciona en `localhost`, `127.0.0.1`, `[::1]` y `*.localhost`.

## Simulador de escorrentía

Bloque "Simulador de escorrentía" en su propio panel, que se abre con el botón de la gota con flecha de la barra superior (un panel a la vez: tabla ☰, simulador y ajustes se excluyen; con el simulador prendido y el panel cerrado, el botón lleva un puntito dorado). Calidad, hora del día y relieve viven ahora en el panel "Ajustes" (botón de controles deslizantes). El interruptor prende la vista **Agua natural**:
dónde se junta el agua en el pico de una lluvia (por defecto 50 mm/h), calculada en el navegador sobre el modelo de terreno
(DEM) del campo. Es **ilustrativo: no es un estudio hidrológico**, y la lámina de agua está exagerada a propósito para que se vea.
Al prenderlo se prende también el relieve del terreno (lo necesita). Si el campo es llano o no hay modelo de terreno, el
interruptor queda deshabilitado y el panel dice por qué. La vista **Velocidad** pinta la rapidez del agua con una paleta turbo en escala logarítmica (leyenda en m/s) y estelas más largas donde el agua va más rápido. El deslizador **Lluvia (mm/h)** (10–100, de a 5) recalcula al soltarlo. Mientras el simulador está prendido, una marca sobre el mapa recuerda que es ilustrativo.

| Parámetro | Efecto |
|---|---|
| `?escorrentia=natural` o `?escorrentia=velocidad` | abre con el simulador prendido en esa vista y su panel abierto en escritorio (se aplica en cuanto el campo admite el simulador); el visor lo mantiene en la URL al prender o apagar |

## Publicación (caché)

GitHub Pages sirve con `Cache-Control: max-age=600`: sin versionar, un navegador puede mezclar módulos viejos y nuevos hasta 10 min.
Antes de publicar:

1. `node tools/stamp_version.mjs <VERSION>` (p. ej. la fecha, `20261113`). Pone `?v=<VERSION>` en todos los imports/exports/`import()`
   relativos de `js/**/*.js` y en las referencias locales de `index.html` (`auth.js`, `app.js`, `style.css`, `maplibre-gl.css`).
   Es idempotente (reemplaza la versión anterior) y no toca `vendor/` ni el importmap.
2. `node tools/stamp_version.mjs --check` verifica que no haya mezcla (todos sellados, una sola versión). Un módulo importado con y sin
   query serían dos instancias con estado duplicado, por eso es todo o nada.
3. Commit y push. Si se agrega un `import` nuevo sin `?v=`, el `--check` lo marca.

Los scripts de `tools/qa` que usan `import('/js/...')` desde la página agregan la versión de `app.js` solos.

## Fuentes de datos

- Imagen satelital: Esri World Imagery (© Esri, Maxar, Earthstar Geographics)
- Relieve (solo con terreno activo): Terrain Tiles en AWS; SRTM y GMTED2010 cortesía del USGS; ETOPO1 NOAA/NCEI
- Capas de paisaje: equipo GIS de AgroDesign (WGS84 / EPSG:4326)

## Agregar otro campo

**Desde el 2026-08-11 esto es automático**: `python upload_cliente.py <carpeta> --apply` en
`D:\Claude\PBI_dashboards` publica el campo acá como último paso (`publish_nav3d.py`). Sube
los mismos dos GeoJSON al bucket, arma las rutas y escribe las columnas `nav3d_*`; respeta el
`nav3d_slug` que ya tenga el campo y no toca `nav3d_maxzoom` si ya está determinado. Para
publicar sin repetir toda la carga: `python publish_nav3d.py <carpeta> --apply`.

Ese camino **no usa `data/`**: sube directo desde `mapas/<carpeta>/` del dashboard. Las copias
locales sólo hacen falta para el procedimiento manual de abajo.

### A mano (si hace falta)

1. Que el campo exista en la tabla `campos` del dashboard, con su `cliente_id`.
2. Copiar los dos GeoJSON a `data/<slug>/inicial.geojson` y `data/<slug>/multifuncional.geojson`.
3. Marcarlo como publicado en el visor (ver el bloque 4 de `tools/supabase_setup.sql` como
   modelo):

   ```sql
   UPDATE campos
   SET nav3d_slug    = '<slug>',
       nav3d_maxzoom = 17,
       nav3d_inicial = cliente_id::text || '/<slug>/inicial.geojson',
       nav3d_multi   = cliente_id::text || '/<slug>/multifuncional.geojson'
   WHERE id = '<uuid del campo>';
   ```

4. `python tools/upload_gis.py --campo <slug>`

No hay que tocar el código (`js/map/data.js` y `js/map/scenario.js`): el encuadre inicial y los límites de navegación se calculan
de la geometría, y `classify()` tolera los distintos esquemas de atributos (`UNIDAD`/`Unidad`
con nombres largos, o sólo códigos `RASTER`). Las geometrías `Polygon` y los registros sin
geometría se normalizan al cargar. Si el campo trae una clase nueva, sumarla a `CLASS_META`,
`CLASS_ORDER` y `classify()`.

El `maxzoom` de cada campo es hasta dónde Esri tiene imagen nativa en esa zona (más allá
devuelve "Map data not yet available"): se verifica pidiendo el tile del centro por nivel y
comparando el tamaño (el placeholder pesa siempre 2521 bytes).

Un campo se abre con `?campo=<slug>`, siempre que el usuario tenga permiso sobre él; si no,
se ignora el parámetro. Sin parámetro, el visor pide elegir campo después del login.

## Herramientas (`../tools/`)

| Script | Para qué |
|---|---|
| `inspect_db.sql` | Lectura del estado de la base antes de tocar nada |
| `supabase_setup.sql` | Columnas `nav3d_*`, bucket privado, policy de Storage, publicación de campos |
| `upload_gis.py` | Sube los GeoJSON al bucket (`SUPABASE_SERVICE_KEY`, `--dry-run` disponible) |
| `verify_access.py` | Prueba que un cliente no puede firmar los archivos de otro |
