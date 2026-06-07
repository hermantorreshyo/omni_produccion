/* =====================================================================
 * [1004][JOSEPAN 360][OMNI] · setup.js
 * Asistente de Configuracion (frontend). Consume setup.php (mismo origen,
 * sin CORS) para validar latencia, autenticar al supervisor, mapear
 * fabrica/ubicaciones e instalar el nodo (escritura de config.php).
 * ===================================================================== */
(function (OMNI) {
  'use strict';

  var TOTAL_STEPS = 4;
  var state = {
    step: 1, apiUrl: '', supervisorToken: null,
    interlocutors: [], locations: [],
    interlocutorId: null, interlocutorName: '',
    custodyLocationId: null, custodyLocationName: '',
    transitLocationId: null, transitLocationName: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  /* Cliente de setup contra el backend PHP de mismo origen. */
  async function setupCall(action, body) {
    var res = await fetch('setup.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    });
    var data = null, text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ('Error del instalador (HTTP ' + res.status + ')'));
    }
    return data.data;
  }

  function renderStepDots() {
    var ol = $('wizard-steps'); ol.innerHTML = '';
    for (var i = 1; i <= TOTAL_STEPS; i++) {
      var done = i < state.step, active = i === state.step;
      var li = document.createElement('li');
      li.className = 'flex-1 flex items-center';
      li.innerHTML =
        '<div class="num w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ' +
          (done ? 'bg-ok text-white' : active ? 'bg-ink text-white' : 'bg-edge text-mute') + '">' +
          (done ? '✓' : i) + '</div>' +
        (i < TOTAL_STEPS ? '<div class="flex-1 h-1 mx-1 rounded ' + (done ? 'bg-ok' : 'bg-edge') + '"></div>' : '');
      ol.appendChild(li);
    }
  }

  function showPanel(n) {
    state.step = n;
    document.querySelectorAll('.wizard-panel').forEach(function (p) {
      p.classList.toggle('hidden', Number(p.getAttribute('data-step')) !== n);
    });
    renderStepDots();
  }

  function msg(el, text, kind) {
    el.className = 'mt-3 text-sm font-bold num ' + (kind === 'ok' ? 'text-ok' : kind === 'err' ? 'text-danger' : 'text-mute');
    el.textContent = text;
  }

  /* PASO 1 · Conectividad (latencia medida por el backend) */
  async function testConnection() {
    var btn = $('btn-test-conn'), out = $('conn-result');
    var url = $('cfg-api-url').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) { msg(out, 'URL invalida. Debe iniciar con https://', 'err'); OMNI.feedback.error(); return; }
    btn.disabled = true; msg(out, 'Probando conexion…', 'mute');
    try {
      var r = await setupCall('test_connection', { api_url: url });
      state.apiUrl = url;
      btn.classList.remove('bg-ink'); btn.classList.add('bg-ok');
      msg(out, '✓ Conexion correcta · latencia ' + r.latency_ms + ' ms', 'ok');
      OMNI.feedback.success();
      setTimeout(function () { showPanel(2); }, 650);
    } catch (e) { msg(out, '✗ ' + e.message, 'err'); OMNI.feedback.error(); }
    finally { btn.disabled = false; }
  }

  /* PASO 2 · Identidad del nodo */
  async function supervisorAuth() {
    var btn = $('btn-sup-auth'), out = $('sup-result');
    var user = $('cfg-sup-user').value.trim(), pin = $('cfg-sup-pin').value.trim();
    if (!user || !pin) { msg(out, 'Introduzca usuario y PIN del supervisor.', 'err'); OMNI.feedback.error(); return; }
    btn.disabled = true; msg(out, 'Validando identidad…', 'mute');
    try {
      var r = await setupCall('auth', { api_url: state.apiUrl, user: user, pin: pin });
      state.supervisorToken = r.token;
      var list = await setupCall('interlocutors', { api_url: state.apiUrl, token: state.supervisorToken });
      state.interlocutors = list.items || list || [];
      var sel = $('cfg-interlocutor');
      sel.innerHTML = '<option value="">— Seleccione fabrica/sede —</option>';
      state.interlocutors.forEach(function (it) {
        var id = it.id || it.interlocutor_id, name = it.name || it.nombre || ('ID ' + id);
        sel.insertAdjacentHTML('beforeend', '<option value="' + id + '" data-name="' + name + '">' + name + '</option>');
      });
      $('interlocutor-block').classList.remove('hidden');
      msg(out, '✓ Identidad validada · ' + state.interlocutors.length + ' sedes', 'ok');
      OMNI.feedback.success();
      sel.onchange = function () {
        var opt = sel.options[sel.selectedIndex];
        state.interlocutorId = sel.value || null;
        state.interlocutorName = opt ? opt.getAttribute('data-name') : '';
        if (state.interlocutorId) loadLocationsAndAdvance();
      };
    } catch (e) { msg(out, '✗ ' + e.message, 'err'); OMNI.feedback.error(); }
    finally { btn.disabled = false; }
  }

  async function loadLocationsAndAdvance() {
    var out = $('sup-result');
    try {
      msg(out, 'Cargando ubicaciones de ' + state.interlocutorName + '…', 'mute');
      var list = await setupCall('locations', { api_url: state.apiUrl, token: state.supervisorToken, interlocutor_id: state.interlocutorId });
      state.locations = list.items || list || [];
      populateLocationSelects();
      OMNI.feedback.action();
      showPanel(3);
    } catch (e) { msg(out, '✗ ' + e.message, 'err'); OMNI.feedback.error(); }
  }

  /* PASO 3 · Ubicaciones */
  function populateLocationSelects() {
    var custody = $('cfg-loc-custody'), transit = $('cfg-loc-transit');
    var html = '<option value="">— Seleccione ubicacion —</option>';
    state.locations.forEach(function (loc) {
      var id = loc.id || loc.location_id, name = loc.name || loc.nombre || ('Ubicacion ' + id);
      var type = (loc.type || loc.tipo || '').toString();
      html += '<option value="' + id + '" data-name="' + name + '" data-type="' + type + '">' + name + (type ? ' · ' + type : '') + '</option>';
    });
    custody.innerHTML = html; transit.innerHTML = html;
    state.locations.forEach(function (loc) {
      var t = (loc.type || loc.tipo || '').toString().toLowerCase(), id = loc.id || loc.location_id;
      if (/custod|tempor|produc|salida/.test(t)) custody.value = id;
      if (/transit|tránsito|transito|bodega|almac/.test(t)) transit.value = id;
    });
  }

  function confirmLocations() {
    var out = $('loc-result'), custody = $('cfg-loc-custody'), transit = $('cfg-loc-transit');
    if (!custody.value || !transit.value) { msg(out, 'Seleccione ambas ubicaciones.', 'err'); OMNI.feedback.error(); return; }
    if (custody.value === transit.value) { msg(out, 'Origen y destino deben ser distintos.', 'err'); OMNI.feedback.error(); return; }
    state.custodyLocationId = custody.value; state.custodyLocationName = custody.options[custody.selectedIndex].getAttribute('data-name');
    state.transitLocationId = transit.value; state.transitLocationName = transit.options[transit.selectedIndex].getAttribute('data-name');
    OMNI.feedback.action(); renderSummary(); showPanel(4);
  }

  /* PASO 4 · Finalizacion (escribe config.php via setup.php) */
  function renderSummary() {
    var rows = [
      ['API CORE', state.apiUrl],
      ['Fabrica / Sede', state.interlocutorName + ' (#' + state.interlocutorId + ')'],
      ['Custodia temporal', state.custodyLocationName + ' (#' + state.custodyLocationId + ')'],
      ['Destino bodega/transito', state.transitLocationName + ' (#' + state.transitLocationId + ')']
    ];
    $('cfg-summary').innerHTML = rows.map(function (r) {
      return '<div class="flex justify-between gap-3"><dt class="text-mute">' + r[0] + '</dt><dd class="font-bold text-right break-all">' + r[1] + '</dd></div>';
    }).join('');
  }

  async function finishSetup() {
    var btn = $('btn-finish-setup'), out = $('finish-result');
    btn.disabled = true; msg(out, 'Escribiendo config.php y cifrando entorno…', 'mute');
    try {
      await setupCall('install', {
        api_url: state.apiUrl, token: state.supervisorToken,
        interlocutor_id: state.interlocutorId, interlocutor_name: state.interlocutorName,
        custody_location_id: state.custodyLocationId, custody_location_name: state.custodyLocationName,
        transit_location_id: state.transitLocationId, transit_location_name: state.transitLocationName
      });
      // Cache cifrado del cliente (respaldo). El supervisor NO persiste su token.
      OMNI.store.cacheConfig({
        apiUrl: state.apiUrl, interlocutorId: state.interlocutorId, interlocutorName: state.interlocutorName,
        custodyLocationId: state.custodyLocationId, custodyLocationName: state.custodyLocationName,
        transitLocationId: state.transitLocationId, transitLocationName: state.transitLocationName,
        installedAt: new Date().toISOString()
      });
      state.supervisorToken = null; OMNI.store.clearToken();
      msg(out, '✓ Nodo instalado. Reiniciando…', 'ok'); OMNI.feedback.success();
      setTimeout(function () { location.reload(); }, 600); // auto-reinicio
    } catch (e) { msg(out, '✗ ' + e.message, 'err'); OMNI.feedback.error(); btn.disabled = false; }
  }

  var bound = false;
  function bindOnce() {
    if (bound) return; bound = true;
    $('btn-test-conn').addEventListener('click', testConnection);
    $('btn-sup-auth').addEventListener('click', supervisorAuth);
    $('btn-step3-next').addEventListener('click', confirmLocations);
    $('btn-finish-setup').addEventListener('click', finishSetup);
  }

  OMNI.setup = {
    start: function () { bindOnce(); showPanel(1); $('setup-view').classList.remove('hidden'); }
  };

})(window.OMNI = window.OMNI || {});
