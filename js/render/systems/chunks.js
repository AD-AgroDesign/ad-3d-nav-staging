/* ============ Chunking espacial + LOD por distancia (compartido) ============
   Dueño: A2. Lo consumen trees.js y grass.js; A5 (fauna) y otros pueden reusarlo.

   API (estable):
     partitionCells(items, cell, getXZ) → Map("ix,iz" → { key, ix, iz, items: [item…] })
         Reparte en celdas cuadradas de `cell` metros (coordenadas de escena). No regenera ni
         cambia datos: solo agrupa (el orden de entrada se conserva dentro de cada celda).
     shuffleDet(arr, seed) → arr   orden aleatorio determinista (mulberry32) in situ.
     cellSeed(ix, iz, salt) → entero  semilla estable por celda/clase.
     lodKeep(d, near, far) → 0..1   fracción de instancias que sobrevive a distancia d
         (1 - smoothstep(near, far, d); idéntica a la del shader de applyLod).
     applyLod(material, camUniform, lodUniform[, opts])   encadena (no pisa) el onBeforeCompile del
         material con el raleo/encogimiento por instancia (opts.keep = otra curva de raleo en GLSL, G5). Requiere, en la geometría de la malla,
         el atributo instanciado `aRank` (ver addRank). lodUniform.value = Vector4(near, far, band, compMax).
     addRank(geometry, n)   agrega aRank = (i+0.5)/n; las instancias de la celda deben estar en
         orden aleatorio, así el raleo es uniforme.
     lodCount(keep, band, n) → instancias a dibujar (cuenta de la malla) para un `keep` dado.
     class ChunkLod: registra las mallas de una celda ({mesh, n, ...}) y, en update(cam, near,
         far, band), ajusta visible/count por celda. El culling por frustum lo hace Three
         con la boundingSphere correcta de cada InstancedMesh (T2).

   Raleo sin "pop": cada instancia i tiene rank r=(i+.5)/n. Con t = keep*(1+band), la escala
   es clamp((t - r)/band, 0, 1): las instancias con r<keep están enteras y las que están en la
   franja [keep, keep(1+band)] se encogen hacia su base. La CPU dibuja solo las primeras
   ceil(t*n) (las demás tendrían escala 0): menos triángulos reales, no solo degenerados.
   Compensación (compMax>1): las instancias que sobreviven se agrandan keep^-0.5 en XZ y keep^-0.25
   en Y (tope compMax), para que a lo lejos se conserve la masa de color del pasto en vez de
   verse el suelo pelado; en keep=1 (cerca) el factor es 1: la densidad y forma cercanas no cambian.
   Viento en reposo (ajuste G3): lo resuelve el idleDriver único del host (render/idle.js); trees y grass piden
   idleDriver.request("trees"|"grass", near) con near = vegetación en cuadro y a menos de WIND_IDLE_DIST.
   Coordinación con A1 (shaderlib): este módulo usa nombres propios (uA2Cam, uA2Lod, aRank) y
   se engancha DESPUÉS de shaderlib.patch() (chainShader compone onBeforeCompile y
   customProgramCacheKey; propuesta a A1 en handoffs/a2-fade.md); solo exige que `#include <common>` y
   `#include <project_vertex>` sigan presentes en el vertex shader. */
import * as THREE from "three";
import { mulberry32 } from "../../core/geo.js?v=20261201";

/* A6 relieve en vivo: terrain.js (que importa este módulo) enchufa acá `low(x, z)` = metros que el suelo está bajado en (x, z) respecto de lo horneado
   (0 con el relieve completo). ChunkLod mide la distancia con el centro del chunk ya bajado, igual que lo dibujan los shaders. */
export const reliefHook = { low: null };

export function partitionCells(items, cell, getXZ) {
  const cells = new Map();
  for (const it of items) {
    const [x, z] = getXZ(it);
    const ix = Math.floor(x / cell), iz = Math.floor(z / cell);
    const key = ix + "," + iz;
    let c = cells.get(key);
    if (!c) cells.set(key, c = { key, ix, iz, items: [] });
    c.items.push(it);
  }
  return cells;
}

export function cellSeed(ix, iz, salt = 0) {
  return ((ix * 73856093) ^ (iz * 19349663) ^ (salt * 83492791)) >>> 0;
}

export function shuffleDet(arr, seed) {
  const r = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

export function lodKeep(d, near, far) {
  const t = Math.min(1, Math.max(0, (d - near) / Math.max(1e-6, far - near)));
  return 1 - t * t * (3 - 2 * t);
}

export function lodCount(keep, band, n) {
  return Math.min(n, Math.ceil(Math.min(1, keep * (1 + band)) * n));
}

export function addRank(geometry, n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (i + 0.5) / n;
  geometry.setAttribute("aRank", new THREE.InstancedBufferAttribute(a, 1));
}

/* Curva de raleo por defecto (la de siempre): 1 hasta `near`, 0 desde `far`. G5 (pasto): applyLod acepta otra curva (`opts.keep`). */
const LOD_KEEP_DEFAULT = "1.0 - smoothstep(uA2Lod.x, uA2Lod.y, lodD)";
const lodGlsl = keepExpr => `{
  vec3 lodP = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);   // A6: y = altura del suelo (con terreno; sin terreno es 0, igual que antes)
  float lodD = distance(uA2Cam, lodP);
  float lodKeep = ${keepExpr};
  float lodS = clamp((lodKeep * (1.0 + uA2Lod.z) - aRank) / uA2Lod.z, 0.0, 1.0);
  float lodC = min(uA2Lod.w, inversesqrt(max(lodKeep, 1e-3)));
  transformed *= lodS * vec3(lodC, sqrt(lodC), lodC);
}
`;

/* Encadena una modificación de shader (`fn(sh)`) SOBRE el onBeforeCompile del material y
   compone la clave de caché de programa (`tag`) con la que ya tenga, de forma perezosa:
   la clave resultante es siempre "<clave previa>+<tag>", sin importar el orden en que se
   encadenen varias (LOD, AO) ni si shaderlib.patchExtra() se aplicó antes o después.
   Si alguien llama patch() DESPUÉS, reemplaza onBeforeCompile y clave: encadenar acá siempre
   al final del build (ver grass.js/trees.js). */
export function chainShader(material, tag, fn) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (sh, renderer) {
    if (prev) prev.call(this, sh, renderer);
    fn(sh);
  };
  material.customProgramCacheKey = function () {
    const k = prevKey ? prevKey.call(this) : "";
    return (k ? k + "+" : "") + tag;
  };
  return material;
}

/* opts (opcional, G5): { keep: expresión GLSL de la fracción que sobrevive en función de `lodD` (distancia a la cámara) y de uA2Lod,
   tag: texto que distingue el programa en la caché }. Sin opts: la curva de siempre (idéntica a la anterior). */
export function applyLod(material, camUniform, lodUniform, opts) {
  const keep = (opts && opts.keep) || LOD_KEEP_DEFAULT;
  return chainShader(material, opts && opts.keep ? "a2lod-" + (opts.tag || "x") : "a2lod", sh => {
    sh.uniforms.uA2Cam = camUniform;
    sh.uniforms.uA2Lod = lodUniform;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aRank;\nuniform vec3 uA2Cam;\nuniform vec4 uA2Lod;")
      .replace("#include <project_vertex>", lodGlsl(keep) + "#include <project_vertex>");
  });
}

/* Oclusión falsa por vértice (E-AO): oscurece el color de vértice según la altura LOCAL
   (position.y de la geometría base, antes de escalar): factor = mix(1-amount, 1, smoothstep(y0, y1, y)).
   Solo toca el tramo bajo; lo que queda por encima de y1 no cambia. Requiere vColor (vertexColors
   o instanceColor, ambos presentes en trees/grass). */
export function applyAO(material, amount, y0, y1) {
  const f = v => v.toFixed(3);
  return chainShader(material, "a2ao" + f(amount) + f(y0) + f(y1), sh => {
    sh.vertexShader = sh.vertexShader.replace("#include <color_vertex>",
      "#include <color_vertex>\n#if defined(USE_COLOR) || defined(USE_INSTANCING_COLOR)\n" +
      "  vColor.rgb *= mix(" + f(1 - amount) + ", 1.0, smoothstep(" + f(y0) + ", " + f(y1) + ", position.y));\n#endif");
  });
}

/* Registro de celdas con LOD. add() guarda la esfera envolvente (ya calculada) de la malla. */
export class ChunkLod {
  constructor() { this.chunks = []; }
  add(mesh, n) {
    mesh.computeBoundingSphere();            // esfera real de las instancias (r170), con las n completas
    const bs = mesh.boundingSphere;
    this.chunks.push({ mesh, n, cx: bs.center.x, cy: bs.center.y, cz: bs.center.z, r: bs.radius });
    return mesh;
  }
  /* cam: Vector3 en metros de escena. Devuelve cuántas celdas siguen visibles. */
  update(cam, near, far, band) {
    let vis = 0;
    for (const c of this.chunks) {
      const d = Math.hypot(cam.x - c.cx, cam.y - (c.cy - (reliefHook.low ? reliefHook.low(c.cx, c.cz) : 0)), cam.z - c.cz) - c.r;   // A6: centro bajado (relieve en vivo)
      const keep = lodKeep(d, near, far);
      if (keep <= 0) { c.mesh.visible = false; continue; }
      c.mesh.visible = true;
      c.mesh.count = lodCount(keep, band, c.n);
      vis++;
    }
    return vis;
  }
}
