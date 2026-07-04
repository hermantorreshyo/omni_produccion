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

## Diagnóstico de errores del proxy
Si el API CORE o PHP fallan, `api/omni.php` ya **no** devuelve un 500 vacío: captura el fatal y
responde JSON con el mensaje real (`ERR_PHP_FATAL` / `ERR_PHP_EXCEPTION` / `ERR_NON_JSON`),
que el terminal muestra en pantalla. El cliente del API se construye de forma perezosa (el arranque
`config` no depende de cURL ni del SDK).

## Notas
- "Categorías aceptadas" = códigos `item_type` (lo que el catálogo permite filtrar). Si necesitas
  filtrar por familias/categorías del catálogo y el API expone ese filtro, se adapta.
- Los KPIs muestran "API · tú" si el kardex trae el usuario por fila; si no, "API · sede".

## Compatibilidad API CORE v6.8
- **Login siempre con `interlocutor_id`** (como los demás subsistemas): el login del SDK lo enviaba
  sin `interlocutor_id`, lo que provocaba `Unknown column 'id' in 'ORDER BY'` para el SuperAdmin.
  Ahora el proxy hace login **crudo** con un interlocutor de arranque (`DEFAULT_INTERLOCUTOR_ID`, por
  defecto 1) para poder listar sedes, y **re-autentica con la sede elegida** (rol correcto en el JWT).
  El usuario se construye desde los campos planos v6.8 (`user_id`, `role`, `interlocutor_name`).
- **RBAC de pantallas (§16.1):** tras elegir sede, se consulta `rbac/subsystems/1004/my-screens`.
  `'*'` = acceso total; `[]` = **sin acceso** (se bloquea el terminal y vuelve a la selección de sede);
  el botón de reporte se muestra solo si el rol tiene la pantalla `historial`. Ante fallo de red no se bloquea.
- Los GET de referencia ya solo requieren JWT (desaparecen 403 de lectura): sin cambios.
- **Rol por sede:** al elegir la sede, el proxy **re-autentica con `interlocutor_id`** para que el JWT lleve el rol de ESA sede (necesario para permisos de escritura como crear/completar OPs). Las credenciales se guardan solo en la sesión PHP (HttpOnly) entre el login y la selección de sede, y se borran tras re-autenticar.

---
*API CORE documentado: v6.6.0 · subsistema [1004] Producción.*


## Modo visual (rejilla de productos)
El terminal muestra los productos terminados como **tarjetas grandes tocables** (icono por
tipo de producto derivado del nombre + color suave), pensado para operarios poco habituados a
teclear. Un toque suma +1; la insignia sobre la tarjeta muestra la cantidad en el lote.
- **Más usados / Todos:** arranca en los más registrados de la sede (desde el historial local);
  el buscador y el escáner siguen disponibles como respaldo.
- **Solo con receta:** los PT sin receta se marcan «SIN RECETA» y no se pueden registrar
  (la producción crea una orden que necesita `recipe_id`).
- **Responsive:** en tablet el resumen del lote es un panel fijo a la derecha; en móvil es una
  barra inferior (contador + Registrar) con una hoja deslizante para revisar/editar el lote.
- Cantidades finas con **− / +** en cada línea del resumen. Cache-buster `app.js?v=20260701a`.


## Sincronización con OMNI API CORE v6.9
- **`GET /system/params` tras el login:** lee `recipe_restriction`, `stock_negative_allowed`,
  `inventory_restriction`, `decimal_precision` (módulo `Params`). Permitido en el proxy.
- **`recipe_id` opcional:** si `recipe_restriction=false`, los PT sin receta también se
  registran (OP sin `recipe_id`) y las tarjetas no se bloquean. Solo se marca «SIN RECETA» y
  se bloquea cuando `recipe_restriction=true`.
- **`catalog/skus` sin `item_type`:** se pide `catalog/skus?limit=500`; el API filtra a PT
  automáticamente por `X-Subsystem-Id: 1004`.
- **`output_location_id` opcional** en `complete`: se elimina el bloqueo por «ubicación de
  salida»; el API resuelve `zona_producto_terminado` de la sede del JWT.
- **`decimal_precision`:** aplicado vía `fmtQty()` en las cantidades del resumen.
- **Fechas ISO 8601** en los envíos. Cache-buster `app.js?v=20260704a`.


## Layout del terminal (herramientas fijas)
`#prod-view` se fija a `100dvh` con `overflow:hidden` y la cabecera pasa a `flex:none`,
de modo que **buscador, cantidad y filtros quedan fijos** y **solo la rejilla de productos
hace scroll**. El resumen (rail en tablet / barra+hoja en móvil) también permanece fijo.


## Gestión de permisos (RBAC §16.2)
Nueva opción en el menú principal (drawer) **🔐 Gestión de permisos**, visible para roles
administrativos (SuperAdmin siempre). Usa el mismo método que los demás subsistemas: una
**matriz pantallas × roles** con casillas.
- `GET /rbac/subsystems/1004/screen-permissions` → `{screens, roles, permissions}` construye la matriz.
- `PUT /rbac/subsystems/1004/screen-permissions` con `{permissions:{screen_key:[rol,...]}}`
  hace **reemplazo atómico completo** (se envía el mapa entero); efecto inmediato, sin logout.
- Pantallas [1004]: `ordenes`, `nueva_orden`, `consumos`, `recetas`, `historial`.
- Proxy: allowlist ampliada con GET/PUT `screen-permissions`. Cache-buster `app.js?v=20260704b`.
