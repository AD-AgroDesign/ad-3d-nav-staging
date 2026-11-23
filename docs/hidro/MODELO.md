# Modelo hidrológico del simulador (Motor 1: estático, en el pico de la lluvia)

Implementación de referencia: `docs/hidro/referencia/velocidad.py` (script único, sin dependencias del resto del repo).
Es la que generó las demos aprobadas (verificado: corrida sobre el campo de la demo reproduce sus números). El port a JS (F1) tiene que reproducirla dentro de las tolerancias de §5.

> Es un modelo **ilustrativo**: estado estacionario en el pico de una tormenta, sobre un modelo de terreno de ~30 m.
> No resuelve la evolución en el tiempo (eso sería un "Motor 2" con ecuaciones de agua somera en GPU, fuera de este programa).

## 1. Grilla
- DEM terrarium de AWS a **z13** (el mismo del visor: `A6_TERRAIN.demUrl`, decodificación `h = R·256 + G + B/256 − 32768`),
  en la grilla de píxeles Web Mercator (celda ≈ 19,1 m · cos(lat); ~15–16 m en la provincia de Buenos Aires).
- Recorte: bbox del campo **+ 1,5 km de margen** (cuenca de aporte: el agua viene de afuera del lote).
- **Mediana 3×3** sobre la grilla (mata picos aislados de ±10–15 m del SRTM: copas, galpones), igual que `reliefStats`.
- Área de celda `A = cell²` (m²).

## 2. Pasos
1. **Relleno de depresiones** — Priority-Flood con épsilon (Barnes 2014): se siembran los bordes en una cola de prioridad;
   cada vecino sin visitar toma `max(H_vecino, h_actual + ε)` con ε ≈ 1e-4 m. Resultado `F` (DEM drenable).
2. **Flujo múltiple (MFD, Holmgren p = 3)** sobre `F`: para cada una de las 8 vecinas más bajas,
   `w_k = (caída_k / (dist_k · cell))^p · L_k`, con `L_k = 0,5` (cardinal) o `0,354` (diagonal) (largos de contorno de Quinn);
   normalizar para que sumen 1. Celdas sin vecina más baja: sin salida (solo bordes, gracias al relleno).
3. **Dirección media** (para el flowmap y las partículas): `dir = Σ w_k · (dx_k, dy_k) / dist_k`, suavizada con dos pasadas
   de caja 3×3 y normalizada.
4. **Pendiente local**: gradiente por diferencias centrales del DEM **suavizado** (dos pasadas de caja 3×3 sobre la mediana,
   NO sobre `F`), con piso `S_min = 0,004`.
5. **Clase por celda y escenario** (`_cls` del polígono que contiene el centro de la celda; afuera del campo = agrícola) →
   CN y n (tabla §3).
6. **Coeficiente de escurrimiento** `C = Q_cn(P = 80 mm) / 80`, con SCS-CN: `S = 25400/CN − 254`, `Ia = 0,2·S`,
   `Q = (P − Ia)² / (P + 0,8·S)` si `P > Ia`, si no 0.
7. **Área efectiva de aporte**: acumulación MFD de `C·A` recorriendo las celdas de mayor a menor `F` → `Ae` (m²).
8. **Caudal pico (método racional)**: `Q = i · Ae`, con `i` = intensidad de lluvia en m/s (`mm/h / 1000 / 3600`).
9. **Manning** con ancho de flujo = lado de celda: `q = Q / cell` (m²/s); `h = (q·n/√S)^(3/5)`; `v = q / h`.
10. **Suavizado** de `v` en escala log: `v = 10^(caja3×3(log10(max(v, 1e-4))))`.
11. **Diferencia** (F4): `dlog = log2(v_multi / v_inicial)`.

## 3. Parámetros por clase (diales en `HIDRO`)
| `_cls` | clase hidrológica | CN (grupo B) | n de Manning | origen |
|---|---|---|---|---|
| `agri`, `zona1`, `zona2`, `zona3`, `otros` | cultivo | 78 | 0,10 | TR-55 (cultivo en hileras; n laminar con rastrojo moderado) |
| `corr-herb`, `parche-herb` | pasto denso | 61 | 0,24 | TR-55 (pastura buena; "dense grasses") |
| `corr-le`, `parche-le` | monte | 55 | 0,40 | TR-55 (bosque bueno; "woods, light underbrush") |
| `instalaciones` | casco | 86 | 0,05 | supuesto |
| `camino` | camino de tierra | 82 | 0,03 | TR-55 (caminos de tierra) |
| `ganaderia` | pastura pastoreada | 69 | 0,15 | **supuesto, a validar** |
| `suelo-desnudo` | barbecho | 86 | 0,05 | **supuesto, a validar** |
| `bajo` | bajo / humedal | 70 | 0,24 | **supuesto, a validar** |
| `agua` | cuerpo de agua | 98 | 0,03 | supuesto |

Otros diales: `rainMmH` 50 (deslizador 10–100), `P_cn` 80 mm, `mfdP` 3, `sMin` 0,004, `margenCuencaM` 1500.
La referencia Python porta `classify()` y usa esta misma tabla. (Las demos originales usaban un mapeo más corto de las
clases; para el campo de la demo el resultado es el mismo.)

## 4. Disponibilidad
El simulador se ofrece solo si el campo tiene relieve que el DEM pueda resolver: `terrain.stats.desvioResidual > 2,7 m` o
`terrain.stats.pendienteP95 > 2,5 %` (mismos umbrales que `A6_TERRAIN.auto`). En los campos llanos el resultado es ruido
del DEM (verificado con las demos): el bloque aparece deshabilitado con el motivo.

## 5. Tolerancias del port (tests de F1)
Sobre el campo sintético, JS vs Python, misma grilla:
- `F` (relleno): |Δ| ≤ 1e-3 m en el 99,9 % de las celdas.
- Acumulación `Ae`: error relativo ≤ 1 % en celdas con `Ae > 10·A` (diferencias de orden de recorrido en empates).
- `v`: mediana del error relativo ≤ 2 %, p95 ≤ 5 %.
- Estadísticos del campo (velocidad media, ha con v > 0,3 m/s): ≤ 2 %.
- Conservación: `Σ C·A` de todas las celdas = suma de lo que sale por los bordes, error relativo ≤ 1e-6.
Para generar la referencia: `python3 docs/hidro/referencia/velocidad.py --geojson-dir fixtures/demo_relieve --out /tmp/ref`
(requiere `numpy`, `pillow`, `shapely`; escribe `meta_vel.json` y, con `--dump`, `grid.npz` con las grillas H, F, S,
dirX, dirY, inside y, por escenario, Ae, h, v, cn, n, más dlog). El script clasifica con el mismo criterio que `classify()`
y usa la tabla de §3, así que la comparación vale para todas las clases.

## 6. Cómo se tiene que ver (objetivo visual de las demos aprobadas)
- **Agua natural**: agua visible solo donde la lámina supera ~2 cm (vaguadas y líneas de escurrimiento), opacidad que crece
  hasta ~15–25 cm; color de somero `#60a0c4` a profundo `#1e5280` (o el shader de agua del visor con esos tonos);
  la red se ve como **cintas de agua que confluyen** hacia los cauces. Con el flowmap, la superficie se mueve aguas abajo.
  El escurrimiento laminar real es de milímetros: la lámina visible está exagerada a propósito y la leyenda lo dice.
- **Velocidad**: campo continuo con paleta *turbo* sobre `log10(v)`, de 0,02 m/s (azul oscuro) a 1,5 m/s (rojo), opacidad
  ~0,85 dentro del área de cálculo con borde suave; los cauces quedan en naranja-rojo, las laderas en verde-azul, los
  corredores de pasto y monte en azul. Encima, **estelas blancas** finas (1,5–2 px) con cola transparente, más largas donde
  el agua va más rápido (en las demos: largo ≈ v·320 s, entre 45 y 420 m). Leyenda con marcas en 0,02 · 0,05 · 0,1 · 0,2 ·
  0,5 · 1 · 1,5 m/s.
- **Diferencia**: transparente donde |dlog| < 0,06; azul claro `#96cdff` → azul `#1946c8` donde frena (saturado en −55 %);
  naranja `#ffbe8c` → rojo `#c8321e` donde acelera; traza del diseño (corredores y parches) en línea blanca punteada.
- Rótulo en todas las vistas: "Ilustrativo · pico de una lluvia de N mm/h · no es un estudio hidrológico".

Números de referencia de la demo aprobada (un campo real con relieve de ~470 ha, lluvia de 50 mm/h), para tener órdenes de
magnitud: velocidad media en el campo ~0,09 m/s; ha con v > 0,3 m/s 8,9 (inicial) → 5,6 (multi); ~66 ha donde el diseño
frena ≥ 16 %; en una confluencia cruzada por un corredor, 0,89 → 0,53 m/s; caudal pico del arroyo principal ~40 m³/s.

## 7. Límites (para la UI y para el dueño)
- SRTM ~30 m: pendientes suavizadas (velocidades absolutas por debajo de las reales), ruido de varios metros, los montes
  y cortinas aparecen como lomitas de hasta 10–15 m; no ve terraplenes, alcantarillas ni canales.
- Estado estacionario: no hay tiempo, ni encharcamiento que se llena, ni infiltración de lo que llega de aguas arriba.
- n y CN de tabla, a validar por un especialista. Todo es dial.
- La comparación inicial vs multi es el mensaje robusto (mismo terreno, mismo método); los valores absolutos, no.
