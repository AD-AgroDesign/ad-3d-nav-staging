#!/usr/bin/env node
// Sella una versión en TODO el grafo de módulos para saltear la caché de GitHub Pages (max-age=600).
// Uso:  node tools/stamp_version.mjs <VERSION>        (p. ej. 20261113)
//       node tools/stamp_version.mjs --check          (verifica que no haya mezcla; sale 1 si la hay)
// Idempotente: reemplaza la versión anterior. Toca solo especificadores relativos (./ y ../) de
// import / export ... from / import() / new URL("./x.js", import.meta.url) dentro de js/**/*.js, y las referencias locales de index.html
// (js/auth.js, js/app.js, css/style.css, vendor/maplibre-gl.css). No toca URLs absolutas, el
// importmap ("three" -> vendor/three.module.js) ni el contenido de vendor/.
// Un módulo importado con y sin query serían dos instancias (estado duplicado): por eso todo o nada.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
if (!arg) { console.error("Uso: node tools/stamp_version.mjs <VERSION> | --check"); process.exit(2); }
const CHECK = arg === "--check";
if (!CHECK && !/^[0-9A-Za-z._-]+$/.test(arg)) { console.error("VERSION inválida: " + arg); process.exit(2); }

function* walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (n.endsWith(".js")) yield p;
  }
}
// (from | import | import( ) + comilla + especificador relativo .js + ?v= opcional
const RE_JS = /((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.{1,2}\/[^"'?]*\.js)(?:\?v=[^"']*)?\2/g;
// new URL("./x.js", import.meta.url) (p. ej. el Worker de módulo del simulador): también es un módulo del grafo
const RE_URL = /(\bnew\s+URL\(\s*)(["'])(\.{1,2}\/[^"'?]*\.js)(?:\?v=[^"']*)?\2(\s*,\s*import\.meta\.url)/g;
// referencias locales de index.html
const RE_HTML = /((?:src|href)=")((?:js\/auth\.js|js\/app\.js|css\/style\.css|vendor\/maplibre-gl\.css))(?:\?v=[^"]*)?(")/g;

let tocados = 0, specs = 0, sinSello = [];
const sufijo = CHECK ? null : "?v=" + arg;

for (const f of walk(join(RAIZ, "js"))) {
  const src = readFileSync(f, "utf8");
  let n = 0;
  const out = src
    .replace(RE_JS, (m, pre, q, esp) => { n++; return CHECK ? m : pre + q + esp + sufijo + q; })
    .replace(RE_URL, (m, pre, q, esp, post) => { n++; return CHECK ? m : pre + q + esp + sufijo + q + post; });
  specs += n;
  if (CHECK) { for (const m of [...src.matchAll(RE_JS), ...src.matchAll(RE_URL)]) if (!m[0].includes("?v=")) sinSello.push(f + ": " + m[3]); }
  if (!CHECK && out !== src) { writeFileSync(f, out); tocados++; }
}
const html = join(RAIZ, "index.html");
const h = readFileSync(html, "utf8");
const hOut = h.replace(RE_HTML, (m, a, ruta, c) => CHECK ? m : a + ruta + sufijo + c);
if (CHECK) { for (const m of h.matchAll(RE_HTML)) if (!m[0].includes("?v=")) sinSello.push("index.html: " + m[2]); }
else if (hOut !== h) { writeFileSync(html, hOut); tocados++; }

if (CHECK) {
  // todas las versiones presentes deben ser una sola
  const vers = new Set();
  const todos = [...walk(join(RAIZ, "js")), html];
  for (const f of todos) for (const m of readFileSync(f, "utf8").matchAll(/\.(?:js|css)\?v=([0-9A-Za-z._-]+)/g)) vers.add(m[1]);
  if (sinSello.length || vers.size !== 1) {
    console.error("MEZCLA: sin sello=" + sinSello.length + " versiones=" + [...vers].join(","));
    sinSello.forEach(s => console.error("  " + s));
    process.exit(1);
  }
  console.log("OK: " + specs + " especificadores, versión única " + [...vers][0]);
} else {
  console.log("Versión " + arg + ": " + specs + " especificadores en js/, " + tocados + " archivos modificados.");
}
