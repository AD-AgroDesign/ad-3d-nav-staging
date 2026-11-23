/* ============ AgroDesign 3D Navigator · API de QA (window.__nav3d) ============

   Módulo ES importado por app.js. Lee el estado de los módulos de la app con
   imports explícitos (antes, como script clásico, lo tomaba del ámbito global).

   Solo se expone con ?debug o ?qa en la URL. Sin esos parámetros este archivo
   no hace nada (producción: sin cambio de comportamiento).

   Lo usa el harness de tools/qa (capture.mjs, perf.mjs), fuera del repo.
   Con ?qa nunca arranca el tour ni la cámara solos: el splash se saltea desde
   la API y el tour/órbita solo corren si se piden (startTour/startOrbit).
   ==================================================================== */
import { HOME_VIEW, state } from "../core/state.js?v=20261201";
import { featureCentroid, mulberry32, ringAreaHa } from "../core/geo.js?v=20261201";
import { map } from "../map/style.js?v=20261201";
import { setScenario } from "../map/scenario.js?v=20261201";
import { getCamera } from "../core/camera.js?v=20261201";
import { LEVELS, setQuality } from "../core/quality.js?v=20261201";
import * as hidro from "../hydro/state.js?v=20261201";   // F2: simulador de escorrentía
import { host } from "../render/host.js?v=20261201";
import { PRESET_NAMES, atm, presetName, setPreset, uniforms } from "../render/lighting.js?v=20261201";
import { RAZANTE_CAM, corridorCenterline, makeFlight } from "../tour/flight.js?v=20261201";
import { startOrbit, startTour, stopOrbit, stopTour } from "../tour/tour.js?v=20261201";

(() => {
  const _q = new URLSearchParams(location.search);
  if (!(_q.has("debug") || _q.has("qa"))) return;

  const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* Espera a que el mapa quede quieto con las teselas cargadas. Si ya estaba
     quieto, 'idle' no vuelve a dispararse solo: se fuerza un repintado. */
  async function waitIdle(timeoutMs = 60000) {
    const t0 = performance.now();
    for (;;) {
      await new Promise(res => {
        let done = false;
        const fin = () => { if (!done) { done = true; res(); } };
        map.once("idle", fin);
        map.triggerRepaint();
        setTimeout(fin, 3000);
      });
      if (map.loaded() && !map.isMoving()) break;
      if (performance.now() - t0 > timeoutMs) throw new Error("waitIdle: timeout esperando teselas");
    }
    await nextFrame(); await nextFrame();
  }

  /* ---------- ready: escenario montado (botón de inicio habilitado) ---------- */
  const ready = (async () => {
    const btn = document.getElementById("btn-start");
    while (btn.disabled) {
      if (document.getElementById("btn-start-label").textContent.includes("Error")) {
        throw new Error("El escenario no cargó");
      }
      await sleep(50);
    }
    /* Solo con ?qa (con ?debug solo se expone la API, sin cambiar lo visible):
       saltea el splash sin disparar el vuelo ni el tour automático y apaga el
       fundido de teselas ráster para tener capturas deterministas. */
    if (_q.has("qa")) {
      document.getElementById("splash").classList.add("hidden");
      map.setPaintProperty("satellite", "raster-fade-duration", 0);
      await waitIdle();
    }
  })();

  /* ---------- Tiempo congelado ----------
     host.render() escribe uniforms.uTime.value = performance.now()/1000 en cada
     frame. Se reemplaza 'value' por un accesor que ignora esa escritura mientras
     el tiempo esté congelado (viento quieto y reproducible). */
  let frozen = null;
  const tu = uniforms.uTime;
  let liveValue = tu.value;
  Object.defineProperty(tu, "value", {
    configurable: true,
    get: () => (frozen === null ? liveValue : frozen),
    set: v => { liveValue = v; }
  });

  /* ---------- Vistas canónicas (§10.2) ----------
     Deterministas: salen de los datos con las mismas funciones del tour, sin
     sorteos (el tour elige entre los 2 mejores corredores al azar; acá siempre
     el más largo). */
  function bySup(fc, cls) {
    return fc.features.filter(f => f.properties._cls === cls)
      .sort((a, b) => (b.properties._sup || 0) - (a.properties._sup || 0));
  }

  function computeViews() {
    const out = {};
    const multi = state.data.multi, ini = state.data.inicial;

    // 1 cenital: campo completo
    const cam = map.cameraForBounds(state.bbox, { padding: 60 });
    out.cenital = { center: HOME_VIEW.center.slice(), zoom: cam ? cam.zoom : HOME_VIEW.zoom, pitch: 0, bearing: 0 };

    // 2 home
    out.home = { center: HOME_VIEW.center.slice(), zoom: HOME_VIEW.zoom, pitch: HOME_VIEW.pitch, bearing: HOME_VIEW.bearing };

    // 3 y 4 rasante: corredor herbáceo de eje más largo, tal cual lo orienta corridorCenterline
    const flyable = bySup(multi, "corr-herb")
      .map(f => ({ f, cl: corridorCenterline(f) }))
      .filter(x => x.cl)
      .sort((a, b) => b.cl.lenM - a.cl.lenM);
    if (flyable.length) {
      const flight = makeFlight(flyable[0].cl.path);
      out.rasante = { center: flight.at(0), ...RAZANTE_CAM, bearing: flight.bearingAt(0) };
      const dm = flight.total / 2;
      out["rasante-medio"] = { center: flight.at(dm), ...RAZANTE_CAM, bearing: flight.bearingAt(dm) };
    }

    // 5 parche: el parche leñoso más grande, mirado desde su borde sur hacia el centro
    const parches = bySup(multi, "parche-le");
    if (parches.length) {
      const f = parches[0];
      const c = featureCentroid(f);
      let ring = null, best = -1;
      for (const poly of f.geometry.coordinates) {
        const a = ringAreaHa(poly[0], poly[0][0][1]);
        if (a > best) { best = a; ring = poly[0]; }
      }
      const edge = ring.reduce((m, p) => (p[1] < m[1] ? p : m), ring[0]);   // vértice más al sur
      const kx = 111320 * Math.cos(c[1] * Math.PI / 180), ky = 110540;
      const bearing = (Math.atan2((c[0] - edge[0]) * kx, (c[1] - edge[1]) * ky) * 180 / Math.PI + 360) % 360;
      out.parche = { center: c, zoom: 17.3, pitch: 70, bearing };
    }

    // 6 horizonte
    out.horizonte = { center: HOME_VIEW.center.slice(), zoom: 15.5, pitch: 80, bearing: HOME_VIEW.bearing };

    // 7 agua (si el campo tiene): el polígono de agua más grande
    const aguas = bySup(multi, "agua").concat(bySup(ini, "agua"))
      .sort((a, b) => (b.properties._sup || 0) - (a.properties._sup || 0));
    if (aguas.length) out.agua = { center: featureCentroid(aguas[0]), zoom: 16.5, pitch: 65, bearing: 0 };

    return out;
  }

  /* ---------- stats ----------
     drawCalls/triangles salen de renderer.info.render de Three. OJO: Three
     reinicia info en cada renderer.render() (autoReset), y la capa custom lo
     llama una vez por frame de MapLibre, así que miden SOLO el último frame de
     la capa Three (árboles + pasto de los escenarios visibles, ya con el culling
     de Three aplicado). No incluyen lo que dibuja MapLibre (ráster, fill, line,
     fill-extrusion, cielo). Se espera un frame fresco antes de leer. */
  async function stats() {
    await new Promise(r => { map.once("render", r); map.triggerRepaint(); });
    await nextFrame();
    const info = host.renderer.info;
    // instancias por escenario y sistema: las informa cada sistema del host (render/host.js)
    const instances = host.instanceStats();
    const mem = performance.memory;
    return {
      scenario: state.scenario,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      instances,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null
    };
  }

  /* ---------- frameTimes ----------
     Mide intervalos entre eventos 'render' del mapa durante `ms`. Por defecto
     fuerza un repintado continuo (para medir una escena estática); con
     {force:false} solo cuenta lo que el mapa repinta por su cuenta (tour,
     órbita, reposo). */
  function frameTimes(ms, opts = {}) {
    const force = opts.force !== false;
    return new Promise(resolve => {
      const ts = [];
      const onRender = () => { ts.push(performance.now()); if (force) map.triggerRepaint(); };
      map.on("render", onRender);
      if (force) map.triggerRepaint();
      setTimeout(() => {
        map.off("render", onRender);
        const d = [];
        for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
        d.sort((a, b) => a - b);
        const q = p => (d.length ? +d[Math.min(d.length - 1, Math.floor(p * d.length))].toFixed(2) : null);
        resolve({ n: ts.length, p50: q(0.5), p95: q(0.95), max: d.length ? +d[d.length - 1].toFixed(2) : null,
                  fpsMedian: d.length ? +(1000 / q(0.5)).toFixed(1) : 0 });
      }, ms);
    });
  }

  window.__nav3d = {
    ready,
    map,                                    // atajo para scripts de QA
    async setView({ center, zoom, pitch = 0, bearing = 0 }) {
      stopTour(); stopOrbit();
      map.jumpTo({ center, zoom, pitch, bearing });
      await waitIdle();
    },
    async setScenario(key, { animate = false } = {}) {
      setScenario(key, animate);            // main.js: no-op si ya es el actual
      if (animate) await sleep(2000);
      await waitIdle();
    },
    /* Fija uTime (viento) en `seconds`; null/undefined lo suelta. */
    freezeTime(seconds) {
      frozen = (seconds == null) ? null : seconds;
      map.triggerRepaint();
    },
    /* Reemplaza Math.random por mulberry32(n): el tour (waypoints y corredor)
       pasa a ser reproducible. Solo existe en modo QA. */
    seed(n) { Math.random = mulberry32(n >>> 0); },
    /* F2: simulador de escorrentía. ready es getter: cada lectura pide el resultado vigente. */
    runoff: {
      set: mode => hidro.setMode(mode),
      rain: mmh => hidro.setRain(mmh, true),
      get ready() { return hidro.ensureComputed(); },
      stats() {
        const { mode, rainMmH, available, reason, computing, error, result } = hidro.getState();
        return { mode, rainMmH, available, reason, computing, error, result: result ? { stats: result.stats } : null };
      },
    },
    stats,
    frameTimes,
    views: computeViews,
    startTour, stopTour, startOrbit, stopOrbit,
    /* Cámara real (core/camera.js) del último frame + centro del mapa en metros de escena,
       para verificar uCamPos contra la altitud/distancia de MapLibre (P-7). */
    async camera() {
      await new Promise(r => { map.once("render", r); map.triggerRepaint(); });
      const cam = getCamera();
      const cs = host.ctx.toScene(map.getCenter().lng, map.getCenter().lat);
      const p = cam.camPosScene;
      const dist = Math.hypot(p[0] - cs[0], p[1], p[2] - cs[1]);
      const cp = map.transform.getCameraPosition();
      return { camPosScene: p, altitudeM: cam.altitudeM, altitudeMapLibre: cp.altitude, ctdM: cam.ctdM, ctdPx: cam.ctdPx,
               pxPerMeter: cam.pxPerMeter, horizonPx: cam.horizonPx, centerScene: cs, distToCenter: dist,
               pitch: map.getPitch(), zoom: map.getZoom(), rays: cam.rays };
    },
    /* Modos de hora (A1, 3.1): "mediodia" | "dorada" | "atardecer". setPreset(name, {instant = true, duration}) devuelve una
       promesa que resuelve tras la transición y el repintado (por defecto INSTANTÁNEO: determinista para capturas;
       { instant: false } prueba la transición animada de 1,5 s). `preset()` informa el vigente y su estado interpolado. */
    presets: PRESET_NAMES.slice(),
    async setPreset(name, opts = {}) {
      const ok = await setPreset(name, { instant: opts.instant !== false, duration: opts.duration });
      if (ok) await waitIdle();
      return ok;
    },
    preset() { return { name: presetName, state: JSON.parse(JSON.stringify(atm)) }; },
    /* Calidad: cambia el nivel real (core/quality.js) sin persistir en localStorage (determinismo). */
    qualities: LEVELS.slice(),
    setQuality(name) { return setQuality(name, { persist: false, reload: false }); }
  };
})();
