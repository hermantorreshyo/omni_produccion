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
      while (guard++ < 25) {
        var data = await omniFetch('catalog/skus?item_type=' + encodeURIComponent(types[i]) + '&limit=200&offset=' + off, 'GET');
        var rows = rowsOf(data); acc = acc.concat(rows);
        if (rows.length < 200) break; off += 200;
      }
    }
    Catalog.load(acc); Catalog.persist(acc); return Catalog.size();
  }

  /* ════ 4. HISTORIAL LOCAL (registrado hoy + respaldo KPI) ════ */
  var History = {
    key: function () { var u = sessionUser || {}; return 'omni1004.hist.' + (u.id || u.username || u.nombre || 'anon'); },
    read: function () { try { return JSON.parse(ls(this.key()) || '[]'); } catch (e) { return []; } },
    add: function (p) { var h = this.read(); h.unshift(p); if (h.length > 300) h = h.slice(0, 300); lsSet(this.key(), JSON.stringify(h)); },
    kpis: function () { var h = this.read(), s = new Date(); s.setHours(0, 0, 0, 0); var t0 = s.getTime(), u = 0, sk = {}, p = 0; h.forEach(function (x) { if (new Date(x.ts).getTime() >= t0) { p++; (x.lines || []).forEach(function (l) { u += l.qty; sk[l.itemId] = 1; }); } }); return { units: u, moves: p, skus: Object.keys(sk).length, last: h[0] ? h[0].ts : null }; }
  };

  /* ════ 5. KPIs DESDE EL KARDEX DEL API ════ */
  function computeKpis(rows) {
    var uid = sessionUser && (sessionUser.id || sessionUser.user_id);
    var uname = sessionUser && (sessionUser.username || sessionUser.nombre || sessionUser.name);
    var hasUser = rows.some(function (r) { return ('user_id' in r) || ('username' in r) || ('created_by' in r) || ('user_name' in r); });
    function mine(r) { if (!hasUser) return true; if (uid != null && (String(r.user_id) === String(uid) || String(r.created_by) === String(uid))) return true; if (uname && (r.username === uname || r.user_name === uname)) return true; return false; }
    var s = new Date(); s.setHours(0, 0, 0, 0); var t0 = s.getTime();
    var tU = 0, tM = 0, tS = {}, wU = 0, wM = 0, last = null;
    rows.forEach(function (r) {
      if (!mine(r)) return;
      var q = Math.abs(Number(r.quantity != null ? r.quantity : (r.qty || 0))) || 0;
      var ts = r.created_at || r.movement_date || r.date || r.timestamp; var tm = ts ? new Date(ts).getTime() : 0;
      wU += q; wM++; if (!last || tm > new Date(last).getTime()) last = ts;
      if (tm >= t0) { tU += q; tM++; var iid = r.item_id != null ? r.item_id : r.itemId; if (iid != null) tS[iid] = 1; }
    });
    return { todayUnits: Math.round(tU), todayMoves: tM, todaySkus: Object.keys(tS).length, weekUnits: Math.round(wU), weekMoves: wM, last: last, hasUser: hasUser };
  }
  function renderKpis(k, src) {
    $('kpi-units').textContent = k.todayUnits || 0; $('kpi-moves').textContent = k.todayMoves || 0; $('kpi-skus').textContent = k.todaySkus || 0;
    $('kpi-week').textContent = '7 días: ' + (k.weekUnits || 0) + ' u · ' + (k.weekMoves || 0) + ' traslados';
    $('kpi-last').textContent = k.last ? ('Última actividad: ' + new Date(k.last).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) : 'Sin actividad reciente.';
    $('kpi-source').textContent = src === 'API' ? (k.hasUser === false ? 'API · sede' : 'API · tú') : 'local';
  }
  async function loadKpis() {
    try {
      var data = await omniFetch('analytics/kardex?days=7&movement_category=TRASLADO', 'GET');
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
    async function dispatch(p) {
      var batchId = p.batchId;
      if (batchId == null) {
        var data = await omniFetch('inventory/stock?location_id=' + p.originLocationId + '&item_id=' + p.itemId + '&item_type=sku', 'GET');
        var rows = rowsOf(data);
        if (!rows.length) { var e = new Error('Sin stock en custodia: ' + (p.name || p.itemId)); e.rejected = true; throw e; }
        batchId = rows[0].batch_id != null ? rows[0].batch_id : rows[0].batchId;
      }
      return omniFetch('inventory/transfer', 'POST', { location_id_origin: p.originLocationId, location_id_destination: p.destinationLocationId, batch_id: batchId, item_id: p.itemId, item_type: 'sku', quantity: p.quantity, movement_type: p.movementType || 'Traslado Interno' });
    }
    async function drain() {
      if (draining || frozen() || !navigator.onLine) { render(); return; }
      draining = true; render();
      try {
        var q = read();
        while (q.length) { try { await dispatch(q[0]); } catch (e) { if (e.rejected) { setFrozen(e.message || 'Traslado rechazado'); Feedback.err(); break; } else break; } q.shift(); write(q); render(); }
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
    try { var d = await omniFetch('select-interlocutor', 'POST', { interlocutor_id: parseInt(sel.value, 10), interlocutor_name: opt.getAttribute('data-name') }); activeSite = d.interlocutor; await startTerminal(); }
    catch (e) { siteMsg('✗ ' + (e.message || 'No se pudo entrar'), 'err'); Feedback.err(); }
    finally { $('btn-enter').disabled = false; }
  }

  /* ════ 9. UBICACIONES ════ */
  function locLabel(l) { var a = (l.area_type || '').replace(/_/g, ' '); var sp = [l.shelf, l.position].filter(Boolean).join(' '); var qr = l.qr_code_uid ? (' · ' + l.qr_code_uid) : ''; return ([a, sp].filter(Boolean).join(' ') || ('Ubicación ' + (l.id || l.location_id))) + qr; }
  async function loadLocations() {
    var data = await omniFetch('catalog/locations', 'GET'); locations = rowsOf(data);
    var cp = new RegExp((CFG && CFG.custody_pattern) || 'producto_terminado', 'i'), tp = new RegExp((CFG && CFG.transit_pattern) || 'bodega', 'i');
    custody = transit = null;
    locations.forEach(function (l) { var a = (l.area_type || '').toString(), id = l.id || l.location_id; if (!custody && cp.test(a)) custody = { id: id, name: locLabel(l) }; if (!transit && tp.test(a)) transit = { id: id, name: locLabel(l) }; });
    fillLocSelect($('drw-custody'), custody && custody.id); fillLocSelect($('drw-transit'), transit && transit.id);
  }
  function fillLocSelect(sel, current) { sel.innerHTML = '<option value="">— Seleccione —</option>'; locations.forEach(function (l) { var id = l.id || l.location_id; sel.insertAdjacentHTML('beforeend', '<option value="' + id + '"' + (String(id) === String(current) ? ' selected' : '') + '>' + locLabel(l) + '</option>'); }); }
  function onLocChange() { var c = $('drw-custody'), t = $('drw-transit'); if (c.value) custody = { id: parseInt(c.value, 10), name: c.options[c.selectedIndex].textContent }; if (t.value) transit = { id: parseInt(t.value, 10), name: t.options[t.selectedIndex].textContent }; renderLocLine(); toast('Ubicaciones actualizadas.', 'ok'); }
  function renderLocLine() { $('loc-custody').textContent = (custody && custody.name) || '— custodia —'; $('loc-transit').textContent = (transit && transit.name) || '— bodega —'; }

  /* ════ 10. TERMINAL ════ */
  async function startTerminal() {
    var u = sessionUser || {};
    $('prod-factory').textContent = (activeSite && activeSite.name) || 'Sede';
    $('prod-operator').textContent = u.nombre || u.name || u.username || 'Operario';
    $('prod-role').textContent = u.rol || u.role || '';
    batch = []; renderCounter(); renderRecent();
    showView('prod-view'); Scan.start(onScan); Outbox.render(); Outbox.drain(); siteMsg('', 'mute'); forceFocus();
    try { await loadLocations(); } catch (e) { toast('No se pudieron cargar ubicaciones.', 'warn'); }
    renderLocLine();
    if (navigator.onLine) { try { await refreshCatalog(); } catch (e) { Catalog.restore(); } } else Catalog.restore();
  }
  function forceFocus() { try { $('scan-trap').focus(); } catch (e) {} }
  function flashStage(kind) { var s = $('prod-stage'); s.classList.remove('ok', 'err'); void s.offsetWidth; s.classList.add(kind); setTimeout(function () { s.classList.remove('ok', 'err'); }, 260); }
  function totalUnits() { return batch.reduce(function (a, e) { return a + e.qty; }, 0); }
  function renderCounter() { $('prod-counter').textContent = totalUnits(); $('btn-conclude').disabled = batch.length === 0; }

  function addItem(item, via) {
    batch.push({ rid: 'r' + Date.now() + Math.random().toString(36).slice(2, 5), itemId: item.id, sku: item.sku, name: item.name, qty: 1, unit: item.unit });
    flashStage('ok'); Feedback.ok();
    $('prod-last').className = 'text-base font-semibold min-h-[1.5rem] text-ok num';
    $('prod-last').textContent = '✓ ' + item.name + '  +1 ' + item.unit + (via ? ' (' + via + ')' : '');
    renderCounter(); renderRecent();
  }
  function onScan(code) { var item = Catalog.resolve(code); if (!item) { flashStage('err'); Feedback.err(); $('prod-last').className = 'text-base font-semibold min-h-[1.5rem] text-danger num'; $('prod-last').textContent = '✗ SKU inexistente: ' + code; return; } addItem(item); }
  function renderRecent() {
    var wrap = $('prod-recent'), recent = batch.slice(-4).reverse();
    if (!recent.length) { wrap.innerHTML = '<div class="text-ink-400 text-sm py-3 text-center">— Sin lecturas en el pallet —</div>'; return; }
    wrap.innerHTML = '';
    recent.forEach(function (e) {
      var row = document.createElement('div'); row.className = 'flex items-center gap-3 bg-white border border-ink-200 rounded-xl p-3';
      row.innerHTML = '<div class="flex-1 min-w-0"><div class="font-semibold text-ink-900 truncate">' + e.name + '</div><div class="text-ink-400 text-xs num truncate">' + (e.sku || ('#' + e.itemId)) + ' · +' + e.qty + ' ' + e.unit + '</div></div><button class="shrink-0 w-11 h-11 rounded-lg text-danger flex items-center justify-center" style="background:#fef2f2;" aria-label="Eliminar">✕</button>';
      row.querySelector('button').addEventListener('click', function () { removeRead(e.rid); }); wrap.appendChild(row);
    });
  }
  function removeRead(rid) { var i = batch.findIndex(function (e) { return e.rid === rid; }); if (i >= 0) { batch.splice(i, 1); Feedback.action(); renderCounter(); renderRecent(); forceFocus(); } }

  /* ════ 11. BUSCADOR / TECLEO ════ */
  function renderSearch() {
    var q = $('sku-search').value, box = $('sku-results'), matches = Catalog.search(q, 8);
    if (!q || !matches.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.innerHTML = '';
    matches.forEach(function (it) {
      var b = document.createElement('button'); b.className = 'w-full text-left px-4 py-3 border-b border-ink-100 hover:bg-ink-50';
      b.innerHTML = '<div class="font-semibold text-ink-900 truncate">' + it.name + '</div><div class="text-ink-400 text-xs num truncate">' + (it.sku || '') + (it.ean ? ' · ' + it.ean : '') + ' · ' + it.unit + '</div>';
      b.addEventListener('click', function () { addItem(it, 'buscador'); $('sku-search').value = ''; renderSearch(); $('sku-search').focus(); }); box.appendChild(b);
    });
    box.classList.remove('hidden');
  }
  function onSearchEnter() {
    var q = $('sku-search').value.trim(); if (!q) return;
    var exact = Catalog.resolve(q);
    if (exact) { addItem(exact, 'manual'); $('sku-search').value = ''; renderSearch(); return; }
    var m = Catalog.search(q, 2);
    if (m.length === 1) { addItem(m[0], 'buscador'); $('sku-search').value = ''; renderSearch(); }
    else if (!m.length) { Feedback.err(); toast('Sin coincidencias para "' + q + '".', 'err'); }
  }

  /* ════ 12. CONCLUIR ════ */
  function concludeTransfer() {
    if (!batch.length) return;
    if (Outbox.frozen()) { toast('Sincronización detenida: requiere supervisor.', 'err'); Feedback.err(); return; }
    if (!custody || !custody.id || !transit || !transit.id) { toast('Configura las ubicaciones en el menú.', 'err'); Feedback.err(); openDrawer(); return; }
    var byItem = {};
    batch.forEach(function (e) { var k = String(e.itemId); if (!byItem[k]) byItem[k] = { itemId: e.itemId, sku: e.sku, name: e.name, quantity: 0, unit: e.unit }; byItem[k].quantity += e.qty; });
    var lines = Object.keys(byItem).map(function (k) { return byItem[k]; });
    lines.forEach(function (it) { Outbox.push({ idempotencyKey: 'TX-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), timestamp: new Date().toISOString(), itemId: it.itemId, name: it.name, quantity: it.quantity, unit: it.unit, originLocationId: custody.id, destinationLocationId: transit.id, movementType: (CFG && CFG.movement_type) || 'Traslado Interno' }); });
    History.add({ palletId: 'P-' + Date.now(), ts: new Date().toISOString(), sede: activeSite && activeSite.name, lines: lines.map(function (l) { return { itemId: l.itemId, sku: l.sku, name: l.name, qty: l.quantity, unit: l.unit }; }), totalUnits: lines.reduce(function (a, l) { return a + l.quantity; }, 0) });
    Feedback.ok(); flashStage('ok');
    $('prod-last').className = 'text-base font-semibold min-h-[1.5rem] text-ok num';
    $('prod-last').textContent = '→ Traspaso despachado (' + lines.length + ' SKU)';
    batch = []; renderCounter(); renderRecent(); forceFocus();
    toast('Traslado en cola de envío (' + lines.length + ' SKU).', 'ok');
  }

  /* ════ 13. DRAWER ════ */
  function openDrawer() { refreshDrawer(); $('drawer-scrim').classList.remove('hidden'); $('drawer').classList.add('open'); loadKpis(); }
  function closeDrawer() { $('drawer').classList.remove('open'); $('drawer-scrim').classList.add('hidden'); forceFocus(); }
  function refreshDrawer() {
    $('cfg-section').classList.toggle('hidden', !canConfigure);
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
    $('btn-menu').addEventListener('click', openDrawer);
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-scrim').addEventListener('click', closeDrawer);
    $('btn-logout').addEventListener('click', logout);
    $('drw-custody').addEventListener('change', onLocChange);
    $('drw-transit').addEventListener('change', onLocChange);
    $('sku-search').addEventListener('input', renderSearch);
    $('sku-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); onSearchEnter(); } });
    $('cat-add').addEventListener('click', addCat);
    $('cat-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addCat(); } });
    $('cat-save').addEventListener('click', saveCats);
    $('btn-unfreeze').addEventListener('click', function () { $('unfreeze-modal').classList.remove('hidden'); $('unfreeze-modal').classList.add('flex'); });
    $('uf-cancel').addEventListener('click', function () { $('unfreeze-modal').classList.add('hidden'); $('unfreeze-modal').classList.remove('flex'); });
    $('uf-ok').addEventListener('click', doUnfreeze);
    document.addEventListener('pointerup', function () { if ($('prod-view').classList.contains('active') && !$('drawer').classList.contains('open') && !document.querySelector('#unfreeze-modal.flex') && document.activeElement !== $('sku-search')) setTimeout(forceFocus, 30); });
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
    } catch (e) { if (e.deploy) loginMsg('⚠ ' + e.message, 'err'); }
    showView('login-view'); setTimeout(function () { try { $('login-user').focus(); } catch (e) {} }, 60);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

})();
