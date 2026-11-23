import { CLASS_META, CLASS_ORDER } from "../core/config.js?v=20261201";
import { state } from "../core/state.js?v=20261201";
import { natureHa } from "../map/data.js?v=20261201";

/* ---------- Panel ---------- */
export function fmtHa(v) {
  return v.toLocaleString("es-AR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + " ha";
}

export function updatePanel() {
  const key = state.scenario;
  document.getElementById("panel-title").textContent = key === "inicial" ? "Paisaje Actual" : "Paisaje Multifuncional";
  document.getElementById("panel-sub").textContent = key === "inicial"
    ? `Composición actual de ${state.campo.nombre}`
    : "Propuesta de diseño AgroDesign: corredores biológicos y parches de naturaleza";

  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  for (const cls of CLASS_ORDER) {
    const ha = state.stats[key][cls];
    if (!ha) continue;
    const li = document.createElement("li");
    li.innerHTML = `<span class="chip" style="background:${CLASS_META[cls].legend}"></span>${CLASS_META[cls].label}<span class="ha">${fmtHa(ha)}</span>`;
    legend.appendChild(li);
  }

  const before = natureHa("inicial"), after = natureHa("multi");
  document.getElementById("imp-before").textContent = fmtHa(before);
  document.getElementById("imp-after").textContent = fmtHa(after);
  const pct = Math.round(((after - before) / before) * 100);
  document.getElementById("imp-note").textContent =
    `El diseño multiplica la superficie destinada a biodiversidad (+${pct}%), conectando el paisaje con corredores biológicos sin resignar la matriz productiva.`;
}
