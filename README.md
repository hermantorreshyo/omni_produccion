# [1004] JOSEPAN 360 · OMNI — Producción en Planta

Login → **selección de fábrica (posterior al login)** → terminal: escanea/teclea/busca
producto terminado → **Concluir traslado** (custodia → bodega). Consume el OMNI API CORE v6
**siempre por PHP** (SDK `OmniCoreClient.php` + proxy `api/omni.php`) → cero CORS.
Aspecto visual heredado del subsistema [1002].

## Estructura
```
1004_04/
├── .htaccess
├── index.html           SPA (Inter + Tailwind, marca #642a72)
├── app.js               Login → sede → terminal; escaneo/tecleo/buscador; menú con KPIs
├── README.md
└── api/
    ├── config.php          Conexión + comportamiento (categorías por defecto)
    ├── OmniCoreClient.php   SDK oficial [1001] — sin modificar
    ├── omni.php             Proxy { endpoint, method, payload } (sesión PHP)
    └── settings.json        (se crea solo) categorías aceptadas persistidas
```

## Puesta en marcha
1. Copia `1004_04/` a la raíz web del subdominio (PHP 8 + cURL).
2. La carpeta `api/` debe tener **permiso de escritura** para PHP (para `settings.json`).
3. Abre el subdominio → **login (usuario + contraseña)** → **elige la sede del día (fábricas y puntos de venta)** → terminal.

## Cambios de esta versión
- **Sede posterior al login:** la elección de sede (todas: fábricas y puntos de venta) es una pantalla propia tras autenticarse
  (no dentro del login), como en los otros subsistemas. El proxy guarda la sede en sesión e
  inyecta `X-Interlocutor-Id`.
- **Categorías aceptadas configurables:** en el menú (solo roles admin/encargado) hay una sección
  para añadir/quitar los `item_type` que el módulo carga del catálogo. Se persisten en
  `api/settings.json` (compartido por todas las terminales). Por defecto: `PT`.
- **KPIs desde la base de datos:** el menú consulta `analytics/kardex?days=7&movement_category=TRASLADO`
  (scoped a la sede) y calcula, para el usuario autenticado, unidades/traslados/SKUs de hoy y de
  7 días, y la última actividad. Si no hay conexión, usa un respaldo local de la sesión.

## Formas de ingresar SKU
Escáner HID · tecleo manual (SKU/EAN + Enter) · buscador por nombre/código sobre el catálogo cargado.

## Contrato del proxy (Manual §6)
`POST api/omni.php { endpoint, method, payload }` → envelope `{ status, data, message, error_code }`.
Allowlist: `auth/login`, `auth/me`, `catalog/{interlocutors,locations,skus}`,
`inventory/{stock,transfer}`, `analytics/kardex`, `health`.
Pseudo-endpoints: `config`, `settings`, `auth/logout`, `select-interlocutor`.

## Notas
- "Categorías aceptadas" = códigos `item_type` (lo que el catálogo permite filtrar). Si necesitas
  filtrar por familias/categorías del catálogo y el API expone ese filtro, se adapta.
- Los KPIs muestran "API · tú" si el kardex trae el usuario por fila; si no, "API · sede".

---
*API CORE documentado: v6.6.0 · subsistema [1004] Producción.*
