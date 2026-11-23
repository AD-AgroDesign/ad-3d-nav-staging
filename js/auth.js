/* ============ AgroDesign 3D Navigator · Control de acceso ============

   Usa la misma base de usuarios, los mismos permisos y las mismas credenciales
   que el dashboard (proyecto Supabase ivucpzmedseoanjrwutn). Un usuario entra
   acá con la contraseña con la que entra al dashboard.

   Quién ve qué lo decide Postgres, no este archivo:
     · profiles.cliente_id dice a qué cliente pertenece el usuario
     · la policy campos_by_role filtra la tabla campos por ese cliente_id
     · la policy gis3d_read_by_role hace lo propio con los archivos del bucket
   El JS de acá abajo sólo dibuja lo que la base ya decidió devolver: aunque
   alguien lo manipule desde la consola, no puede ver ni bajar un campo ajeno.

   La publishable key es pública por diseño (va en el HTML del dashboard
   también); sin sesión válida no abre ninguna puerta.
   ==================================================================== */

const SUPABASE_URL = "https://ivucpzmedseoanjrwutn.supabase.co";
/* Clave publishable (reemplaza a la vieja anon key, migración 2026-08-07).
   Mismos privilegios bajos: la RLS se comporta igual. */
const SUPABASE_ANON_KEY = "sb_publishable_JCCcFphCzigm36R1bFIzDw_Xk0M1wbm";

const GIS_BUCKET     = "gis3d";
const SIGNED_URL_TTL = 3600;   // 1 h; los datos ya quedan en memoria del visor

let _sb = null;

/* ---------- Modo local (sólo desarrollo) ----------
   ?local salta Supabase y lee data/campos.local.json (no versionado; lo genera
   tools/gen_campos_local.py). Se activa únicamente en hosts de desarrollo:
   en cualquier otro host (producción incluida) el parámetro se ignora. */
const HOST_DEV = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i.test(location.hostname);
const MODO_LOCAL = HOST_DEV && new URLSearchParams(location.search).has("local");

/* ---------- Modo fixture (campo sintético, sin login) ----------
   ?fixture=<id> lee fixtures/campos.fixture.json y sirve los GeoJSON desde fixtures/ (todo inventado, sin datos de
   clientes). Se permite en hosts de desarrollo y en el staging; en 3d.agrodesign.site (o cualquier otro host) el
   parámetro se ignora y sigue el login normal. */
const HOST_FIXTURE = HOST_DEV || location.hostname === "3d-staging.agrodesign.site";
const FIXTURE_ID = HOST_FIXTURE ? new URLSearchParams(location.search).get("fixture") : null;
const MODO_FIXTURE = !!FIXTURE_ID && !MODO_LOCAL;   // ?local manda si vienen los dos

/* Contrato con main.js: éste lee AD_AUTH.campo y AD_AUTH.signedUrlFor() */
const AD_AUTH = {
  sb: null,
  user: null,
  profile: null,
  campos: [],       // sólo los que este usuario puede ver
  campo: null,      // el elegido; main.js no arranca hasta que esté
  signedUrlFor,
  esAdmin: () => AD_AUTH.profile && AD_AUTH.profile.rol === "admin"
};
window.AD_AUTH = AD_AUTH;

/* ---------- Atajos de DOM ---------- */
const $ = id => document.getElementById(id);
const overlay  = () => $("login-overlay");
const card     = () => $("login-card");
const errorBox = () => $("login-error");

/* La tarjeta pasa por tres estados: verificando sesión, formulario, selector */
function setCardState(estado) {
  card().className = `state-${estado}`;
}

function showError(msg) {
  const el = errorBox();
  el.textContent = msg;
  el.classList.add("visible");
}

function clearError() {
  errorBox().classList.remove("visible");
}

/* ---------- Cliente Supabase ---------- */
function initSupabase() {
  if (!window.supabase || !window.supabase.createClient) {
    setCardState("form");
    showError("No se pudo cargar el módulo de acceso. Recargá la página.");
    return false;
  }
  _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  AD_AUTH.sb = _sb;
  return true;
}

/* ---------- Mostrar / ocultar contraseña ---------- */
function togglePassVisibility() {
  const inp  = $("login-password");
  const btn  = $("login-pass-toggle");
  const ver  = inp.type === "password";
  inp.type = ver ? "text" : "password";
  btn.classList.toggle("off", ver);
  const lbl = ver ? "Ocultar contraseña" : "Mostrar contraseña";
  btn.setAttribute("aria-label", lbl);
  btn.setAttribute("title", lbl);
  inp.focus();
}

/* ---------- Login ---------- */
async function doLogin() {
  const btn   = $("login-btn");
  const email = $("login-email").value.trim();
  const pass  = $("login-password").value;

  clearError();
  if (!email || !pass) {
    showError("Ingresá tu correo y tu contraseña.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Validando…";
  try {
    const { data, error } = await _sb.auth.signInWithPassword({ email, password: pass });
    if (error) throw error;
    await afterLogin(data.session);
    if (AD_AUTH.campos.length) registrarAcceso("login");
  } catch (err) {
    console.error("Error de acceso:", err);
    showError(traducirError(err));
    btn.disabled = false;
    btn.textContent = "Validar acceso";
  }
}

/* Supabase devuelve los mensajes en inglés; los pocos que el usuario puede
   provocar en la práctica los mostramos en castellano. */
function traducirError(err) {
  const m = (err && err.message) || "";
  if (/invalid login credentials/i.test(m)) return "Correo o contraseña incorrectos.";
  if (/email not confirmed/i.test(m))       return "Tu cuenta todavía no fue confirmada. Escribinos para activarla.";
  if (/too many requests|rate limit/i.test(m)) return "Demasiados intentos. Esperá un minuto y probá de nuevo.";
  if (/failed to fetch|network/i.test(m))   return "Sin conexión con el servidor. Revisá tu internet.";
  return m || "No se pudo validar el acceso.";
}

/* ---------- Post-login: perfil, campos habilitados y selector ---------- */
async function afterLogin(session) {
  AD_AUTH.user = session.user;

  const { data: perfil, error: errPerfil } = await _sb
    .from("profiles")
    .select("rol, cliente_id, sesiones_count")
    .eq("id", session.user.id)
    .single();
  if (errPerfil) throw errPerfil;
  AD_AUTH.profile = perfil;

  /* La RLS ya recorta la tabla al cliente del usuario (o la deja entera si es
     admin). El filtro nav3d_slug deja fuera los campos que existen en el
     dashboard pero todavía no fueron cargados al visor 3D. */
  const { data: filas, error: errCampos } = await _sb
    .from("campos")
    .select("id, nombre, cliente_id, nav3d_slug, nav3d_maxzoom, nav3d_inicial, nav3d_multi, clientes(nombre)")
    .not("nav3d_slug", "is", null)
    .order("nombre");
  if (errCampos) throw errCampos;

  AD_AUTH.campos = (filas || []).map(f => ({
    id:          f.nav3d_slug,
    uuid:        f.id,
    nombre:      f.nombre,
    cliente:     (f.clientes && f.clientes.nombre) || null,
    maxzoom:     f.nav3d_maxzoom || 17,
    pathInicial: f.nav3d_inicial,
    pathMulti:   f.nav3d_multi
  })).sort((a, b) => {
    const c = (a.cliente || "").localeCompare(b.cliente || "", "es");
    return c !== 0 ? c : a.nombre.localeCompare(b.nombre, "es");
  });

  registrarIngreso(perfil);

  /* Usuario válido pero sin nada que mostrarle: cerramos la sesión para que la
     tarjeta vuelva a un estado coherente y no quede autenticado en el vacío. */
  if (!AD_AUTH.campos.length) {
    await _sb.auth.signOut();
    setCardState("form");
    showError("Tu usuario no tiene campos habilitados en el visualizador 3D. Escribinos para que te los activemos.");
    $("login-btn").disabled = false;
    $("login-btn").textContent = "Validar acceso";
    return;
  }

  poblarSelector();

  /* Deep link ?campo=<slug>: sólo se respeta si el usuario tiene permiso sobre
     ese campo. Al volver de un cambio de campo (que recarga la página) esto
     evita pasar otra vez por el selector. */
  const pedido = new URLSearchParams(location.search).get("campo");
  const match  = AD_AUTH.campos.find(c => c.id === pedido);
  if (match) { entrarAlVisor(match); return; }

  setCardState("campos");
  $("login-enter").focus();
}

/* Mismo registro de actividad que el dashboard, para que su panel de usuarios
   siga contando bien. No bloquea el ingreso: a un cliente la RLS le deja el
   UPDATE en cero filas y eso no es un error que deba frenarlo. */
function registrarIngreso(perfil) {
  const meta   = AD_AUTH.user.user_metadata || {};
  const nombre = meta.full_name || meta.name || null;
  const upd = {
    email:          AD_AUTH.user.email,
    ultimo_login:   new Date().toISOString(),
    sesiones_count: (perfil.sesiones_count || 0) + 1
  };
  if (nombre) upd.nombre = nombre;
  _sb.from("profiles").update(upd).eq("id", AD_AUTH.user.id)
    .then(({ error }) => { if (error) console.warn("No se registró el ingreso:", error.message); });
}

/* Historial de ingresos para el informe semanal: tabla accesos, compartida con
   el dashboard (que escribe plataforma 'dashboard'). 'login' = entró con
   contraseña; 'sesion' = volvió con la sesión guardada. registrarIngreso() no
   sirve para eso: suma también al restaurar la sesión y no guarda fechas.
   La base completa usuario, cliente y rol, y descarta las 'sesion' a menos de
   30 min de otro ingreso — cambiar de campo recarga la página y no es otra
   visita. El tope local sólo ahorra el request; un error nunca frena el ingreso. */
const ACCESO_SESION_MS = 30 * 60 * 1000;
function registrarAcceso(evento) {
  try {
    const ult = parseInt(localStorage.getItem("ad_acceso_ult") || "0", 10);
    if (evento === "sesion" && Date.now() - ult < ACCESO_SESION_MS) return;
    localStorage.setItem("ad_acceso_ult", String(Date.now()));
  } catch (e) { /* sin localStorage decide sólo la base */ }
  _sb.from("accesos").insert({ plataforma: "nav3d", evento })
    .then(({ error }) => { if (error) console.warn("No se registró el acceso:", error.message); });
}

/* ---------- Selector de campos dentro de la tarjeta ---------- */
function poblarSelector() {
  const sel = $("login-campo-select");
  sel.innerHTML = "";

  const campos = AD_AUTH.campos;
  const varios = campos.length > 1;

  /* Con un solo campo no tiene sentido pedir que elija: queda seleccionado y
     sólo resta el botón. Con varios, un placeholder obliga a elegir. */
  if (varios) {
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "Elegí un campo…";
    ph.disabled = true;
    ph.selected = true;
    sel.appendChild(ph);
  }

  /* Los admin ven campos de varios clientes: se los prefija para distinguirlos.
     Cuando el cliente y el campo se llaman igual (El Carmen, Monte Hermoso) el
     prefijo no agrega nada, así que se omite. */
  const mostrarCliente = AD_AUTH.esAdmin() &&
    new Set(campos.map(c => c.cliente)).size > 1;
  const etiqueta = c => (mostrarCliente && c.cliente && c.cliente !== c.nombre)
    ? `${c.cliente} — ${c.nombre}` : c.nombre;

  for (const c of campos) {
    const op = document.createElement("option");
    op.value = c.id;
    op.textContent = etiqueta(c);
    sel.appendChild(op);
  }

  $("login-campos-count").textContent = varios
    ? `${campos.length} campos disponibles`
    : "1 campo disponible";
  $("login-enter").disabled = varios;
}

function entrarAlVisor(campo) {
  AD_AUTH.campo = campo;
  clearError();

  /* El nombre va al splash antes de descubrirlo: si el mapa todavía no terminó
     de cargar, bootEscenario() se demora y no queremos que el usuario alcance a
     ver el título de otro campo. loadCampos() lo vuelve a escribir después. */
  $("splash-campo").textContent = campo.nombre;
  document.title = `AgroDesign · Navegador 3D · ${campo.nombre}`;

  /* El overlay se desvanece y deja ver el splash de portada, con el botón para
     iniciar la simulación. */
  overlay().classList.add("hidden");
  $("login-password").value = "";
  $("login-email").value    = "";

  /* app.js es un módulo ES (diferido): puede ejecutarse DESPUÉS de este punto, p. ej.
     al restaurar la sesión o en modo local. Se deja la bandera y, si AD_BOOT ya
     existe, se lo llama; si no, app.js revisa la bandera al inicializar y arranca él.
     Uno u otro: nunca los dos (ver el cierre de app.js). */
  window.AD_ACCESS_READY = true;
  if (typeof window.AD_BOOT === "function") window.AD_BOOT();
}

/* ---------- URL firmada para un archivo del bucket privado ---------- */
async function signedUrlFor(path) {
  if (!path) throw new Error("El campo no tiene cargada la ruta de sus datos GIS.");
  if (MODO_LOCAL) return `data/${path}`;
  if (MODO_FIXTURE) return `fixtures/${path}`;
  const { data, error } = await _sb.storage
    .from(GIS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------- Cerrar sesión ---------- */
async function doLogout() {
  if (!MODO_LOCAL && !MODO_FIXTURE) {
    try { await _sb.auth.signOut(); } catch (e) { console.warn(e); }
  }
  location.replace(location.pathname);   // limpia también el ?campo=
}

/* ---------- Cableado ---------- */
$("login-btn").addEventListener("click", doLogin);
$("login-pass-toggle").addEventListener("click", togglePassVisibility);
$("btn-logout").addEventListener("click", doLogout);

$("login-campo-select").addEventListener("change", e => {
  $("login-enter").disabled = !e.target.value;
});

$("login-enter").addEventListener("click", () => {
  const slug  = $("login-campo-select").value;
  const campo = AD_AUTH.campos.find(c => c.id === slug);
  if (campo) entrarAlVisor(campo);
});

/* Enter envía el formulario visible en cada estado */
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || overlay().classList.contains("hidden")) return;
  const estado = card().className;
  if (estado === "state-form") doLogin();
  else if (estado === "state-campos" && !$("login-enter").disabled) $("login-enter").click();
});

/* ---------- Arranque en modo local: sin Supabase, sin login ---------- */
async function arrancarLocal() {
  try {
    const r = await fetch("data/campos.local.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`data/campos.local.json respondió ${r.status}`);
    AD_AUTH.campos = await r.json();
    if (!AD_AUTH.campos.length) throw new Error("data/campos.local.json está vacío");
  } catch (err) {
    console.error("Modo local: no se pudo leer data/campos.local.json (¿corriste tools/gen_campos_local.py?):", err);
    setCardState("form");
    showError("Modo local: falta data/campos.local.json.");
    return;
  }

  /* Marca discreta para no confundir esta sesión con una de producción */
  const marca = document.createElement("div");
  marca.textContent = "modo local";
  marca.style.cssText = "position:fixed;left:6px;bottom:4px;z-index:9999;font:10px/1 sans-serif;" +
    "letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.55);" +
    "background:rgba(0,0,0,.35);padding:3px 6px;border-radius:3px;pointer-events:none";
  document.body.appendChild(marca);

  const pedido = new URLSearchParams(location.search).get("campo");
  entrarAlVisor(AD_AUTH.campos.find(c => c.id === pedido) || AD_AUTH.campos[0]);
}

/* ---------- Arranque en modo fixture: igual que el local, con el campo sintético ---------- */
async function arrancarFixture() {
  try {
    const r = await fetch("fixtures/campos.fixture.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`fixtures/campos.fixture.json respondió ${r.status}`);
    AD_AUTH.campos = await r.json();
  } catch (err) {
    console.error("Modo fixture: no se pudo leer fixtures/campos.fixture.json:", err);
    setCardState("form");
    showError("Modo fixture: falta fixtures/campos.fixture.json.");
    return;
  }
  const campo = AD_AUTH.campos.find(c => c.id === FIXTURE_ID);
  if (!campo) {
    console.error(`Modo fixture: no hay un campo "${FIXTURE_ID}" en fixtures/campos.fixture.json`);
    setCardState("form");
    showError(`Modo fixture: no existe el campo "${FIXTURE_ID}".`);
    return;
  }

  /* Misma marca discreta que el modo local, para no confundir esta sesión con una real */
  const marca = document.createElement("div");
  marca.textContent = "campo sintético";
  marca.style.cssText = "position:fixed;left:6px;bottom:4px;z-index:9999;font:10px/1 sans-serif;" +
    "letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.55);" +
    "background:rgba(0,0,0,.35);padding:3px 6px;border-radius:3px;pointer-events:none";
  document.body.appendChild(marca);

  entrarAlVisor(campo);
}

/* ---------- Arranque ---------- */
if (MODO_LOCAL) {
  arrancarLocal();
} else if (MODO_FIXTURE) {
  arrancarFixture();
} else if (initSupabase()) {
  /* Si la sesión anterior sigue viva (supabase-js la guarda y la renueva sola
     en localStorage) el usuario no vuelve a escribir la contraseña. Mientras se
     resuelve, la tarjeta muestra "Verificando sesión" en vez del formulario,
     así no parpadea un login que quizá no haga falta. */
  _sb.auth.getSession()
    .then(({ data }) => {
      if (!data.session) { setCardState("form"); $("login-email").focus(); return; }
      return afterLogin(data.session)
        .then(() => { if (AD_AUTH.campos.length) registrarAcceso("sesion"); });
    })
    .catch(err => {
      console.error("No se pudo restaurar la sesión:", err);
      setCardState("form");
      showError(traducirError(err));
    });

  /* Si la sesión caduca o se cierra en otra pestaña, volvemos al login en vez
     de dejar el visor fallando en silencio contra URLs que ya no se firman. */
  _sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && AD_AUTH.campo) location.replace(location.pathname);
  });
}
