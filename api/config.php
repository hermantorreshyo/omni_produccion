<?php
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1004] PRODUCCIÓN — Configuración CENTRAL
 *  api/config.php
 *
 *  ÚNICO lugar de constantes de CONEXIÓN y COMPORTAMIENTO.
 *  La SEDE/fábrica NO se fija aquí: el operario la elige al iniciar sesión
 *  (fija el filtro perimetral X-Interlocutor-Id de esa jornada).
 * ═══════════════════════════════════════════════════════════════════════════
 */

return [
    // ── API CORE ──────────────────────────────────────────────────────────
    'API_BASE'    => 'https://api.omni.josepan.app',
    'API_PREFIX'  => '/api/v1',
    'HTTP_TIMEOUT' => 20,

    // ── Catálogo: SOLO productos fabricados por la empresa ──────────────────
    'SKU_ITEM_TYPES' => ['PT'],   // PT = Producto Terminado (empanadas, etc.). Sin comercializables.

    // ── Traslado custodia → bodega ──────────────────────────────────────────
    'MOVEMENT_TYPE' => 'Traslado Interno',  // 'Traslado Externo' si la bodega es otro interlocutor

    // ── Auto-resolución de ubicaciones por tipo de área (de la sede elegida) ─
    'CUSTODY_AREA_PATTERN' => 'producto_terminado|terminado|salida',  // origen (custodia)
    'TRANSIT_AREA_PATTERN' => 'bodega|transito|almac',                // destino (bodega)
];
