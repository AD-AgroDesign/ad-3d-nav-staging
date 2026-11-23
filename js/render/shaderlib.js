/* ============ Biblioteca de shaders compartida ============
   Dueño desde la Ola 1: A1 (niebla, hemisferio, AO, fade dither, ruido). Los chunks GLSL
   se agregan acá y se activan con una opción de `opts` en patch(). Un material que ya usaba
   onBeforeCompile se compone SIEMPRE dentro de patch() (no pisarlo desde afuera).

   patch(material, opts):
     opts.wind   vaivén del pasto en el vertex shader (uTime compartido)
     opts.fog    niebla por distancia real a la cámara (uCamPos, T1; curva adFog) con los
                 uniforms globales uFogColor/uFogNear/uFogFar/uFogMax de lighting.js
     opts.fade   fade dither (screen-door): descarta fragmentos por umbral Bayer 4x4 contra uFade,
                 así el material queda OPACO (transparent:false, depthWrite:true).
                   fade: "inicial" | "multi" → usa el uniforme COMPARTIDO del escenario
                                               (lo escribe host.setOpacity: nadie más lo toca)
                   fade: true               → uniforme propio del material (setFade(mat, v))
   El material debe ser MeshBasic/Lambert/Phong/Standard (necesitan <fog_fragment>). */
import * as THREE from "three";
import { A1_FOLIAGE, A6_NIEBLA, A6_TERRAIN } from "../core/config.js?v=20261201";
import { uniforms } from "./lighting.js?v=20261201";

/* ---------- GLSL ---------- */

/* Curva de niebla compartida con la capa atmo-fog del suelo (render/atmo.js): ambas deben
   dar el mismo valor para la misma distancia o el horizonte se parte en dos. */
export const GLSL_FOG_UNIFORMS = "uniform vec3 uFogColor;\nuniform float uFogNear;\nuniform float uFogFar;\nuniform float uFogMax;\nuniform vec4 uFogRel;\n";
export const GLSL_ADFOG =
  "float adFogFlat(float d) {\n" +
  "  float x = clamp((d - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);\n" +
  "  return pow(x * x * (3.0 - 2.0 * x), " + A6_NIEBLA.curvePow.toFixed(3) + ") * uFogMax;\n" +
  "}\n" +
  /* A6 (G4-fix): con relieve la niebla de MapLibre sobre la malla es otra curva (por profundidad de vista z, no por distancia, y no llega al
     100 % hasta el plano lejano). uFogRel = (near px, far px, opacidad por pitch, peso k): el valor final es la mezcla lineal de la curva plana
     y la de relieve con peso k (0 = plana, 1 = relieve), así la niebla acompaña de forma continua la transición animada del relieve. */
  "float adFog(float d) {\n" +
  "  float ff = adFogFlat(d);\n" +
  "  if (uFogRel.w <= 0.0) return ff;\n" +
  "  float dp = uFogRel.y * (1.0 - uFogRel.x / max(1.0 / gl_FragCoord.w, 1.0)) / max(uFogRel.y - uFogRel.x, 1.0);\n" +
  "  float k = clamp(max(dp - " + A6_TERRAIN.sky.fogGroundBlend.toFixed(3) + ", 0.0) / " + (1 - A6_TERRAIN.sky.fogGroundBlend).toFixed(3) + ", 0.0, 1.0);\n" +
  "  return mix(ff, k * k * uFogRel.z, uFogRel.w);\n" +
  "}\n" +
  /* Parámetro de mezcla para mix(color, uFogColor, adFogT(color, t)): sin relieve es t (la mezcla de siempre, en espacio de salida);
     con relieve MapLibre mezcla en lineal (gamma 2,2), así que se corrige t (con peso k) para que la luminancia resultante sea la de esa mezcla. */
  "float adFogT(vec3 c, float t) {\n" +
  "  if (uFogRel.w <= 0.0) return t;\n" +
  "  float lc = dot(c, vec3(0.2126, 0.7152, 0.0722)), lf = dot(uFogColor, vec3(0.2126, 0.7152, 0.0722));\n" +
  "  float tl = pow(mix(pow(lc, 2.2), pow(lf, 2.2), t), 1.0 / 2.2);\n" +
  "  float tc = abs(lf - lc) < 0.02 ? t : clamp((tl - lc) / (lf - lc), 0.0, 1.0);\n" +
  "  return mix(t, tc, uFogRel.w);\n" +
  "}\n";

/* Umbral Bayer 4x4 en [0,1) por píxel de pantalla (ordenado: sin parpadeo entre frames). */
const GLSL_FADE =
  "uniform float uFade;\n" +
  "float adBayer4(vec2 p) {\n" +
  "  ivec2 q = ivec2(mod(p, 4.0));\n" +
  "  int i = q.x + q.y * 4;\n" +
  "  // matriz Bayer 4x4 (valores 0..15)\n" +
  "  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);\n" +
  "  return (float(m[i]) + 0.5) / 16.0;\n" +
  "}\n";

/* ---------- fade dither: uniformes por escenario y por material ---------- */

/* Un uniforme compartido por escenario: host.setOpacity(key, o) lo escribe una sola vez y
   todos los materiales parchados con fade:"<key>" lo ven. */
export const scenarioFade = { inicial: { value: 1 }, multi: { value: 1 } };

/* Fija el fade (0..1) de un material parchado con fade:true (uniforme propio). */
export function setFade(material, v) {
  const u = material.userData && material.userData.uFade;
  if (u) u.value = v;
}

/* Aplica los chunks pedidos a un shader de Three (vertex + fragment). */
function applyChunks(sh, o) {
  let vs = sh.vertexShader, fs = sh.fragmentShader;

  if (o.wind) {
    // Viento: vaivén en shader según la fase por posición de instancia.
    // Solo anima cuando el mapa repinta (tour, órbita, navegación).
    sh.uniforms.uTime = uniforms.uTime;
    vs = vs
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\n" +
        "float ph = dot(instanceMatrix[3].xz, vec2(37.0, 73.0));\n" +
        "transformed.x += sin(uTime * 1.8 + ph) * 0.12 * position.y;\n" +
        "transformed.z += cos(uTime * 1.3 + ph * 1.7) * 0.08 * position.y;");
  }

  if (o.fog) {
    // Posición de mundo (metros de escena) del vértice: ya con instancia y con el viento aplicado.
    sh.uniforms.uCamPos = uniforms.uCamPos;
    sh.uniforms.uFogColor = uniforms.uFogColor;
    sh.uniforms.uFogNear = uniforms.uFogNear;
    sh.uniforms.uFogFar = uniforms.uFogFar;
    sh.uniforms.uFogMax = uniforms.uFogMax;
    sh.uniforms.uFogRel = uniforms.uFogRel;
    vs = vs
      .replace("#include <common>", "#include <common>\nvarying vec3 vAdWPos;")
      .replace("#include <project_vertex>",
        "#include <project_vertex>\n" +
        "#ifdef USE_INSTANCING\n" +
        "  vAdWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n" +
        "#else\n" +
        "  vAdWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n" +
        "#endif");
    // Reemplaza <fog_fragment> (va después del tone mapping y de la conversión de color de
    // salida): la niebla se mezcla en el espacio de salida, igual que el horizon-color del sky.
    fs = fs
      .replace("#include <common>", "#include <common>\nvarying vec3 vAdWPos;\nuniform vec3 uCamPos;\n" + GLSL_FOG_UNIFORMS + GLSL_ADFOG)
      .replace("#include <fog_fragment>",
        "gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, adFogT(gl_FragColor.rgb, adFog(distance(vAdWPos, uCamPos))));");   // el prefijo mix(gl_FragColor.rgb, uFogColor lo busca shadows.js (patchGrassReceive)
  }

  if (o.srgbVC) {
    // El color de vértice del pasto (base/mid/tip) es un MULTIPLICADOR pensado en espacio de pantalla
    // (valores > 1 incluidos). Con iluminación lineal se eleva a 2,2 para que el producto con el
    // color de instancia dé el mismo tono diseñado: lin(a)·m^2.2 = lin(a·m).
    vs = vs.replace("#include <color_vertex>", THREE.ShaderChunk.color_vertex.replace("vColor *= color;", "vColor.rgb *= pow(color.rgb, vec3(2.2));"));
  }

  if (o.foliage) {
    // Follaje: wrap lighting (el sol "dobla" alrededor del volumen) + translucidez barata (luz que
    // atraviesa la hoja desde atrás, sin depender de la cámara). Solo MeshPhong (lights_phong_pars).
    const W = A1_FOLIAGE.wrap.toFixed(3), T = A1_FOLIAGE.trans.toFixed(3);
    /* 2026-11-20 (Mike: copas grises con relieve en Monte Hermoso). Especular negra = SIN especular. Three r170 calcula el brillo con
       F_Schlick(specular, 1.0, dotVH): con specular 0x000000 igual queda el Fresnel (1-dotVH)^5, blanco. Y geometryViewDir sale de
       vViewPosition, que en la capa custom de MapLibre NO es relativo a la cámara (la vista está metida en la proyección: viewMatrix =
       identidad), así que es la posición del árbol en la escena. Con relieve los árboles suben a su cota del DEM (cientos de m), ese
       "viewDir" apunta casi contra el sol, el Fresnel llega a ~1 y el brillo blanco supera a la difusa de las copas oscuras. */
    const SPEC = "\treflectedLight.directSpecular += irradiance * BRDF_BlinnPhong(";
    const phong = THREE.ShaderChunk.lights_phong_pars_fragment;
    if (!phong.includes(SPEC)) console.warn("shaderlib foliage: no encontré la especular de Phong (¿cambió Three?)");
    fs = fs.replace("#include <lights_phong_pars_fragment>", phong.replace(
      "float dotNL = saturate( dot( geometryNormal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;",
      "float rawNL = dot( geometryNormal, directLight.direction );\n" +
      "\tfloat dotNL = saturate( ( rawNL + " + W + " ) / ( 1.0 + " + W + " ) );\n" +
      "\tvec3 irradiance = ( dotNL + saturate( -rawNL ) * " + T + " ) * directLight.color;").replace(
      SPEC, "\tif ( max( max( material.specularColor.r, material.specularColor.g ), material.specularColor.b ) > 0.0 ) reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong("));
  }

  if (o.floor) {
    // Copas oscuras (ajuste G1): AgX hunde a casi negro los verdes mas oscuros de la paleta.
    //  - lumMin: piso de luminancia del ALBEDO (lineal). Escala el color completo (tono y saturacion intactos) solo si el
    //    albedo es mas oscuro que lumMin; las copas de tono medio/claro no cambian.
    //  - shadow: levantado de la cara sin sol (suma albedo·shadow donde la luz saliente < 0,5·albedo; se apaga hacia la cara
    //    iluminada, asi las facetas conservan el volumen).
    const L = o.floor.lumMin.toFixed(4), S = o.floor.shadow.toFixed(3);
    fs = fs.replace("#include <color_fragment>",
      "#include <color_fragment>\n" +
      "{ float adLa = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)); diffuseColor.rgb *= max(1.0, " + L + " / max(adLa, 1e-4)); }");
    if (o.floor.shadow > 0) fs = fs.replace("#include <opaque_fragment>",
      "{ float adLo = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)), adLa = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n" +
      "  outgoingLight += diffuseColor.rgb * " + S + " * (1.0 - smoothstep(0.0, max(0.5 * adLa, 1e-4), adLo)); }\n" +
      "#include <opaque_fragment>");
  }

  if (o.fadeU) {
    sh.uniforms.uFade = o.fadeU;
    // Va lo primero en main(): descarta antes de gastar en iluminación. uFade>=1 → nada se descarta.
    fs = fs
      .replace("#include <common>", "#include <common>\n" + GLSL_FADE)
      .replace("void main() {", "void main() {\n  if (uFade < 1.0 && uFade <= adBayer4(gl_FragCoord.xy)) discard;");
  }

  sh.vertexShader = vs;
  sh.fragmentShader = fs;
}

function resolveOpts(material, opts) {
  const fadeU = !opts.fade ? null
    : typeof opts.fade === "string" ? (scenarioFade[opts.fade] || (scenarioFade[opts.fade] = { value: 1 }))
    : (material.userData.uFade || (material.userData.uFade = { value: 1 }));
  // piso de sombra solo en copas: follaje sin color de vértice (el pasto lleva vertexColors) y sin opt-out
  const floor = opts.foliage && !material.vertexColors && (A1_FOLIAGE.lumMin > 0 || A1_FOLIAGE.shadow > 0) && opts.foliageFloor !== false && material.userData.foliageFloor !== false ? { lumMin: A1_FOLIAGE.lumMin || 0, shadow: A1_FOLIAGE.shadow || 0 } : null;
  return { wind: !!opts.wind, fog: !!opts.fog, foliage: !!opts.foliage, srgbVC: !!opts.srgbVC, floor, fadeU };
}

/* Three cachea el programa por onBeforeCompile.toString() (igual para todos los patch):
   la clave tiene que distinguir las combinaciones de chunks. */
const keyOf = (o, prev) => (prev ? prev + "+" : "") + "ad:" + (o.wind ? "w" : "") + (o.fog ? "f" : "") + (o.foliage ? "l" : "") + (o.srgbVC ? "c" : "") + (o.floor ? "k" + o.floor.lumMin + "_" + o.floor.shadow : "") + (o.fadeU ? "d" : "");

/* Alfa del framebuffer intacto en materiales OPACOS con recorte por alfa (copas/impostores: alphaTest o alphaToCoverage).
   Con alphaToCoverage el fragmento sale con el alfa de la textura (0..1) y, sin mezcla, ese valor se ESCRIBE en el canal alfa del
   canvas (premultiplicado): los bordes de las copas lejanas quedaban semitransparentes y dejaban ver el fondo claro de la página
   → puntitos pálidos sobre la bruma del horizonte (G2b). Mezcla personalizada: color = src (opaco), alfa = dst (el que dejó MapLibre).
   No cambia el color ni la cobertura MSAA; transparent:false y depthWrite:true quedan como están. */
function keepFramebufferAlpha(material) {
  if (material.transparent || !(material.alphaToCoverage || material.alphaTest > 0) || material.userData.adKeepAlpha) return;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation; material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor; material.blendDst = THREE.ZeroFactor;
  material.blendSrcAlpha = THREE.ZeroFactor; material.blendDstAlpha = THREE.OneFactor;
  material.userData.adKeepAlpha = true;
}

export function patch(material, opts = {}) {
  keepFramebufferAlpha(material);
  const o = resolveOpts(material, opts);
  material.onBeforeCompile = sh => applyChunks(sh, o);
  const key = keyOf(o);
  material.customProgramCacheKey = () => key;
  material.userData.adChunks = { wind: o.wind, fog: o.fog, foliage: o.foliage, srgbVC: o.srgbVC, fade: !!o.fadeU };
  return material;
}

/* patchExtra(material, opts): igual que patch() pero COMPONE con el onBeforeCompile que el
   material ya tenga (p. ej. el viento que puso un sistema) en vez de reemplazarlo. Es
   idempotente por chunk: si el material ya tiene `fog` (o `fade`) parchado, no lo repite.
   Lo usa el host para dar niebla a los materiales de TODOS los sistemas sin que cada uno
   tenga que acordarse; un sistema que llame patch(mat, { fog: true }) en su build queda igual. */
export function patchExtra(material, opts = {}) {
  keepFramebufferAlpha(material);
  const had = material.userData.adChunks || {};
  const want = { ...opts };
  if (had.fog) want.fog = false;
  if (had.fade) want.fade = false;
  if (had.foliage) want.foliage = false;
  if (had.srgbVC) want.srgbVC = false;
  const o = resolveOpts(material, want);
  if (!o.fog && !o.fadeU && !o.foliage && !o.srgbVC) return material;
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
  const prevStr = material.userData.adChunks && prevKey ? prevKey.call(material) : "";   // sin patch previo: clave limpia
  material.onBeforeCompile = function (sh, renderer) { if (prev) prev.call(this, sh, renderer); applyChunks(sh, { fog: o.fog, foliage: o.foliage, srgbVC: o.srgbVC, floor: o.floor, fadeU: o.fadeU }); };
  const key = keyOf(o, prevStr);
  material.customProgramCacheKey = () => key;
  material.userData.adChunks = { wind: !!had.wind, fog: !!(had.fog || o.fog), foliage: !!(had.foliage || o.foliage), srgbVC: !!(had.srgbVC || o.srgbVC), fade: !!(had.fade || o.fadeU) };
  return material;
}
