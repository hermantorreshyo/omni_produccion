<?php
declare(strict_types=1);

/* =====================================================================
 * [1004][JOSEPAN 360][OMNI] · setup.php
 * Backend nativo del Asistente de Configuracion (sin frameworks).
 * Actua como proxy de mismo origen hacia el [1001] API CORE durante la
 * instalacion (evita CORS), escribe config.php con permisos restringidos
 * y expone acciones de estado / purga de nodo.
 *
 * Principios: POO limpia, SRP por clase, manejo semantico de excepciones
 * con log centralizado y respuestas JSON consistentes.
 * ===================================================================== */

namespace Josepan\Omni1004;

/* ---------------------------------------------------------------------
 * Logger · registro centralizado de eventos del setup.
 * ------------------------------------------------------------------- */
final class Logger
{
    private string $file;

    public function __construct(string $file)
    {
        $this->file = $file;
    }

    public function write(string $level, string $message): void
    {
        $line = sprintf("[%s] %s: %s%s", date('c'), strtoupper($level), $message, PHP_EOL);
        // Fallo de escritura de log nunca debe tumbar la peticion.
        @file_put_contents($this->file, $line, FILE_APPEND | LOCK_EX);
    }

    public function info(string $m): void  { $this->write('info', $m); }
    public function error(string $m): void { $this->write('error', $m); }
}

/* ---------------------------------------------------------------------
 * SetupException · excepcion semantica con codigo HTTP asociado.
 * ------------------------------------------------------------------- */
final class SetupException extends \RuntimeException
{
    public int $httpStatus;

    public function __construct(string $message, int $httpStatus = 400)
    {
        parent::__construct($message);
        $this->httpStatus = $httpStatus;
    }
}

/* ---------------------------------------------------------------------
 * HttpClient · cliente HTTP nativo (cURL con fallback a streams).
 * ------------------------------------------------------------------- */
final class HttpClient
{
    private int $timeout;

    public function __construct(int $timeout = 15)
    {
        $this->timeout = $timeout;
    }

    /**
     * @param array<string,string> $headers
     * @return array{status:int, body:string, latency_ms:int}
     */
    public function request(string $method, string $url, ?string $body = null, array $headers = []): array
    {
        $start = microtime(true);

        if (\function_exists('curl_init')) {
            $result = $this->viaCurl($method, $url, $body, $headers);
        } else {
            $result = $this->viaStream($method, $url, $body, $headers);
        }

        $result['latency_ms'] = (int) round((microtime(true) - $start) * 1000);
        return $result;
    }

    /** @param array<string,string> $headers @return array{status:int, body:string} */
    private function viaCurl(string $method, string $url, ?string $body, array $headers): array
    {
        $ch = curl_init();
        $hdr = [];
        foreach ($headers as $k => $v) { $hdr[] = $k . ': ' . $v; }

        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_HTTPHEADER     => $hdr,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $resp = curl_exec($ch);
        if ($resp === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new SetupException('Error de red hacia el API CORE: ' . $err, 502);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return ['status' => $status, 'body' => (string) $resp];
    }

    /** @param array<string,string> $headers @return array{status:int, body:string} */
    private function viaStream(string $method, string $url, ?string $body, array $headers): array
    {
        $headerLines = '';
        foreach ($headers as $k => $v) { $headerLines .= $k . ': ' . $v . "\r\n"; }

        $ctx = stream_context_create(['http' => [
            'method'        => $method,
            'header'        => $headerLines,
            'content'       => $body ?? '',
            'timeout'       => $this->timeout,
            'ignore_errors' => true,
        ]]);

        $resp = @file_get_contents($url, false, $ctx);
        if ($resp === false) {
            throw new SetupException('Error de red hacia el API CORE (stream).', 502);
        }
        $status = 0;
        if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) {
            $status = (int) $m[1];
        }
        return ['status' => $status ?: 200, 'body' => (string) $resp];
    }
}

/* ---------------------------------------------------------------------
 * NodeConfig · persistencia del estado estructural del nodo (config.php).
 * ------------------------------------------------------------------- */
final class NodeConfig
{
    private string $path;

    public function __construct(string $path)
    {
        $this->path = $path;
    }

    public function isInstalled(): bool
    {
        return is_file($this->path);
    }

    /** @param array<string,mixed> $cfg */
    public function write(array $cfg): void
    {
        $export = var_export($cfg, true);
        $php = "<?php\ndeclare(strict_types=1);\n/* [1004][OMNI] config de nodo autogenerado. NO editar a mano. */\nreturn {$export};\n";

        if (@file_put_contents($this->path, $php, LOCK_EX) === false) {
            throw new SetupException('No se pudo escribir config.php. Verifique permisos de escritura del directorio.', 500);
        }
        // Permisos restringidos (lectura/escritura solo del propietario).
        @chmod($this->path, 0600);
    }

    public function purge(): bool
    {
        if (is_file($this->path)) {
            return @unlink($this->path);
        }
        return true;
    }
}

/* ---------------------------------------------------------------------
 * Jwt · utilidades minimas de inspeccion del token (sin verificar firma;
 *       la verificacion criptografica es responsabilidad del API CORE).
 * ------------------------------------------------------------------- */
final class Jwt
{
    /** @return array<string,mixed>|null */
    public static function payload(string $token): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) < 2) { return null; }
        $json = base64_decode(strtr($parts[1], '-_', '+/'), true);
        if ($json === false) { return null; }
        $data = json_decode($json, true);
        return is_array($data) ? $data : null;
    }

    /** @param array<string,mixed> $payload */
    public static function hasSupervisorRole(array $payload): bool
    {
        $roles = $payload['roles'] ?? ($payload['role'] ?? []);
        foreach ((array) $roles as $r) {
            if (preg_match('/supervisor|admin|infra/i', (string) $r)) { return true; }
        }
        return false;
    }
}

/* ---------------------------------------------------------------------
 * SetupController · orquesta las acciones del asistente.
 * ------------------------------------------------------------------- */
final class SetupController
{
    private HttpClient $http;
    private NodeConfig $config;
    private Logger $log;

    public function __construct(HttpClient $http, NodeConfig $config, Logger $log)
    {
        $this->http = $http;
        $this->config = $config;
        $this->log = $log;
    }

    private function baseUrl(array $in): string
    {
        $url = trim((string) ($in['api_url'] ?? ''));
        if ($url === '' || !preg_match('#^https?://#i', $url)) {
            throw new SetupException('URL base del API invalida.', 422);
        }
        return rtrim($url, '/');
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    public function dispatch(string $action, array $in): array
    {
        switch ($action) {
            case 'status':         return $this->status();
            case 'test_connection':return $this->testConnection($in);
            case 'auth':           return $this->auth($in);
            case 'interlocutors':  return $this->interlocutors($in);
            case 'locations':      return $this->locations($in);
            case 'install':        return $this->install($in);
            case 'purge':          return $this->purge($in);
            default:
                throw new SetupException('Accion no reconocida: ' . $action, 404);
        }
    }

    /** @return array<string,mixed> */
    private function status(): array
    {
        return ['installed' => $this->config->isInstalled()];
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    private function testConnection(array $in): array
    {
        $base = $this->baseUrl($in);
        $res = $this->http->request('GET', $base . '/health', null, ['Accept' => 'application/json']);
        if ($res['status'] < 200 || $res['status'] >= 300) {
            throw new SetupException('El API CORE respondio HTTP ' . $res['status'] . ' en /health.', 502);
        }
        $this->log->info('Health OK ' . $base . ' (' . $res['latency_ms'] . 'ms)');
        return ['ok' => true, 'latency_ms' => $res['latency_ms']];
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    private function auth(array $in): array
    {
        $base = $this->baseUrl($in);
        $payload = json_encode([
            'identifier' => (string) ($in['user'] ?? ''),
            'pin'        => (string) ($in['pin'] ?? ''),
        ]);
        $res = $this->http->request('POST', $base . '/auth/login', $payload, [
            'Accept' => 'application/json', 'Content-Type' => 'application/json',
        ]);
        $data = json_decode($res['body'], true);
        if ($res['status'] < 200 || $res['status'] >= 300 || !is_array($data) || empty($data['token'])) {
            throw new SetupException('Credenciales de supervisor invalidas.', 401);
        }
        $claims = Jwt::payload((string) $data['token']) ?? [];
        $rolesOk = Jwt::hasSupervisorRole($claims)
            || Jwt::hasSupervisorRole(is_array($data['user'] ?? null) ? $data['user'] : []);
        if (!$rolesOk) {
            throw new SetupException('El usuario no tiene perfil para instalar terminales.', 403);
        }
        $this->log->info('Supervisor autenticado para instalacion.');
        return ['token' => (string) $data['token'], 'user' => $data['user'] ?? null];
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    private function interlocutors(array $in): array
    {
        $base = $this->baseUrl($in);
        $token = (string) ($in['token'] ?? '');
        $res = $this->http->request('GET', $base . '/interlocutors', null, [
            'Accept' => 'application/json', 'Authorization' => 'Bearer ' . $token,
        ]);
        return ['items' => $this->unwrap($res)];
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    private function locations(array $in): array
    {
        $base = $this->baseUrl($in);
        $token = (string) ($in['token'] ?? '');
        $iid = rawurlencode((string) ($in['interlocutor_id'] ?? ''));
        $res = $this->http->request('GET', $base . '/locations?interlocutor_id=' . $iid, null, [
            'Accept' => 'application/json', 'Authorization' => 'Bearer ' . $token,
        ]);
        return ['items' => $this->unwrap($res)];
    }

    /** @param array{status:int,body:string} $res @return array<int,mixed> */
    private function unwrap(array $res): array
    {
        if ($res['status'] < 200 || $res['status'] >= 300) {
            throw new SetupException('El API CORE respondio HTTP ' . $res['status'] . '.', 502);
        }
        $data = json_decode($res['body'], true);
        if (is_array($data)) {
            if (isset($data['data']) && is_array($data['data']))   { return $data['data']; }
            if (isset($data['items']) && is_array($data['items'])) { return $data['items']; }
            return $data;
        }
        return [];
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    private function install(array $in): array
    {
        $required = ['api_url', 'interlocutor_id', 'custody_location_id', 'transit_location_id', 'token'];
        foreach ($required as $f) {
            if (empty($in[$f])) {
                throw new SetupException('Falta el campo obligatorio: ' . $f, 422);
            }
        }
        // El token debe ser de un supervisor (autorizacion para instalar).
        $claims = Jwt::payload((string) $in['token']) ?? [];
        if (!Jwt::hasSupervisorRole($claims)) {
            throw new SetupException('Token sin privilegios para instalar el nodo.', 403);
        }
        if ((string) $in['custody_location_id'] === (string) $in['transit_location_id']) {
            throw new SetupException('Origen y destino deben ser distintos.', 422);
        }

        // Se persisten SOLO identificadores estructurales; jamas credenciales operativas.
        $this->config->write([
            'api_url'               => rtrim((string) $in['api_url'], '/'),
            'interlocutor_id'       => (string) $in['interlocutor_id'],
            'interlocutor_name'     => (string) ($in['interlocutor_name'] ?? ''),
            'custody_location_id'   => (string) $in['custody_location_id'],
            'custody_location_name' => (string) ($in['custody_location_name'] ?? ''),
            'transit_location_id'   => (string) $in['transit_location_id'],
            'transit_location_name' => (string) ($in['transit_location_name'] ?? ''),
            'installed_at'          => date('c'),
        ]);
        $this->log->info('Nodo instalado: ' . $in['interlocutor_name'] . ' (#' . $in['interlocutor_id'] . ')');
        return ['installed' => true];
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    private function purge(array $in): array
    {
        // Purga de infraestructura: exige token de supervisor.
        $claims = Jwt::payload((string) ($in['token'] ?? '')) ?? [];
        if (!Jwt::hasSupervisorRole($claims)) {
            throw new SetupException('Purga no autorizada: requiere supervisor.', 403);
        }
        $ok = $this->config->purge();
        $this->log->info('Purga de nodo solicitada. Resultado: ' . ($ok ? 'OK' : 'FALLIDA'));
        return ['purged' => $ok];
    }
}

/* =====================================================================
 * BOOTSTRAP DE LA PETICION
 * ===================================================================== */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$logger     = new Logger(__DIR__ . '/setup.log');
$nodeConfig = new NodeConfig(__DIR__ . '/config.php');
$controller = new SetupController(new HttpClient(15), $nodeConfig, $logger);

try {
    // Acepta JSON en el cuerpo o accion por query string.
    $raw  = file_get_contents('php://input') ?: '';
    $body = json_decode($raw, true);
    if (!is_array($body)) { $body = []; }

    $action = (string) ($_GET['action'] ?? ($body['action'] ?? ''));
    if ($action === '') {
        throw new SetupException('Parametro "action" requerido.', 400);
    }

    $result = $controller->dispatch($action, $body);
    echo json_encode(['ok' => true, 'data' => $result], JSON_UNESCAPED_UNICODE);
} catch (SetupException $e) {
    http_response_code($e->httpStatus);
    $logger->error($e->getMessage());
    echo json_encode(['ok' => false, 'error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
} catch (\Throwable $e) {
    http_response_code(500);
    $logger->error('Excepcion no controlada: ' . $e->getMessage());
    echo json_encode(['ok' => false, 'error' => 'Error interno del servidor de instalacion.'], JSON_UNESCAPED_UNICODE);
}
