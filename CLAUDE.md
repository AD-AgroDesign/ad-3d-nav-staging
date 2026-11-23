# Navegador 3D de AgroDesign — reglas para Claude

Visor 3D "vuelo de dron" de campos agrícolas de AgroDesign: MapLibre GL 4.7.1 + Three.js r170, ES modules **sin build**,
todo vendorizado en `vendor/`. Se publica en **https://3d.agrodesign.site** con GitHub Pages directamente desde la rama `main`.
El dueño del producto (Mike, AgroDesign) decide por rondas cortas mirando capturas y probando en el navegador.

Programa en curso: **Simulador de escorrentía**. Leé `docs/hidro/PLAN.md` antes de hacer cualquier cosa.

## Reglas que no se negocian
1. **`main` es producción.** Pushear a `main` publica al instante. No se pushea a `main` jamás: los cambios llegan por un
   Pull Request que mergea el dueño. Las demos van a la rama de preview (`staging`), que publica en el sitio de staging.
2. **El repo es PÚBLICO.** Nunca commitear GeoJSON, capturas, coordenadas ni nombres de campos de clientes. Los datos reales
   viven en un bucket privado (Supabase `gis3d`) y se bajan con URL firmada tras el login. Para probar se usa SOLO el campo
   sintético de `fixtures/`.
3. **Fidelidad al dato GIS:** no modificar, simplificar ni "arreglar" geometrías de los campos.
4. **Sin dependencias nuevas en tiempo de ejecución.** Nada de CDN: lo que haga falta se vendoriza en `vendor/` con versión
   fija y con aprobación del dueño. Ya están aprobados el DEM terrarium de AWS (`s3.amazonaws.com/elevation-tiles-prod`) y el
   satélite de Esri (`server.arcgisonline.com`). Las herramientas de desarrollo (`dev/`) pueden usar npm.
5. **Versión de caché:** cada import relativo lleva `?v=AAAAMMDD` (si un módulo se importa con y sin query se duplica su
   estado). Al cerrar una compuerta: `node tools/stamp_version.mjs <AAAAMMDD>` y después `node tools/stamp_version.mjs --check`.
6. **Un archivo, un dueño** por fase (ver la tabla de dueños en `docs/hidro/PLAN.md`). Lo ajeno se pide, no se edita.
7. **Medir antes y después:** toda entrega visual trae capturas antes/después (harness `dev/qa`), `stats()` y consola.

## Cosas que NO se tocan (salvo pedido explícito del dueño)
Diseño y densidad del pasto, árboles, tour y vuelo rasante, colores de `CLASS_META`, textos y breakpoints de la UI
(830 px y 500 px), el modelo de acceso (login Supabase, RLS, URLs firmadas).

## Trampas conocidas del código
- La cámara de Three es "falsa" (la matriz viene de MapLibre): para la posición real usar el uniform `uCamPos`.
- Animaciones: `dt = Math.max(0, now - t0)` (el primer timestamp de rAF puede ser anterior).
- Repintado en reposo: solo vía `idleDriver.request(owner, activo)` (`js/render/idle.js`), nunca un rAF propio.
- Las capas de MapLibre que quedan debajo de un sistema Three se dejan con opacidad 0,001 (no 0): así siguen los popups.
- Un evento nuevo se agrega al array `EVENTS` de `js/core/events.js`, si no `on()` avisa por consola.
- `?local` solo funciona en localhost y necesita `data/` (que no está en el repo). En la nube usá `?fixture=demo_relieve`.
- Todo lo que cuelga del relieve debe seguir el factor vivo `k` (`a6Low` en GLSL, `lowAt` en CPU): el usuario prende y apaga
  el relieve sin recargar.

## Idioma y estilo
Español rioplatense en la UI, los comentarios, los docs y los mensajes de commit. Comentarios que explican el porqué.
Commits chicos y descriptivos. La UI dice siempre que el simulador es ilustrativo ("no es un estudio hidrológico").
