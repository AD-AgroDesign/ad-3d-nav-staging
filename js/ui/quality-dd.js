/* ============ Desplegable de calidad con la estética de la plataforma (ORQ G4, pedido de Mike 2026-11-13) ============
   El <select id="quality-select"> nativo se ve blanco con selección azul en escritorio. Queda oculto como fuente de verdad
   (controls.js escucha su "change", quality.js le escribe el valor en la auto-degradación) y encima va un botón + menú
   calcado del selector de campos del header (#campo-dd). En el celular también se usa este menú. */
export function armarQualityDD() {
  const sel = document.getElementById("quality-select");
  if (!sel || document.getElementById("quality-dd")) return;
  const dd = document.createElement("div"); dd.id = "quality-dd";
  const btn = document.createElement("button"); btn.type = "button"; btn.id = "quality-btn";
  btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-label", "Calidad gráfica");
  const cur = document.createElement("span"); cur.id = "quality-current";
  const caret = document.createElement("span"); caret.className = "dd-caret"; caret.textContent = "▾";
  btn.append(cur, caret);
  const menu = document.createElement("ul"); menu.id = "quality-menu"; menu.setAttribute("role", "listbox");
  for (const o of sel.options) {
    const li = document.createElement("li"); li.dataset.v = o.value; li.setAttribute("role", "option");
    const dot = document.createElement("span"); dot.className = "dot";
    const nm = document.createElement("span"); nm.className = "dd-name"; nm.textContent = o.textContent;
    const ck = document.createElement("span"); ck.className = "check"; ck.textContent = "✓";
    li.append(dot, nm, ck);
    li.addEventListener("click", () => {
      cerrar();
      if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event("change")); }
      sync();
    });
    menu.appendChild(li);
  }
  dd.append(btn, menu);
  sel.after(dd);
  sel.classList.add("quality-select-oculto");

  function sync() {
    const o = sel.options[sel.selectedIndex];
    cur.textContent = o ? o.textContent : "";
    for (const li of menu.children) { const s = li.dataset.v === sel.value; li.classList.toggle("selected", s); li.setAttribute("aria-selected", String(s)); }
  }
  function cerrar() { dd.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }
  btn.addEventListener("click", e => {
    e.stopPropagation(); sync();
    const abrir = !dd.classList.contains("open");
    if (abrir) {   // el panel recorta (overflow-y): si el menú no entra debajo del botón, se abre hacia arriba
      const panel = btn.closest("aside"), lim = panel ? panel.getBoundingClientRect().bottom : innerHeight;
      dd.classList.toggle("arriba", btn.getBoundingClientRect().bottom + menu.offsetHeight + 10 > lim);
    }
    dd.classList.toggle("open", abrir); btn.setAttribute("aria-expanded", String(abrir));
  });
  document.addEventListener("click", e => { if (!dd.contains(e.target)) cerrar(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") cerrar(); });
  sel.addEventListener("change", sync);
  sel.addEventListener("ad:sync", sync);   // quality.js (auto-degradación Ultra→Alta) cambia el valor sin "change"
  sync();
}
