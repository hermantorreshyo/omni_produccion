<?php
declare(strict_types=1);

/* =====================================================================
 * [1004][JOSEPAN 360][OMNI] · index.php
 * Archivo maestro. Renderizado condicional del DOM segun el estado de
 * instalacion del nodo (presencia de config.php). Inyecta el bootstrap
 * estructural del nodo hacia el cliente (Single Source of Truth servidor)
 * sin exponer credenciales operativas.
 * ===================================================================== */

$configFile = __DIR__ . '/config.php';
$installed  = is_file($configFile);

/** @var array<string,mixed> $bootstrap */
$bootstrap = ['installed' => false];

if ($installed) {
    try {
        /** @var array<string,mixed> $cfg */
        $cfg = require $configFile;
        $bootstrap = [
            'installed'           => true,
            'apiUrl'              => (string)($cfg['api_url'] ?? ''),
            'interlocutorId'      => (string)($cfg['interlocutor_id'] ?? ''),
            'interlocutorName'    => (string)($cfg['interlocutor_name'] ?? ''),
            'custodyLocationId'   => (string)($cfg['custody_location_id'] ?? ''),
            'custodyLocationName' => (string)($cfg['custody_location_name'] ?? ''),
            'transitLocationId'   => (string)($cfg['transit_location_id'] ?? ''),
            'transitLocationName' => (string)($cfg['transit_location_name'] ?? ''),
            'installedAt'         => (string)($cfg['installed_at'] ?? ''),
        ];
    } catch (\Throwable $e) {
        // Nodo corrupto: forzar reinstalacion mostrando el wizard.
        $installed = false;
        $bootstrap = ['installed' => false, 'configError' => true];
    }
}

$bootstrapJson = json_encode($bootstrap, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
?>
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <meta name="theme-color" content="#ffffff" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <title>[1004] JOSEPAN 360 · Terminal de Produccion OMNI</title>

  <!-- TailwindCSS (utilidades estaticas). EN PRODUCCION: compilar a CSS estatico
       local y servirlo desde el propio nodo para no depender del CDN ni de la red. -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            ok:     '#10B981', // Verde  · confirmacion / lectura correcta / paso completado
            warn:   '#F59E0B', // Amarillo · advertencia / modo offline / incidencia leve
            danger: '#EF4444', // Rojo   · error critico / SKU corrupto / bloqueo
            ink:    '#18181b', // Texto y accion neutra (alto contraste)
            panel:  '#f4f4f5', // Paneles
            edge:   '#d4d4d8', // Bordes
            mute:   '#71717a'  // Texto secundario
          }
        }
      }
    };
  </script>

  <!-- CSS critico de respaldo: garantiza operacion legible aun sin el CDN (offline). -->
  <style>
    *{ -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
    html,body{ height:100%; margin:0; overscroll-behavior:none; background:#fff; color:#18181b;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-weight:600; touch-action:manipulation; -webkit-user-select:none; user-select:none; }
    .num{ font-variant-numeric: tabular-nums; font-feature-settings:'tnum' 1; letter-spacing:-0.01em; }
    .hidden{ display:none !important; }
    /* Pulsacion fat-finger: minimo 70px. Sin animaciones costosas. */
    .touch{ min-height:70px; min-width:70px; }
    .touch:active{ filter:brightness(0.94); }
    #pin-pad{ display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
    /* Banner offline intermitente (requisito explicito). */
    @keyframes blink{ 0%,100%{opacity:1} 50%{opacity:.35} }
    .blink{ animation: blink 1.1s steps(1) infinite; }
    /* Flash semantico breve de lectura (toggle de clase, sin keyframes pesados). */
    .stage{ transition: background-color .25s ease; }
    .stage.ok{ background:#ecfdf5; }
    .stage.err{ background:#fef2f2; }
    .scanner-trap{ position:absolute; opacity:0; pointer-events:none; height:1px; width:1px; }
    [safe-top]{ padding-top: env(safe-area-inset-top,0px); }
    [safe-bottom]{ padding-bottom: env(safe-area-inset-bottom,0px); }
  </style>
</head>

<body data-installed="<?= $installed ? '1' : '0' ?>">

  <!-- =================================================================== -->
  <!-- BANNERS GLOBALES                                                    -->
  <!-- =================================================================== -->
  <!-- Offline: AMARILLO intermitente -->
  <div id="offline-banner"
       class="hidden fixed top-0 inset-x-0 z-40 bg-warn text-ink text-center font-extrabold py-3 px-4 num text-lg tracking-wide blink"
       safe-top>
    <span id="offline-label">MODO OFFLINE</span> · <span id="offline-count">0</span> TRANSACCIONES RETENIDAS
  </div>

  <!-- Sincronizacion congelada: ROJO -->
  <div id="sync-error-banner"
       class="hidden fixed top-0 inset-x-0 z-50 bg-danger text-white text-center font-extrabold py-4 px-4"
       safe-top>
    <div class="text-lg uppercase tracking-wide">⚠ Sincronizacion bloqueada · Requiere supervisor</div>
    <div id="sync-error-detail" class="text-sm font-medium opacity-90 mt-1"></div>
  </div>


  <!-- =================================================================== -->
  <!-- VISTA A · SETUP WIZARD                                              -->
  <!-- =================================================================== -->
  <section id="setup-view" class="hidden min-h-screen w-full flex flex-col items-center px-5 py-8" safe-top safe-bottom>
    <div class="w-full max-w-md">
      <header class="text-center mb-7">
        <div class="font-black text-xl tracking-tight">JOSEPAN 360 · OMNI</div>
        <div class="text-mute text-xs uppercase tracking-[0.25em] mt-1">Terminal de Planta [1004]</div>
        <h1 class="font-extrabold text-2xl mt-4">Autoinstalacion del Nodo</h1>
      </header>

      <ol id="wizard-steps" class="flex items-center justify-between mb-7 px-1"></ol>

      <!-- PASO 1 -->
      <div data-step="1" class="wizard-panel">
        <h2 class="font-extrabold text-lg mb-1">1 · Conectividad con el API CORE</h2>
        <p class="text-mute text-sm mb-4">URL base del [1001] OMNI API CORE.</p>
        <label class="block text-xs uppercase tracking-wider text-mute mb-2">URL Base del API</label>
        <input id="cfg-api-url" type="url" inputmode="url" spellcheck="false" autocapitalize="off"
               value="https://api.omni.josepan.app/v1"
               class="w-full bg-white border-2 border-edge rounded-xl px-4 py-4 text-base num outline-none focus:border-ink mb-4" />
        <button id="btn-test-conn" class="touch w-full rounded-xl bg-ink text-white font-extrabold text-lg uppercase tracking-wide">
          Probar Conexion
        </button>
        <div id="conn-result" class="mt-3 text-sm font-bold num"></div>
      </div>

      <!-- PASO 2 -->
      <div data-step="2" class="wizard-panel hidden">
        <h2 class="font-extrabold text-lg mb-1">2 · Identidad del Nodo</h2>
        <p class="text-mute text-sm mb-4">Autenticacion del supervisor de infraestructura.</p>
        <label class="block text-xs uppercase tracking-wider text-mute mb-2">Usuario supervisor</label>
        <input id="cfg-sup-user" type="text" spellcheck="false" autocapitalize="off"
               class="w-full bg-white border-2 border-edge rounded-xl px-4 py-4 text-base outline-none focus:border-ink mb-3" />
        <label class="block text-xs uppercase tracking-wider text-mute mb-2">PIN / Contrasena</label>
        <input id="cfg-sup-pin" type="password" inputmode="numeric"
               class="w-full bg-white border-2 border-edge rounded-xl px-4 py-4 text-base num outline-none focus:border-ink mb-4" />
        <button id="btn-sup-auth" class="touch w-full rounded-xl bg-ink text-white font-extrabold text-lg uppercase tracking-wide">
          Validar y Cargar Fabricas
        </button>
        <div id="interlocutor-block" class="hidden mt-5">
          <label class="block text-xs uppercase tracking-wider text-mute mb-2">Fabrica / Sede de este terminal</label>
          <select id="cfg-interlocutor" class="touch w-full bg-white border-2 border-edge rounded-xl px-4 text-base outline-none focus:border-ink"></select>
        </div>
        <div id="sup-result" class="mt-3 text-sm font-bold"></div>
      </div>

      <!-- PASO 3 -->
      <div data-step="3" class="wizard-panel hidden">
        <h2 class="font-extrabold text-lg mb-1">3 · Mapeo de Ubicaciones</h2>
        <p class="text-mute text-sm mb-4">Ubicaciones base de custodia y destino.</p>
        <label class="block text-xs uppercase tracking-wider text-mute mb-2">Custodia Temporal (origen)</label>
        <select id="cfg-loc-custody" class="touch w-full bg-white border-2 border-edge rounded-xl px-4 text-base outline-none focus:border-ink mb-4"></select>
        <label class="block text-xs uppercase tracking-wider text-mute mb-2">Destino (Bodega / En transito)</label>
        <select id="cfg-loc-transit" class="touch w-full bg-white border-2 border-edge rounded-xl px-4 text-base outline-none focus:border-ink mb-4"></select>
        <button id="btn-step3-next" class="touch w-full rounded-xl bg-ink text-white font-extrabold text-lg uppercase tracking-wide">
          Continuar
        </button>
        <div id="loc-result" class="mt-3 text-sm font-bold"></div>
      </div>

      <!-- PASO 4 -->
      <div data-step="4" class="wizard-panel hidden">
        <h2 class="font-extrabold text-lg mb-1">4 · Finalizacion y Cifrado</h2>
        <p class="text-mute text-sm mb-4">Se escribira config.php en el servidor (permisos restringidos) y el cache cifrado del cliente.</p>
        <dl id="cfg-summary" class="bg-panel border border-edge rounded-xl p-4 text-sm space-y-2 mb-5 num"></dl>
        <button id="btn-finish-setup" class="touch w-full rounded-xl bg-ok text-white font-extrabold text-lg uppercase tracking-wide">
          Concluir Autoinstalacion
        </button>
        <div id="finish-result" class="mt-3 text-sm font-bold"></div>
      </div>

      <button data-open-docs data-docs-section="despliegue" class="mt-8 mx-auto block text-mute text-sm underline">Ver manuales (Usuario / Tecnico / Despliegue)</button>
    </div>
  </section>


  <!-- =================================================================== -->
  <!-- VISTA B · LOGIN OPERATIVO                                           -->
  <!-- =================================================================== -->
  <section id="auth-view" class="hidden min-h-screen w-full flex flex-col items-center justify-center px-5" safe-top safe-bottom>
    <input id="auth-scan-trap" class="scanner-trap" autocomplete="off" inputmode="none" />
    <div class="w-full max-w-sm text-center">
      <div class="font-black text-lg">JOSEPAN 360</div>
      <div id="auth-node-name" class="text-mute text-xs uppercase tracking-[0.2em] mb-6 num"></div>
      <h1 class="font-extrabold text-3xl mb-1">Identifiquese</h1>
      <p class="text-mute text-sm mb-5">Escanee su fotocheck o introduzca su PIN.</p>
      <div id="pin-display" class="num text-4xl font-bold tracking-[0.3em] h-16 flex items-center justify-center bg-panel border-2 border-edge rounded-xl mb-5"></div>
      <div id="pin-pad"></div>
      <div id="auth-result" class="mt-5 text-base font-bold min-h-[1.5rem]"></div>
      <button data-open-docs data-docs-section="usuario" class="mt-6 text-mute text-sm underline">Ayuda / Manual de usuario</button>
    </div>
  </section>


  <!-- =================================================================== -->
  <!-- VISTA C · TERMINAL DE PRODUCCION                                    -->
  <!-- =================================================================== -->
  <section id="production-view" class="hidden min-h-screen w-full flex flex-col" safe-top>
    <input id="prod-scan-trap" class="scanner-trap" autocomplete="off" inputmode="none" />
    <header class="flex items-center justify-between gap-2 px-4 py-3 bg-panel border-b border-edge">
      <div class="min-w-0">
        <div id="prod-factory" class="font-extrabold text-base truncate"></div>
        <div id="prod-operator" class="text-mute text-xs truncate num"></div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button data-open-docs class="touch w-[56px] rounded-xl bg-panel border-2 border-edge text-ink font-black text-xl" aria-label="Ayuda" style="min-width:56px;">?</button>
        <button id="btn-logout" class="touch px-4 rounded-xl bg-edge text-ink font-extrabold uppercase text-sm tracking-wide">Salir</button>
      </div>
    </header>

    <main id="prod-stage" class="stage flex-1 flex flex-col items-center justify-center px-5 py-6">
      <div class="text-mute uppercase tracking-[0.3em] text-sm mb-1">Pallet actual</div>
      <div id="prod-counter" class="num font-bold leading-none text-center text-ink" style="font-size:clamp(5rem,26vw,11rem);">0</div>
      <div class="num text-2xl font-bold text-mute uppercase tracking-wide -mt-1">Unidades listas</div>
      <div id="prod-last-sku" class="mt-4 text-base font-bold num min-h-[1.5rem]"></div>
    </main>

    <div class="px-4 pb-2">
      <div class="text-mute uppercase tracking-wider text-xs mb-2">Ultimas lecturas</div>
      <div id="prod-recent" class="space-y-2 min-h-[3rem]"></div>
    </div>

    <footer class="p-4 bg-panel border-t border-edge" safe-bottom>
      <button id="btn-conclude"
              class="touch w-full rounded-2xl bg-ink text-white font-black text-xl uppercase tracking-wide flex flex-col items-center justify-center py-4 disabled:opacity-40"
              style="min-height:84px;" disabled>
        Concluir Traslado
        <span class="text-xs font-bold tracking-widest opacity-90 mt-1">Traspasar custodia → bodega</span>
      </button>
    </footer>
  </section>


  <!-- =================================================================== -->
  <!-- VISTA DE CONTINGENCIA (anti-crash)                                  -->
  <!-- =================================================================== -->
  <section id="error-view" class="hidden fixed inset-0 z-[60] bg-danger flex flex-col items-center justify-center px-6 text-center" safe-top safe-bottom>
    <div class="text-7xl mb-4 text-white">⚠</div>
    <h1 class="font-black text-3xl text-white mb-2">Fallo del Terminal</h1>
    <p id="error-detail" class="text-white/90 font-bold num text-sm mb-8 max-w-sm break-words"></p>
    <button id="btn-error-retry" class="touch w-full max-w-sm rounded-2xl bg-white text-danger font-black text-xl uppercase tracking-wide py-5">
      Reintentar y Reenfocar Terminal
    </button>
  </section>


  <!-- =================================================================== -->
  <!-- MODAL · DOCUMENTACION EN VIVO (visor iframe de manual.html)         -->
  <!-- Fuente unica: manual.html (autonomo, abrible sin desplegar).        -->
  <!-- =================================================================== -->
  <section id="docs-modal" class="hidden fixed inset-0 z-[80] bg-black/70 flex flex-col">
    <div class="flex items-center justify-between gap-2 p-3 bg-white border-b border-edge" safe-top>
      <div class="font-black text-base truncate">Manuales · [1004] OMNI</div>
      <div class="flex items-center gap-2 shrink-0">
        <a href="manual.html" target="_blank" rel="noopener"
           class="touch px-3 rounded-xl bg-panel border-2 border-edge text-ink font-bold text-sm flex items-center">Abrir aparte</a>
        <button id="docs-close" class="touch w-[56px] rounded-xl bg-panel border-2 border-edge text-ink font-black text-2xl" style="min-width:56px;">×</button>
      </div>
    </div>
    <iframe id="docs-frame" title="Manuales del sistema" class="flex-1 w-full bg-white" style="border:0;"></iframe>
  </section>


  <!-- =================================================================== -->
  <!-- BOOTSTRAP servidor → cliente + feedback sensorial integrado         -->
  <!-- =================================================================== -->
  <script>
    window.__OMNI_BOOTSTRAP__ = <?= $bootstrapJson ?: '{"installed":false}' ?>;
    window.OMNI = window.OMNI || {};

    /* Feedback sensorial: audio sintetizado (WebAudio, sin archivos) + haptica. */
    OMNI.feedback = (function () {
      var ctx = null;
      function ac(){ if(!ctx){ var C=window.AudioContext||window.webkitAudioContext; if(C) ctx=new C(); } if(ctx&&ctx.state==='suspended') ctx.resume().catch(function(){}); return ctx; }
      function tone(freq,durMs,type,gainVal){ try{ var a=ac(); if(!a) return; var o=a.createOscillator(),g=a.createGain(); o.type=type||'square'; o.frequency.value=freq; g.gain.value=gainVal==null?0.18:gainVal; o.connect(g); g.connect(a.destination); var t=a.currentTime; o.start(t); o.stop(t+durMs/1000); g.gain.setValueAtTime(g.gain.value,t); g.gain.exponentialRampToValueAtTime(0.0001,t+durMs/1000);}catch(e){} }
      function vibrate(p){ try{ if(navigator.vibrate) navigator.vibrate(p);}catch(e){} }
      return {
        unlock: function(){ ac(); },
        success: function(){ tone(1320,90,'square',0.2); vibrate(40); },   // beep agudo
        error:   function(){ tone(180,420,'sawtooth',0.28); vibrate([90,80,90]); }, // buzzer grave
        action:  function(){ tone(880,110,'sine',0.16); vibrate(25); }
      };
    })();
    OMNI.log = function(){ try{ console.log.apply(console,['[OMNI 1004]'].concat([].slice.call(arguments))); }catch(e){} };
    window.addEventListener('pointerdown', function once(){ OMNI.feedback.unlock(); window.removeEventListener('pointerdown', once); }, { once:true });
  </script>

  <!-- Orden de carga por dependencias -->
  <script src="api-client.js"></script>
  <script src="outbox-service.js"></script>
  <script src="setup.js"></script>
  <script src="app.js"></script>
</body>
</html>
