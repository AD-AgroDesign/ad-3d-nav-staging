/* ============ Mapa de velocidad del simulador de escorrentía (hidro-render, F3) ============
   Dueño: hidro-render. Objetivo visual: MODELO §6 "Velocidad": campo continuo con paleta turbo sobre log10(v) entre
   HIDRO.vis.vMinMs y vMaxMs, opacidad HIDRO.vis.velocidad.opacidad, borde suave. Cauces en naranja-rojo, laderas verde-azul,
   corredores azules.

   Reusa de F2 la malla (misma grilla de vértices, misma bajada viva a6Low) y la textura de datos `tD` del escenario
   (r = h, g = v, b/a = dirección). Lo único propio es el índice (cubre TODA la grilla, no solo los cuadros con agua; lo arma
   runoff.js una vez y lo comparten los dos escenarios) y este shader. La v se interpola en log10 (el color es lineal en log v)
   con el mismo bilineal manual de la vista natural (NEAREST es el único filtro de float que WebGL2 garantiza).
   Fuera del campo se atenúa con HIDRO.vis.natural.outside (mismo criterio que el agua natural, para que las dos vistas se lean igual);
   el borde del campo se difumina con un promedio 3×3 de `tIn` separado `bordeSuaveCeldas` celdas, y el borde de la grilla
   con una rampa de la misma anchura. La salida pasa por la conversión sRGB → lineal → colorspace_fragment del renderer: en
   pantalla el color es exactamente turboCss(t) (la leyenda de la UI). Sin tone mapping (es un mapa de datos, no una superficie iluminada). */
import * as THREE from "three";
import { HIDRO } from "../../core/config.js?v=20261201";
import { GLSL_DECL, withReliefU } from "../../terrain/terrain.js?v=20261201";
import { GLSL_ADFOG, GLSL_FOG_UNIFORMS, scenarioFade } from "../shaderlib.js?v=20261201";
import { simFade } from "./runoff-fade.js?v=20261201";
import { GLSL_TURBO } from "./runoff-turbo.js?v=20261201";

const VEL = HIDRO.vis.velocidad;
const LIFT_FROM = (s => /[.e]/.test(s) ? s : s + ".0")(String(+VEL.liftDistDesdeM));   // literal float de GLSL

const VS =
  "varying vec3 vWp;\n" +
  "uniform vec3 uCamPos;\nuniform float uLift;\nuniform float uLift0;\n" +
  "void main() {\n  vec4 w = modelMatrix * vec4(position, 1.0);\n  w.y -= a6Low(w.xz);\n  w.y += uLift * max(length(uCamPos - w.xyz) - " + LIFT_FROM + ", 0.0) + uLift0;\n  vWp = w.xyz;\n" +
  "  gl_Position = projectionMatrix * viewMatrix * w;\n}\n";

/* uG = afín escena→celda · uN = tamaño de la grilla · uVel = (log10 vMin, 1/rango log10, opacidad, alfa fuera) · uBorde = celdas */
const FS =
  "precision highp float;\n" +
  "varying vec3 vWp;\n" +
  "uniform sampler2D tD;\nuniform sampler2D tIn;\nuniform vec4 uG;\nuniform vec2 uN;\nuniform vec4 uVel;\nuniform float uBorde;\n" +
  "uniform vec3 uCamPos;\nuniform float uFade;\n" +
  GLSL_FOG_UNIFORMS + GLSL_ADFOG + GLSL_TURBO +
  "float lv(ivec2 i) { return log(max(texelFetch(tD, clamp(i, ivec2(0), ivec2(uN) - 1), 0).g, 1e-4)) * 0.43429448; }\n" +
  "vec3 srgb2lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }\n" +
  "void main() {\n" +
  "  float dist = length(uCamPos - vWp);\n" +
  "  vec2 f = vec2(vWp.x * uG.x + uG.y, vWp.z * uG.z + uG.w);\n" +
  "  ivec2 i0 = ivec2(floor(f));\n  vec2 t = f - vec2(i0);\n  t = t * t * (3.0 - 2.0 * t);\n" +
  "  float l = mix(mix(lv(i0), lv(i0 + ivec2(1, 0)), t.x), mix(lv(i0 + ivec2(0, 1)), lv(i0 + ivec2(1, 1)), t.x), t.y);\n" +
  "  vec3 col = srgb2lin(turbo((l - uVel.x) * uVel.y));\n" +
  // halo del campo (R8 lineal: 1 dentro, 0 a ~300 m del borde) y rampa en el borde de la grilla
  "  float ins = smoothstep(0.0, 1.0, texture2D(tIn, (f + 0.5) / uN).r);\n" +
  "  vec2 de = min(f, uN - 1.0 - f);\n  float eg = smoothstep(0.0, max(uBorde, 1.0), min(de.x, de.y));\n" +
  "  float a = uVel.z * ins * eg * uFade;\n" +
  "  if (a < 0.003) discard;\n" +
  "  gl_FragColor = vec4(col, a);\n" +
  "  #include <colorspace_fragment>\n" +
  "  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, adFog(dist));\n" +
  "}\n";

export function makeVelocityMaterial(key, shared) {
  const vMin = Math.log10(HIDRO.vis.vMinMs), vMax = Math.log10(HIDRO.vis.vMaxMs);
  const m = new THREE.ShaderMaterial({
    vertexShader: GLSL_DECL + VS, fragmentShader: FS,
    uniforms: { ...shared, ...withReliefU({}), uFade: simFade[key] || { value: 1 },
      tD: { value: null }, tIn: { value: null }, uG: { value: new THREE.Vector4(1, 0, 1, 0) }, uN: { value: new THREE.Vector2(1, 1) },
      uVel: { value: new THREE.Vector4(vMin, 1 / (vMax - vMin), VEL.opacidad, HIDRO.vis.natural.outside) },
      uBorde: { value: VEL.bordeSuaveCeldas } }
  });
  // misma lista opaca y mezcla a medida que la lámina natural (ver runoff.js: renderOrder −9,5, polygonOffset −2/−4)
  m.side = THREE.DoubleSide; m.depthTest = true; m.depthWrite = false; m.transparent = false;
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4;
  m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  return m;
}
