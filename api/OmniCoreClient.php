<?php
/**
 * SDK nativo de integración con el OMNI API CORE — proyecto [1001].
 * Implementa, en PHP del lado servidor, los métodos de autenticación descritos
 * en el cuaderno [1000] JOSEPAN 360 OMNI.
 *
 * Contrato consumido:
 *   Base URL : {API_CORE_BASE}{API_PREFIX}            (p. ej. https://omni.josepan.es/api/v1)
 *   Login    : POST /auth/login  { usuario, password }
 *   Respuesta: { "data": { "token": "...", "user": {...}, "permissions": ["recurso.accion", ...] } }
 *   Auth     : Authorization: Bearer <token>
 *
 * Esta academia NO valida credenciales contra su BD local: delega siempre en OMNI.
 */
class OmniCoreClient
{
    private string $baseUrl;
    private string $prefix;
    private int $timeout;
    private ?string $token = null;

    public function __construct(string $baseUrl, string $prefix = '/api/v1', int $timeout = 10)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->prefix  = '/' . trim($prefix, '/');
        $this->timeout = $timeout;
    }

    /** Endpoint absoluto a partir de una ruta relativa al prefijo /api/v1. */
    public function endpoint(string $path): string
    {
        return $this->baseUrl . $this->prefix . '/' . ltrim($path, '/');
    }

    public function setToken(string $token): void { $this->token = $token; }

    /**
     * Autenticación centralizada contra OMNI (cuaderno [1000]).
     * @return array{ok:bool, token?:string, user?:array, permissions?:array, error?:string, code?:string}
     */
    public function login(string $usuario, string $password): array
    {
        $body = json_encode([
            'usuario'  => $usuario,
            'username' => $usuario,
            'email'    => $usuario,
            'password' => $password,
        ], JSON_UNESCAPED_UNICODE);

        $res = $this->request('POST', '/auth/login', $body, false);

        // Respaldo de desarrollo si OMNI no responde y DEV_MODE está activo.
        if (defined('DEV_MODE') && DEV_MODE) {
            if ($usuario === DEV_USER && $password === DEV_PASS) {
                return [
                    'ok'          => true,
                    'token'       => 'dev-token',
                    'permissions' => ['academia.admin'],
                    'user'        => [
                        'id' => 1, 'nombre' => 'Administrador Demo',
                        'rol' => 'Director de Operaciones', 'tienda' => 'CEDI / Fábrica',
                        'email' => DEV_USER,
                    ],
                ];
            }else if ($usuario === "encargado_demo" && $password === DEV_PASS) {
                return [
                    'ok'          => true,
                    'token'       => 'dev-token',
                    'permissions' => ['academia.manager'],
                    'user'        => [
                        'id' => 1, 'nombre' => 'Encargado Demo',
                        'rol' => 'Encargado Tienda', 'tienda' => 'CEDI / Fábrica',
                        'email' => "encargado_demo",
                    ],
                ];
            }
            return ['ok' => false, 'error' => 'Credenciales de desarrollo no válidas.', 'code' => 'DEV_AUTH'];
        }

        if (!$res['ok']) {
            return ['ok' => false, 'error' => $res['error'] ?? 'No se pudo contactar con el OMNI API CORE.', 'code' => $res['code'] ?? 'OMNI_UNREACHABLE'];
        }

        $payload = $res['data'];
        if (($res['status'] ?? 0) >= 400) {
            return [
                'ok'    => false,
                'error' => $payload['message'] ?? $payload['error'] ?? 'Credenciales incorrectas.',
                'code'  => $payload['code'] ?? 'ERR_AUTH',
            ];
        }

        // OMNI envuelve la carga útil en "data".
        $data = $payload['data'] ?? $payload;
        $token = $data['token'] ?? $data['accessToken'] ?? $data['access_token'] ?? null;
        if (!$token) {
            return ['ok' => false, 'error' => 'OMNI no devolvió un token válido.', 'code' => 'ERR_NO_TOKEN'];
        }

        $this->token = $token;
        return [
            'ok'          => true,
            'token'       => $token,
            'permissions' => $data['permissions'] ?? [],
            'user'        => $this->normalizeUser($data['user'] ?? $data['profile'] ?? $data),
        ];
    }

    /** Sincroniza el perfil desde OMNI (GET /auth/me) usando el token actual. */
    public function me(): ?array
    {
        if (!$this->token) return null;
        $res = $this->request('GET', '/auth/me', null, true);
        if (!$res['ok'] || ($res['status'] ?? 0) >= 400) return null;
        $data = $res['data']['data'] ?? $res['data'];
        return $this->normalizeUser($data['user'] ?? $data);
    }

    /** Normaliza el objeto de usuario de OMNI a la forma que usa la academia. */
    public function normalizeUser(array $u): array
    {
        $rol = $u['rol'] ?? $u['role'] ?? $u['cargo'] ?? null;
        if (is_array($rol)) $rol = $rol[0] ?? 'Sin asignar';

        $tienda = $u['tienda'] ?? $u['sede'] ?? $u['franquicia']
            ?? $u['interlocutor_nombre'] ?? $u['location'] ?? null;
        if (is_array($tienda)) $tienda = $tienda['nombre'] ?? $tienda['name'] ?? 'Sin asignar';

        return [
            'id'     => (int)($u['id'] ?? $u['userId'] ?? $u['empleado_id'] ?? 0),
            'nombre' => $u['nombre'] ?? $u['name'] ?? $u['full_name'] ?? $u['username'] ?? 'Empleado',
            'rol'    => $rol ?: 'Sin asignar',
            'tienda' => $tienda ?: 'Sin asignar',
            'email'  => $u['email'] ?? $u['correo'] ?? null,
        ];
    }

    /** Petición cURL genérica. */
    private function request(string $method, string $path, ?string $body, bool $auth): array
    {
        $ch = curl_init($this->endpoint($path));
        $headers = ['Accept: application/json'];
        if ($body !== null)            $headers[] = 'Content-Type: application/json';
        if ($auth && $this->token)     $headers[] = 'Authorization: Bearer ' . $this->token;

        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);

        $raw    = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err    = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            return ['ok' => false, 'error' => 'Fallo de red con OMNI: ' . $err, 'code' => 'ERR_CURL'];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) $data = [];

        return ['ok' => true, 'status' => $status, 'data' => $data];
    }
}
