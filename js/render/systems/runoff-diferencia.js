/* ============ Vista "Diferencia" del simulador de escorrentía (hidro-render, F4) ============
   Dueño: hidro-render. Objetivo visual: MODELO §6 "Diferencia". Diales: HIDRO.vis.diferencia (+ velocidad.haloM / opacidad).

   Dos piezas, ambas independientes del escenario (comparan los dos, así que se ven igual en inicial y en multi):
   1) Mapa de dlog = log2(v_multi / v_inicial): divergente, transparente donde |dlog| < umbral; frena (dlog < 0) de colFrena[0] a
      colFrena[1] saturando en |saturacion|; acelera (dlog > 0) de colAcelera[0] a colAcelera[1] saturando en la misma magnitud.
      Reusa la malla del mapa de velocidad (misma grilla, mismo índice con el halo de 300 m, misma bajada viva a6Low). Lo único nuevo en la
      GPU es una textura R32F de solo lectura (`tDl`, 4 B por celda: ~0,5 MB en el sintético) que es una REFERENCIA al Float32Array `dlog`
      del resultado (sin copia). Filtrado bilineal manual (NEAREST es el único filtro de float garantizado en WebGL2), como la velocidad.
      Se mezcla en sRGB y pasa por la misma salida que Velocidad: en pantalla el color es el de la paleta de la leyenda.
   2) Traza del diseño: contorno PUNTEADO de los polígonos del escenario multi cuyas clases están en traza.clases. Cintas en pantalla
      (anchoPx) expandidas en el vertex shader, un solo draw call. La raya se mide en PÍXELES DE PANTALLA: cada frame que cambia la
      cámara se proyectan en CPU los puntos de cada contorno y se acumula el largo en píxeles (un Float32Array preasignado → atributo);
      así la raya es pareja en la cenital, en el rasante y a través de las esquinas (con la distancia en metros el punteado se aprieta
      con la perspectiva y se corta en cada tramo). Las geometrías NO se simplifican: los tramos se subdividen cada MAX_SEG_M para
      apoyarse en el relieve (la subdivisión es colineal: la línea es exactamente la del GIS). La altura sale de la misma grilla que el mapa
      (sin z-fighting con él), más yExtraM, y el vertex shader aplica a6Low y la subida por distancia como el resto de las capas. */
import * as THREE from "three";
import { HIDRO } from "../../core/config.js?v=20261201";
import { GLSL_DECL, withReliefU } from "../../terrain/terrain.js?v=20261201";
import { GLSL_ADFOG, GLSL_FOG_UNIFORMS } from "../shaderlib.js?v=20261201";

const VIS = HIDRO.vis, DIF = VIS.diferencia, TR = DIF.traza;
const MAX_SEG_M = 10;            // m · tramo máximo de la traza (apoyo en el relieve; menos que una celda de 15 m)
const RAMP = 0.7;                // × umbral · ancho de la rampa de alfa por encima del umbral (sin escalón duro en el borde de la mancha)
const FEATHER = 0.6;             // px · suavizado del borde de la cinta
const LIFT_FROM = (s => /[.e]/.test(s) ? s : s + ".0")(String(+VIS.velocidad.liftDistDesdeM));   // literal float de GLSL

const rgb = hex => { const n = parseInt(hex.slice(1), 16); return new THREE.Vector3((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };   // sRGB 0–1 (se mezcla en sRGB, como la leyenda)

/* ---------- mapa de dlog ---------- */
const VS_MAP =
  "varying vec3 vWp;\nuniform vec3 uCamPos;\nuniform float uLift;\nuniform float uLift0;\n" +
  "void main() {\n  vec4 w = modelMatrix * vec4(position, 1.0);\n  w.y -= a6Low(w.xz);\n  w.y += uLift * max(length(uCamPos - w.xyz) - " + LIFT_FROM + ", 0.0) + uLift0;\n  vWp = w.xyz;\n" +
  "  gl_Position = projectionMatrix * viewMatrix * w;\n}\n";

/* uDif = (umbral, |saturación|, opacidad, ancho de la rampa) · uBorde = celdas de difuminado del borde de la grilla */
const FS_MAP =
  "precision highp float;\n" +
  "varying vec3 vWp;\n" +
  "uniform sampler2D tDl;\nuniform sampler2D tIn;\nuniform vec4 uG;\nuniform vec2 uN;\nuniform vec4 uDif;\nuniform float uBorde;\n" +
  "uniform vec3 uF0;\nuniform vec3 uF1;\nuniform vec3 uA0;\nuniform vec3 uA1;\n" +
  "uniform vec3 uCamPos;\nuniform float uFade;\n" +
  GLSL_FOG_UNIFORMS + GLSL_ADFOG +
  "float dl(ivec2 i) { return texelFetch(tDl, clamp(i, ivec2(0), ivec2(uN) - 1), 0).r; }\n" +
  "vec3 srgb2lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }\n" +
  "void main() {\n" +
  "  float dist = length(uCamPos - vWp);\n" +
  "  vec2 f = vec2(vWp.x * uG.x + uG.y, vWp.z * uG.z + uG.w);\n" +
  "  ivec2 i0 = ivec2(floor(f));\n  vec2 t = f - vec2(i0);\n  t = t * t * (3.0 - 2.0 * t);\n" +
  "  float d = mix(mix(dl(i0), dl(i0 + ivec2(1, 0)), t.x), mix(dl(i0 + ivec2(0, 1)), dl(i0 + ivec2(1, 1)), t.x), t.y);\n" +
  "  float m = abs(d);\n" +
  "  float tt = clamp((m - uDif.x) / max(uDif.y - uDif.x, 1e-4), 0.0, 1.0);\n" +
  "  vec3 col = srgb2lin(d < 0.0 ? mix(uF0, uF1, tt) : mix(uA0, uA1, tt));\n" +
  "  float ins = smoothstep(0.0, 1.0, texture2D(tIn, (f + 0.5) / uN).r);\n" +
  "  vec2 de = min(f, uN - 1.0 - f);\n  float eg = smoothstep(0.0, max(uBorde, 1.0), min(de.x, de.y));\n" +
  "  float a = uDif.z * smoothstep(uDif.x, uDif.x + uDif.w, m) * ins * eg * uFade;\n" +
  "  if (a < 0.003) discard;\n" +
  "  gl_FragColor = vec4(col, a);\n" +
  "  #include <colorspace_fragment>\n" +
  "  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, adFog(dist));\n" +
  "}\n";

function blend(m, off) {   // misma lista opaca con mezcla a medida que el mapa de velocidad (renderOrder −9,5, polygonOffset −2/−4)
  m.side = THREE.DoubleSide; m.depthTest = true; m.depthWrite = false; m.transparent = false;
  m.polygonOffset = true; m.polygonOffsetFactor = off[0]; m.polygonOffsetUnits = off[1];
  m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  return m;
}

/** Material del mapa de dlog. `fade` = { value } compartido (no es el de un escenario: la capa es una sola). */
export function makeDifMaterial(shared, fade) {
  const m = new THREE.ShaderMaterial({
    vertexShader: GLSL_DECL + VS_MAP, fragmentShader: FS_MAP,
    uniforms: { ...shared, ...withReliefU({}), uFade: fade,
      tDl: { value: null }, tIn: { value: null }, uG: { value: new THREE.Vector4(1, 0, 1, 0) }, uN: { value: new THREE.Vector2(1, 1) },
      uDif: { value: new THREE.Vector4(DIF.umbral, Math.abs(DIF.saturacion), DIF.opacidad, DIF.umbral * RAMP) },
      uF0: { value: rgb(DIF.colFrena[0]) }, uF1: { value: rgb(DIF.colFrena[1]) },
      uA0: { value: rgb(DIF.colAcelera[0]) }, uA1: { value: rgb(DIF.colAcelera[1]) },
      uBorde: { value: VIS.velocidad.bordeSuaveCeldas } }
  });
  return blend(m, [-2, -4]);
}

/** Textura R32F de dlog: referencia al Float32Array del resultado (sin copia). */
export function makeDlogTex(dlog, nx, ny) {
  const t = new THREE.DataTexture(dlog, nx, ny, THREE.RedFormat, THREE.FloatType);
  t.internalFormat = "R32F"; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.flipY = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.unpackAlignment = 4; t.needsUpdate = true;
  return t;
}

/* ---------- traza punteada del diseño ---------- */
const VS_TR = GLSL_DECL +
  "attribute vec3 aB;\nattribute vec2 aF;\nattribute float aU;\n" +
  "uniform vec2 uPx;\nuniform float uHalf;\nuniform vec3 uCamPos;\nuniform float uLift;\nuniform float uLift0;\n" +
  "varying vec3 vWp;\nvarying float vSide;\nvarying float vU;\n" +
  "vec4 clipOf(vec3 q, out vec3 wp) {\n  vec4 w = modelMatrix * vec4(q, 1.0);\n  w.y -= a6Low(w.xz);\n  w.y += uLift * max(length(uCamPos - w.xyz) - " + LIFT_FROM + ", 0.0) + uLift0;\n  wp = w.xyz;\n  return projectionMatrix * viewMatrix * w;\n}\n" +
  "void main() {\n" +
  "  vec3 wa, wb;\n  vec4 CA = clipOf(position, wa), CB = clipOf(aB, wb);\n" +
  "  float e = aF.x, side = aF.y;\n  vec4 C = e < 0.5 ? CA : CB;\n  vWp = e < 0.5 ? wa : wb;\n" +
  "  if (CA.w < 0.01 || CB.w < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vSide = 0.0; vU = 0.0; return; }\n" +
  "  vec2 d = (CB.xy / CB.w - CA.xy / CA.w) / uPx;\n  float len = length(d);\n" +
  "  vec2 t = len > 1e-4 ? d / len : vec2(1.0, 0.0);\n  vec2 n = vec2(-t.y, t.x);\n" +
  // la cinta se alarga medio ancho por cada punta: las esquinas del polígono no quedan con hueco
  "  gl_Position = C;\n  gl_Position.xy += (n * side * uHalf + t * (e * 2.0 - 1.0) * uHalf) * uPx * C.w;\n" +
  "  vSide = side;\n  vU = aU;\n}\n";

/* uDash = (raya px, período px, alfa, mitad del núcleo px) · uCol = color lineal */
const FS_TR =
  "precision highp float;\n" +
  "varying vec3 vWp;\nvarying float vSide;\nvarying float vU;\n" +
  "uniform vec3 uCamPos;\nuniform float uFade;\nuniform float uHalf;\nuniform vec4 uDash;\nuniform vec3 uCol;\n" +
  GLSL_FOG_UNIFORMS + GLSL_ADFOG +
  "void main() {\n" +
  "  float cw = clamp(uDash.w + 0.5 - abs(vSide) * uHalf, 0.0, 1.0);\n" +
  "  float m = mod(vU, uDash.y);\n" +
  "  float cd = clamp(m + 0.5, 0.0, 1.0) * clamp(uDash.x - m + 0.5, 0.0, 1.0);\n" +
  "  float a = cw * cd * uDash.z * uFade;\n" +
  "  if (a < 0.004) discard;\n" +
  "  gl_FragColor = vec4(uCol, a);\n" +
  "  #include <colorspace_fragment>\n" +
  "  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, adFog(length(uCamPos - vWp)));\n" +
  "}\n";

/** La traza: una geometría y un material para toda la app; `makeMesh()` da una malla por escenario (solo se dibuja una). */
export function createTraza(shared, fade, getCanvas) {
  const geom = new THREE.BufferGeometry();
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  geom.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VS_TR, fragmentShader: FS_TR,
    uniforms: { ...shared, ...withReliefU({}), uFade: fade, uPx: { value: new THREE.Vector2(0.002, 0.002) }, uHalf: { value: 1 },
      uDash: { value: new THREE.Vector4(8, 14, TR.alfa, 1) }, uCol: { value: new THREE.Color(TR.color) } }
  });
  blend(mat, [-3, -6]);   // sobre el mapa de dlog (−2, −4), como las estelas sobre el mapa de velocidad
  let n = 0, nSeg = 0, px = null, py = null, cum = null, ringOf = null, aU = null, aUAttr = null, lastVP = null, vpW = 0, vpH = 0, rat = 1, bytes = 0;
  let nRings = 0, ringStart = null, builtFor = null, polys = 0;

  const api = {
    mat, geom,
    makeMesh(name) {
      const m = new THREE.Mesh(geom, mat);
      m.frustumCulled = false; m.renderOrder = -9.4; m.name = name; m.visible = false;
      return m;
    },
    /** ¿Ya está armada para esta grilla y estos datos? */
    isBuilt(G, data) { return builtFor && builtFor.G === G && builtFor.data === data; },
    /** Arma los contornos (una vez por grilla/datos). `data` = FeatureCollection del escenario multi; `ctx` para toScene. */
    build(ctx, G, data) {
      api.release();
      if (!data || !G) return;
      const ok = new Set(TR.clases), ax = G.aff.x, bx = G.aff.y, az = G.aff.z, bz = G.aff.w, nx = G.nx, ny = G.ny, pos = G.pos.array;
      const yAt = (x, z) => {   // misma superficie que el mapa (grilla bilineal) + margen
        let fx = x * ax + bx, fz = z * az + bz;
        if (fx < 0) fx = 0; else if (fx > nx - 1) fx = nx - 1;
        if (fz < 0) fz = 0; else if (fz > ny - 1) fz = ny - 1;
        let i = fx | 0, j = fz | 0; if (i > nx - 2) i = nx - 2; if (j > ny - 2) j = ny - 2;
        const tx = fx - i, tz = fz - j, q = (j * nx + i) * 3 + 1, r = q + nx * 3;
        return (pos[q] * (1 - tx) + pos[q + 3] * tx) * (1 - tz) + (pos[r] * (1 - tx) + pos[r + 3] * tx) * tz + HIDRO.vis.particulas.yExtraM;
      };
      const X = [], Z = [], starts = [];   // puntos de todos los anillos (subdivididos), y dónde empieza cada uno
      polys = 0;
      for (const f of data.features) {
        const g = f.geometry; if (!g || !ok.has(f.properties && f.properties._cls)) continue;
        polys++;
        const rings = g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
        for (const ring of rings) {
          if (ring.length < 2) continue;
          starts.push(X.length);
          let [x0, z0] = ctx.toScene(ring[0][0], ring[0][1]);
          X.push(x0); Z.push(z0);
          for (let k = 1; k < ring.length; k++) {
            const [x1, z1] = ctx.toScene(ring[k][0], ring[k][1]);
            const ns = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / MAX_SEG_M));
            for (let q = 1; q <= ns; q++) { X.push(x0 + (x1 - x0) * q / ns); Z.push(z0 + (z1 - z0) * q / ns); }
            x0 = x1; z0 = z1;
          }
        }
      }
      starts.push(X.length);
      n = X.length; nRings = starts.length - 1; ringStart = Int32Array.from(starts);
      if (!n) { builtFor = { G, data }; return; }
      px = new Float32Array(n); py = new Float32Array(n); cum = new Float32Array(n);
      const pa = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pa[3 * i] = X[i]; pa[3 * i + 1] = yAt(X[i], Z[i]); pa[3 * i + 2] = Z[i]; }
      // un segmento = un cuadrado de 4 vértices (extremo A/B × lado ∓1)
      nSeg = 0; for (let r = 0; r < nRings; r++) nSeg += Math.max(0, ringStart[r + 1] - ringStart[r] - 1);
      const P = new Float32Array(nSeg * 12), B = new Float32Array(nSeg * 12), F = new Float32Array(nSeg * 8), IX = new Uint32Array(nSeg * 6);
      ringOf = new Int32Array(nSeg * 2);   // por segmento: índices globales de sus dos puntos
      let s = 0;
      for (let r = 0; r < nRings; r++) for (let i = ringStart[r]; i < ringStart[r + 1] - 1; i++, s++) {
        ringOf[2 * s] = i; ringOf[2 * s + 1] = i + 1;
        for (let v = 0; v < 4; v++) {
          const e = v >> 1, side = (v & 1) * 2 - 1, o = (s * 4 + v) * 3;
          P[o] = pa[3 * i]; P[o + 1] = pa[3 * i + 1]; P[o + 2] = pa[3 * i + 2];
          B[o] = pa[3 * i + 3]; B[o + 1] = pa[3 * i + 4]; B[o + 2] = pa[3 * i + 5];
          F[(s * 4 + v) * 2] = e; F[(s * 4 + v) * 2 + 1] = side;
        }
        const b = s * 4; IX.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], s * 6);
      }
      aU = new Float32Array(nSeg * 4);
      aUAttr = new THREE.BufferAttribute(aU, 1); aUAttr.setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute("position", new THREE.BufferAttribute(P, 3)); geom.setAttribute("aB", new THREE.BufferAttribute(B, 3));
      geom.setAttribute("aF", new THREE.BufferAttribute(F, 2)); geom.setAttribute("aU", aUAttr);
      geom.setIndex(new THREE.BufferAttribute(IX, 1)); geom.setDrawRange(0, nSeg * 6);
      bytes = P.byteLength + B.byteLength + F.byteLength + IX.byteLength + aU.byteLength + px.byteLength * 3 + ringOf.byteLength;
      lastVP = null;   // fuerza el primer cálculo de píxeles
      builtFor = { G, data };
      api._pa = pa;
    },
    /** Tamaño de píxel y ancho de cinta (como las estelas); cada frame visible. */
    setViewport() {
      const cv = getCanvas(); if (!cv) return;
      const w = cv.width || 1, h = cv.height || 1, r = w / Math.max(1, cv.clientWidth || w);
      if (w !== vpW || h !== vpH || r !== rat) { vpW = w; vpH = h; rat = r; lastVP = null; }
      mat.uniforms.uPx.value.set(2 / w, 2 / h);
      const core = TR.anchoPx * rat * 0.5;
      mat.uniforms.uDash.value.set(TR.rayaPx * rat, (TR.rayaPx + TR.huecoPx) * rat, TR.alfa, core);
      mat.uniforms.uHalf.value = core + 0.5 + FEATHER;
    },
    /** Largo acumulado en píxeles de pantalla sobre cada contorno (solo si cambió la cámara o el lienzo). */
    updatePx(viewProj) {
      if (!nSeg) return;
      const e = viewProj.elements;
      if (lastVP) { let same = true; for (let k = 0; k < 16; k++) if (lastVP[k] !== e[k]) { same = false; break; } if (same) return; }
      else lastVP = new Float32Array(16);
      for (let k = 0; k < 16; k++) lastVP[k] = e[k];
      const pa = api._pa, hw = vpW * 0.5, hh = vpH * 0.5;
      for (let i = 0; i < n; i++) {   // proyección (sin a6Low ni subida por distancia: no cambian el largo en pantalla de forma apreciable)
        const x = pa[3 * i], y = pa[3 * i + 1], z = pa[3 * i + 2];
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w < 0.01) { px[i] = NaN; continue; }
        px[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w * hw; py[i] = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * hh;
      }
      for (let r = 0; r < nRings; r++) {
        let c = 0;
        for (let i = ringStart[r]; i < ringStart[r + 1]; i++) {
          cum[i] = c;
          if (i + 1 < ringStart[r + 1]) { const l = Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]); if (l === l) c += l; }
        }
      }
      for (let s = 0; s < nSeg; s++) {
        const a = cum[ringOf[2 * s]], b = cum[ringOf[2 * s + 1]], o = s * 4;
        aU[o] = a; aU[o + 1] = a; aU[o + 2] = b; aU[o + 3] = b;
      }
      aUAttr.needsUpdate = true;
    },
    get tris() { return nSeg * 2; },
    get polys() { return polys; },
    get points() { return n; },
    get mb() { return bytes / 1048576; },
    release() {
      builtFor = null; n = nSeg = nRings = 0; px = py = cum = ringOf = aU = aUAttr = ringStart = null; bytes = 0; api._pa = null; lastVP = null;
      for (const k of ["position", "aB", "aF", "aU"]) geom.deleteAttribute(k);
      geom.setIndex(null); geom.setDrawRange(0, 0); geom.dispose();
    },
    dispose() { api.release(); mat.dispose(); }
  };
  return api;
}
