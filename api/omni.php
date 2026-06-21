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

$ALLOW = [
    'GET'  => ['auth/me', 'catalog/interlocutors', 'catalog/locations', 'catalog/skus', 'inventory/stock', 'analytics/kardex', 'health'],
    'POST' => ['auth/login', 'inventory/transfer'],
];

$client   = new OmniCoreClient($CFG['API_BASE'], $CFG['API_PREFIX'], (int) ($CFG['HTTP_TIMEOUT'] ?? 20));
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
    $headers = ['Accept: application/json'];
    if (!empty($_SESSION['omni_token'])) { $headers[] = 'Authorization: Bearer ' . $_SESSION['omni_token']; }
    if ($injectIid && !empty($_SESSION['omni_iid'])) { $headers[] = 'X-Interlocutor-Id: ' . $_SESSION['omni_iid']; }

    $ch  = curl_init($client->endpoint($endpoint));
    $opt = [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => (int) ($CFG['HTTP_TIMEOUT'] ?? 20), CURLOPT_SSL_VERIFYPEER => true];
    if ($payload !== null && $method !== 'GET') { $headers[] = 'Content-Type: application/json'; $opt[CURLOPT_POSTFIELDS] = json_encode($payload, JSON_UNESCAPED_UNICODE); }
    $opt[CURLOPT_HTTPHEADER] = $headers;
    curl_setopt_array($ch, $opt);
    $raw = curl_exec($ch); $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
    if ($raw === false) { return ['status' => 0, 'json' => null, 'error' => $err]; }
    return ['status' => $status, 'json' => json_decode($raw, true), 'error' => ''];
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
    success(['interlocutor' => activeInterlocutor()], 'Sede activa establecida');
}

if ($path === 'auth/login') {
    $username = trim((string) ($payload['username'] ?? $payload['usuario'] ?? ''));
    $password = (string) ($payload['password'] ?? '');
    if ($username === '' || $password === '') { failure('Usuario y contraseña son obligatorios.', 'ERR_VALIDATION', 400); }
    $r = $client->login($username, $password);
    if (empty($r['ok'])) { failure($r['error'] ?? 'Credenciales inválidas.', $r['code'] ?? 'ERR_AUTH', 401); }
    $_SESSION['omni_token'] = $r['token'];
    $_SESSION['omni_user']  = $r['user'] ?? null;
    unset($_SESSION['omni_iid'], $_SESSION['omni_iname']);
    success(['user' => $r['user'] ?? null, 'permissions' => $r['permissions'] ?? []], 'Sesión iniciada');
}

/* ═══════════════ ENDPOINTS DEL API (allowlist) ═══════════════ */

$allowedForMethod = $ALLOW[$method] ?? [];
if (!in_array($path, $allowedForMethod, true)) { failure('Endpoint no permitido: ' . $method . ' ' . $path, 'ERR_RBAC', 403); }
if ($path !== 'health' && empty($_SESSION['omni_token'])) { failure('Sesión no iniciada o expirada.', 'ERR_AUTH', 401); }

$isDiscovery = ($path === 'catalog/interlocutors');
if (!$isDiscovery && $path !== 'health' && empty($_SESSION['omni_iid'])) { failure('Selecciona una sede antes de operar.', 'ERR_VALIDATION', 400); }

$res = coreCall($client, $CFG, $method, $endpoint, $payload, !$isDiscovery);
if ($res['status'] === 0) { failure('Error de red con el API CORE: ' . $res['error'], 'ERR_OMNI_UNREACHABLE', 502); }
if ($res['status'] === 401) { $_SESSION = []; }

$body = is_array($res['json']) ? $res['json'] : ['status' => 'error', 'data' => null, 'message' => 'Respuesta no-JSON del API', 'error_code' => 'ERR_INTERNAL'];
reply($body, $res['status'] ?: 200);
