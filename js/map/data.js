import { CROWN_PALETTE, NATURE_CLASSES, WOODY_CLASSES } from "../core/config.js?v=20261201";
import { blobRing, normalizeGeometry, offsetRing, ringAreaHa, ringBBox, scatterInClasses } from "../core/geo.js?v=20261201";
import { HOME_VIEW, setHomeView, state } from "../core/state.js?v=20261201";
import { map, mapStyle } from "./style.js?v=20261201";

/* ---------- Carga de configuración y datos ---------- */
/* La lista de campos y cuál abrir los resuelve auth.js contra Supabase: la base
   ya filtró por los permisos del usuario, así que acá sólo se dibuja lo que el
   usuario tiene derecho a ver. */
export function loadCampos() {
  const campos = window.AD_AUTH.campos;
  state.campo = window.AD_AUTH.campo;

  // Resolución satelital por campo: reconstruimos la fuente Esri con el maxzoom
  // del campo si difiere del default (evita el cartel "Map data not yet
  // available" donde no hay imagen, sin resignar nitidez donde sí la hay).
  const mz = state.campo.maxzoom || mapStyle.sources.esri.maxzoom;
  if (map.getSource("esri") && mz !== mapStyle.sources.esri.maxzoom) {
    map.removeLayer("satellite");
    map.removeSource("esri");
    map.addSource("esri", { ...mapStyle.sources.esri, maxzoom: mz });
    map.addLayer({ id: "satellite", type: "raster", source: "esri" });
  }

  // Con un solo campo habilitado el selector no tiene nada que ofrecer
  document.getElementById("campo-dd").style.display = campos.length > 1 ? "" : "none";

  const list = document.getElementById("campo-list");
  list.innerHTML = "";
  // El nombre del cliente sólo aporta cuando hay más de uno en la lista, que es
  // el caso de los admin; un cliente ve sus propios campos sin prefijo. Y cuando
  // cliente y campo se llaman igual (El Carmen, Monte Hermoso) tampoco se prefija
  const variosClientes = new Set(campos.map(c => c.cliente)).size > 1;
  const ddLabel = c => (variosClientes && c.cliente && c.cliente !== c.nombre)
    ? `${c.cliente} — ${c.nombre}` : c.nombre;
  for (const c of campos) {
    const li = document.createElement("li");
    li.dataset.id = c.id;
    li.innerHTML = `<span class="dot"></span><span class="dd-name">${ddLabel(c)}</span><span class="check">✓</span>`;
    if (c.id === state.campo.id) li.classList.add("selected");
    li.addEventListener("click", () => {
      const q = new URLSearchParams(location.search);
      q.set("campo", c.id);
      location.search = q.toString();
    });
    list.appendChild(li);
  }
  document.getElementById("campo-current").textContent = ddLabel(state.campo);
  document.getElementById("splash-campo").textContent = state.campo.nombre;
  document.title = `AgroDesign · Navegador 3D · ${state.campo.nombre}`;
}

export async function loadData() {
  // Los GeoJSON viven en un bucket privado de Supabase: cada descarga necesita
  // una URL firmada, que sólo se emite si la RLS reconoce al usuario como dueño
  // del campo. Pedirlas es barato y ya vienen con el token adentro.
  const [urlInicial, urlMulti] = await Promise.all([
    window.AD_AUTH.signedUrlFor(state.campo.pathInicial),
    window.AD_AUTH.signedUrlFor(state.campo.pathMulti)
  ]);
  const [ini, multi] = await Promise.all([
    fetch(urlInicial).then(r => r.json()),
    fetch(urlMulti).then(r => r.json())
  ]);
  for (const fc of [ini, multi]) {
    normalizeGeometry(fc);
    for (const f of fc.features) {
      f.properties._cls = classify(f.properties);
      // superficie: del atributo si existe, si no calculada de la geometría
      let sup = f.properties.Sup ?? f.properties.SUP ?? f.properties.sup;
      if (sup == null || sup === 0) {
        sup = f.geometry.coordinates.reduce((s, poly) =>
          s + ringAreaHa(poly[0], poly[0][0][1]), 0);
      }
      f.properties._sup = sup;
    }
  }
  state.data.inicial = ini;
  state.data.multi = multi;
  computeStats();
  computeHomeView();
  state.veg.inicial = generateTreeData(ini, 20260711);
  state.veg.multi = generateTreeData(multi, 47110226);
}

export function computeStats() {
  for (const [key, fc] of [["inicial", state.data.inicial], ["multi", state.data.multi]]) {
    const sums = {};
    for (const f of fc.features) {
      const cls = f.properties._cls;
      sums[cls] = (sums[cls] || 0) + (f.properties._sup || 0);
    }
    state.stats[key] = sums;
  }
}

export function computeHomeView() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const fc of [state.data.inicial, state.data.multi]) {
    for (const f of fc.features) {
      for (const poly of f.geometry.coordinates) {
        const [a, b, c, d] = ringBBox(poly[0]);
        if (a < minX) minX = a; if (b < minY) minY = b;
        if (c > maxX) maxX = c; if (d > maxY) maxY = d;
      }
    }
  }
  state.bbox = [[minX, minY], [maxX, maxY]];
  const cam = map.cameraForBounds(state.bbox, { padding: 80 });
  setHomeView({ center: [(minX + maxX) / 2, (minY + maxY) / 2], zoom: (cam ? cam.zoom : 12.6) - 0.1, pitch: 58, bearing: 15 });
  const padX = Math.max(0.35, (maxX - minX)), padY = Math.max(0.3, (maxY - minY));
  map.setMaxBounds([[minX - padX, minY - padY], [maxX + padX, maxY + padY]]);
  map.jumpTo({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom - 1.2, pitch: 0, bearing: 0 });
}

export function natureHa(key) {
  return NATURE_CLASSES.reduce((s, c) => s + (state.stats[key][c] || 0), 0);
}

/* Clasificador universal: tolera las variantes de esquema de cada campo
   (Unidad/UNIDAD, nombres largos, con acentos, o solo códigos RASTER) */
export function classify(props) {
  const raw = (props.Unidad || props.UNIDAD || props.unidad || "")
    .toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (raw && raw !== "no aplica") {
    if (/otros/.test(raw)) return "otros";
    if (/agua/.test(raw)) return "agua";
    if (/suelo.*desnudo/.test(raw)) return "suelo-desnudo";
    if (/ganader/.test(raw)) return "ganaderia";
    if (/bajo/.test(raw)) return "bajo";
    if (/instalacion/.test(raw)) return "instalaciones";
    if (/camino/.test(raw)) return "camino";
    if (/parche.*herb/.test(raw)) return "parche-herb";
    if (/corr.*herb/.test(raw)) return "corr-herb";
    if (/parche/.test(raw)) return "parche-le";
    if (/corr/.test(raw)) return "corr-le";
    // Macroambientes: tolera la nomenclatura vieja (zona 1/2/3) y la nueva
    // (macroambiente de mayor / intermedio / menor potencial productivo)
    if (/macroambiente|potencial productivo|(^|[^a-z])pp([^a-z]|$)/.test(raw)) {
      if (/mayor|alto/.test(raw)) return "zona1";
      if (/intermedi|medio/.test(raw)) return "zona2";
      if (/menor|bajo/.test(raw)) return "zona3";
    }
    if (/(zona\s*-?1|z1)/.test(raw)) return "zona1";
    if (/(zona\s*-?2|z2)/.test(raw)) return "zona2";
    if (/(zona\s*-?3|z3)/.test(raw)) return "zona3";
    if (/(agricola|ag-secano|secano)/.test(raw)) return "agri";
  }
  switch (props.RASTER) {
    case 11: return "parche-le";
    case 12: return "corr-le";
    case 21: return "parche-herb";
    case 22: return "corr-herb";
    case 31: return "agri";
    case 33: return "ganaderia";
    case 311: return "zona1";
    case 312: return "zona2";
    case 313: return "zona3";
    case 41: return "instalaciones";
    case 42: return "camino";
    case 44: return "agua";
    case 46: return "suelo-desnudo";
    default: return "otros";
  }
}

/* Genera atributos de árboles + sombras drapeadas (GeoJSON) */
export function generateTreeData(fc, seed) {
  const { points, rng } = scatterInClasses(fc, WOODY_CLASSES, seed, 55, 4200, 3);
  const trees = [], shadowFeats = [];
  for (const [lon, lat] of points) {
    const h = 5 + rng() * 9;                    // altura total 5–14 m
    const r = h * (0.32 + rng() * 0.2);         // radio de copa proporcional
    trees.push({
      lon, lat, h, r,
      c: Math.floor(rng() * CROWN_PALETTE.length),
      lobe: rng() < 0.45,
      j: rng()
    });
    shadowFeats.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: offsetRing(blobRing(lon, lat, r * 1.15, rng, 7, 0.4), 2.4, -1.8, lat) }
    });
  }
  return { trees, shadows: { type: "FeatureCollection", features: shadowFeats } };
}

