/* =====================================================================
 * [1004][JOSEPAN 360][OMNI] · outbox-service.js
 * Resiliencia Offline-First mediante Transactional Outbox Pattern.
 *  - Encola lecturas/traspasos en IndexedDB conservando el timestamp físico.
 *  - Sincroniza en estricto orden cronológico al restaurarse el enlace.
 *  - Si el servidor RECHAZA una transacción (lógica), congela la cola,
 *    bloquea la interfaz en rojo y exige intervención del supervisor.
 * ===================================================================== */
(function (OMNI) {
  'use strict';

  var DB_NAME = 'omni1004_outbox';
  var DB_VERSION = 1;
  var STORE = 'queue';
  var FROZEN_KEY = 'omni1004.outbox.frozen';

  var db = null;
  var syncing = false;
  var listeners = [];

  /* --- Apertura de IndexedDB con fallback a localStorage si no existe --- */
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (db) return resolve(db);
      if (!window.indexedDB) return reject(new Error('IndexedDB no disponible.'));
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          var os = d.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
          os.createIndex('byTs', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = function (e) { db = e.target.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(mode) {
    return openDb().then(function (d) { return d.transaction(STORE, mode).objectStore(STORE); });
  }

  function notify() {
    countPending().then(function (n) {
      var frozen = isFrozen();
      listeners.forEach(function (fn) { try { fn({ pending: n, frozen: frozen, online: navigator.onLine }); } catch (e) {} });
    });
  }

  /* --- Estado de congelamiento (persistente) --- */
  function isFrozen() { return localStorage.getItem(FROZEN_KEY) != null; }
  function freeze(reason) {
    localStorage.setItem(FROZEN_KEY, JSON.stringify({ reason: reason || 'Rechazo del servidor', at: Date.now() }));
  }
  function unfreeze() { localStorage.removeItem(FROZEN_KEY); }
  function frozenInfo() {
    try { return JSON.parse(localStorage.getItem(FROZEN_KEY)); } catch (e) { return null; }
  }

  /* --- Operaciones de cola --- */
  function enqueue(payload) {
    return tx('readwrite').then(function (os) {
      return new Promise(function (resolve, reject) {
        var record = {
          payload: payload,
          timestamp: payload.timestamp || new Date().toISOString(),
          attempts: 0,
          createdAt: Date.now()
        };
        var req = os.add(record);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function allOrdered() {
    return tx('readonly').then(function (os) {
      return new Promise(function (resolve, reject) {
        var out = [];
        // El cursor por keyPath autoincremental ya respeta el orden de inserción
        // (== orden cronológico físico de las acciones).
        var req = os.openCursor();
        req.onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) { out.push(Object.assign({ seq: cur.key }, cur.value)); cur.continue(); }
          else resolve(out);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function remove(seq) {
    return tx('readwrite').then(function (os) {
      return new Promise(function (resolve, reject) {
        var req = os.delete(seq);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function bumpAttempts(seq, record) {
    return tx('readwrite').then(function (os) {
      return new Promise(function (resolve) {
        record.attempts = (record.attempts || 0) + 1;
        var req = os.put(record);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { resolve(); };
      });
    });
  }

  function countPending() {
    return tx('readonly').then(function (os) {
      return new Promise(function (resolve) {
        var req = os.count();
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(0); };
      });
    }).catch(function () { return 0; });
  }

  /* =====================================================================
   * Sincronización diferida en orden cronológico estricto
   * ===================================================================== */
  async function sync() {
    if (syncing || isFrozen() || !navigator.onLine) { notify(); return; }
    syncing = true;
    try {
      var pending = await allOrdered();
      for (var i = 0; i < pending.length; i++) {
        var item = pending[i];
        try {
          await OMNI.api.dispatchTransfer(item.payload);
          await remove(item.seq);   // sólo se elimina tras confirmación del servidor
          notify();
        } catch (err) {
          if (err && err.network) {
            // Microcorte: detener sin congelar; reintentar al volver la red.
            OMNI.log('Sync detenida por red. Pendientes:', pending.length - i);
            break;
          }
          if (err && err.rejected) {
            // Rechazo de lógica de servidor: CONGELAR la cola.
            await bumpAttempts(item.seq, item);
            freeze((err.message || 'Transacción rechazada') + ' [seq ' + item.seq + ']');
            OMNI.log('OUTBOX CONGELADO:', err.message);
            notify();
            break;
          }
          // Error desconocido (5xx): detener e intentar más tarde.
          await bumpAttempts(item.seq, item);
          break;
        }
      }
    } finally {
      syncing = false;
      notify();
    }
  }

  /* --- API pública del servicio --- */
  var outbox = {
    init: function () {
      window.addEventListener('online', function () { OMNI.log('Red restaurada → sync'); sync(); });
      window.addEventListener('offline', function () { OMNI.log('Red perdida'); notify(); });
      // Reintento periódico de respaldo (cubre cambios de estado no notificados).
      setInterval(function () { if (navigator.onLine && !isFrozen()) sync(); }, 20000);
      notify();
      if (navigator.onLine) sync();
      return this;
    },

    /** Encola un traspaso y dispara sync inmediato si hay red. */
    push: async function (payload) {
      await enqueue(payload);
      notify();
      if (navigator.onLine && !isFrozen()) sync();
    },

    sync: sync,
    count: countPending,
    isFrozen: isFrozen,
    frozenInfo: frozenInfo,

    /** Desbloqueo manual por el supervisor (tras revisar el rechazo). */
    supervisorUnfreeze: function () { unfreeze(); notify(); sync(); },

    /** Suscripción a cambios de estado (pending / frozen / online). */
    onChange: function (fn) { listeners.push(fn); fn && fn({ pending: 0, frozen: isFrozen(), online: navigator.onLine }); return this; }
  };

  OMNI.outbox = outbox;

})(window.OMNI = window.OMNI || {});
