<?php
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1004] PRODUCCIÓN
 *  api/omni.php — Proxy PHP mismo-origen hacia el API CORE v6 (sin CORS)
 *
 *  Contrato (Manual §6):  POST api/omni.php  { endpoint, method, payload }
 *  - Auth vía SDK OmniCoreClient.php (no modificar). Token en SESIÓN PHP.
 *  - Sede activa elegida tras login (sesión) → inyecta X-Interlocutor-Id (§5).
 *  - Envelope del API tal cual { status, data, message, error_code }.
 *  - Categorías aceptadas configurables y persistidas en settings.json.
 *  - Allowlist estricta. Pseudo-endpoints: config · settings · auth/logout · select-interlocutor.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Diagnóstico: cualquier fatal/excepción se devuelve como JSON (no 500 vacío) ──
ini_set('display_errors', '0');
error_reporting(E_ALL);
set_exception_handler(function ($e) {
    if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); }
    echo json_encode(['status' => 'error', 'data' => null, 'message' => 'PHP: ' . $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine(), 'error_code' => 'ERR_PHP_EXCEPTION'], JSON_UNESCAPED_UNICODE);
    exit;
});
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); }
        echo json_encode(['status' => 'error', 'data' => null, 'message' => 'PHP fatal: ' . $e['message'] . ' @ ' . basename($e['file']) . ':' . $e['line'], 'error_code' => 'ERR_PHP_FATAL'], JSON_UNESCAPED_UNICODE);
    }
});

session_start();
require_once __DIR__ . '/OmniCoreClient.php';
$CFG = require __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(200); exit; }

function reply(array $payload, int $status = 200): void { http_response_code($status); echo json_encode($payload, JSON_UNESCAPED_UNICODE); exit; }
function success($data, string $message = 'OK'): void { reply(['status' => 'success', 'data' => $data, 'message' => $message]); }
function failure(string $message, string $code = 'ERR_INTERNAL', int $status = 400): void { reply(['status' => 'error', 'data' => null, 'message' => $message, 'error_code' => $code], $status); }

/* ── Ajustes persistidos (categorías aceptadas) ─────────────────────────── */
function settingsPath(): string { return __DIR__ . '/settings.json'; }
function readSettings(array $CFG): array {
    $defaults = ['accepted_categories' => array_values($CFG['SKU_ITEM_TYPES'] ?? ['PT'])];
    $p = settingsPath();
    if (is_file($p)) { $j = json_decode((string) file_get_contents($p), true); if (is_array($j)) return array_merge($defaults, $j); }
    return $defaults;
}
function writeSettings(array $data): bool {
    return @file_put_contents(settingsPath(), json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)) !== false;
}

$in       = json_decode(file_get_contents('php://input') ?: '[]', true);
$in       = is_array($in) ? $in : [];
$endpoint = trim((string) ($in['endpoint'] ?? ''));
$method   = strtoupper((string) ($in['method'] ?? 'GET'));
$payload  = (isset($in['payload']) && is_array($in['payload'])) ? $in['payload'] : null;
$path     = strtok($endpoint, '?');
if ($endpoint === '') { failure('Falta el campo "endpoint".', 'ERR_VALIDATION', 400); }

function isAllowedEndpoint(string $method, string $path): bool {
    $exact = [
        'GET'  => ['auth/me', 'catalog/interlocutors', 'catalog/locations', 'catalog/skus', 'inventory/stock', 'analytics/kardex', 'production/recipes', 'production/orders', 'system/params', 'health'],
        'POST' => ['auth/login', 'inventory/transfer', 'production/orders'],
    ];
    if (isset($exact[$method]) && in_array($path, $exact[$method], true)) return true;
    if ($method === 'GET' && preg_match('#^rbac/subsystems/\d+/my-screens$#', $path)) return true;     // RBAC pantallas (§16.1)
    if ($method === 'GET' && preg_match('#^production/orders/\d+$#', $path)) return true;           // detalle OP
    if ($method === 'PUT' && preg_match('#^production/orders/\d+/(execute|complete)$#', $path)) return true; // ejecutar/completar
    return false;
}

function omniClient(array $CFG): OmniCoreClient {
    static $c = null;
    if ($c === null) { $c = new OmniCoreClient($CFG['API_BASE'], $CFG['API_PREFIX'], (int) ($CFG['HTTP_TIMEOUT'] ?? 20)); }
    return $c;
}
$settings = readSettings($CFG);

function publicConfig(array $CFG, array $settings): array {
    return [
        'accepted_categories' => $settings['accepted_categories'],
        'movement_type'       => $CFG['MOVEMENT_TYPE'],
        'custody_pattern'     => $CFG['CUSTODY_AREA_PATTERN'] ?? 'producto_terminado',
        'transit_pattern'     => $CFG['TRANSIT_AREA_PATTERN'] ?? 'bodega',
    ];
}
function activeInterlocutor(): ?array {
    if (empty($_SESSION['omni_iid'])) return null;
    return ['id' => $_SESSION['omni_iid'], 'name' => $_SESSION['omni_iname'] ?? ('Sede ' . $_SESSION['omni_iid'])];
}
function userRole(): string {
    $u = $_SESSION['omni_user'] ?? [];
    return strtolower((string) ($u['rol'] ?? $u['role'] ?? ''));
}
function isAdminish(): bool {
    $r = userRole();
    return $r === '' || (bool) preg_match('/super|admin|director|supervisor|jefe|encargad/i', $r);
}

function coreCall(OmniCoreClient $client, array $CFG, string $method, string $endpoint, ?array $payload, bool $injectIid): array {
    $headers = ['Accept: application/json', 'X-Subsystem-Id: 1004'];
    if (!empty($_SESSION['omni_token'])) { $headers[] = 'Authorization: Bearer ' . $_SESSION['omni_token']; }
    if ($injectIid && !empty($_SESSION['omni_iid'])) { $headers[] = 'X-Interlocutor-Id: ' . $_SESSION['omni_iid']; }

    $ch  = curl_init($client->endpoint($endpoint));
    $opt = [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => (int) ($CFG['HTTP_TIMEOUT'] ?? 20), CURLOPT_SSL_VERIFYPEER => true];
    if ($payload !== null && $method !== 'GET') { $headers[] = 'Content-Type: application/json'; $opt[CURLOPT_POSTFIELDS] = json_encode($payload, JSON_UNESCAPED_UNICODE); }
    $opt[CURLOPT_HTTPHEADER] = $headers;
    curl_setopt_array($ch, $opt);
    $raw = curl_exec($ch); $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
    if ($raw === false) { return ['status' => 0, 'json' => null, 'raw' => '', 'error' => $err]; }
    return ['status' => $status, 'json' => json_decode($raw, true), 'raw' => $raw, 'error' => ''];
}

/**
 * Login crudo contra el API CORE (v6.8): SIEMPRE con interlocutor_id (como los demás
 * subsistemas). Construye el usuario desde los campos planos de la respuesta v6.8.
 * $iid = null → login sin interlocutor_id (fallback para operarios sin sede de arranque).
 */
function rawLogin(array $CFG, string $username, string $password, ?int $iid): array {
    $body = ['usuario' => $username, 'username' => $username, 'email' => $username, 'password' => $password];
    if ($iid !== null && $iid > 0) { $body['interlocutor_id'] = $iid; }
    $res = coreCall(omniClient($CFG), $CFG, 'POST', 'auth/login', $body, false);
    if ($res['status'] === 0) { return ['ok' => false, 'error' => 'Sin conexión con el API CORE: ' . $res['error'], 'code' => 'ERR_OMNI_UNREACHABLE', 'status' => 502]; }
    if (!is_array($res['json'])) {
        $snip = function_exists('mb_substr') ? mb_substr(trim((string) $res['raw']), 0, 200) : substr(trim((string) $res['raw']), 0, 200);
        return ['ok' => false, 'error' => 'Login sin JSON (HTTP ' . $res['status'] . '). ' . $snip, 'code' => 'ERR_NON_JSON', 'status' => $res['status'] ?: 502];
    }
    $j = $res['json'];
    if (($j['status'] ?? '') !== 'success') { return ['ok' => false, 'error' => $j['message'] ?? 'Credenciales inválidas.', 'code' => $j['error_code'] ?? 'ERR_AUTH', 'status' => $res['status'] ?: 401]; }
    $d = $j['data'] ?? $j;
    $token = $d['token'] ?? $d['accessToken'] ?? $d['access_token'] ?? null;
    if (!$token) { return ['ok' => false, 'error' => 'El API no devolvió token.', 'code' => 'ERR_NO_TOKEN', 'status' => 502]; }
    $uid = (int) ($d['user_id'] ?? $d['id'] ?? 0);
    $user = [
        'id' => $uid, 'user_id' => $uid,
        'username' => $d['username'] ?? $username,
        'nombre'   => $d['nombre'] ?? $d['name'] ?? $d['username'] ?? $username,
        'rol'      => $d['role'] ?? $d['rol'] ?? '',
        'role'     => $d['role'] ?? $d['rol'] ?? '',
        'tienda'   => $d['interlocutor_name'] ?? null,
    ];
    return ['ok' => true, 'token' => $token, 'user' => $user, 'permissions' => $d['permissions'] ?? [], 'interlocutor_id' => $d['interlocutor_id'] ?? $iid, 'interlocutor_name' => $d['interlocutor_name'] ?? null];
}

/* ═══════════════ PSEUDO-ENDPOINTS LOCALES ═══════════════ */

if ($path === 'config') {
    success(['config' => publicConfig($CFG, $settings), 'authenticated' => !empty($_SESSION['omni_token']), 'user' => $_SESSION['omni_user'] ?? null, 'interlocutor' => activeInterlocutor(), 'can_configure' => isAdminish()]);
}

if ($path === 'settings') {
    if (empty($_SESSION['omni_token'])) { failure('Sesión no iniciada.', 'ERR_AUTH', 401); }
    if ($method === 'POST') {
        if (!isAdminish()) { failure('Solo un administrador puede cambiar la configuración.', 'ERR_RBAC', 403); }
        $cats = $payload['accepted_categories'] ?? null;
        if (!is_array($cats)) { failure('accepted_categories debe ser una lista.', 'ERR_VALIDATION', 400); }
        $clean = [];
        foreach ($cats as $c) { $c = strtoupper(trim((string) $c)); if ($c !== '' && preg_match('/^[A-Z0-9_]{1,12}$/', $c)) { $clean[$c] = true; } }
        if (!$clean) { failure('Indica al menos una categoría válida.', 'ERR_VALIDATION', 400); }
        $settings['accepted_categories'] = array_keys($clean);
        if (!writeSettings($settings)) { failure('No se pudo guardar (carpeta api/ sin permiso de escritura).', 'ERR_INTERNAL', 500); }
    }
    success(['settings' => $settings]);
}

if ($path === 'auth/logout') {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) { $p = session_get_cookie_params(); setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']); }
    session_destroy();
    success(['logged_out' => true], 'Sesión cerrada');
}

if ($path === 'select-interlocutor') {
    if (empty($_SESSION['omni_token'])) { failure('Sesión no iniciada.', 'ERR_AUTH', 401); }
    $iid = (int) ($payload['interlocutor_id'] ?? 0);
    if ($iid <= 0) { failure('interlocutor_id inválido.', 'ERR_VALIDATION', 400); }
    $_SESSION['omni_iid'] = $iid;
    $_SESSION['omni_iname'] = trim((string) ($payload['interlocutor_name'] ?? ('Sede ' . $iid)));

    // v6.8 §2: re-autenticar con la sede elegida para que el JWT lleve el ROL de ESA sede.
    if (!empty($_SESSION['omni_cred']['u'])) {
        $r = rawLogin($CFG, $_SESSION['omni_cred']['u'], $_SESSION['omni_cred']['p'], $iid);
        if (!empty($r['ok'])) {
            $_SESSION['omni_token'] = $r['token'];
            $_SESSION['omni_user']  = $r['user'];
            if (!empty($r['interlocutor_name'])) { $_SESSION['omni_iname'] = $r['interlocutor_name']; }
        }
        unset($_SESSION['omni_cred']); // el password ya no se necesita
    }
    success(['interlocutor' => activeInterlocutor(), 'user' => $_SESSION['omni_user'] ?? null], 'Sede activa establecida');
}

if ($path === 'auth/login') {
    $username = trim((string) ($payload['username'] ?? $payload['usuario'] ?? ''));
    $password = (string) ($payload['password'] ?? '');
    if ($username === '' || $password === '') { failure('Usuario y contraseña son obligatorios.', 'ERR_VALIDATION', 400); }
    // v6.8: el login SIEMPRE lleva interlocutor_id. Arranque con el por defecto (para poder listar sedes);
    // si ese interlocutor no aplica al usuario, fallback a login sin interlocutor_id.
    $boot = (int) ($CFG['DEFAULT_INTERLOCUTOR_ID'] ?? 1);
    $r = rawLogin($CFG, $username, $password, $boot);
    if (empty($r['ok'])) { $r2 = rawLogin($CFG, $username, $password, null); if (!empty($r2['ok'])) { $r = $r2; } }
    if (empty($r['ok'])) { failure($r['error'] ?? 'Credenciales inválidas.', $r['code'] ?? 'ERR_AUTH', $r['status'] ?? 401); }
    $_SESSION['omni_token'] = $r['token'];
    $_SESSION['omni_user']  = $r['user'];
    $_SESSION['omni_cred']  = ['u' => $username, 'p' => $password]; // server-side, para re-autenticar con la sede
    unset($_SESSION['omni_iid'], $_SESSION['omni_iname']);          // la sede real se elige después
    success(['user' => $r['user'], 'permissions' => $r['permissions']], 'Sesión iniciada');
}

/* ═══════════════ ENDPOINTS DEL API (allowlist) ═══════════════ */

if (!isAllowedEndpoint($method, $path)) { failure('Endpoint no permitido: ' . $method . ' ' . $path, 'ERR_RBAC', 403); }
if ($path !== 'health' && empty($_SESSION['omni_token'])) { failure('Sesión no iniciada o expirada.', 'ERR_AUTH', 401); }

$isDiscovery = ($path === 'catalog/interlocutors');
if (!$isDiscovery && $path !== 'health' && empty($_SESSION['omni_iid'])) { failure('Selecciona una sede antes de operar.', 'ERR_VALIDATION', 400); }

$res = coreCall(omniClient($CFG), $CFG, $method, $endpoint, $payload, !$isDiscovery);
if ($res['status'] === 0) { failure('Error de red con el API CORE: ' . $res['error'], 'ERR_OMNI_UNREACHABLE', 502); }
if ($res['status'] === 401) { $_SESSION = []; }

if (is_array($res['json'])) { reply($res['json'], $res['status'] ?: 200); }

// El API no devolvió JSON: surface el cuerpo real para diagnosticar (HTML/500/etc).
$snippet = trim((string) ($res['raw'] ?? ''));
$snippet = function_exists('mb_substr') ? mb_substr($snippet, 0, 300) : substr($snippet, 0, 300);
failure(
    'El API CORE respondió sin JSON (HTTP ' . $res['status'] . ' en ' . $path . '). ' . ($snippet !== '' ? 'Inicio: ' . $snippet : '(respuesta vacía)'),
    'ERR_NON_JSON',
    $res['status'] >= 400 ? $res['status'] : 502
);
