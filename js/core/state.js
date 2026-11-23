/* ---------- Estado global ---------- */
export const params = new URLSearchParams(location.search);
export const DEBUG = params.has("debug");

export const state = {
  scenario: "inicial",
  campo: null,
  data: { inicial: null, multi: null },
  veg: { inicial: null, multi: null },
  stats: { inicial: {}, multi: {} },
  bbox: null,
  designOpacity: 1,
  tour: { running: false, timer: null, raf: null, route: [], step: 0 },
  orbit: { running: false, raf: null },
  growth: { inicial: 1, multi: 0 },
  anim: null
};

export let HOME_VIEW = { center: [-63.7885, -33.865], zoom: 12.6, pitch: 58, bearing: 15 };

/* Un módulo no puede reasignar lo que importa de otro: computeHomeView() (map/data.js)
   reemplaza HOME_VIEW a través de este setter; los demás módulos ven el valor nuevo
   porque un import ES es un enlace vivo (live binding). */
export function setHomeView(v) { HOME_VIEW = v; }
