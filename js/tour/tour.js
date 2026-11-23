import { featureCentroid } from "../core/geo.js?v=20261201";
import { HOME_VIEW, state } from "../core/state.js?v=20261201";
import { map } from "../map/style.js?v=20261201";
import { RAZANTE_CAM, corridorCenterline, flyAlongPath, makeFlight } from "./flight.js?v=20261201";

/* ---------- Tour de dron (recorrido distinto en cada vuelo) ---------- */
export function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildTourWaypoints() {
  const multi = state.data.multi;
  const byArea = cls => multi.features
    .filter(f => f.properties._cls === cls)
    .sort((a, b) => (b.properties._sup || 0) - (a.properties._sup || 0));

  const corridors = shuffled(byArea("corr-herb").concat(byArea("corr-le")).slice(0, 6)).slice(0, 2);
  const patches = shuffled(byArea("parche-le").slice(0, 5)).slice(0, 2);
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* Corredor para el rasante: el herbáceo con eje más largo (protagonista);
     al azar entre los 2 mejores para variar entre vuelos */
  const flyable = byArea("corr-herb")
    .map(f => ({ f, cl: corridorCenterline(f) }))
    .filter(x => x.cl)
    .sort((a, b) => b.cl.lenM - a.cl.lenM);
  const razante = flyable.length ? shuffled(flyable.slice(0, 2))[0].cl : null;

  const wp = [];
  wp.push({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom + 0.4, pitch: rnd(50, 60), bearing: rnd(-40, 40), duration: 6000, msg: "Sobrevolando el establecimiento" });
  if (corridors[0]) wp.push({ center: featureCentroid(corridors[0]), zoom: rnd(15.2, 15.6), pitch: rnd(68, 74), bearing: rnd(0, 360), duration: 8000, msg: "Descendiendo sobre un corredor biológico" });
  if (razante) {
    // arrancar por la punta más cercana al waypoint anterior
    const prev = wp[wp.length - 1].center;
    const p = razante.path;
    const d2 = q => (q[0] - prev[0]) ** 2 + (q[1] - prev[1]) ** 2;
    if (d2(p[p.length - 1]) < d2(p[0])) p.reverse();
    const flight = makeFlight(p);
    /* La aproximación termina en la misma pose (centro/zoom/pitch/rumbo)
       en la que arranca el rasante: la transición no tiene salto */
    wp.push({ center: flight.at(0), ...RAZANTE_CAM, bearing: flight.bearingAt(0), duration: 7000, msg: "Descendiendo al corredor" });
    /* La duración sale del perfil de velocidad del vuelo (crucero + frenadas
       en curvas): así el tope de tasa de giro se respeta de verdad */
    wp.push({ flight, duration: Math.max(10000, Math.min(22000, flight.timeTotal * 1000)), msg: "Vuelo rasante siguiendo el corredor" });
  } else if (corridors[1]) {
    wp.push({ center: featureCentroid(corridors[1]), zoom: rnd(15.6, 16.0), pitch: rnd(72, 76), bearing: rnd(0, 360), duration: 9000, msg: "Vuelo rasante sobre el corredor" });
  }
  if (patches[0]) {
    const c = featureCentroid(patches[0]);
    const b = rnd(0, 360);
    wp.push({ center: c, zoom: rnd(15.4, 15.8), pitch: rnd(64, 70), bearing: b, duration: 8000, msg: "Aproximación al parche de monte" });
    wp.push({ center: c, zoom: rnd(15.4, 15.8), pitch: rnd(64, 70), bearing: b + 140, duration: 9000, msg: "Órbita sobre el parche leñoso" });
  }
  if (patches[1]) wp.push({ center: featureCentroid(patches[1]), zoom: rnd(15.0, 15.5), pitch: rnd(62, 70), bearing: rnd(0, 360), duration: 8000, msg: "Cruzando hacia otro parche de naturaleza" });
  wp.push({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom + 0.2, pitch: rnd(48, 56), bearing: rnd(-30, 30), duration: 8000, msg: "Vista general del paisaje rediseñado" });
  return wp;
}

export function startTour() {
  stopOrbit();
  state.tour.running = true;
  state.tour.route = buildTourWaypoints();
  state.tour.step = 0;
  document.getElementById("btn-tour").classList.add("active");
  document.getElementById("tour-banner").classList.add("visible");
  nextTourStep();
}

export function nextTourStep() {
  if (!state.tour.running) return;
  if (state.tour.step >= state.tour.route.length) { stopTour(); return; }
  const wp = state.tour.route[state.tour.step++];
  document.getElementById("tour-banner").textContent = wp.msg;
  if (wp.flight) {
    flyAlongPath(wp.flight, wp.duration, () => {
      state.tour.timer = setTimeout(nextTourStep, 400);
    });
  } else {
    /* Ease-in-out: arranca y frena en velocidad cero, sin tirones;
       essential evita el salto instantáneo con "reducir movimiento" del SO */
    map.easeTo({ ...wp, easing: t => t * t * (3 - 2 * t), essential: true });
    state.tour.timer = setTimeout(nextTourStep, wp.duration + 400);
  }
}

export function stopTour() {
  if (!state.tour.running) return;
  state.tour.running = false;
  clearTimeout(state.tour.timer);
  if (state.tour.raf) cancelAnimationFrame(state.tour.raf);
  document.getElementById("btn-tour").classList.remove("active");
  document.getElementById("tour-banner").classList.remove("visible");
}

/* ---------- Órbita ---------- */
export function startOrbit() {
  stopTour();
  state.orbit.running = true;
  document.getElementById("btn-orbit").classList.add("active");
  let last = performance.now();
  const spin = now => {
    if (!state.orbit.running) return;
    const dt = now - last; last = now;
    map.setBearing(map.getBearing() + dt * 0.006);
    state.orbit.raf = requestAnimationFrame(spin);
  };
  state.orbit.raf = requestAnimationFrame(spin);
}

export function stopOrbit() {
  state.orbit.running = false;
  if (state.orbit.raf) cancelAnimationFrame(state.orbit.raf);
  document.getElementById("btn-orbit").classList.remove("active");
}

for (const ev of ["mousedown", "touchstart", "wheel"]) {
  map.getCanvas().addEventListener(ev, () => { stopTour(); stopOrbit(); }, { passive: true });
}
