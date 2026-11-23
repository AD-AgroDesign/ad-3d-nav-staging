#!/usr/bin/env python3
"""Referencia del Motor 1 del simulador de escorrentía (la que generó las demos aprobadas). NO es parte de la app.

Calcula, para los dos escenarios de un campo, la velocidad del escurrimiento en el pico de una lluvia:
DEM terrarium z13 -> mediana 3x3 -> Priority-Flood con épsilon -> flujo múltiple (MFD, Holmgren p=3) -> C por clase
(Curva Número a 80 mm) -> caudal racional -> Manning (h, v) -> suavizado log. Especificación: docs/hidro/MODELO.md.

Uso:
  python3 velocidad.py --geojson-dir fixtures/demo_relieve --out /tmp/ref [--rain 50] [--dump] [--cache /tmp/terrarium]
Requiere: numpy, pillow, shapely (pip install numpy pillow shapely). Baja tiles de s3.amazonaws.com (se cachean).
Salida: <out>/meta_vel.json (parámetros + estadísticos) y, con --dump, <out>/grid.npz con H, F, Ae, v, h, dirX, dirY por
escenario (para comparar con el port JS en los tests de F1).
F2: box() promedia solo las vecinas que existen (igual que flow.js box3); antes sesgaba el borde de la grilla.
"""
import argparse, heapq, io, json, math, re, unicodedata, urllib.request
from pathlib import Path
import numpy as np
from PIL import Image
from shapely.geometry import shape
from shapely import contains_xy
from shapely.ops import unary_union

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--geojson-dir", required=True, help="carpeta con inicial.geojson y multifuncional.geojson")
ap.add_argument("--out", required=True)
ap.add_argument("--rain", type=float, default=50.0, help="intensidad de lluvia en el pico (mm/h)")
ap.add_argument("--dump", action="store_true", help="guardar las grillas en grid.npz")
ap.add_argument("--cache", default=str(Path.home() / ".cache" / "terrarium"))
args = ap.parse_args()

SRC = Path(args.geojson_dir); OUT = Path(args.out); OUT.mkdir(parents=True, exist_ok=True)
CACHE = Path(args.cache); CACHE.mkdir(parents=True, exist_ok=True)
Z, TS = 13, 256
MARGIN_M = 1500.0
P_CN = 80.0
P_EXP = 3.0
S_MIN = 0.004
I_MMH = args.rain

# ---------- clases: mismo criterio que classify() de js/map/data.js ----------
def classify(props):
    raw = str(props.get("Unidad") or props.get("UNIDAD") or props.get("unidad") or "").lower()
    raw = "".join(c for c in unicodedata.normalize("NFD", raw) if unicodedata.category(c) != "Mn")
    if raw and raw != "no aplica":
        for pat, cls in ((r"otros", "otros"), (r"agua", "agua"), (r"suelo.*desnudo", "suelo-desnudo"), (r"ganader", "ganaderia"),
                         (r"bajo", "bajo"), (r"instalacion", "instalaciones"), (r"camino", "camino"),
                         (r"parche.*herb", "parche-herb"), (r"corr.*herb", "corr-herb"), (r"parche", "parche-le"), (r"corr", "corr-le")):
            if re.search(pat, raw): return cls
        if re.search(r"macroambiente|potencial productivo|(^|[^a-z])pp([^a-z]|$)", raw):
            if re.search(r"mayor|alto", raw): return "zona1"
            if re.search(r"intermedi|medio", raw): return "zona2"
            if re.search(r"menor|bajo", raw): return "zona3"
        if re.search(r"(zona\s*-?1|z1)", raw): return "zona1"
        if re.search(r"(zona\s*-?2|z2)", raw): return "zona2"
        if re.search(r"(zona\s*-?3|z3)", raw): return "zona3"
        if re.search(r"(agricola|ag-secano|secano)", raw): return "agri"
    return {11: "parche-le", 12: "corr-le", 21: "parche-herb", 22: "corr-herb", 31: "agri", 33: "ganaderia", 311: "zona1",
            312: "zona2", 313: "zona3", 41: "instalaciones", 42: "camino", 44: "agua", 46: "suelo-desnudo"}.get(props.get("RASTER"), "otros")

# MODELO.md §3: _cls -> (CN grupo B, n de Manning)
PARAM = {"agri": (78, 0.10), "zona1": (78, 0.10), "zona2": (78, 0.10), "zona3": (78, 0.10), "otros": (78, 0.10),
         "corr-herb": (61, 0.24), "parche-herb": (61, 0.24), "corr-le": (55, 0.40), "parche-le": (55, 0.40),
         "instalaciones": (86, 0.05), "camino": (82, 0.03), "ganaderia": (69, 0.15), "suelo-desnudo": (86, 0.05),
         "bajo": (70, 0.24), "agua": (98, 0.03)}

# ---------- proyección y DEM ----------
def lonlat_to_px(lon, lat, z=Z):
    n = TS * 2 ** z
    s = math.sin(math.radians(lat))
    return (lon + 180) / 360 * n, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n

def px_to_lonlat(x, y, z=Z):
    n = TS * 2 ** z
    return x / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))

def tile(tx, ty):
    f = CACHE / f"t{Z}_{tx}_{ty}.png"
    if not f.exists():
        f.write_bytes(urllib.request.urlopen(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png", timeout=30).read())
    a = np.asarray(Image.open(f).convert("RGB")).astype(np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768

ini = json.load(open(SRC / "inicial.geojson", encoding="utf-8"))
mul = json.load(open(SRC / "multifuncional.geojson", encoding="utf-8"))
field = unary_union([shape(f["geometry"]) for f in ini["features"] if f.get("geometry")])
w, s, e, n = field.bounds
latc = (s + n) / 2
dlat = MARGIN_M / 110574; dlon = MARGIN_M / (111320 * math.cos(math.radians(latc)))
x0, y0 = lonlat_to_px(w - dlon, n + dlat); x1, y1 = lonlat_to_px(e + dlon, s - dlat)
tx0, ty0, tx1, ty1 = int(x0 // TS), int(y0 // TS), int(x1 // TS), int(y1 // TS)
mos = np.zeros(((ty1 - ty0 + 1) * TS, (tx1 - tx0 + 1) * TS))
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        mos[(ty - ty0) * TS:(ty - ty0 + 1) * TS, (tx - tx0) * TS:(tx - tx0 + 1) * TS] = tile(tx, ty)
gx0, gy0 = int(x0), int(y0)
H0 = mos[gy0 - ty0 * TS:int(math.ceil(y1)) - ty0 * TS, gx0 - tx0 * TS:int(math.ceil(x1)) - tx0 * TS].copy()
ny, nx = H0.shape
cell = 156543.03392 / 2 ** Z * math.cos(math.radians(latc))
AREA = cell * cell

def shift(A, di, dj, fill):
    out = np.full_like(A, fill)
    ys, yd = (slice(dj, None), slice(0, ny - dj)) if dj >= 0 else (slice(0, ny + dj), slice(-dj, None))
    xs, xd = (slice(di, None), slice(0, nx - di)) if di >= 0 else (slice(0, nx + di), slice(-di, None))
    out[yd, xd] = A[ys, xs]
    return out

def box(A):
    """Media 3x3 de las vecinas que EXISTEN (en el borde de la grilla divide por 4 o 6, no por 9).
    Corrección F2: la versión original rellenaba con ceros y dividía siempre por 9, lo que sesgaba hacia 0 las 2-3 celdas
    del borde (pendientes enormes en el DEM suavizado, log v tirado hacia v = 1 m/s). Ahora es igual a flow.js box3."""
    acc = np.zeros_like(A); cnt = np.zeros_like(A)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            acc += shift(A, di, dj, 0)
            cnt += shift(np.ones_like(A), di, dj, 0)
    return acc / cnt

pad = np.pad(H0, 1, mode="edge")
H = np.median(np.stack([pad[1 + dj:1 + dj + ny, 1 + di:1 + di + nx] for dj in (-1, 0, 1) for di in (-1, 0, 1)]), axis=0)

NB = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
DIST = np.array([math.sqrt(2), 1, math.sqrt(2), 1, 1, math.sqrt(2), 1, math.sqrt(2)])
CLEN = np.array([0.354, 0.5, 0.354, 0.5, 0.5, 0.354, 0.5, 0.354])

# ---------- 1. Priority-Flood con épsilon ----------
EPS = 1e-4
F = H.copy(); done = np.zeros(H.shape, bool); pq = []
for j in range(ny):
    for i in range(nx):
        if i in (0, nx - 1) or j in (0, ny - 1):
            heapq.heappush(pq, (F[j, i], j, i)); done[j, i] = True
while pq:
    h, j, i = heapq.heappop(pq)
    for di, dj in NB:
        a, b = i + di, j + dj
        if 0 <= a < nx and 0 <= b < ny and not done[b, a]:
            done[b, a] = True
            F[b, a] = max(F[b, a], h + EPS)
            heapq.heappush(pq, (F[b, a], b, a))

# ---------- 2-4. MFD, dirección media, pendiente ----------
Wt = np.zeros((8, ny, nx))
for k, (di, dj) in enumerate(NB):
    drop = F - shift(F, di, dj, np.inf)
    Wt[k] = np.where(drop > 0, drop / (DIST[k] * cell), 0) ** P_EXP * CLEN[k]
tot = Wt.sum(0); has = tot > 0; Wt[:, has] /= tot[has]
U = box(box(sum(Wt[k] * NB[k][0] / DIST[k] for k in range(8))))
V = box(box(sum(Wt[k] * NB[k][1] / DIST[k] for k in range(8))))
nrm = np.hypot(U, V) + 1e-9; U /= nrm; V /= nrm
Hs = box(box(H))
gx = (shift(Hs, 1, 0, np.nan) - shift(Hs, -1, 0, np.nan)) / (2 * cell)
gy = (shift(Hs, 0, 1, np.nan) - shift(Hs, 0, -1, np.nan)) / (2 * cell)
S = np.maximum(np.nan_to_num(np.hypot(gx, gy), nan=S_MIN), S_MIN)

order = np.argsort(-F, axis=None, kind="stable")
flatW = Wt.reshape(8, -1)
offs = [dj * nx + di for di, dj in NB]
def mfd_acc(weight):
    acc = weight.ravel().astype(float).copy()
    for k in order:
        a = acc[k]
        if a == 0: continue
        for d in range(8):
            wv = flatW[d, k]
            if wv > 0: acc[k + offs[d]] += a * wv
    return acc.reshape(ny, nx)

# ---------- clases por celda ----------
LON = np.empty((ny, nx)); LAT = np.empty((ny, nx))
for j in range(ny):
    for i in range(nx):
        LON[j, i], LAT[j, i] = px_to_lonlat(gx0 + i + 0.5, gy0 + j + 0.5)
INSIDE = contains_xy(field, LON, LAT)
def param_grids(fc):
    cn = np.full((ny, nx), 78.0); nn = np.full((ny, nx), 0.10)
    for f in fc["features"]:
        if not f.get("geometry"): continue
        m = contains_xy(shape(f["geometry"]), LON, LAT)
        c, r = PARAM[classify(f["properties"])]
        cn[m] = c; nn[m] = r
    return cn, nn

def runoff_mm(cn, P=P_CN):
    Sm = 25400 / cn - 254
    return np.where(P > 0.2 * Sm, (P - 0.2 * Sm) ** 2 / (P + 0.8 * Sm), 0)

# ---------- 5-10. por escenario ----------
def escenario(fc):
    cn, nn = param_grids(fc)
    C = runoff_mm(cn) / P_CN
    Ae = mfd_acc(C * AREA)
    Q = I_MMH / 1000 / 3600 * Ae
    q = Q / cell
    h = (q * nn / np.sqrt(S)) ** 0.6
    v = np.where(h > 0, q / np.maximum(h, 1e-6), 0)
    v = 10 ** box(np.log10(np.maximum(v, 1e-4)))
    return dict(cn=cn, n=nn, Ae=Ae, Q=Q, h=h, v=v)

R = {"inicial": escenario(ini), "multi": escenario(mul)}
dlog = np.log2(np.maximum(R["multi"]["v"], 1e-4) / np.maximum(R["inicial"]["v"], 1e-4))

def stats(r):
    v = r["v"][INSIDE]
    return {"v_media_ms": round(float(v.mean()), 4), "v_p95_ms": round(float(np.percentile(v, 95)), 3),
            "ha_v_mayor_0_3": round(float((v > 0.3).sum() * AREA / 1e4), 2),
            "Q_pico_max_campo_m3s": round(float(r["Q"][INSIDE].max()), 3)}
meta = {"grilla": {"z": Z, "gx0": gx0, "gy0": gy0, "nx": nx, "ny": ny, "cell_m": cell},
        "parametros": {"rain_mmh": I_MMH, "P_cn_mm": P_CN, "mfd_p": P_EXP, "S_min": S_MIN, "eps_fill": EPS, "margen_m": MARGIN_M,
                       "clases": {k: {"CN": c, "n": r} for k, (c, r) in PARAM.items()}},
        "campo_ha": round(float(INSIDE.sum() * AREA / 1e4), 2),
        "inicial": stats(R["inicial"]), "multi": stats(R["multi"]),
        "frena_ha": round(float(((dlog < -0.25) & INSIDE).sum() * AREA / 1e4), 2)}
meta["reduccion_v_media_pct"] = round(100 * (1 - meta["multi"]["v_media_ms"] / meta["inicial"]["v_media_ms"]), 2)
json.dump(meta, open(OUT / "meta_vel.json", "w"), indent=1)
if args.dump:
    np.savez_compressed(OUT / "grid.npz", H=H, F=F, S=S, dirX=U, dirY=V, inside=INSIDE,
                        **{f"{k}_{c}": R[k][c] for k in R for c in ("Ae", "h", "v", "cn", "n")}, dlog=dlog)
print(json.dumps(meta, indent=1))
