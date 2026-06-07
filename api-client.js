/* =====================================================================
 * [1004][JOSEPAN 360][OMNI] · api-client.js
 * Cliente de red operativo (JS Vanilla, fetch nativo, async/await).
 *  - OMNI.store : config del nodo (SSOT = bootstrap del servidor) + sesion JWT.
 *  - OMNI.units : conversion metrologica de frontera a unidad base (g/ml/ud).
 *  - OMNI.api   : login operario, catalogo SKU y traspasos atomicos relativos.
 * Inyecta Authorization: Bearer <JWT> en cada transaccion logistica.
 * Requiere CORS habilitado en el API CORE para el subdominio del terminal.
 * ===================================================================== */
(function (OMNI) {
  'use strict';

  /* CONTRATO DE ENDPOINTS — mapear a las rutas reales del [1001] API CORE v6. */
  var ENDPOINTS = {
    login:    '/auth/login',           // POST { identifier, pin } -> { token, user }
    products: '/products',             // GET  ?interlocutor_id=  catalogo SKU + equivalencias
    transfer: '/inventory/transfers'   // POST traspaso de custodia (delta relativo)
  };
  var MOVEMENT_TYPE = { TRANSFER_CUSTODY: 'TRANSFER_CUSTODY' };

  var TOKEN_KEY   = 'omni1004.token.v1';
  var CONFIG_KEY  = 'omni1004.node.v1';
  var CATALOG_KEY = 'omni1004.catalog.v1';
  var REQUEST_TIMEOUT_MS = 15000;

  /* =====================================================================
   * OMNI.store · Config del nodo + sesion
   *  Fuente de verdad: window.__OMNI_BOOTSTRAP__ (inyectado por index.php).
   *  El cache cifrado en localStorage es respaldo de arranque resiliente.
   * ===================================================================== */
  var store = (function () {
    var SEED = 'JOSEPAN360::' + (location.host || 'node') + '::OMNI1004';

    function xor(s, k) { var o = ''; for (var i = 0; i < s.length; i++) o += String.fromCharCode(s.charCodeAt(i) ^ k.charCodeAt(i % k.length)); return o; }
    function enc(obj) { try { return btoa(unescape(encodeURIComponent(xor(JSON.stringify(obj), SEED)))); } catch (e) { return null; } }
    function dec(b)   { try { return JSON.parse(xor(decodeURIComponent(escape(atob(b))), SEED)); } catch (e) { return null; } }

    function fromBootstrap() {
      var b = window.__OMNI_BOOTSTRAP__;
      if (b && b.installed) {
        return {
          apiUrl: b.apiUrl, interlocutorId: b.interlocutorId, interlocutorName: b.interlocutorName,
          custodyLocationId: b.custodyLocationId, custodyLocationName: b.custodyLocationName,
          transitLocationId: b.transitLocationId, transitLocationName: b.transitLocationName,
          installedAt: b.installedAt
        };
      }
      return null;
    }

    var cache = null;

    return {
      getConfig: function () {
        if (cache) return cache;
        cache = fromBootstrap();                       // servidor manda
        if (!cache) {                                   // respaldo cliente
          var raw = localStorage.getItem(CONFIG_KEY);
          cache = raw ? dec(raw) : null;
        }
        return cache;
      },
      isConfigured: function () {
        var c = this.getConfig();
        return !!(c && c.apiUrl && c.interlocutorId && c.custodyLocationId && c.transitLocationId);
      },
      /** Cache local de respaldo (la instalacion real la escribe setup.php). */
      cacheConfig: function (cfg) { cache = cfg; var b = enc(cfg); if (b) localStorage.setItem(CONFIG_KEY, b); },
      purgeLocal: function () { cache = null; localStorage.removeItem(CONFIG_KEY); localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(CATALOG_KEY); },

      setToken: function (t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); },
      getToken: function () { return localStorage.getItem(TOKEN_KEY); },
      clearToken: function () { localStorage.removeItem(TOKEN_KEY); },
      decodeToken: function (t) {
        try { var p = (t || this.getToken()).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(p)))); }
        catch (e) { return null; }
      }
    };
  })();

  /* =====================================================================
   * OMNI.units · Conversion metrologica de frontera
   * ===================================================================== */
  var units = (function () {
    var bySku = Object.create(null), byEan = Object.create(null);
    var FACTOR = { g: 1, kg: 1000, mg: 0.001, ml: 1, l: 1000, cl: 10, ud: 1, unidad: 1, pza: 1 };
    function nu(u) { return u ? String(u).toLowerCase().trim() : 'ud'; }

    return {
      loadCatalog: function (products) {
        bySku = Object.create(null); byEan = Object.create(null);
        (products || []).forEach(function (p) {
          var it = {
            sku: p.sku, ean: p.ean, name: p.name || p.nombre || p.sku,
            saleUnit: nu(p.sale_unit || p.unidad_venta || 'ud'),
            baseUnit: nu(p.base_unit || p.unidad_base || 'ud'),
            factorToBase: Number(p.factor_to_base || p.factor || 0),
            unitsPerScan: Number(p.units_per_scan || p.unidades_por_lectura || 1)
          };
          if (!it.factorToBase) {
            var fS = FACTOR[it.saleUnit] != null ? FACTOR[it.saleUnit] : 1;
            var fB = FACTOR[it.baseUnit] != null ? FACTOR[it.baseUnit] : 1;
            it.factorToBase = fS / fB;
          }
          if (it.sku) bySku[String(it.sku)] = it;
          if (it.ean) byEan[String(it.ean)] = it;
        });
        OMNI.log('Catalogo:', Object.keys(bySku).length, 'SKUs');
      },
      catalogSize: function () { return Object.keys(bySku).length; },
      resolve: function (code) { var c = String(code || '').trim(); return byEan[c] || bySku[c] || null; },
      toBase: function (item, saleQty) {
        var q = Number(saleQty) || 0;
        return { baseQty: Math.round(q * item.factorToBase * 1000) / 1000, baseUnit: item.baseUnit };
      }
    };
  })();

  /* =====================================================================
   * OMNI.api · Cliente HTTP
   * ===================================================================== */
  function joinUrl(base, path) { if (!base) throw new Error('URL base del API no configurada.'); return base.replace(/\/+$/, '') + path; }

  async function request(path, options, opts) {
    opts = opts || {};
    var cfg = store.getConfig();
    var url = joinUrl(cfg && cfg.apiUrl, path);

    var headers = Object.assign({ 'Accept': 'application/json' }, (options && options.headers) || {});
    if (options && options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (!opts.noAuth) { var t = store.getToken(); if (t) headers['Authorization'] = 'Bearer ' + t; }

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeout || REQUEST_TIMEOUT_MS);
    var res;
    try {
      res = await fetch(url, Object.assign({}, options, { headers: headers, signal: controller.signal }));
    } catch (e) {
      clearTimeout(timer);
      var ne = new Error(e.name === 'AbortError' ? 'Tiempo de espera agotado.' : 'Error de red: sin conexion con el API CORE.');
      ne.network = true; throw ne;
    }
    clearTimeout(timer);

    var data = null, text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
    if (!res.ok) {
      var err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      err.rejected = (res.status >= 400 && res.status < 500); // rechazo logico
      throw err;
    }
    return data;
  }

  function unwrap(data) { return (data && (data.data || data.items || data)) || []; }

  var api = {
    ENDPOINTS: ENDPOINTS, MOVEMENT_TYPE: MOVEMENT_TYPE,

    /** Login operario. identifier = fotocheck escaneado o usuario; pin = PIN. */
    login: async function (identifier, pin) {
      var data = await request(ENDPOINTS.login, {
        method: 'POST', body: JSON.stringify({ identifier: identifier, pin: pin })
      }, { noAuth: true });
      if (!data || !data.token) throw new Error('Respuesta de autenticacion invalida.');
      return data;
    },

    getProducts: async function (interlocutorId) {
      var q = interlocutorId ? ('?interlocutor_id=' + encodeURIComponent(interlocutorId)) : '';
      return unwrap(await request(ENDPOINTS.products + q, { method: 'GET' }, {}));
    },

    refreshCatalog: async function (interlocutorId) {
      var products = await this.getProducts(interlocutorId);
      units.loadCatalog(products);
      try { localStorage.setItem(CATALOG_KEY, JSON.stringify(products)); } catch (e) {}
      return units.catalogSize();
    },

    restoreCatalogFromCache: function () {
      try { var raw = localStorage.getItem(CATALOG_KEY); if (raw) { units.loadCatalog(JSON.parse(raw)); return units.catalogSize(); } } catch (e) {}
      return 0;
    },

    /**
     * Despacha un traspaso de custodia. Deltas RELATIVOS exclusivamente.
     * @param tx { idempotencyKey, timestamp, items:[{sku, baseQty, baseUnit, ...}] }
     */
    dispatchTransfer: async function (tx) {
      var cfg = store.getConfig();
      var body = {
        type: MOVEMENT_TYPE.TRANSFER_CUSTODY,
        idempotency_key: tx.idempotencyKey,
        interlocutor_id: cfg.interlocutorId,
        from_location_id: cfg.custodyLocationId,  // decrementa custodia
        to_location_id:   cfg.transitLocationId,  // incrementa en transito -> bodega
        occurred_at: tx.timestamp,                // timestamp fisico real
        items: tx.items.map(function (it) {
          return { sku: it.sku, delta: it.baseQty, unit: it.baseUnit }; // jamas SET absoluto
        })
      };
      return await request(ENDPOINTS.transfer, { method: 'POST', body: JSON.stringify(body) }, {});
    }
  };

  OMNI.store = store;
  OMNI.units = units;
  OMNI.api = api;

})(window.OMNI = window.OMNI || {});
