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

## Formas de ingresar SKU y cantidad
Escáner HID · tecleo manual (SKU/EAN + Enter) · **buscador en vivo contra TODO el catálogo del API**
(`catalog/skus?q=`). La **cantidad** se puede teclear (campo junto al buscador) y ajustar con +/- en
cada lectura; las lecturas del mismo SKU se fusionan.

## Modelo de producción (orden de producción)
Al **Registrar producción**, por cada SKU contado se crea automáticamente una **orden de producción**
(`POST production/orders` con `recipe_id` mapeado desde el SKU + `interlocutor_id` de la sede),
se **ejecuta** (`PUT …/execute`) y se **completa** (`PUT …/complete` con `quantity_real` y
`output_location_id`). El `complete` incrementa stock y escribe el kardex con `movement_type='Produccion'`.
Todas las llamadas incluyen el header `X-Subsystem-Id: 1004`. Si un SKU no tiene receta, no se registra
(se avisa). El Outbox reanuda OPs a medio camino (guarda `orderId`/`executed`).

## Reporte de producción
Desde el menú → "Ver reporte": filtro por rango de fechas (o atajos Hoy / 7 / 30 días) y opción
"Solo yo". Consulta `production/orders?status=completado` (con filtro de fecha) y muestra totales
(unidades, movimientos, SKUs) y el desglose por producto.

## Contrato del proxy (Manual §6)
`POST api/omni.php { endpoint, method, payload }` → envelope `{ status, data, message, error_code }`.
Allowlist: `auth/login`, `auth/me`, `catalog/{interlocutors,locations,skus}`,
`inventory/{stock,transfer}`, `analytics/kardex`, `health`.
Pseudo-endpoints: `config`, `settings`, `auth/logout`, `select-interlocutor`.

## Notas
- "Categorías aceptadas" = códigos `item_type` (lo que el catálogo permite filtrar). Si necesitas
  filtrar por familias/categorías del catálogo y el API expone ese filtro, se adapta.
- Los KPIs muestran "API · tú" si el kardex trae el usuario por fila; si no, "API · sede".

## Compatibilidad API CORE v6.8
- **RBAC de pantallas (§16.1):** tras elegir sede, se consulta `rbac/subsystems/1004/my-screens`.
  `'*'` = acceso total; `[]` = **sin acceso** (se bloquea el terminal y vuelve a la selección de sede);
  el botón de reporte se muestra solo si el rol tiene la pantalla `historial`. Ante fallo de red no se bloquea.
- Los GET de referencia ya solo requieren JWT (desaparecen 403 de lectura): sin cambios.
- **Rol por sede:** al elegir la sede, el proxy **re-autentica con `interlocutor_id`** para que el JWT lleve el rol de ESA sede (necesario para permisos de escritura como crear/completar OPs). Las credenciales se guardan solo en la sesión PHP (HttpOnly) entre el login y la selección de sede, y se borran tras re-autenticar.

---
*API CORE documentado: v6.6.0 · subsistema [1004] Producción.*
