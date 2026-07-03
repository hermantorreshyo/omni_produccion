/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1004] PRODUCCIÓN EN PLANTA — app.js (vanilla)
 *  Proxy api/omni.php { endpoint, method, payload }. Token en sesión PHP.
 *  Login → (vista) selección de sede → terminal. Catálogo por categorías configurables.
 *  KPIs desde el kardex del API (analytics/kardex). Escaneo + tecleo + buscador. Menú.
 * ═══════════════════════════════════════════════════════════════════════════
 */
'use strict';
(function () {

  /* ════ 0. UTILIDADES ════ */
  var $ = function (id) { return document.getElementById(id); };
  var OUTBOX_KEY = 'omni1004.outbox', FROZEN_KEY = 'omni1004.frozen', CAT_KEY = 'omni1004.catalog';
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var CFG = null, canConfigure = false, sessionUser = null, activeSite = null;
  var locations = [], custody = null, transit = null, batch = [], catState = [];

  function toast(msg, kind) {
    var box = $('toast-box'), t = $('toast');
    box.textContent = msg;
    box.className = 'rounded-xl px-5 py-3 text-white text-sm font-semibold shadow-lg ' + (kind === 'ok' ? 'bg-ok' : kind === 'err' ? 'bg-danger' : kind === 'warn' ? 'bg-warn' : 'bg-ink-900');
    t.classList.remove('hide'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hide'); }, 2600);
  }
  function showView(id) { ['login-view', 'site-view', 'prod-view'].forEach(function (v) { $(v).classList.toggle('active', v === id); }); }
  function roleIsAdmin() { var r = ((sessionUser && (sessionUser.rol || sessionUser.role)) || '').toLowerCase(); return r === '' || /super|admin|director|supervisor|jefe|encargad/.test(r); }

  /* ════ 1. FEEDBACK ════ */
  var Feedback = (function () {
    var ctx = null;
    function ac() { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} return ctx; }
    function beep(f, ms, type) { var a = ac(); if (!a) return; var o = a.createOscillator(), g = a.createGain(); o.type = type || 'sine'; o.frequency.value = f; o.connect(g); g.connect(a.destination); g.gain.setValueAtTime(0.12, a.currentTime); o.start(); o.stop(a.currentTime + ms / 1000); }
    function vibe(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
    return { ok: function () { beep(880, 90); vibe(40); }, err: function () { beep(220, 240, 'square'); vibe([60, 50, 60]); }, action: function () { beep(660, 60); vibe(20); } };
  })();

  /* ════ 2. CLIENTE → api/omni.php ════ */
  function parseOmniResponse(r) { return { ok: r && r.status === 'success', data: (r && r.data) != null ? r.data : null, error: (r && r.status === 'error') ? r.message : null, code: (r && r.error_code) || null }; }
  async function omniFetch(endpoint, method, payload) {
    var res;
    try {
      res = await fetch('api/omni.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: endpoint, method: method || 'GET', payload: payload || null }), redirect: 'manual', cache: 'no-store' });
    } catch (e) { var ne = new Error('Sin conexión con el servidor.'); ne.network = true; throw ne; }
    if (res.type === 'opaqueredirect' || res.status === 0) { var rr = new Error('El servidor redirigió api/omni.php (302). Revisa el despliegue y el .htaccess.'); rr.deploy = true; throw rr; }
    var text = ''; try { text = await res.text(); } catch (e) {}
    var ct = (res.headers.get('content-type') || '').toLowerCase(), json = null;
    if (ct.indexOf('json') >= 0 || (text && text.trim().charAt(0) === '{')) { try { json = JSON.parse(text); } catch (e) {} }
    if (!json) { var pe = new Error('api/omni.php no devolvió JSON (HTTP ' + res.status + '). ¿Existe y ejecuta PHP?'); pe.deploy = true; throw pe; }
    var r = parseOmniResponse(json);
    if (!r.ok) { var err = new Error(r.error || ('HTTP ' + res.status)); err.status = res.status; err.code = r.code; err.rejected = (res.status >= 400 && res.status < 500); throw err; }
    return r.data;
  }
  function rowsOf(data) { if (!data) return []; if (Array.isArray(data.rows)) return data.rows; if (Array.isArray(data)) return data; if (data.data && Array.isArray(data.data.rows)) return data.data.rows; if (data.data && Array.isArray(data.data)) return data.data; return []; }

  /* ════ 3. CATÁLOGO + BÚSQUEDA ════ */
  var Catalog = (function () {
    var byEan = Object.create(null), bySku = Object.create(null), all = [];
    function load(rows) {
      byEan = Object.create(null); bySku = Object.create(null); all = [];
      (rows || []).forEach(function (p) {
        var it = { id: p.id, sku: (p.sku_final_code || p.sku) != null ? String(p.sku_final_code || p.sku) : null, ean: p.ean != null ? String(p.ean) : null, name: p.name || p.nombre || p.sku_final_code || ('SKU ' + p.id), unit: (p.unit_of_measure || 'ud').toString().toLowerCase() };
        if (it.ean) byEan[it.ean] = it; if (it.sku) bySku[it.sku] = it; all.push(it);
      });
    }
    return {
      load: load, size: function () { return all.length; },
      list: function () { return all.slice(); },
      resolve: function (c) { c = String(c || '').trim(); return byEan[c] || bySku[c] || null; },
      search: function (q, limit) { q = String(q || '').trim().toLowerCase(); if (!q) return []; var out = []; for (var i = 0; i < all.length && out.length < (limit || 8); i++) { var it = all[i]; if (((it.name || '') + ' ' + (it.sku || '') + ' ' + (it.ean || '')).toLowerCase().indexOf(q) >= 0) out.push(it); } return out; },
      persist: function (rows) { try { lsSet(CAT_KEY, JSON.stringify(rows)); } catch (e) {} },
      restore: function () { try { var r = ls(CAT_KEY); if (r) load(JSON.parse(r)); } catch (e) {} return all.length; }
    };
  })();
  async function refreshCatalog() {
    var acc = [], types = (CFG && CFG.accepted_categories) || ['PT'];
    for (var i = 0; i < types.length; i++) {
      var off = 0, guard = 0;
      while (guard++ < 40) {
        var qs = 'catalog/skus?item_type=' + encodeURIComponent(types[i]) + '&limit=50' + (off > 0 ? '&offset=' + off : '');
        var rows;
        try { rows = rowsOf(await omniFetch(qs, 'GET')); }
        catch (e) { if (off === 0) throw e; break; }   // 1ª página propaga el error; siguientes, best-effort
        acc = acc.concat(rows);
        if (rows.length < 50) break; off += 50;
      }
    }
    Catalog.load(acc); Catalog.persist(acc); return Catalog.size();
  }

  /* ════ 3b. RECETAS (SKU producido → recipe_id) ════ */
  var Recipes = (function () {
    var bySku = Object.create(null), count = 0;
    return {
      load: function (rows) {
        bySku = Object.create(null); count = 0;
        (rows || []).forEach(function (r) {
          var sku = r.product_sku_id != null ? r.product_sku_id : (r.sku_id != null ? r.sku_id : r.product_id);
          var rid = r.id != null ? r.id : r.recipe_id;
          if (sku != null && rid != null) { bySku[String(sku)] = { recipeId: rid, name: r.product_name || r.product || r.name || null }; count++; }
        });
      },
      forSku: function (itemId) { return bySku[String(itemId)] || null; },
      size: function () { return count; }
    };
  })();
  async function refreshRecipes() { try { Recipes.load(rowsOf(await omniFetch('production/recipes', 'GET'))); } catch (e) {} return Recipes.size(); }

  /* ════ 3c. RBAC DE PANTALLAS (my-screens §16.1) ════ */
  var screens = '*'; // '*' = todo; [] = sin acceso; ['historial',...] = solo esas
  async function loadScreens() {
    try {
      var d = await omniFetch('rbac/subsystems/1004/my-screens', 'GET');
      var s = d && d.screens;
      if (s === '*' || s == null) screens = '*';
      else if (Array.isArray(s)) screens = s;
      else screens = '*';
    } catch (e) { screens = '*'; } // ante error de red, no bloquear al operario
  }
  function canScreen(key) { return screens === '*' || (Array.isArray(screens) && screens.indexOf(key) >= 0); }
  function hasAnyAccess() { return screens === '*' || (Array.isArray(screens) && screens.length > 0); }

  /* ════ 4. HISTORIAL LOCAL (registrado hoy + respaldo KPI) ════ */
  var History = {
    key: function () { var u = sessionUser || {}; return 'omni1004.hist.' + (u.id || u.username || u.nombre || 'anon'); },
    read: function () { try { return JSON.parse(ls(this.key()) || '[]'); } catch (e) { return []; } },
    add: function (p) { var h = this.read(); h.unshift(p); if (h.length > 300) h = h.slice(0, 300); lsSet(this.key(), JSON.stringify(h)); },
    kpis: function () { var h = this.read(), s = new Date(); s.setHours(0, 0, 0, 0); var t0 = s.getTime(), u = 0, sk = {}, p = 0; h.forEach(function (x) { if (new Date(x.ts).getTime() >= t0) { p++; (x.lines || []).forEach(function (l) { u += l.qty; sk[l.itemId] = 1; }); } }); return { units: u, moves: p, skus: Object.keys(sk).length, last: h[0] ? h[0].ts : null }; },
    topItems: function (n) { var h = this.read(), freq = {}; h.forEach(function (x) { (x.lines || []).forEach(function (l) { var k = String(l.itemId); freq[k] = (freq[k] || 0) + (l.qty || 1); }); }); return Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, n || 8); }
  };

  /* ════ 5. KPIs DESDE ÓRDENES DE PRODUCCIÓN COMPLETADAS ════ */
  function computeKpis(rows) {
    var uid = sessionUser && (sessionUser.id || sessionUser.user_id);
    var uname = sessionUser && (sessionUser.username || sessionUser.nombre || sessionUser.name);
    var hasUser = rows.some(function (r) { return ('completed_by_user_id' in r) || ('registered_by' in r) || ('created_by_user_id' in r) || ('user_id' in r); });
    function mine(r) { if (!hasUser) return true; var u = r.completed_by_user_id != null ? r.completed_by_user_id : (r.registered_by != null ? r.registered_by : (r.created_by_user_id != null ? r.created_by_user_id : r.user_id)); if (uid != null && String(u) === String(uid)) return true; if (uname && (r.username === uname || r.user_name === uname)) return true; return false; }
    var s = new Date(); s.setHours(0, 0, 0, 0); var t0 = s.getTime();
    var tU = 0, tM = 0, tS = {}, wU = 0, wM = 0, last = null;
    rows.forEach(function (r) {
      if (!mine(r)) return;
      var q = Math.abs(Number(r.quantity_real != null ? r.quantity_real : (r.quantity != null ? r.quantity : 0))) || 0;
      var ts = r.end_time || r.completed_at || r.created_at || r.start_time; var tm = ts ? new Date(ts).getTime() : 0;
      wU += q; wM++; if (!last || tm > new Date(last).getTime()) last = ts;
      if (tm >= t0) { tU += q; tM++; var sku = r.product_sku_id != null ? r.product_sku_id : r.recipe_id; if (sku != null) tS[sku] = 1; }
    });
    return { todayUnits: Math.round(tU), todayMoves: tM, todaySkus: Object.keys(tS).length, weekUnits: Math.round(wU), weekMoves: wM, last: last, hasUser: hasUser };
  }
  function renderKpis(k, src) {
    $('kpi-units').textContent = k.todayUnits || 0; $('kpi-moves').textContent = k.todayMoves || 0; $('kpi-skus').textContent = k.todaySkus || 0;
    $('kpi-week').textContent = '7 días: ' + (k.weekUnits || 0) + ' u · ' + (k.weekMoves || 0) + ' OPs';
    $('kpi-last').textContent = k.last ? ('Última actividad: ' + new Date(k.last).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) : 'Sin actividad reciente.';
    $('kpi-source').textContent = src === 'API' ? (k.hasUser === false ? 'API · sede' : 'API · tú') : 'local';
  }
  async function loadKpis() {
    try {
      var from = new Date(); from.setDate(from.getDate() - 7);
      var data = await omniFetch('production/orders?status=completado&date_from=' + fmtDate(from), 'GET');
      renderKpis(computeKpis(rowsOf(data)), 'API');
    } catch (e) {
      var k = History.kpis();
      renderKpis({ todayUnits: k.units, todayMoves: k.moves, todaySkus: k.skus, weekUnits: k.units, weekMoves: k.moves, last: k.last, hasUser: true }, 'local');
    }
  }

  /* ════ 6. OUTBOX FIFO ════ */
  var Outbox = (function () {
    var draining = false;
    function read() { try { return JSON.parse(ls(OUTBOX_KEY) || '[]'); } catch (e) { return []; } }
    function write(q) { lsSet(OUTBOX_KEY, JSON.stringify(q)); }
    function frozen() { return ls(FROZEN_KEY) === '1'; }
    function setFrozen(r) { lsSet(FROZEN_KEY, '1'); lsSet(FROZEN_KEY + '.r', r || ''); }
    function clearFrozen() { lsDel(FROZEN_KEY); lsDel(FROZEN_KEY + '.r'); }
    function render() {
      var q = read(), off = $('offline-banner'), sync = $('sync-banner');
      if (frozen()) { $('sync-detail').textContent = ls(FROZEN_KEY + '.r') || 'requiere supervisor'; sync.classList.remove('hidden'); off.classList.add('hidden'); return; }
      sync.classList.add('hidden');
      if (q.length > 0 || !navigator.onLine) { $('offline-count').textContent = q.length; $('offline-label').textContent = navigator.onLine ? 'SINCRONIZANDO' : 'MODO OFFLINE'; off.classList.toggle('hidden', navigator.onLine && q.length === 0); } else off.classList.add('hidden');
    }
    async function dispatch(p, save) {
      // Ciclo de producción: crear OP → ejecutar → completar (con lote). Resumible.
      if (p.orderId == null) {
        var c = await omniFetch('production/orders', 'POST', { recipe_id: p.recipeId, interlocutor_id: p.interlocutorId, quantity_target: p.quantity });
        p.orderId = (c && (c.id != null ? c.id : (c.order_id != null ? c.order_id : (c.data && c.data.id)))) || null;
        if (p.orderId == null) { var e0 = new Error('La creación de la OP no devolvió id'); e0.rejected = true; throw e0; }
        save();
      }
      if (!p.executed) { await omniFetch('production/orders/' + p.orderId + '/execute', 'PUT', null); p.executed = true; save(); }
      return omniFetch('production/orders/' + p.orderId + '/complete', 'PUT', { quantity_real: p.quantity, output_location_id: p.outputLocationId });
    }
    async function drain() {
      if (draining || frozen() || !navigator.onLine) { render(); return; }
      draining = true; render();
      try {
        var q = read();
        while (q.length) {
          try { await dispatch(q[0], function () { write(q); }); }
          catch (e) { write(q); if (e.rejected) { setFrozen(e.message || 'Orden de producción rechazada'); Feedback.err(); break; } else break; }
          q.shift(); write(q); render();
        }
      } finally { draining = false; render(); if ($('drawer').classList.contains('open')) loadKpis(); }
    }
    return { push: function (p) { var q = read(); q.push(p); write(q); render(); drain(); }, drain: drain, render: render, frozen: frozen, resume: function () { clearFrozen(); render(); drain(); } };
  })();

  /* ════ 7. ESCÁNER HID ════ */
  var Scan = (function () {
    var buf = '', last = 0, cb = null, on = false;
    function handler(e) {
      if (!on) return; if (document.activeElement === $('sku-search')) return;
      var now = Date.now(); if (now - last > 120) buf = ''; last = now;
      if (e.key === 'Enter') { if (buf.length >= 3 && cb) cb(buf); buf = ''; return; }
      if (e.key && e.key.length === 1) buf += e.key;
    }
    return { start: function (fn) { cb = fn; on = true; buf = ''; document.addEventListener('keydown', handler); }, stop: function () { on = false; cb = null; document.removeEventListener('keydown', handler); } };
  })();

  /* ════ 8. LOGIN → SEDE ════ */
  function loginMsg(t, kind) { var el = $('login-msg'); el.className = 'mt-4 text-sm font-medium min-h-[1.25rem] text-center ' + (kind === 'ok' ? 'text-ok' : kind === 'err' ? 'text-danger' : 'text-ink-500'); el.textContent = t; }
  function siteMsg(t, kind) { var el = $('site-msg'); el.className = 'mt-4 text-sm font-medium min-h-[1.25rem] text-center ' + (kind === 'ok' ? 'text-ok' : kind === 'err' ? 'text-danger' : 'text-ink-500'); el.textContent = t; }

  async function submitLogin() {
    var u = $('login-user').value.trim(), p = $('login-pass').value;
    if (!u || !p) { loginMsg('Introduzca usuario y contraseña.', 'err'); Feedback.err(); return; }
    loginMsg('Validando…', 'mute'); $('btn-login').disabled = true;
    try {
      var data = await omniFetch('auth/login', 'POST', { username: u, password: p });
      sessionUser = data && data.user; canConfigure = roleIsAdmin();
      Feedback.ok(); loginMsg('', 'mute');
      await goToSiteSelection();
    } catch (e) { loginMsg('✗ ' + (e.message || 'Credenciales inválidas'), 'err'); Feedback.err(); $('login-pass').value = ''; }
    finally { $('btn-login').disabled = false; }
  }
  async function goToSiteSelection() {
    $('site-user').textContent = (sessionUser && (sessionUser.nombre || sessionUser.name || sessionUser.username)) || '';
    siteMsg('Cargando fábricas…', 'mute'); showView('site-view');
    try { await loadFabricas(); siteMsg('', 'mute'); }
    catch (e) { siteMsg('✗ ' + (e.message || 'No se pudieron cargar fábricas'), 'err'); }
  }
  async function loadFabricas() {
    // Todas las sedes operativas (fábricas y puntos de venta): los PdV también fabrican.
    var data = await omniFetch('catalog/interlocutors', 'GET');
    var rows = rowsOf(data).filter(function (it) { return String(it.type || '').toLowerCase() !== 'empresa'; });
    var sel = $('login-site');
    sel.innerHTML = '<option value="">— Seleccione sede —</option>';
    rows.forEach(function (it) { var id = it.id || it.interlocutor_id, name = it.commercial_name || it.fiscal_name || it.name || ('Sede ' + id); sel.insertAdjacentHTML('beforeend', '<option value="' + id + '" data-name="' + String(name).replace(/"/g, '') + '">' + name + '</option>'); });
  }
  async function enterSite() {
    var sel = $('login-site'); if (!sel.value) { siteMsg('Seleccione una fábrica.', 'err'); Feedback.err(); return; }
    var opt = sel.options[sel.selectedIndex];
    siteMsg('Preparando terminal…', 'mute'); $('btn-enter').disabled = true;
    try { var d = await omniFetch('select-interlocutor', 'POST', { interlocutor_id: parseInt(sel.value, 10), interlocutor_name: opt.getAttribute('data-name') }); activeSite = d.interlocutor; if (d.user) { sessionUser = d.user; canConfigure = roleIsAdmin(); } await startTerminal(); }
    catch (e) { siteMsg('✗ ' + (e.message || 'No se pudo entrar'), 'err'); Feedback.err(); }
    finally { $('btn-enter').disabled = false; }
  }

  /* ════ 9. UBICACIONES ════ */
  function locLabel(l) { var a = (l.area_type || '').replace(/_/g, ' '); var sp = [l.shelf, l.position].filter(Boolean).join(' '); var qr = l.qr_code_uid ? (' · ' + l.qr_code_uid) : ''; return ([a, sp].filter(Boolean).join(' ') || ('Ubicación ' + (l.id || l.location_id))) + qr; }
  async function loadLocations() {
    var data = await omniFetch('catalog/locations', 'GET'); locations = rowsOf(data);
    var cp = new RegExp((CFG && CFG.custody_pattern) || 'producto_terminado', 'i');
    // Ubicación de SALIDA del PT (output_location_id): zona de producto terminado de la sede; si no, su 1ª ubicación.
    var out = null;
    locations.forEach(function (l) { if (!out && cp.test((l.area_type || '').toString())) out = { id: l.id || l.location_id, name: locLabel(l) }; });
    if (!out && locations.length) { var l0 = locations[0]; out = { id: l0.id || l0.location_id, name: locLabel(l0) }; }
    custody = out; transit = out;
    fillLocSelect($('drw-custody'), custody && custody.id);
  }
  function fillLocSelect(sel, current) { sel.innerHTML = '<option value="">— Seleccione —</option>'; locations.forEach(function (l) { var id = l.id || l.location_id; sel.insertAdjacentHTML('beforeend', '<option value="' + id + '"' + (String(id) === String(current) ? ' selected' : '') + '>' + locLabel(l) + '</option>'); }); }
  function onLocChange() { var c = $('drw-custody'); if (c.value) { custody = { id: parseInt(c.value, 10), name: c.options[c.selectedIndex].textContent }; transit = custody; } renderLocLine(); toast('Ubicación de salida actualizada.', 'ok'); }
  function renderLocLine() {
    $('loc-custody').textContent = 'Salida PT:';
    $('loc-transit').textContent = (custody && custody.name) || '— sin ubicación —';
  }

  /* ════ 10. TERMINAL ════ */
  async function startTerminal() {
    var u = sessionUser || {};
    if (navigator.onLine) { await loadScreens(); if (!hasAnyAccess()) { siteMsg('Tu rol no tiene acceso a Producción en esta sede.', 'err'); showView('site-view'); Feedback.err(); return; } }
    $('prod-factory').textContent = (activeSite && activeSite.name) || 'Sede';
    $('prod-operator').textContent = u.nombre || u.name || u.username || 'Operario';
    $('prod-role').textContent = u.rol || u.role || '';
    batch = []; renderCounter(); renderRecent(); renderChips(); renderGrid();
    showView('prod-view'); Scan.start(onScan); Outbox.render(); Outbox.drain(); siteMsg('', 'mute'); forceFocus();
    try { await loadLocations(); } catch (e) { toast('No se pudieron cargar ubicaciones.', 'warn'); }
    renderLocLine();
    if (navigator.onLine) { try { await refreshCatalog(); } catch (e) { Catalog.restore(); toast('Catálogo: ' + (e.message || 'no se pudo cargar'), 'warn'); } } else Catalog.restore();
    if (navigator.onLine) { try { await refreshRecipes(); } catch (e) {} }
    renderChips(); renderGrid();
  }
  function forceFocus() { try { $('scan-trap').focus(); } catch (e) {} }
  function flashStage(kind) { var s = $('prod-stage'); s.classList.remove('ok', 'err'); void s.offsetWidth; s.classList.add(kind); setTimeout(function () { s.classList.remove('ok', 'err'); }, 260); }
  function totalUnits() { return batch.reduce(function (a, e) { return a + e.qty; }, 0); }
  function renderCounter() {
    var t = totalUnits(), empty = batch.length === 0;
    $('prod-counter').textContent = t; $('btn-conclude').disabled = empty;
    var mc = $('prod-mcount'); if (mc) mc.textContent = t;
    var mg = $('prod-mgo'); if (mg) mg.disabled = empty;
    if (t > 0) { var c = $('prod-counter'); c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse'); }
  }

  function addItem(item, via, qty) {
    qty = qty || 1;
    var existing = batch.find(function (e) { return String(e.itemId) === String(item.id); });
    if (existing) { existing.qty += qty; batch.splice(batch.indexOf(existing), 1); batch.push(existing); }
    else batch.push({ rid: 'r' + Date.now() + Math.random().toString(36).slice(2, 5), itemId: item.id, sku: item.sku, name: item.name, qty: qty, unit: item.unit });
    flashStage('ok'); Feedback.ok();
    $('prod-last').textContent = '✓ ' + item.name + '  +' + qty + ' ' + item.unit + (via ? ' (' + via + ')' : '');
    $('sku-qty').value = '1';
    renderCounter(); renderRecent(); updateTile(item.id);
  }
  function onScan(code) { var item = Catalog.resolve(code); if (!item) { flashStage('err'); Feedback.err(); $('prod-last').textContent = '✗ SKU inexistente: ' + code; return; } addItem(item, 'escáner', readQty()); }
  function changeQty(rid, d) { var e = batch.find(function (x) { return x.rid === rid; }); if (!e) return; e.qty = Math.max(1, e.qty + d); Feedback.action(); renderCounter(); renderRecent(); updateTile(e.itemId); forceFocus(); }
  function renderRecent() {
    var wrap = $('prod-recent'), items = batch.slice().reverse();
    if (!items.length) { wrap.innerHTML = '<div class="pv-liempty"><span class="pv-big">👋</span>Aún no hay productos en el lote. Toca uno para empezar.</div>'; return; }
    wrap.innerHTML = '';
    items.forEach(function (e) {
      var row = document.createElement('div'); row.className = 'pv-li';
      row.innerHTML = '<span class="pv-lem">' + emojiFor(e.name) + '</span>' +
        '<span class="pv-lnm"><b>' + e.name + '</b><small>' + (e.sku || ('#' + e.itemId)) + ' · ' + e.unit + '</small></span>' +
        '<span class="pv-stp"><button data-a="dec">−</button><span class="pv-q num">' + e.qty + '</span><button data-a="inc">+</button></span>' +
        '<button data-a="del" class="pv-del" aria-label="Quitar">🗑</button>';
      row.querySelector('[data-a="dec"]').addEventListener('click', function () { changeQty(e.rid, -1); });
      row.querySelector('[data-a="inc"]').addEventListener('click', function () { changeQty(e.rid, 1); });
      row.querySelector('[data-a="del"]').addEventListener('click', function () { removeRead(e.rid); });
      wrap.appendChild(row);
    });
  }
  function removeRead(rid) { var i = batch.findIndex(function (e) { return e.rid === rid; }); if (i >= 0) { var iid = batch[i].itemId; batch.splice(i, 1); Feedback.action(); renderCounter(); renderRecent(); updateTile(iid); forceFocus(); } }

  /* ════ MODO VISUAL: rejilla de productos tocables ════ */
  var pvFilter = 'fav', pvQuery = '';
  function emojiFor(name) {
    var n = (name || '').toLowerCase();
    var map = [[/baguette|barra/, '🥖'], [/croissant|ensaimad|napolitan/, '🥐'], [/empanad/, '🥟'],
      [/tarta|pastel/, '🥧'], [/magdalen|muffin|lionesa|cupcake/, '🧁'], [/donut|rosquill|rosco/, '🍩'],
      [/palmera|hojaldr/, '🥨'], [/galleta|cookie/, '🍪'], [/bollo|suizo/, '🥯'],
      [/pan|hogaza|chapata|payes|payés|molde|integral|pueblo/, '🍞']];
    for (var i = 0; i < map.length; i++) { if (map[i][0].test(n)) return map[i][1]; }
    return '📦';
  }
  function tintFor(name) {
    var pal = ['#fbf0df', '#fdeede', '#fbe6e3', '#f3ecfa', '#e8f3ef', '#eaf1fb', '#fdf4e3'];
    var s = String(name || ''), h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return pal[h % pal.length];
  }
  function qtyOf(itemId) { var e = batch.find(function (x) { return String(x.itemId) === String(itemId); }); return e ? e.qty : 0; }
  function renderChips() {
    var box = $('prod-chips'); if (!box) return; box.innerHTML = '';
    [['fav', '⭐ Más usados'], ['all', 'Todos']].forEach(function (it) {
      var b = document.createElement('button'); b.className = 'pv-chip'; b.setAttribute('aria-pressed', pvFilter === it[0]); b.textContent = it[1];
      b.addEventListener('click', function () { pvFilter = it[0]; pvQuery = ''; $('sku-search').value = ''; renderResults([]); renderChips(); renderGrid(); });
      box.appendChild(b);
    });
  }
  function pvVisible() {
    var all = Catalog.list();
    if (pvQuery) { var q = pvQuery.toLowerCase(); return all.filter(function (p) { return ((p.name || '') + ' ' + (p.sku || '')).toLowerCase().indexOf(q) >= 0; }); }
    if (pvFilter === 'fav') {
      var top = History.topItems(12), idx = {}; all.forEach(function (p) { idx[String(p.id)] = p; });
      var favs = top.map(function (id) { return idx[id]; }).filter(Boolean);
      return favs.length ? favs : all.slice(0, 12);
    }
    return all;
  }
  function renderGrid() {
    var w = $('prod-grid-wrap'); if (!w) return; w.innerHTML = '';
    var all = Catalog.list();
    if (!all.length) { w.innerHTML = '<div class="pv-empty">El catálogo aún no se ha cargado.</div>'; return; }
    if (!pvQuery) { var eb = document.createElement('div'); eb.className = 'pv-eyebrow'; eb.textContent = pvFilter === 'fav' ? 'Más usados en esta sede' : 'Todos los productos'; w.appendChild(eb); }
    var vis = pvVisible();
    if (!vis.length) { var e = document.createElement('div'); e.className = 'pv-empty'; e.textContent = 'Sin productos para “' + pvQuery + '”.'; w.appendChild(e); return; }
    var hasRecipes = Recipes.size() > 0, g = document.createElement('div'); g.className = 'pv-grid';
    vis.forEach(function (p) {
      var locked = hasRecipes && !Recipes.forSku(p.id), qty = qtyOf(p.id);
      var t = document.createElement('button'); t.className = 'pv-tile' + (qty ? ' has' : '') + (locked ? ' lock' : '');
      t.setAttribute('data-id', p.id); t.style.setProperty('--tc', tintFor(p.name));
      t.innerHTML = '<span class="pv-em">' + emojiFor(p.name) + '</span><span class="pv-nm">' + p.name + '</span>' +
        (locked ? '<span class="pv-nr">SIN RECETA</span>' : '<span class="pv-sku num">' + (p.sku || ('#' + p.id)) + '</span>') +
        '<span class="pv-badge num">' + qty + '</span>';
      t.addEventListener('click', function () {
        if (locked) { flashStage('err'); $('prod-last').textContent = '⚠ ' + p.name + ' no tiene receta: no se puede registrar.'; return; }
        addItem(p, 'toque', readQty());
      });
      g.appendChild(t);
    });
    w.appendChild(g);
  }
  function updateTile(itemId) {
    var wrap = $('prod-grid-wrap'); if (!wrap) return;
    var t = wrap.querySelector('[data-id="' + itemId + '"]'); if (!t) return;
    var q = qtyOf(itemId), b = t.querySelector('.pv-badge'); if (b) b.textContent = q;
    t.classList.toggle('has', q > 0);
    t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump');
  }
  function pvOpenSheet() { var s = $('prod-summary'); if (s) s.classList.add('pv-open'); var sc = $('prod-scrim'); if (sc) sc.classList.add('show'); }
  function pvCloseSheet() { var s = $('prod-summary'); if (s) s.classList.remove('pv-open'); var sc = $('prod-scrim'); if (sc) sc.classList.remove('show'); }

  /* ════ 11. BUSCADOR (todos los SKU del API) / TECLEO + CANTIDAD ════ */
  function mapSku(p) { return { id: p.id, sku: (p.sku_final_code || p.sku) != null ? String(p.sku_final_code || p.sku) : null, ean: p.ean != null ? String(p.ean) : null, name: p.name || p.nombre || p.sku_final_code || ('SKU ' + p.id), unit: (p.unit_of_measure || 'ud').toString().toLowerCase() }; }
  function readQty() { var v = parseInt($('sku-qty').value, 10); if (!v || v < 1) v = 1; return v; }
  var searchTimer = null, searchSeq = 0;
  function renderResults(items) {
    var box = $('sku-results');
    if (!items || !items.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.innerHTML = '';
    items.slice(0, 15).forEach(function (it) {
      var b = document.createElement('button'); b.className = 'w-full text-left px-4 py-3 border-b border-ink-100 hover:bg-ink-50';
      b.innerHTML = '<div class="font-semibold text-ink-900 truncate">' + it.name + '</div><div class="text-ink-400 text-xs num truncate">' + (it.sku || '') + (it.ean ? ' · ' + it.ean : '') + ' · ' + it.unit + '</div>';
      b.addEventListener('click', function () { addItem(it, 'buscador', readQty()); $('sku-search').value = ''; renderResults([]); $('sku-search').focus(); });
      box.appendChild(b);
    });
    box.classList.remove('hidden');
  }
  function onSearchInput() {
    var q = $('sku-search').value.trim();
    if (!q) { renderResults([]); return; }
    renderResults(Catalog.search(q, 8));          // local inmediato
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { remoteSearch(q); }, 280); // refina con el API (todos los SKU)
  }
  async function remoteSearch(q) {
    if (!navigator.onLine) return;
    var seq = ++searchSeq;
    try {
      var data = await omniFetch('catalog/skus?q=' + encodeURIComponent(q) + '&limit=25', 'GET');
      if (seq !== searchSeq || $('sku-search').value.trim() !== q) return;
      var items = rowsOf(data).map(mapSku);
      if (items.length) renderResults(items);
    } catch (e) {}
  }
  async function onSearchEnter() {
    var q = $('sku-search').value.trim(); if (!q) return;
    var exact = Catalog.resolve(q);
    if (exact) { addItem(exact, 'manual', readQty()); $('sku-search').value = ''; renderResults([]); return; }
    try {
      var data = await omniFetch('catalog/skus?q=' + encodeURIComponent(q) + '&limit=10', 'GET');
      var items = rowsOf(data).map(mapSku);
      var ex = items.filter(function (it) { return it.sku === q || it.ean === q; });
      if (ex.length) { addItem(ex[0], 'manual', readQty()); $('sku-search').value = ''; renderResults([]); return; }
      if (items.length === 1) { addItem(items[0], 'buscador', readQty()); $('sku-search').value = ''; renderResults([]); return; }
      if (items.length) { renderResults(items); }
      else { Feedback.err(); toast('Sin coincidencias para "' + q + '".', 'err'); }
    } catch (e) { Feedback.err(); toast(e.network ? 'Sin conexión con el servidor.' : (e.message || 'No se pudo buscar'), 'err'); }
  }

  /* ════ 12. CONCLUIR ════ */
  function concludeTransfer() {
    if (!batch.length) return;
    if (Outbox.frozen()) { toast('Sincronización detenida: requiere supervisor.', 'err'); Feedback.err(); return; }
    if (!custody || !custody.id) { toast('Esta sede no tiene ubicación de salida en OMNI.', 'err'); Feedback.err(); return; }
    if (!activeSite || !activeSite.id) { toast('Sin sede activa.', 'err'); Feedback.err(); return; }
    var byItem = {};
    batch.forEach(function (e) { var k = String(e.itemId); if (!byItem[k]) byItem[k] = { itemId: e.itemId, sku: e.sku, name: e.name, quantity: 0, unit: e.unit }; byItem[k].quantity += e.qty; });
    var lines = Object.keys(byItem).map(function (k) { return byItem[k]; });
    var queued = [], missing = [];
    lines.forEach(function (it) {
      var rec = Recipes.forSku(it.itemId);
      if (!rec) { missing.push(it.name); return; }
      Outbox.push({ idempotencyKey: 'OP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), timestamp: new Date().toISOString(), recipeId: rec.recipeId, interlocutorId: activeSite.id, quantity: it.quantity, outputLocationId: custody.id, itemId: it.itemId, sku: it.sku, name: it.name, unit: it.unit, orderId: null, executed: false });
      queued.push(it);
    });
    if (queued.length) {
      History.add({ palletId: 'P-' + Date.now(), ts: new Date().toISOString(), sede: activeSite && activeSite.name, lines: queued.map(function (l) { return { itemId: l.itemId, sku: l.sku, name: l.name, qty: l.quantity, unit: l.unit }; }), totalUnits: queued.reduce(function (a, l) { return a + l.quantity; }, 0) });
      Feedback.ok(); flashStage('ok');
      $('prod-last').textContent = '→ Producción registrada (' + queued.length + ' producto' + (queued.length > 1 ? 's' : '') + ')';
      toast('Órdenes de producción en cola (' + queued.length + ').', 'ok');
    }
    if (missing.length) { Feedback.err(); toast('Sin receta, no se registran: ' + missing.join(', '), 'warn'); }
    if (queued.length) { batch = batch.filter(function (e) { return missing.indexOf(e.name) >= 0; }); renderCounter(); renderRecent(); renderGrid(); pvCloseSheet(); }
    forceFocus();
  }

  /* ════ 13. DRAWER ════ */
  function openDrawer() { refreshDrawer(); $('drawer-scrim').classList.remove('hidden'); $('drawer').classList.add('open'); loadKpis(); }
  function closeDrawer() { $('drawer').classList.remove('open'); $('drawer-scrim').classList.add('hidden'); forceFocus(); }
  function refreshDrawer() {
    $('cfg-section').classList.toggle('hidden', !canConfigure);
    $('btn-report').style.display = canScreen('historial') ? '' : 'none';
    catState = ((CFG && CFG.accepted_categories) || ['PT']).slice(); renderCats(); catMsg('', 'mute');
    var h = History.read().slice(0, 20), wrap = $('drw-history');
    if (!h.length) { wrap.innerHTML = '<div class="text-ink-400 text-sm">— Nada registrado en esta sesión —</div>'; }
    else {
      wrap.innerHTML = '';
      h.forEach(function (p) {
        var time = new Date(p.ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        var div = document.createElement('div'); div.className = 'bg-white rounded-xl border border-ink-200 p-3';
        div.innerHTML = '<div class="flex items-center justify-between"><span class="font-semibold text-sm num">' + time + '</span><span class="text-brand font-bold text-sm num">' + p.totalUnits + ' u</span></div><div class="text-ink-400 text-xs mt-0.5">' + (p.lines ? p.lines.length : 0) + ' SKU · ' + (p.lines || []).slice(0, 3).map(function (l) { return l.name; }).join(', ') + ((p.lines || []).length > 3 ? '…' : '') + '</div>';
        wrap.appendChild(div);
      });
    }
  }

  /* ════ 14. CONFIGURACIÓN DE CATEGORÍAS ════ */
  function catMsg(t, kind) { var el = $('cat-msg'); el.className = 'text-xs mt-2 min-h-[1rem] ' + (kind === 'ok' ? 'text-ok' : kind === 'err' ? 'text-danger' : 'text-ink-400'); el.textContent = t; }
  function renderCats() {
    var box = $('cat-chips'); box.innerHTML = '';
    catState.forEach(function (c, i) {
      var chip = document.createElement('span'); chip.className = 'cat-chip bg-brand/10 text-brand rounded-full px-3 py-1 text-sm font-semibold';
      chip.innerHTML = c + ' <button class="text-brand/70" aria-label="Quitar">✕</button>';
      chip.querySelector('button').addEventListener('click', function () { catState.splice(i, 1); renderCats(); }); box.appendChild(chip);
    });
    if (!catState.length) box.innerHTML = '<span class="text-ink-400 text-xs">Sin categorías. Añade al menos una.</span>';
  }
  function addCat() {
    var v = ($('cat-input').value || '').trim().toUpperCase();
    if (!v) return;
    if (!/^[A-Z0-9_]{1,12}$/.test(v)) { catMsg('Código inválido (A-Z, 0-9, _).', 'err'); return; }
    if (catState.indexOf(v) < 0) catState.push(v);
    $('cat-input').value = ''; renderCats(); catMsg('', 'mute');
  }
  async function saveCats() {
    if (!catState.length) { catMsg('Indica al menos una categoría.', 'err'); return; }
    catMsg('Guardando…', 'mute');
    try {
      var d = await omniFetch('settings', 'POST', { accepted_categories: catState });
      CFG.accepted_categories = d.settings.accepted_categories;
      catMsg('✓ Guardado. Recargando catálogo…', 'ok'); Feedback.ok();
      await refreshCatalog(); catMsg('✓ Guardado · ' + Catalog.size() + ' SKUs', 'ok'); toast('Categorías actualizadas.', 'ok');
    } catch (e) { catMsg('✗ ' + (e.message || 'Error al guardar'), 'err'); Feedback.err(); }
  }

  /* ════ 14b. REPORTE DE PRODUCCIÓN (filtro de fecha) ════ */
  function fmtDate(d) { return d.toISOString().slice(0, 10); }
  function repMsg(t, kind) { var el = $('rep-msg'); el.className = 'text-xs min-h-[1rem] mt-2 ' + (kind === 'err' ? 'text-danger' : 'text-ink-400'); el.textContent = t || ''; }
  function openReport() {
    closeDrawer();
    var t = new Date(), f = new Date(); f.setDate(f.getDate() - 6);
    $('rep-to').value = fmtDate(t); $('rep-from').value = fmtDate(f);
    $('rep-summary').classList.add('hidden'); $('rep-body').innerHTML = ''; repMsg('');
    $('report-modal').classList.remove('hidden'); $('report-modal').classList.add('flex');
  }
  function closeReport() { $('report-modal').classList.add('hidden'); $('report-modal').classList.remove('flex'); forceFocus(); }
  function quickRange(days) { var t = new Date(), f = new Date(); f.setDate(f.getDate() - days); $('rep-to').value = fmtDate(t); $('rep-from').value = fmtDate(f); }
  async function generateReport() {
    var from = $('rep-from').value, to = $('rep-to').value;
    if (!from || !to) { repMsg('Selecciona el rango de fechas.', 'err'); return; }
    var fromT = new Date(from + 'T00:00:00').getTime(), toT = new Date(to + 'T23:59:59').getTime();
    if (fromT > toT) { repMsg('La fecha "desde" es posterior a "hasta".', 'err'); return; }
    repMsg('Consultando órdenes de producción…'); $('rep-generate').disabled = true;
    try {
      var data = await omniFetch('production/orders?status=completado&date_from=' + from + '&date_to=' + to, 'GET');
      renderReport(rowsOf(data), fromT, toT, $('rep-mine').checked);
    } catch (e) { repMsg('✗ ' + (e.message || 'No se pudo generar el reporte'), 'err'); }
    finally { $('rep-generate').disabled = false; }
  }
  function renderReport(rows, fromT, toT, mineOnly) {
    var uid = sessionUser && (sessionUser.id || sessionUser.user_id), uname = sessionUser && (sessionUser.username || sessionUser.nombre || sessionUser.name);
    var hasUser = rows.some(function (r) { return ('completed_by_user_id' in r) || ('registered_by' in r) || ('created_by_user_id' in r) || ('user_id' in r); });
    function mine(r) { if (!hasUser) return false; var u = r.completed_by_user_id != null ? r.completed_by_user_id : (r.registered_by != null ? r.registered_by : (r.created_by_user_id != null ? r.created_by_user_id : r.user_id)); if (uid != null && String(u) === String(uid)) return true; if (uname && (r.username === uname || r.user_name === uname)) return true; return false; }
    var byItem = {}, units = 0, moves = 0;
    rows.forEach(function (r) {
      var ts = r.end_time || r.completed_at || r.created_at || r.start_time; var tm = ts ? new Date(ts).getTime() : 0;
      if (tm && (tm < fromT || tm > toT)) return;
      if (mineOnly && hasUser && !mine(r)) return;
      var q = Math.abs(Number(r.quantity_real != null ? r.quantity_real : (r.quantity != null ? r.quantity : 0))) || 0;
      var sku = r.product_sku_id != null ? r.product_sku_id : r.recipe_id;
      var nm = r.product || r.product_name || r.name || ((Recipes.forSku(sku) || {}).name) || ('SKU ' + sku);
      var key = String(sku != null ? sku : nm);
      if (!byItem[key]) byItem[key] = { name: nm, units: 0, moves: 0 };
      byItem[key].units += q; byItem[key].moves++; units += q; moves++;
    });
    var list = Object.keys(byItem).map(function (k) { return byItem[k]; }).sort(function (a, b) { return b.units - a.units; });
    $('rep-units').textContent = Math.round(units); $('rep-moves').textContent = moves; $('rep-skus').textContent = list.length;
    $('rep-summary').classList.remove('hidden');
    var body = $('rep-body');
    if (!list.length) { body.innerHTML = '<div class="text-ink-400 text-sm text-center py-4">Sin producción completada en el rango.</div>'; repMsg(''); return; }
    body.innerHTML = '<div class="text-ink-400 text-[11px] uppercase tracking-wider mb-1">Por producto</div>';
    list.forEach(function (it) {
      var div = document.createElement('div'); div.className = 'flex items-center justify-between bg-ink-50 rounded-lg px-3 py-2';
      div.innerHTML = '<span class="text-sm truncate pr-2">' + it.name + '</span><span class="text-sm font-bold text-brand num shrink-0">' + Math.round(it.units) + ' u · ' + it.moves + ' OP</span>';
      body.appendChild(div);
    });
    repMsg((mineOnly && hasUser ? 'Solo tu producción.' : 'Toda la sede.') + (hasUser ? '' : ' (las OPs no traen usuario por fila)'));
  }

  /* ════ 15. DESBLOQUEO / LOGOUT ════ */
  async function doUnfreeze() {
    var u = $('uf-user').value.trim(), p = $('uf-pass').value, msg = $('uf-msg');
    if (!u || !p) { msg.className = 'text-sm font-medium min-h-[1.25rem] mb-2 text-danger'; msg.textContent = 'Credenciales requeridas.'; return; }
    msg.className = 'text-sm font-medium min-h-[1.25rem] mb-2 text-ink-500'; msg.textContent = 'Validando…';
    try { await omniFetch('auth/login', 'POST', { username: u, password: p }); $('unfreeze-modal').classList.add('hidden'); $('unfreeze-modal').classList.remove('flex'); $('uf-user').value = ''; $('uf-pass').value = ''; Outbox.resume(); toast('Reintento autorizado.', 'ok'); Feedback.ok(); }
    catch (e) { msg.className = 'text-sm font-medium min-h-[1.25rem] mb-2 text-danger'; msg.textContent = '✗ ' + (e.message || 'No autorizado'); Feedback.err(); }
  }
  async function logout() {
    Scan.stop(); closeDrawer();
    try { await omniFetch('auth/logout', 'POST'); } catch (e) {}
    sessionUser = null; activeSite = null; batch = []; custody = transit = null; locations = [];
    $('login-user').value = ''; $('login-pass').value = ''; loginMsg('', 'mute'); siteMsg('', 'mute');
    showView('login-view'); $('login-user').focus();
  }

  /* ════ 16. ENLACES + ARRANQUE ════ */
  function bind() {
    $('btn-login').addEventListener('click', submitLogin);
    $('login-user').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('login-pass').focus(); } });
    $('login-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitLogin(); } });
    $('btn-enter').addEventListener('click', enterSite);
    $('btn-back').addEventListener('click', logout);
    $('btn-conclude').addEventListener('click', concludeTransfer);
    $('prod-mgo').addEventListener('click', concludeTransfer);
    $('prod-abcount').addEventListener('click', pvOpenSheet);
    $('prod-grab').addEventListener('click', pvCloseSheet);
    $('prod-scrim').addEventListener('click', pvCloseSheet);
    window.addEventListener('resize', function () { if (!window.matchMedia('(max-width:859px)').matches) pvCloseSheet(); });
    $('btn-menu').addEventListener('click', openDrawer);
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-scrim').addEventListener('click', closeDrawer);
    $('btn-logout').addEventListener('click', logout);
    $('drw-custody').addEventListener('change', onLocChange);
    $('sku-search').addEventListener('input', onSearchInput);
    $('sku-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); onSearchEnter(); } });
    $('cat-add').addEventListener('click', addCat);
    $('cat-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addCat(); } });
    $('cat-save').addEventListener('click', saveCats);
    $('btn-report').addEventListener('click', openReport);
    $('report-close').addEventListener('click', closeReport);
    $('rep-generate').addEventListener('click', generateReport);
    Array.prototype.forEach.call(document.querySelectorAll('.rep-quick'), function (b) { b.addEventListener('click', function () { quickRange(parseInt(b.getAttribute('data-range'), 10)); }); });
    $('btn-unfreeze').addEventListener('click', function () { $('unfreeze-modal').classList.remove('hidden'); $('unfreeze-modal').classList.add('flex'); });
    $('uf-cancel').addEventListener('click', function () { $('unfreeze-modal').classList.add('hidden'); $('unfreeze-modal').classList.remove('flex'); });
    $('uf-ok').addEventListener('click', doUnfreeze);
    document.addEventListener('pointerup', function () { if ($('prod-view').classList.contains('active') && !$('drawer').classList.contains('open') && !document.querySelector('#unfreeze-modal.flex') && !document.querySelector('#report-modal.flex') && document.activeElement !== $('sku-search') && document.activeElement !== $('sku-qty')) setTimeout(forceFocus, 30); });
    window.addEventListener('online', function () { Outbox.render(); Outbox.drain(); });
    window.addEventListener('offline', function () { Outbox.render(); });
  }
  async function boot() {
    bind();
    try {
      var data = await omniFetch('config', 'GET');
      CFG = data.config; sessionUser = data.user; activeSite = data.interlocutor; canConfigure = !!data.can_configure;
      if (data.authenticated && activeSite) { Catalog.restore(); await startTerminal(); return; }
      if (data.authenticated && !activeSite) { await goToSiteSelection(); return; }
    } catch (e) { loginMsg('⚠ ' + (e.message || 'Error al cargar la aplicación'), 'err'); }
    showView('login-view'); setTimeout(function () { try { $('login-user').focus(); } catch (e) {} }, 60);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

})();
