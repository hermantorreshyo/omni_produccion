/* =====================================================================
 * [1004][JOSEPAN 360][OMNI] · app.js
 * Motor principal (JS Vanilla, sin frameworks). Router de vistas, captura
 * ergonomica de escaner, ciclo de produccion (contador masivo + tarjetas),
 * despacho por Outbox, banners semanticos, documentacion en vivo y
 * manejador global de errores (contingencia anti-crash).
 * ===================================================================== */
(function (OMNI) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ALLOWED_ROLES = /operario.*producc|supervisor.*planta|operario_produccion|supervisor_planta/i;

  var session = { user: null, token: null };
  var batch = []; // { id, sku, name, saleQty, saleUnit, baseQty, baseUnit }

  /* ---------------- ROUTER ---------------- */
  var VIEWS = ['setup-view', 'auth-view', 'production-view'];
  function showView(id) { VIEWS.forEach(function (v) { $(v).classList.toggle('hidden', v !== id); }); }

  function route() {
    if (!OMNI.store.isConfigured()) { OMNI.setup.start(); showView('setup-view'); return; }
    if (OMNI.store.getToken()) enterProduction();
    else enterAuth();
  }

  /* ---------------- CAPTURA DE ESCANER (HID, Zero-Typing) ---------------- */
  var ScanCapture = (function () {
    var buffer = '', lastTs = 0, cb = null, active = false, timer = null;
    function onKey(e) {
      if (!active) return;
      var now = Date.now();
      if (now - lastTs > 120) buffer = '';
      lastTs = now;
      if (e.key === 'Enter') { var code = buffer.trim(); buffer = ''; if (code && cb) { e.preventDefault(); cb(code); } return; }
      if (e.key && e.key.length === 1) { buffer += e.key; clearTimeout(timer); timer = setTimeout(function () { buffer = ''; }, 300); }
    }
    return {
      start: function (fn) { cb = fn; active = true; buffer = ''; document.addEventListener('keydown', onKey, true); },
      stop:  function () { active = false; cb = null; document.removeEventListener('keydown', onKey, true); }
    };
  })();

  /* ---------------- FOCO FORZADO ---------------- */
  var focusTrapId = null, focusTimer = null;
  function forceFocus() { var t = $(focusTrapId); if (t) { try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); } } }
  function startFocusGuard(id) { focusTrapId = id; forceFocus(); clearInterval(focusTimer); focusTimer = setInterval(forceFocus, 800); }
  function stopFocusGuard() { clearInterval(focusTimer); focusTrapId = null; }
  document.addEventListener('pointerup', function (e) {
    if (!focusTrapId) return;
    if ($('docs-modal') && !$('docs-modal').classList.contains('hidden')) return; // no robar foco al leer manual
    var t = e.target;
    if (t.closest && (t.closest('button') || t.closest('input') || t.closest('select'))) return;
    setTimeout(forceFocus, 40);
  });

  /* ---------------- LOGIN (PIN + escaneo) ---------------- */
  var pin = '';
  function renderPin() { $('pin-display').textContent = pin.replace(/./g, '•'); }
  function buildPinPad() {
    var pad = $('pin-pad'); if (pad.childElementCount) return;
    ['1','2','3','4','5','6','7','8','9','C','0','↵'].forEach(function (k) {
      var b = document.createElement('button');
      var base = 'touch num rounded-2xl font-bold text-3xl flex items-center justify-center ';
      b.className = base + (k === 'C' ? 'bg-edge text-ink' : k === '↵' ? 'bg-ok text-white' : 'bg-panel border-2 border-edge text-ink');
      b.style.height = '88px'; b.textContent = k;
      b.addEventListener('click', function () { onPinKey(k); });
      pad.appendChild(b);
    });
  }
  function onPinKey(k) {
    OMNI.feedback.action();
    if (k === 'C') pin = '';
    else if (k === '↵') return submitPin();
    else if (pin.length < 12) pin += k;
    renderPin();
  }
  function submitPin() { if (!pin) { authMsg('Introduzca su PIN.', 'err'); OMNI.feedback.error(); return; } doLogin(null, pin); }
  function authMsg(text, kind) {
    var el = $('auth-result');
    el.className = 'mt-5 text-base font-bold min-h-[1.5rem] ' + (kind === 'ok' ? 'text-ok' : kind === 'err' ? 'text-danger' : 'text-mute');
    el.textContent = text;
  }

  async function doLogin(badge, pinCode) {
    authMsg('Validando…', 'mute');
    try {
      var res = await OMNI.api.login(badge, pinCode);
      var claims = OMNI.store.decodeToken(res.token) || {};
      var roles = [].concat((res.user && (res.user.roles || res.user.role)) || claims.roles || []).map(String);
      if (!roles.some(function (r) { return ALLOWED_ROLES.test(r); })) {
        authMsg('Perfil no autorizado para esta terminal.', 'err'); OMNI.feedback.error(); pin = ''; renderPin(); return;
      }
      OMNI.store.setToken(res.token);
      session.token = res.token;
      session.user = res.user || { name: claims.name || claims.sub, roles: roles };
      OMNI.feedback.success(); pin = ''; renderPin();
      enterProduction();
    } catch (e) { authMsg('✗ ' + (e.message || 'Credenciales invalidas'), 'err'); OMNI.feedback.error(); pin = ''; renderPin(); }
  }

  function enterAuth() {
    var cfg = OMNI.store.getConfig();
    $('auth-node-name').textContent = (cfg && cfg.interlocutorName) || '';
    buildPinPad(); pin = ''; renderPin(); authMsg('', 'mute');
    showView('auth-view');
    startFocusGuard('auth-scan-trap');
    ScanCapture.start(function (code) { doLogin(code, null); }); // fotocheck autentica por credencial
  }

  /* ---------------- TERMINAL DE PRODUCCION ---------------- */
  async function enterProduction() {
    var cfg = OMNI.store.getConfig();
    session.token = OMNI.store.getToken();
    var claims = OMNI.store.decodeToken(session.token) || {};
    if (!session.user) session.user = { name: claims.name || claims.sub || 'Operario' };

    $('prod-factory').textContent = cfg.interlocutorName || ('Fabrica #' + cfg.interlocutorId);
    $('prod-operator').textContent = (session.user.name || 'Operario') + ' · turno activo';

    batch = []; renderCounter(); renderRecent();
    showView('production-view');
    startFocusGuard('prod-scan-trap');
    ScanCapture.start(onScan);

    try {
      if (navigator.onLine) await OMNI.api.refreshCatalog(cfg.interlocutorId);
      else OMNI.api.restoreCatalogFromCache();
    } catch (e) { OMNI.api.restoreCatalogFromCache(); OMNI.log('Catalogo desde cache.'); }
  }

  function totalUnits() { return batch.reduce(function (s, e) { return s + e.saleQty; }, 0); }
  function renderCounter() { $('prod-counter').textContent = OMNI.format(totalUnits()); $('btn-conclude').disabled = batch.length === 0; }

  function flashStage(kind) {
    var st = $('prod-stage');
    st.classList.remove('ok', 'err');
    void st.offsetWidth;
    st.classList.add(kind === 'ok' ? 'ok' : 'err');
    setTimeout(function () { st.classList.remove('ok', 'err'); }, 280);
  }

  function onScan(code) {
    var item = OMNI.units.resolve(code);
    if (!item) {
      flashStage('err'); OMNI.feedback.error();
      $('prod-last-sku').className = 'mt-4 text-base font-bold text-danger num min-h-[1.5rem]';
      $('prod-last-sku').textContent = '✗ SKU inexistente: ' + code;
      return;
    }
    var conv = OMNI.units.toBase(item, item.unitsPerScan);
    batch.push({
      id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6),
      sku: item.sku, name: item.name,
      saleQty: item.unitsPerScan, saleUnit: item.saleUnit,
      baseQty: conv.baseQty, baseUnit: conv.baseUnit
    });
    flashStage('ok'); OMNI.feedback.success();
    $('prod-last-sku').className = 'mt-4 text-base font-bold text-ok num min-h-[1.5rem]';
    $('prod-last-sku').textContent = '✓ ' + item.name + '  +' + item.unitsPerScan + ' ' + item.saleUnit;
    renderCounter(); renderRecent();
  }

  function renderRecent() {
    var wrap = $('prod-recent'), recent = batch.slice(-4).reverse();
    if (!recent.length) { wrap.innerHTML = '<div class="text-mute text-sm py-3 num">— Sin lecturas en el pallet actual —</div>'; return; }
    wrap.innerHTML = '';
    recent.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'flex items-center gap-3 bg-panel border border-edge rounded-xl p-3';
      row.innerHTML =
        '<div class="flex-1 min-w-0"><div class="font-extrabold truncate">' + e.name + '</div>' +
        '<div class="text-mute text-xs num truncate">' + e.sku + ' · +' + e.saleQty + ' ' + e.saleUnit + '</div></div>' +
        '<button class="touch shrink-0 rounded-xl text-danger flex items-center justify-center text-2xl" style="width:70px;height:70px;background:#fef2f2;" aria-label="Eliminar lectura">🗑</button>';
      row.querySelector('button').addEventListener('click', function () { removeRead(e.id); });
      wrap.appendChild(row);
    });
  }

  function removeRead(id) {
    var i = batch.findIndex(function (e) { return e.id === id; });
    if (i >= 0) { batch.splice(i, 1); OMNI.feedback.action(); renderCounter(); renderRecent(); }
  }

  async function concludeTransfer() {
    if (!batch.length) return;
    if (OMNI.outbox.isFrozen()) { OMNI.feedback.error(); return; }

    var bySku = {};
    batch.forEach(function (e) {
      if (!bySku[e.sku]) bySku[e.sku] = { sku: e.sku, name: e.name, baseQty: 0, baseUnit: e.baseUnit, saleQty: 0, saleUnit: e.saleUnit };
      bySku[e.sku].baseQty += e.baseQty; bySku[e.sku].saleQty += e.saleQty;
    });
    var items = Object.keys(bySku).map(function (k) { var it = bySku[k]; it.baseQty = Math.round(it.baseQty * 1000) / 1000; return it; });

    var payload = {
      idempotencyKey: 'TX-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(), items: items
    };

    $('btn-conclude').disabled = true;
    try {
      await OMNI.outbox.push(payload); // Outbox-first: resiliente a microcortes
      OMNI.feedback.success(); flashStage('ok');
      $('prod-last-sku').className = 'mt-4 text-base font-bold text-ok num min-h-[1.5rem]';
      $('prod-last-sku').textContent = '→ Traspaso despachado (' + items.length + ' SKU)';
      batch = []; renderCounter(); renderRecent();
    } catch (e) {
      OMNI.feedback.error(); flashStage('err');
      $('prod-last-sku').textContent = '✗ No se pudo encolar: ' + (e.message || 'error');
    } finally { forceFocus(); }
  }

  /* ---------------- BANNERS (amarillo offline / rojo congelado) ---------------- */
  function bindOutboxBanners() {
    OMNI.outbox.onChange(function (st) {
      var off = $('offline-banner'), sync = $('sync-error-banner');
      if (st.frozen) {
        var info = OMNI.outbox.frozenInfo();
        $('sync-error-detail').textContent = (info && info.reason) || 'Transaccion rechazada por el servidor.';
        sync.classList.remove('hidden'); off.classList.add('hidden'); return;
      }
      sync.classList.add('hidden');
      if (!st.online || st.pending > 0) {
        $('offline-count').textContent = st.pending;
        $('offline-label').textContent = st.online ? 'SINCRONIZANDO' : 'MODO OFFLINE';
        off.classList.toggle('hidden', st.online && st.pending === 0);
      } else { off.classList.add('hidden'); }
    });
  }

  /* ---------------- DESBLOQUEO OUTBOX (supervisor) ---------------- */
  function buildUnfreezeModal() {
    var m = document.createElement('div');
    m.id = 'unfreeze-modal';
    m.className = 'hidden fixed inset-0 z-[70] bg-black/70 flex items-center justify-center px-5';
    m.innerHTML =
      '<div class="w-full max-w-sm bg-white border-2 border-danger rounded-2xl p-5">' +
        '<h2 class="font-black text-xl text-danger mb-1">Intervencion de Supervisor</h2>' +
        '<p class="text-mute text-sm mb-4">Revise el rechazo y autentiquese para reanudar la cola.</p>' +
        '<input id="uf-user" type="text" placeholder="Usuario supervisor" class="w-full bg-white border-2 border-edge rounded-xl px-4 py-3 mb-3 outline-none focus:border-danger">' +
        '<input id="uf-pin" type="password" inputmode="numeric" placeholder="PIN" class="num w-full bg-white border-2 border-edge rounded-xl px-4 py-3 mb-4 outline-none focus:border-danger">' +
        '<div id="uf-msg" class="text-sm font-bold text-danger mb-3 min-h-[1rem]"></div>' +
        '<div class="flex gap-3"><button id="uf-cancel" class="touch flex-1 rounded-xl bg-edge text-ink font-bold">Cancelar</button>' +
        '<button id="uf-ok" class="touch flex-1 rounded-xl bg-ok text-white font-extrabold">Reanudar</button></div>' +
      '</div>';
    document.body.appendChild(m);

    $('sync-error-banner').addEventListener('click', function () {
      stopFocusGuard(); m.classList.remove('hidden');
      $('uf-user').value = ''; $('uf-pin').value = ''; $('uf-msg').textContent = '';
    });
    $('uf-cancel').addEventListener('click', function () { m.classList.add('hidden'); if (focusTrapId) startFocusGuard(focusTrapId); });
    $('uf-ok').addEventListener('click', async function () {
      var u = $('uf-user').value.trim(), p = $('uf-pin').value.trim();
      if (!u || !p) { $('uf-msg').textContent = 'Complete usuario y PIN.'; return; }
      try {
        var res = await OMNI.api.login(u, p);
        var roles = [].concat((res.user && (res.user.roles || res.user.role)) || (OMNI.store.decodeToken(res.token) || {}).roles || []).map(String);
        if (!roles.some(function (r) { return /supervisor|admin/i.test(r); })) { $('uf-msg').textContent = 'Requiere perfil de supervisor.'; OMNI.feedback.error(); return; }
        OMNI.outbox.supervisorUnfreeze(); m.classList.add('hidden'); OMNI.feedback.success();
        if (focusTrapId) startFocusGuard(focusTrapId);
      } catch (e) { $('uf-msg').textContent = e.message || 'Autenticacion fallida.'; OMNI.feedback.error(); }
    });
  }

  /* ---------------- DOCUMENTACION EN VIVO (visor de manual.html) ---------------- */
  function bindDocs() {
    var modal = $('docs-modal'), frame = $('docs-frame');
    function open(hash) {
      OMNI.feedback.action(); stopFocusGuard();
      // Carga diferida del manual (una sola fuente: manual.html).
      var src = 'manual.html' + (hash ? ('#' + hash) : '');
      if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
      modal.classList.remove('hidden');
    }
    function close() { modal.classList.add('hidden'); if (focusTrapId) startFocusGuard(focusTrapId); }
    document.querySelectorAll('[data-open-docs]').forEach(function (b) {
      b.addEventListener('click', function () { open(b.getAttribute('data-docs-section') || ''); });
    });
    $('docs-close').addEventListener('click', close);
  }

  /* ---------------- ANTI-CRASH ---------------- */
  function showCrash(detail) { $('error-detail').textContent = detail || 'Error inesperado del terminal.'; $('error-view').classList.remove('hidden'); }
  function bindCrashHandler() {
    window.addEventListener('error', function (e) { showCrash((e.message || 'Error') + ''); });
    window.addEventListener('unhandledrejection', function (e) { var r = e.reason || {}; showCrash((r.message || 'Promesa rechazada') + ''); });
    $('btn-error-retry').addEventListener('click', function () { $('error-view').classList.add('hidden'); OMNI.feedback.action(); forceFocus(); route(); });
  }

  /* ---------------- LOGOUT / ENLACES ---------------- */
  function bindActions() {
    $('btn-logout').addEventListener('click', function () {
      OMNI.feedback.action(); ScanCapture.stop(); OMNI.store.clearToken();
      session = { user: null, token: null }; batch = []; enterAuth();
    });
    $('btn-conclude').addEventListener('click', concludeTransfer);
  }

  OMNI.format = function (n) { try { return Number(n).toLocaleString('es-ES'); } catch (e) { return String(n); } };

  /* ---------------- ARRANQUE ---------------- */
  function boot() {
    bindCrashHandler(); bindActions(); bindOutboxBanners(); buildUnfreezeModal(); bindDocs();
    OMNI.outbox.init(); route();
    OMNI.log('Terminal [1004] v2 iniciado.');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

})(window.OMNI = window.OMNI || {});
