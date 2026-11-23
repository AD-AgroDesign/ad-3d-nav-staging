/* ============ atmo-fog: perspectiva atmosférica sobre el suelo de MapLibre ============
   MapLibre 4.7.1 sin terreno NO aplica niebla al ráster ni a las capas fill/extrusión (spike
   A1): el suelo corta seco contra el degradado del `sky`. Esta capa custom 2D es un quad a
   pantalla completa que, por píxel, calcula la distancia REAL a la cámara sobre el plano del
   suelo y aplica la misma curva adFog() que la niebla de los objetos Three (shaderlib `fog`),
   con los mismos uniforms (lighting.js). Va ENTRE el suelo y la vegetación (host.registerBeforeLayer).

   Por encima de la línea del sky de MapLibre no pinta (descarta): ahí manda el `sky`. La línea
   está al 0,85 del horizonte geométrico, así que se descarta por ella y no por dir.z, y se deja
   un solape de ~3 px para evitar una rendija oscura (el canvas es transparente donde nadie pinta).
   Un draw call, 4 vértices. Calidad Baja: no dibuja (lighting.fog.enabled). */
import { A1_FOG } from "../core/config.js?v=20261201";
import { updateCamera } from "../core/camera.js?v=20261201";
import { atm, fog, uniforms, updateFog } from "./lighting.js?v=20261201";
import { GLSL_ADFOG, GLSL_FOG_UNIFORMS } from "./shaderlib.js?v=20261201";
import { host } from "./host.js?v=20261201";
import { terrain } from "../terrain/terrain.js?v=20261201";   // A6: con terreno la niebla la aplica MapLibre sobre la malla

const VS = "attribute vec2 a;\nvarying vec2 vN;\nvoid main() { vN = a; gl_Position = vec4(a, 0.0, 1.0); }\n";
const FS = "precision highp float;\nvarying vec2 vN;\n" +
  "uniform vec3 uD0, uDx, uDy;\nuniform float uCamH;\nuniform float uHorNdc;\nuniform vec3 uTint;\nuniform float uTintMode;\n" +
  GLSL_FOG_UNIFORMS + GLSL_ADFOG +
  `void main() {
  vec3 dir = uD0 + vN.x * uDx + vN.y * uDy;                  // rayo en metros (este, norte, arriba)
  if (vN.y > uHorNdc || dir.z >= -1e-4 * length(dir)) discard;   // sobre la línea del sky (+ solape)
  if (uTintMode > 0.5) { gl_FragColor = vec4(uTint, 1.0); return; }   // pasada de color (modo de hora): multiplica lo que hay debajo
  float d = (-uCamH / dir.z) * length(dir);                  // distancia real al suelo (plano z=0)
  float f = adFog(d);
  gl_FragColor = vec4(uFogColor * f, f);                     // alfa premultiplicado
}
`;

const _q = new URLSearchParams(location.search);
const NOTINT = (_q.has("qa") || _q.has("debug")) && _q.has("notint");   // solo diagnóstico: mide el costo de la pasada de color

export const atmo = {
  id: "atmo-fog",
  type: "custom",
  renderingMode: "2d",

  onAdd(map, gl) {
    this.map = map;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error("atmo-fog:", gl.getShaderInfoLog(s));
      return s;
    };
    const prog = this.prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error("atmo-fog:", gl.getProgramInfoLog(prog));
    this.loc = gl.getAttribLocation(prog, "a");
    this.u = {};
    for (const n of ["uD0", "uDx", "uDy", "uCamH", "uHorNdc", "uFogColor", "uFogNear", "uFogFar", "uFogMax", "uTint", "uTintMode"])
      this.u[n] = gl.getUniformLocation(prog, n);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    // VAO propio si hay WebGL2: no depende ni pisa los atributos que dejó MapLibre
    if (gl.createVertexArray) {
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.enableVertexAttribArray(this.loc);
      gl.vertexAttribPointer(this.loc, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
  },

  render(gl, matrix) {
    if (!host.origin) return;                  // el host todavía no hizo onAdd (primer frame)
    const T = atm.tint, tinted = !NOTINT && (T[0] < 0.999 || T[1] < 0.999 || T[2] < 0.999);   // mediodía = sin pasada de color (costo 0)
    const kFog = terrain.mesh ? 1 - terrain.k : 1;   // A6 (G4-fix): con relieve este quad (suelo plano) se funde con (1 - k) y entra la niebla de MapLibre; a k = 1 no dibuja
    const wantFog = kFog > 0.002;
    if (!tinted && !wantFog) return;
    const H = this.map.getCanvas().clientHeight;
    /* Esta capa dibuja ANTES que la de vegetación: calcula la cámara y la niebla de este frame
       acá (host.render repite el cálculo para sus uniforms; es idempotente y barato). */
    const cam = updateCamera(this.map, host.origin, host.scale, matrix);
    updateFog(cam, H);
    const doFog = wantFog && fog.enabled && fog.far < 1e8;
    if (!tinted && !doFog) return;
    const r = cam.rays, u = this.u;
    gl.useProgram(this.prog);
    gl.uniform3f(u.uD0, r.d0[0], r.d0[1], r.d0[2]);
    gl.uniform3f(u.uDx, r.dx[0], r.dx[1], r.dx[2]);
    gl.uniform3f(u.uDy, r.dy[0], r.dy[1], r.dy[2]);
    gl.uniform1f(u.uCamH, cam.altitudeM);
    gl.uniform1f(u.uHorNdc, (cam.horizonPx / (H / 2)) + A1_FOG.skyOverlapPx / (H / 2));
    if (this.vao) gl.bindVertexArray(this.vao);
    else { gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.enableVertexAttribArray(this.loc); gl.vertexAttribPointer(this.loc, 2, gl.FLOAT, false, 0, 0); }
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    if (tinted) {   // pasada de color: multiplica el suelo (satélite ya ajustado) por el tinte del modo de hora; no toca el alfa
      gl.uniform1f(u.uTintMode, 1);
      gl.uniform3f(u.uTint, T[0], T[1], T[2]);
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (doFog) {
      gl.uniform1f(u.uTintMode, 0);
      const c = uniforms.uFogColor.value;
      gl.uniform3f(u.uFogColor, c.r, c.g, c.b);
      gl.uniform1f(u.uFogNear, uniforms.uFogNear.value);
      gl.uniform1f(u.uFogFar, uniforms.uFogFar.value);
      gl.uniform1f(u.uFogMax, uniforms.uFogMax.value * kFog);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (this.vao) gl.bindVertexArray(null); else gl.disableVertexAttribArray(this.loc);
  },

  onRemove(map, gl) {
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.buf) gl.deleteBuffer(this.buf);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
};

/* Se registra al importar (app.js lo importa antes de addScenarioLayers): host.addToMap()
   agrega las capas "antes" primero y la de vegetación al final. */
host.registerBeforeLayer(atmo);
