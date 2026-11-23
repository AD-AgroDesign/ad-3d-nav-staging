/* ============ Host de render: capa custom de MapLibre + registro de sistemas ============
   Único módulo que toca el WebGLRenderer. La capa custom ya no es un objeto monolítico:
   es un *host* que contiene sistemas independientes (árboles, pasto, y los que vengan:
   suelo, agua, sombras, fauna), cada uno en render/systems/<x>.js con su dueño (§6).

   Contrato de un sistema (§6.3):
     id
     build(ctx, scenarioKey, data, veg) → { object3d, materials }   una vez por escenario
     setOpacity(scenarioKey, o)    cross-fade
     setGrowth(scenarioKey, t)     crecimiento 0..1 (hoy lo aplica el host con scale.y)
     update(frame)                 por frame: { now, dt, camPosScene, viewProj, quality, preset }
     onQuality(q)                  cambio de nivel de calidad
     dispose()
   Todos los métodos salvo id y build son opcionales.
   ctx = { THREE, toScene, heightAt, quality, shaderlib, uniforms, config, rng }. */
import * as THREE from "three";
import * as config from "../core/config.js?v=20261201";
import { updateCamera } from "../core/camera.js?v=20261201";
import { emit, hasListeners, on } from "../core/events.js?v=20261201";
import { mulberry32 } from "../core/geo.js?v=20261201";
import { quality } from "../core/quality.js?v=20261201";
import { HOME_VIEW, state } from "../core/state.js?v=20261201";
import { applyCampoLighting, applyRenderSettings, createLights, uniforms, updateFog } from "./lighting.js?v=20261201";   // A1: updateFog (niebla)
import { idleDriver } from "./idle.js?v=20261201";   // lazo único de repintado en reposo (Ola 4)
import * as shaderlib from "./shaderlib.js?v=20261201";
import { scenarioFade } from "./shaderlib.js?v=20261201";   // A1: uniforme de fade dither por escenario
import trees from "./systems/trees.js?v=20261201";
import grass from "./systems/grass.js?v=20261201";
import ground from "./systems/ground.js?v=20261201";   // A4: suelo por shader + surcos
import water from "./systems/water.js?v=20261201";   // A4: agua por shader
import { bindReliefFrame, fitSpheres, growthU, heightAt, onReliefStep, patchGrowth, terrain } from "../terrain/terrain.js?v=20261201";   // A6: relieve (heightAt real; terrain.active)
import shadows from "./systems/shadows.js?v=20261201";   // A3: sombras de árboles (pase propio + receptor + blobs)
import fauna from "./systems/fauna.js?v=20261201";   // A5: aves y polinizadores
import runoff from "./systems/runoff.js?v=20261201"; // F2: simulador de escorrentía (inerte con el simulador apagado)

const SCENARIOS = ["inicial", "multi"];

/* ---------- Capa custom Three.js: árboles low-poly instanciados ---------- */
export const host = {
  id: "veg-3d",
  type: "custom",
  renderingMode: "3d",
  groups: {},          // scenarioKey → THREE.Group del escenario (contiene los objetos de todos los sistemas)
  systems: [],         // sistemas registrados, en orden de construcción
  preLayers: [],       // capas custom extra que deben quedar ANTES de ésta (p. ej. atmo-fog de A1)
  quality,             // nivel de calidad vigente (core/quality.js: objeto único y mutable)
  idleDriver,          // lazo único de reposo: request(owner, active) (render/idle.js)
  camera3d: null,      // última cámara real calculada por core/camera.js (ver render())

  /* Registra un sistema. Se construye en onAdd, en el orden de registro. */
  register(system) { this.systems.push(system); return system; },

  /* Registra una capa custom extra (objeto con la interfaz de capa custom de MapLibre)
     que addToMap() agrega justo antes de la de vegetación: así dibuja debajo de ella. */
  registerBeforeLayer(layer) { this.preLayers.push(layer); },

  /* Agrega al mapa las capas del host: primero las extra y al final la de vegetación.
     `beforeId` (opcional) las inserta antes de esa capa de MapLibre. */
  addToMap(map, beforeId) {
    for (const l of this.preLayers) map.addLayer(l, beforeId);
    map.addLayer(this, beforeId);
  },

  onAdd(mapInstance, gl) {
    this.map = mapInstance;
    idleDriver.bind(mapInstance);
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    createLights(this.scene);
    applyCampoLighting(state.campo && state.campo.id);   // A1: azimut del sol y color de suelo del campo

    const origin = maplibregl.MercatorCoordinate.fromLngLat(HOME_VIEW.center, 0);
    this.scale = origin.meterInMercatorCoordinateUnits();
    // escena en metros: X=este, Y=arriba, Z=sur
    this.l = new THREE.Matrix4()
      .makeTranslation(origin.x, origin.y, 0)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    this.origin = origin;
    bindReliefFrame(origin.x, origin.y, this.scale);   // A6 relieve en vivo: textura de alturas + afín escena→píxel para los shaders (a6Low)

    const s = this.scale;
    const ctx = {
      THREE,
      // posición exacta en Mercator -> metros de escena [X este, Z sur]
      toScene: (lon, lat) => {
        const mc = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
        return [(mc.x - origin.x) / s, (mc.y - origin.y) / s];
      },
      heightAt,                 // A6: altura del suelo en m de escena (m·exageración); 0 con terreno apagado (terrain/terrain.js)
      // A6: lo mismo con coordenadas de escena (x este, z sur) y la inversa de toScene (para armar mallas apoyadas en el relieve: suelo, sombras)
      toLngLat: (x, z) => { const ll = new maplibregl.MercatorCoordinate(origin.x + x * s, origin.y + z * s, 0).toLngLat(); return [ll.lng, ll.lat]; },
      heightAtScene: (x, z) => { if (!terrain.active) return 0; const ll = new maplibregl.MercatorCoordinate(origin.x + x * s, origin.y + z * s, 0).toLngLat(); return heightAt(ll.lng, ll.lat); },
      quality: this.quality,
      shaderlib, uniforms, config,
      rng: mulberry32
    };
    this.ctx = ctx;

    /* Escenario por escenario y, dentro de cada uno, sistema por sistema: es el mismo
       orden de creación de objetos que tenía el vegLayer monolítico (importa para el
       desempate de orden de dibujo de los materiales transparentes). */
    for (const key of SCENARIOS) {
      const group = new THREE.Group();
      for (const sys of this.systems) {
        const built = sys.build(ctx, key, state.data[key], state.veg[key]);
        group.add(built.object3d);
        /* A1: niebla para los materiales de todos los sistemas, compuesta con lo que ya
           tengan (viento). Idempotente: si un sistema ya hizo patch(mat,{fog:true}) no se repite. */
        for (const m of built.materials || []) {
          shaderlib.patchExtra(m, { fog: true, foliage: m.userData.foliage !== false, srgbVC: !!m.vertexColors });   // ORQ: opt-out de follaje por material (troncos, pedido A1)
          if (terrain.active) patchGrowth(m, key);   // A6: crecimiento apoyado en el suelo (ver arriba)
        }
      }
      if (terrain.active) growthU[key].value = state.growth[key] || 0.0001;   // A6: con terreno el grupo no se escala
      else group.scale.y = state.growth[key] || 0.0001;
      this.groups[key] = group;
      this.setOpacity(key, key === "inicial" ? 1 : 0);
      this.scene.add(group);
    }

    if (terrain.active && terrain.k < 1) fitSpheres(this.scene);   // A6: el relieve arranca apagado: esferas de culling bajadas

    /* Three r170 sube texturas 3D/array vacías al crear el renderer; con UNPACK_FLIP_Y o
       UNPACK_PREMULTIPLY_ALPHA en true (estado que deja MapLibre en el contexto compartido)
       WebGL tira "INVALID_OPERATION: texImage3D: FLIP_Y or PREMULTIPLY_ALPHA isn't allowed
       for uploading 3D textures". Se apagan durante la creación y se restauran después
       (MapLibre las vuelve a fijar él mismo en cada subida de textura). */
    const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    const premul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.renderer = new THREE.WebGLRenderer({ canvas: mapInstance.getCanvas(), context: gl });
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premul);
    applyRenderSettings(this.renderer);   // A1 1.3: salida sRGB + tone mapping (lighting.js)
    this.renderer.autoClear = false;
    /* A3: los sistemas que lo piden (sombras: render target del pase, receptor del pasto) reciben renderer y escena
       una vez creado el renderer y ya construidos todos los grupos. */
    for (const sys of this.systems) if (sys.onRenderer) sys.onRenderer(this.renderer, this.scene);
  },

  setOpacity(key, o) {
    // A1 (fade dither): uniforme compartido del escenario; los materiales parchados con
    // patch(mat, { fade: key }) lo leen solos. Los sistemas que aún usan material.opacity no se enteran.
    if (scenarioFade[key]) scenarioFade[key].value = o;
    for (const sys of this.systems) if (sys.setOpacity) sys.setOpacity(key, o);
    if (this.groups[key]) this.groups[key].visible = o > 0.02;
  },

  setGrowth(key, t) {
    if (terrain.active) growthU[key].value = Math.max(t, 0.0001);   // A6: crecimiento por shader (ver growthU)
    else if (this.groups[key]) this.groups[key].scale.y = Math.max(t, 0.0001);
    for (const sys of this.systems) if (sys.setGrowth) sys.setGrowth(key, t);
  },

  /* Cambio de nivel de calidad (P-7): lo propagan a los sistemas. */
  setQuality(q) {
    this.quality = q;
    if (this.ctx) this.ctx.quality = q;
    for (const sys of this.systems) if (sys.onQuality) sys.onQuality(q);
  },

  /* PUNTO ÚNICO donde se arma la matriz de la capa (A6, terreno 3D): `matrix` es la
     matriz de proyección de MapLibre y `this.l` pasa metros de escena a Mercator.
     A6: con terreno, la matriz de las capas custom de MapLibre 4.7.1 NO trae la traslación −elevación que sí
     usan la malla del terreno y el resto de sus capas, así que todo lo dibujado por Three quedaría E metros
     más arriba (E = elevación del centro de la vista: 40 m en Nikunihué, 76 en Chapadmalal). Se resta acá,
     en CADA frame (E cambia al mover el centro). La Y de escena es la altura absoluta × exageración
     (= heightAt), no hace falta restar la altura del centro del campo. Sin terreno E = 0 y la matriz es la de siempre. */
  sceneMatrix(matrix) {
    const E = terrain.mesh ? (this.map.transform.elevation || 0) : 0;   // A6 relieve en vivo: solo mientras la malla de MapLibre está prendida
    this.l.elements[14] = -E * this.scale;   // traslación Z (mercator) de this.l: -E·metros→mercator
    return new THREE.Matrix4().fromArray(matrix).multiply(this.l);
  },

  render(gl, matrix) {
    const now = performance.now();
    const dt = this._lastNow == null ? 0 : Math.max(0, now - this._lastNow);   // clamp T5
    this._lastNow = now;
    uniforms.uTime.value = now / 1000;
    this.camera.projectionMatrix = this.sceneMatrix(matrix);
    /* Cámara real (T1): posición en metros de escena → uCamPos, compartido por niebla, LOD, agua… */
    const cam = this.camera3d = updateCamera(this.map, this.origin, this.scale, matrix);
    uniforms.uCamPos.value.set(cam.camPosScene[0], cam.camPosScene[1], cam.camPosScene[2]);
    updateFog(cam, this.map.getCanvas().clientHeight, terrain.mesh ? this.map.transform : null, terrain.k);   // A6 (G4): con relieve, niebla de MapLibre (lighting.js). A1: uFogNear/uFogFar de este frame (lighting.js)
    const frame = { now, dt, camPosScene: uniforms.uCamPos.value, viewProj: this.camera.projectionMatrix,
                    camera: cam, quality: this.quality, preset: null };
    idleDriver.frame(now, uniforms.uTime.value);
    for (const sys of this.systems) if (sys.update) sys.update(frame);
    if (hasListeners("frame")) emit("frame", frame);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  },

  dispose() {
    for (const sys of this.systems) if (sys.dispose) sys.dispose();
  },

  /* Para __nav3d.stats(): instancias por escenario y sistema. Cada sistema aporta sus
     números con su método stats(scenarioKey). */
  instanceStats() {
    const out = {};
    for (const key of SCENARIOS) {
      const g = this.groups[key];
      if (!g) continue;
      const o = { visible: g.visible };
      for (const sys of this.systems) if (sys.stats) Object.assign(o, sys.stats(key));
      out[key] = o;
    }
    return out;
  }
};

on("quality", q => host.setQuality(q));
/* A6 relieve en vivo: cada paso del factor k llega a los sistemas que lo necesiten fuera de los shaders (hoy: sombras). */
onReliefStep((k, fin) => { if (host.scene) fitSpheres(host.scene); for (const sys of host.systems) if (sys.setRelief) sys.setRelief(k, fin); });
host.register(trees);
host.register(grass);
host.register(ground);   // A4
host.register(water);   // A4: agua
host.register(shadows);   // A3
host.register(fauna);   // A5
host.register(runoff);  // F2
