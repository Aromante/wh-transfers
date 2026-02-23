# Progreso — Warehouse Transfers

---

## Sesión 2025-10-29

### Frontend (Vite + React + TS)
- UI base lista: escaneo por código de barra, selección de Origen/Destino desde Supabase y tabla de líneas.
- Rediseño visual con Tailwind (alineado al Shell), ErrorBoundary y mejoras de mensajes.
- Edición de cantidades: input numérico y botones +/- por SKU.
- Validación previa (UX) contra Shopify antes de crear: bloquea con mensaje legible y marca "Disponible: X" por línea.
- Mensajes amigables: éxito, insuficiencia, y fallback CSV para draft Shopify.

### Worker (Cloudflare Workers)
- Odoo JSON-RPC: crea `stock.picking` + moves, confirma, asigna y valida (Done).
- Bloqueo de parciales: validación Shopify server-side (blocking) antes de tocar Odoo (409 con `insufficient`).
- Replicación a Shopify (post-Odoo Done): draft en estado Draft vía GraphQL.
- Integración Forecasting WH→KRONI: `in_transit_units` set directo en `forecasting_inventory_today`.

### Supabase
- Tablas: `transfers`, `transfer_lines`, `transfer_logs`, `transfer_locations`, `shopify_transfer_drafts`.
- `transfer_locations.shopify_location_id` poblado para las 4 ubicaciones operativas.

---

## Sesión 2025-10-30

- Eliminado "Too many subrequests." con batching en Shopify y Odoo.
- Draft Shopify obligatorio antes de Odoo (si falla, aborta sin tocar Odoo).
- Endpoint `GET /api/transfers/shopify-health` para probar soporte de mutación en varias versiones del Admin API.
- Deploy: Worker migrado a service-worker sin exports ESM.
- Frontend: auto-enfoque del escáner ajustado a 6s + toggle persistente.

---

## Sesión 2025-10-31

- Caso 1 (WH→Conquista): OK.
- Caso 2 (WH→Ceiba): OK.
- Caso 3 (WH→KRONI): picking validado; ajuste de tránsito en Odoo por `ODOO_KRONI_TRANSIT_LOCATION_ID`.

---

## Sesión 2025-11-01

- WH→KRONI: escritura estricta por fila a `forecasting_inventory_today` con `location_id=98632499512` forzado; sin RPC.
- Validación previa también para KRONI, bloqueando insuficiencias antes de Odoo.
- Auditoría: eventos `forecast_target_location` y `forecast_in_transit_applied`.

---

## 2025-11-07 — Fix Conquista

- Bug: WH→P-CON dejaba destino KRONI en Shopify por mapeo incorrecto.
- Fix: corregido `transfer_locations.shopify_location_id` para `P-CON/Existencias` en Supabase.
- Worker: override opcional `SHOPIFY_CONQUISTA_LOCATION_ID` por si se necesita hotfix sin tocar catálogo.
- Frontend: confirmación de usuario antes de crear transfer (pop-up con resumen).

---

## Migración a Supabase Edge Functions (v14 → v22)

El Worker de Cloudflare fue migrado a una **Supabase Edge Function** (Deno).

- Proyecto Supabase: `bszfkudigjiqddliicri`
- Función: `transfers` (slug)
- Versión activa: **v22**

### Historia de versiones relevante

| Versión | Fecha | Cambio clave |
|---------|-------|-------------|
| v14 | — | `inventoryTransferCreate` funcionando; ship/receive no existían aún |
| v15 | — | Faltaba scope `write_inventory_shipments` |
| v16–v17 | — | Nombre de campo incorrecto: `inventoryItemId` en lugar de `shipmentLineItemId` |
| v18 | — | Campo correcto pero faltaba `reason` en `inventoryShipmentReceive` |
| v19 | — | Agregado `reason: 'ACCEPTED'` como variable JSON; Shopify lo stripeaba |
| v20 | — | Deploy con archivo shopify.ts incorrecto (no tomó efecto) |
| v21 | 2026-02-20 | Inline GraphQL para enum literal `ACCEPTED`; nuevo error: "A draft shipment cannot be received" |
| **v22** | **2026-02-20** | **Añadido `inventoryShipmentMarkInTransit` entre create y receive → FUNCIONA** |

---

## 2026-02-20 — Resolución final del flujo Shopify completo

### Problema
`syncShopifyTransfer` completaba pasos 1-3 pero fallaba en el paso 4 (`inventoryShipmentReceive`) con distintos errores a lo largo de múltiples versiones.

### Diagnóstico iterativo

**v18-v19:** `"reason (Expected value to not be null)"`
- Causa: `reason: 'ACCEPTED'` enviado como variable JSON GraphQL.
- Shopify trata los valores de variables como strings, no como enum literals.
- El campo `InventoryShipmentReceiveLineItemReason` es un enum non-null y Shopify rechazaba el valor aunque se enviara correctamente en JSON.

**v21:** `"A draft shipment cannot be received."`
- El inline GraphQL funcionó para el enum.
- Causa nueva: `inventoryShipmentCreate` SIEMPRE crea el shipment en estado **DRAFT**.
- Un shipment en DRAFT no puede recibirse directamente.
- Faltaba la transición intermedia a IN_TRANSIT.

**v22 (solución):** `inventoryShipmentMarkInTransit` antes de receive → **RECEIVED ✅**

### Dos bugs independientes resueltos

1. **Enum serialization bug**: `reason: ACCEPTED` en variables GraphQL → solución: inline mutation string con el literal sin comillas.
2. **Shipment lifecycle bug**: shipment en DRAFT no puede recibirse → solución: `inventoryShipmentMarkInTransit` obligatorio como paso intermedio.

---

## Estado actual (v22, en producción)

Flujo `syncShopifyTransfer` completo y funcionando:

```
inventoryTransferCreate          → Transfer en DRAFT
inventoryTransferMarkAsReadyToShip → Transfer en READY_TO_SHIP
inventoryShipmentCreate          → Shipment en DRAFT
inventoryShipmentMarkInTransit   → Shipment en IN_TRANSIT  ← pieza que faltaba
inventoryShipmentReceive         → Shipment en RECEIVED ✅
```

Los logs en `transfer_logs` confirman la secuencia:
1. `shopify_transfer_created`
2. `shopify_shipment_created` (con `lineItemCount` y `lineItemIds`)
3. `shopify_shipment_in_transit` (con `status: "IN_TRANSIT"`)
4. `shopify_sync_done` (con `finalStatus: "RECEIVED"`)
