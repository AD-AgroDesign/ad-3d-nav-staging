/* ============ Sistema de render: árboles nativos del espinal (G, Ola 2) ============
   Dueño: A2. Decisión G1 (2026-11-10): tala, algarrobo y chañar (sin eucalipto). Contrato: §6.3.

   Cada árbol conserva su posición, su cantidad y su semilla (data.js no cambia): lo que cambia es
   la forma. Dos representaciones por árbol, según la distancia a la cámara (§6.4):
     - CERCA: tronco + ramas + copa de tarjetas de follaje con atlas procedural (treegen.js), una
       InstancedMesh por especie y celda (tronco y follaje comparten geometría y material).
       alphaTest + alphaToCoverage (con MSAA); normales esféricas; vaivén sutil con uTime.
     - LEJOS (impostor, G2): 3 quads cruzados (6 tris) con una textura horneada en el navegador desde el
       propio modelo de cada especie (treegen.buildImpostorAtlas); UNA InstancedMesh por celda para las tres
       especies (la fila del atlas va por instancia). Se funde con las tarjetas por dither (screen-door) en una
       franja de TREE_LOD_BAND × distancia de tarjetas: sin "pop". Las sombras lejanas (A3) siguen usando el
       elipsoide de 32 tris (`far`, que ya no se dibuja).
   Distancias por nivel (core/quality.js): treeCardDist × TREE_IMPOSTOR.cardDistK / treeImpostorDist. Alta 900/∞,
   Media 450/1500, Baja solo impostor (treeCardDist 0; treeImpostorDist 0 se interpreta como sin límite).

   Para A3 (sombras): ver `casters(scenarioKey)` abajo. */
import * as THREE from "three";
import { CHUNK_CELL_TREES, TREE_ALPHA_TEST, TREE_IMPOSTOR, TREE_IMPOSTOR_CULL, TREE_LOD_BAND, TREE_SPECIES, TREE_SWAY, WIND_IDLE_DIST } from "../../core/config.js?v=20261201";
import { idleDriver } from "../idle.js?v=20261201";
import { chainShader, partitionCells } from "./chunks.js?v=20261201";
import { lowAt } from "../../terrain/terrain.js?v=20261201";   // A6 relieve en vivo: centro de celda bajado
import { uniforms } from "../lighting.js?v=20261201";

const _fr = new THREE.Frustum(), _sp = new THREE.Sphere();
import { buildAtlas, buildImpostorAtlas, buildImpostorGeometry, buildProxy, buildSpecies } from "./treegen.js?v=20261201";

const built = {};   // scenarioKey → { cells, nearMat, farMat, counts, n }
const SPECIES = Object.keys(TREE_SPECIES);

/* Uniforms compartidos: (cardStart, cardEnd, impStart, impEnd) en metros */
const lodU = { value: new THREE.Vector4(480, 600, 1e9 - 1, 1e9) };
function setLodFromQuality(q) {
  const c = (q.treeCardDist || 0) * TREE_IMPOSTOR.cardDistK;
  const band = TREE_LOD_BAND;
  let ie = q.treeImpostorDist;
  if (!TREE_IMPOSTOR_CULL || !ie || !isFinite(ie)) ie = 1e9;              // Infinity y 0 (Baja: solo impostor) = sin límite
  lodU.value.set(c > 0 ? c * (1 - band) : -2, c > 0 ? c : -1, ie >= 1e9 ? 1e9 - 1 : ie * 0.9, ie);
}

/* Hash determinista [0,1) de un árbol (para especie, tamaño, giro y tinte; el dato no cambia) */
const frac = x => x - Math.floor(x);
const hash = (t, k) => frac(Math.sin(t.r * 127.1 + t.h * 311.7 + t.j * 74.7 + k * 19.19) * 43758.5453);
function pickSpecies(t) {
  const x = hash(t, 0);
  let acc = 0;
  for (const s of SPECIES) { acc += TREE_SPECIES[s].mix; if (x < acc) return s; }
  return SPECIES[SPECIES.length - 1];
}

/* Shader común (se encadena DESPUÉS de patch()): vaivén de copa, LOD por distancia con dither y,
   en las tarjetas, normal SIN invertir por cara (las normales esféricas valen para ambos lados). */
function treeShader(mat, kind, sway) {
  const imp = kind === "imp";            // impostor horneado: atlas por fila de instancia, quad cenital a la altura de la copa, normal +Y
  return chainShader(mat, "a2tree-" + kind + (sway ? "s" : ""), sh => {
    sh.uniforms.uA2TCam = mat.userData.camU;
    sh.uniforms.uA2TLod = lodU;
    sh.uniforms.uTime = mat.userData.timeU;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uA2TCam;\nuniform vec4 uA2TLod;\nuniform float uTime;\nvarying vec2 vA2TVis;" + (imp ? "\nattribute vec3 aImp;\nvarying float vA2TD;" : ""))
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\n" +
        (imp ? "transformed.y = mix(transformed.y, aImp.z, step(0.5, normal.y));\n" : "") +
        "{\n  vec3 tip = instanceMatrix[3].xyz;\n  float d = distance(uA2TCam, tip);\n" +
        (imp ? "  vA2TD = d;\n  transformed *= clamp(d / " + TREE_IMPOSTOR.minSizeDist.toFixed(1) + ", 1.0, 3.0);\n" : "") +
        (kind === "near"
          ? "  vA2TVis = vec2(1.0 - smoothstep(uA2TLod.x, uA2TLod.y, d), 1.0);\n"
          : "  vA2TVis = vec2(smoothstep(uA2TLod.x, uA2TLod.y, d), 1.0 - smoothstep(uA2TLod.z, uA2TLod.w, d));\n") +
        (sway
          ? "  float tph = dot(tip.xz, vec2(37.0, 73.0));\n  float yn = max(position.y, 0.0);\n  float sw = yn * yn * " + TREE_SWAY.toFixed(4) + ";\n" +
            "  transformed.x += sin(uTime * 0.9 + tph) * sw;\n  transformed.z += cos(uTime * 0.7 + tph * 1.7) * sw * 0.7;\n"
          : "") +
        "}");
    if (imp) {
      sh.vertexShader = sh.vertexShader
        .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = vec3(0.0, 1.0, 0.0);")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv.y += aImp.y;\n#endif");
    }
    const discardCode = kind === "near"
      ? "  if (vA2TVis.x < 1.0 && ign >= vA2TVis.x) discard;\n"
      : "  if ((vA2TVis.x < 1.0 && ign < 1.0 - vA2TVis.x) || (vA2TVis.y < 1.0 && ign >= vA2TVis.y)) discard;\n";
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vA2TVis;")
      .replace("void main() {", "void main() {\n  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\n" + discardCode);
    if (imp) {
      /* Los mipmaps del alfa adelgazan la silueta con la distancia y los árboles lejanos (decenas de km en el home) se
         iban borrando: el corte de alfa baja con la distancia (de TREE_IMPOSTOR.alphaTest a 0,1) y la masa de copas se conserva. */
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vA2TD;")
        .replace("#include <alphatest_fragment>", [
          "#ifdef USE_ALPHATEST",
          "  float a2T = mix(alphaTest, 0.1, smoothstep(" + TREE_IMPOSTOR.alphaFar[0].toFixed(1) + ", " + TREE_IMPOSTOR.alphaFar[1].toFixed(1) + ", vA2TD));",
          "  #ifdef ALPHA_TO_COVERAGE",
          "    diffuseColor.a = smoothstep(a2T, a2T + fwidth(diffuseColor.a), diffuseColor.a);",
          "    if (diffuseColor.a == 0.0) discard;",
          "  #else",
          "    if (diffuseColor.a < a2T) discard;",
          "  #endif",
          "#endif"
        ].join("\n"));
    }
    if (kind === "near" || imp) {
      sh.fragmentShader = sh.fragmentShader.replace("#include <normal_fragment_begin>",
        THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""));
    }
  });
}

const IMP_ROWS_ = 3;   // = treegen.IMP_ROWS (filas del atlas de impostores: una por especie)
/* Geometría del impostor de UNA celda: comparte posición/uv/índice con la base y agrega el atributo por instancia
   aImp = (0, offset de fila del atlas, altura del quad cenital). */
function impG(base, n) {
  const g = new THREE.BufferGeometry();
  for (const k of ["position", "normal", "color", "uv"]) g.setAttribute(k, base.getAttribute(k));
  g.setIndex(base.getIndex());
  g.setAttribute("aImp", new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
  return g;
}

let speciesGeo = null, proxyGeo = null, impGeo = null, impAtlas = null;
function geometries() {
  if (!speciesGeo) {
    speciesGeo = {};
    for (const s of SPECIES) speciesGeo[s] = buildSpecies(s, TREE_SPECIES[s]);
    proxyGeo = buildProxy();                                  // solo sombras lejanas (A3)
    buildAtlas();
    impAtlas = buildImpostorAtlas(SPECIES.map(s => ({ name: s, bake: speciesGeo[s].bake, cy: speciesGeo[s].cyU * speciesGeo[s].bake.H })));
    impGeo = buildImpostorGeometry();
  }
  return { speciesGeo, proxyGeo, impGeo, impAtlas };
}

export default {
  id: "trees",

  build(ctx, scenarioKey, data, veg) {
    const trees = veg.trees;
    const group = new THREE.Group();
    const { speciesGeo, proxyGeo, impGeo, impAtlas } = geometries();
    const atlas = buildAtlas();
    setLodFromQuality(ctx.quality);

    /* Material de las tarjetas + tronco (una sola pasada, opaco). userData: uniforms para el shader. */
    const nearMat = new THREE.MeshPhongMaterial({
      map: atlas, vertexColors: true, side: THREE.DoubleSide, shininess: 0, specular: 0x000000,
      alphaTest: TREE_ALPHA_TEST, alphaToCoverage: !!ctx.quality.msaa
    });
    const farMat = new THREE.MeshPhongMaterial({ map: impAtlas.texture, vertexColors: true, side: THREE.DoubleSide, shininess: 0, specular: 0x000000,
      alphaTest: TREE_IMPOSTOR.alphaTest, alphaToCoverage: !!ctx.quality.msaa });
    for (const m of [nearMat, farMat]) {
      m.userData.camU = ctx.uniforms.uCamPos; m.userData.timeU = ctx.uniforms.uTime;
      ctx.shaderlib.patch(m, { fog: true, fade: scenarioKey });     // niebla + cross-fade de escenario (dither)
    }
    treeShader(nearMat, "near", true);
    treeShader(farMat, "imp", false);
    /* Tronco y follaje comparten material (una sola malla por especie/celda → menos draws): el
       "no-follaje" de A1 (userData.foliage=false) no se puede separar del tronco; ver handoff. */

    /* Chunking (T2): celdas de CHUNK_CELL_TREES m, cada InstancedMesh con su boundingSphere real */
    const withXZ = trees.map(t => ({ t, xz: ctx.toScene(t.lon, t.lat), sp: pickSpecies(t), gy: ctx.heightAt(t.lon, t.lat) }));   // A6: gy = altura del suelo (0 sin terreno)
    const cells = partitionCells(withXZ, CHUNK_CELL_TREES, o => o.xz);
    const out = [];
    const counts = {};
    let nTrees = 0;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), eul = new THREE.Euler(), col = new THREE.Color();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();

    for (const cell of cells.values()) {
      const entry = { near: [], far: null, imp: null, cx: 0, cy: 0, cz: 0, r: 0 };
      const farMesh = new THREE.InstancedMesh(proxyGeo, farMat, cell.items.length);   // NO se dibuja (no se agrega al grupo): geometría de sombra lejana para A3
      const impMesh = new THREE.InstancedMesh(impG(impGeo, cell.items.length), farMat, cell.items.length);
      const aImp = impMesh.geometry.getAttribute("aImp");
      const perSp = {};
      cell.items.forEach((o, i) => {
        const { t, xz: [x, z], sp, gy } = o;
        const cfg = TREE_SPECIES[sp], g = speciesGeo[sp];
        const u = Math.min(1, Math.max(0, (t.h - 5) / 9)), kv = Math.min(1, Math.max(0, (t.r / t.h - 0.32) / 0.2));
        const H = cfg.h[0] + (cfg.h[1] - cfg.h[0]) * u;
        const k = (cfg.crownK[0] + (cfg.crownK[1] - cfg.crownK[0]) * kv) * (t.lobe ? 1.1 : 1);
        const sxz = H * k / g.R0u;                         // ancho (la geometría tiene altura 1)
        const yaw = hash(t, 1) * Math.PI * 2, tx = (hash(t, 2) - 0.5) * 0.12, tz = (hash(t, 3) - 0.5) * 0.12;
        const b = 1 + (hash(t, 4) - 0.5) * 0.2, c = (hash(t, 5) - 0.5) * 0.08;

        // impostor (todas las especies en la misma malla de la celda)
        eul.set(0, yaw, 0, "YXZ");
        m4.compose(pos.set(x, gy + g.cyU * H, z), q.setFromEuler(eul), scl.set(g.rxU * sxz * cfg.proxyK, g.ryU * H * cfg.proxyK * cfg.proxyFlat, g.rxU * sxz * cfg.proxyK));
        farMesh.setMatrixAt(i, m4);

        // impostor horneado: mismo árbol (posición, giro, tamaño, tinte), 3 quads cruzados con la textura de su especie
        const ii = impAtlas.info[sp];
        eul.set(0, yaw, 0, "YXZ");
        m4.compose(pos.set(x, gy + ii.yb * H, z), q.setFromEuler(eul), scl.set(ii.half * sxz, ii.hgt * H, ii.half * sxz));
        impMesh.setMatrixAt(i, m4);
        const sh = TREE_IMPOSTOR.shade * cfg.proxyShade;
        col.setRGB(sh * b * (1 + c), sh * b, sh * b * (1 - c));
        impMesh.setColorAt(i, col);
        aImp.setXYZ(i, 0, (IMP_ROWS_ - 1 - ii.row) / IMP_ROWS_, ii.topFrac);

        // árbol cercano
        (perSp[sp] || (perSp[sp] = [])).push({ x, gy, z, H, sxz, yaw, tx, tz, b, c });
        nTrees++;
      });
      farMesh.instanceMatrix.needsUpdate = true;
      farMesh.computeBoundingSphere();
      impMesh.instanceMatrix.needsUpdate = true;
      impMesh.instanceColor.needsUpdate = true;
      aImp.needsUpdate = true;
      impMesh.computeBoundingSphere();
      impMesh.boundingSphere.radius += 0.5;
      entry.far = farMesh; entry.imp = impMesh;
      group.add(impMesh);

      for (const sp of SPECIES) {
        const list = perSp[sp];
        if (!list) continue;
        const mesh = new THREE.InstancedMesh(speciesGeo[sp].geometry, nearMat, list.length);
        list.forEach((a, i) => {
          eul.set(a.tx, a.yaw, a.tz, "YXZ");
          m4.compose(pos.set(a.x, a.gy, a.z), q.setFromEuler(eul), scl.set(a.sxz, a.H, a.sxz));
          mesh.setMatrixAt(i, m4);
          col.setRGB(a.b * (1 + a.c), a.b, a.b * (1 - a.c));
          mesh.setColorAt(i, col);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.boundingSphere.radius += 0.6;               // holgura por el vaivén
        mesh.userData.species = sp;
        entry.near.push(mesh);
        group.add(mesh);
        counts[sp] = (counts[sp] || 0) + list.length;
      }
      const bs = farMesh.boundingSphere;
      entry.cx = bs.center.x; entry.cy = bs.center.y; entry.cz = bs.center.z; entry.r = bs.radius + 6;
      out.push(entry);
    }

    built[scenarioKey] = { cells: out, group, nearMat, farMat, counts, n: nTrees, atlas };
    return { object3d: group, materials: [nearMat, farMat] };
  },

  setOpacity() {},   // el fade lo hace el dither (shaderlib.scenarioFade, escrito por host.setOpacity)
  setGrowth() {},    // el crecimiento lo aplica el host con scale.y del grupo del escenario

  /* LOD por celda: decide qué mallas se dibujan (el fundido fino es por instancia, en el shader) */
  update(frame) {
    setLodFromQuality(frame.quality);
    _fr.setFromProjectionMatrix(frame.viewProj);
    let windNear = false;
    const c = frame.camPosScene, L = lodU.value;
    for (const b of Object.values(built)) {
      if (!b.group.visible) continue;
      let near = 0, far = 0;
      for (const e of b.cells) {
        const ecy = e.cy - lowAt(e.cx, e.cz);   // A6: con relieve parcial el centro de la celda está más abajo que lo horneado
        const d = Math.hypot(c.x - e.cx, c.y - ecy, c.z - e.cz), dmin = d - e.r, dmax = d + e.r;
        const nv = L.y > 0 && dmin < L.y, fv = dmax > L.x && dmin < L.w;
        for (const m of e.near) m.visible = nv;
        e.far.visible = e.imp.visible = fv;
        if (nv) near++; if (fv) far++;
        if (nv && !windNear && dmin < WIND_IDLE_DIST && _fr.intersectsSphere(_sp.set(_sp.center.set(e.cx, ecy, e.cz), e.r))) windNear = true;
      }
      b.nearCells = near; b.farCells = far;
    }
    idleDriver.request("trees", windNear);
  },

  onQuality(q) { setLodFromQuality(q); },

  /* Para A3 (pase de sombras): geometría y materiales de los árboles de un escenario, por celda.
     near[] = InstancedMesh por especie (tarjetas alphaTest con `map` = atlas + tronco; hacen falta un
     customDepthMaterial con el mismo map/alphaTest y DoubleSide); far[] = impostores (opacos).
     Cada celda: { cx, cy, cz, r (esfera), near, far }. No implementa el pase. */
  casters(scenarioKey) {
    const b = built[scenarioKey];
    return b ? { cells: b.cells, nearMat: b.nearMat, farMat: b.farMat, atlas: b.atlas, alphaTest: TREE_ALPHA_TEST } : null;
  },

  dispose() {
    for (const b of Object.values(built)) { b.nearMat.dispose(); b.farMat.dispose(); }
  },

  stats(scenarioKey) {
    const b = built[scenarioKey];
    return b
      ? { trees: b.n, treeSpecies: b.counts, treeChunks: b.cells.length, treeNearCells: b.nearCells ?? null, treeFarCells: b.farCells ?? null }
      : { trees: 0, treeSpecies: {}, treeChunks: 0 };
  }
};
