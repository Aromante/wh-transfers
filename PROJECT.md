# Warehouse Transfers — Proyecto

## Alcance
Sistema de transferencias de inventario entre ubicaciones del almacén. Sincroniza Odoo (picking interno) y Shopify (inventory transfer completo) automáticamente al recibir mercancía en destino.

---

## Infraestructura

| Componente | Tecnología | Detalles |
|-----------|-----------|---------|
| Frontend | Vite + React + TypeScript + Tailwind | Escaneo por código de barras, gestión de borradores, recepción |
| Backend | Supabase Edge Function (Deno) | Proyecto `bszfkudigjiqddliicri`, función `transfers`, v22 |
| Base de datos | Supabase (PostgreSQL) | Tablas de transferencias, logs, catálogos |
| ERP | Odoo (JSON-RPC) | Crea `stock.picking` internos, confirma y valida |
| Inventario | Shopify Admin GraphQL API | Sincronización completa DRAFT→RECEIVED |

---

## Ubicaciones operativas

| Odoo Code | Shopify Location GID | Nombre |
|-----------|---------------------|--------|
| `WH/Existencias` | `gid://shopify/Location/103584596280` | Planta Productora |
| `KRONI/Existencias` | `gid://shopify/Location/98632499512` | Kroni |
| `P-CEI/Existencias` | `gid://shopify/Location/107414356280` | La Ceiba - Culiacán |
| `P-CON/Existencias` | `gid://shopify/Location/80271802680` | La Conquista - Culiacán |

El mapeo está hardcodeado en `shopify.ts` (`ODOO_TO_SHOPIFY_LOCATION_GID`) como fuente de verdad para el sync. La tabla `transfer_locations` en Supabase es fuente de verdad para el catálogo de la app.

---

## Flujo principal: POST /receive

```
App (recepción en destino)
        │
        ▼
POST /receive { transfer_id, lines }
        │
        ├── 1. createOdooPickingFromLines()
        │       └── stock.picking → confirm → validate (Done)
        │
        └── 2. syncShopifyTransfer() [fire & forget, non-blocking]
                │
                ├── inventoryTransferCreate          → DRAFT
                ├── inventoryTransferMarkAsReadyToShip → READY_TO_SHIP
                ├── inventoryShipmentCreate           → Shipment DRAFT
                ├── inventoryShipmentMarkInTransit    → Shipment IN_TRANSIT
                └── inventoryShipmentReceive          → Shipment RECEIVED ✅
```

### Notas críticas del flujo Shopify

1. **API version mínima:** `2024-04` para `inventoryTransferCreate`. Si la env var es anterior, se upgradea automáticamente.

2. **Enum serialization bug (resuelto en v21):** El campo `reason` en `inventoryShipmentReceive` es de tipo enum (`InventoryShipmentReceiveLineItemReason`). Al enviarlo como variable JSON GraphQL, Shopify lo recibe como string y lo rechaza con `"Expected value to not be null"`. **Solución:** construir la mutation como string inline con el literal `ACCEPTED` sin comillas, no como variable.

   ```typescript
   // ❌ MAL — Shopify stripea el enum al pasar por variables
   const vars = { lineItems: [{ shipmentLineItemId: id, quantity: 1, reason: 'ACCEPTED' }] }

   // ✅ BIEN — enum literal directo en el query string
   const mutation = `mutation {
     inventoryShipmentReceive(id: "${shipmentGid}", lineItems: [
       { shipmentLineItemId: "${id}", quantity: 1, reason: ACCEPTED }
     ]) { ... }
   }`
   ```

3. **Shipment lifecycle bug (resuelto en v22):** `inventoryShipmentCreate` **siempre** crea el shipment en estado `DRAFT`. Un shipment en DRAFT no puede recibirse. Es **obligatorio** llamar `inventoryShipmentMarkInTransit` antes de `inventoryShipmentReceive`.

   ```
   inventoryShipmentCreate → DRAFT
   inventoryShipmentMarkInTransit → IN_TRANSIT   ← REQUERIDO
   inventoryShipmentReceive → RECEIVED
   ```

---

## Variables de entorno (Edge Function)

| Variable | Requerida | Descripción |
|---------|-----------|-------------|
| `SUPABASE_URL` | ✅ | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key |
| `ODOO_URL` | ✅ | URL base de Odoo |
| `ODOO_DB` | ✅ | Nombre de la base de datos Odoo |
| `ODOO_UID` | ✅ | UID del usuario Odoo (numérico) |
| `ODOO_API_KEY` | ✅ | API key de Odoo |
| `SHOPIFY_DOMAIN` | ✅ | Dominio del store (ej: `store.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | ✅ | Admin API access token |
| `SHOPIFY_API_VERSION` | — | Versión API (default: `unstable`). Min: `2024-04` para transfers |
| `ODOO_AUTO_VALIDATE` | — | `1` para auto-validar pickings (default: 1) |
| `SHOPIFY_REPLICATE_TRANSFERS` | — | `1` para activar sync Shopify (default: 1) |
| `SHOPIFY_CONQUISTA_LOCATION_ID` | — | Override de location ID para P-CON si hay discrepancia |
| `SHOPIFY_KRONI_LOCATION_ID` | — | Location ID numérico de Kroni (para forecasting) |
| `CORS_ORIGIN` | — | Origen permitido (default: `*`) |
| `ENABLE_MULTI_DRAFTS` | — | Permitir múltiples borradores por usuario (default: `1`) |
| `MAX_DRAFTS_PER_OWNER` | — | Límite de borradores por usuario (default: `3`) |

### Scopes de Shopify requeridos
- `read_products`
- `read_inventory`
- `write_inventory`
- `read_inventory_transfers`
- `write_inventory_transfers`
- `read_inventory_shipments`
- `write_inventory_shipments`
- `write_inventory_shipments_received_items`

---

## Endpoints de la Edge Function

| Método | Path | Descripción |
|--------|------|-------------|
| `POST` | `/` o `/create` | Crear orden de transferencia (sin Odoo aún) |
| `POST` | `/receive` | Confirmar recepción → crea picking Odoo + sync Shopify |
| `POST` | `/cancel` | Cancelar transfer pendiente |
| `POST` | `/validate` | Validar picking Odoo manualmente (fallback) |
| `GET` | `/transfer?id=` | Detalle de un transfer con sus líneas |
| `GET` | `/history` | Historial paginado |
| `GET` | `/history/csv` | Export CSV del historial |
| `POST` | `/duplicate` | Duplicar un transfer existente como borrador |
| `GET` | `/drafts` | Listar borradores del usuario |
| `POST` | `/drafts` | Crear borrador |
| `PATCH` | `/drafts?id=` | Actualizar borrador |
| `DELETE` | `/drafts?id=` | Eliminar borrador (soft-delete) |
| `POST` | `/drafts/commit` | Confirmar borrador → crea picking en Odoo |
| `GET` | `/logs?transfer_id=` | Logs de auditoría de un transfer |
| `GET` | `/resolve?code=` | Resolver código (caja → SKU, o SKU → producto Odoo) |
| `GET` | `/locations` | Listado de ubicaciones disponibles |
| `GET` | `/boxes` | Catálogo de cajas |
| `POST` | `/boxes` | Crear caja |
| `PATCH` | `/boxes?id=` | Actualizar caja |
| `DELETE` | `/boxes?id=` | Desactivar caja |
| `GET` | `/boxes/one?id=` | Detalle de una caja |
| `GET` | `/boxes/resolve/:barcode` | Resolver barcode de caja → SKU + qty |
| `POST` | `/webhook/shopify-transfer` | Webhook Shopify (fallback Odoo) |
| `POST` | `/webhook/register` | Registrar webhooks en Shopify |
| `GET` | `/health` | Health check (Odoo + Supabase + Shopify) |

---

## Estructura de archivos (Edge Function)

```
supabase/functions/transfers/
├── index.ts            # Router principal (serve + dispatch)
├── helpers.ts          # Types (Env), utils (corsHeaders, json, boolFlag...)
├── shopify.ts          # Cliente Shopify GraphQL/REST + syncShopifyTransfer()
├── odoo.ts             # Cliente Odoo JSON-RPC + createOdooPickingFromLines()
├── supabase-helpers.ts # Helpers REST de Supabase (sbInsert, sbSelect...)
├── routes-transfer.ts  # POST /, /receive, /cancel, /validate
├── routes-misc.ts      # GET /history, /locations, /health, /logs, /resolve
├── routes-boxes.ts     # CRUD /boxes
├── routes-drafts.ts    # CRUD /drafts
└── routes-webhook.ts   # POST /webhook/shopify-transfer, /webhook/register
```

---

## Tablas Supabase relevantes

| Tabla/Vista | Uso |
|-------------|-----|
| `transfers` | Registro principal de cada transferencia |
| `transfer_lines` | Líneas (SKU + qty) de cada transferencia |
| `transfer_logs` | Auditoría completa de eventos (Odoo, Shopify, etc.) |
| `transfer_locations` | Catálogo de ubicaciones válidas |
| `transfer_boxes` | Catálogo de cajas (barcode → SKU + qty_per_box) |
| `transfer_log` (vista) | Vista enriquecida del historial para la UI |
| `forecasting_inventory_today` | Mercancía en tránsito para dashboard de reabastecimiento |

### Eventos en transfer_logs

| Evento | Cuándo |
|--------|--------|
| `transfer_created` | Al crear la orden |
| `transfer_received` | Al confirmar recepción (Odoo done) |
| `transfer_cancelled` | Al cancelar |
| `shopify_transfer_created` | Step 1 Shopify OK |
| `shopify_transfer_ready_error` | Step 2 Shopify falló |
| `shopify_shipment_created` | Step 3 Shopify OK (incluye lineItemIds) |
| `shopify_shipment_in_transit` | Step 3.5 Shopify OK (shipment → IN_TRANSIT) |
| `shopify_shipment_in_transit_error` | Step 3.5 Shopify falló |
| `shopify_transfer_receive_error` | Step 4 Shopify falló |
| `shopify_sync_done` | Fin del sync (incluye `finalStatus`) |
| `shopify_sync_skipped` | Sync omitido (sin credenciales, ubicación no mapeada) |
| `odoo_error` | Error en Odoo |
| `odoo_validate_error` | Error al validar picking en Odoo |

---

## Deploy

La Edge Function se despliega vía Supabase MCP. **Crítico:** incluir los 10 archivos `.ts` en cada deploy o el bundler falla con "Module not found".

```
Proyecto: bszfkudigjiqddliicri
Función:  transfers
Versión:  v22 (activa)
```

No hay `SUPABASE_ACCESS_TOKEN` disponible en el entorno local, por lo que el deploy vía CLI (`npx supabase functions deploy`) no funciona. Usar exclusivamente el MCP de Supabase.

---

## Integración Forecasting (WH → KRONI)

Al validar una transferencia WH/Existencias → KRONI/Existencias:
- Se actualiza `forecasting_inventory_today` con `in_transit_units` por SKU.
- `location_id` = `98632499512` (hardcodeado, Shopify location ID de Kroni).
- Escritura por fila: PATCH primero; si no afecta filas, POST.
- Idempotencia: se registra `forecast_in_transit_applied` en `transfer_logs`.
- El dashboard de reabastecimiento depura `in_transit_units` a 0 al recibir.

---

## Pendientes / Mejoras futuras

- Smoke tests (Vitest) para validación de líneas y confirmación de submit.
- Ajustar CORS a dominios finales de producción.
- Retries con backoff exponencial en llamadas Shopify (429/5xx).
- Parametrizar `location_id=98632499512` de Kroni como variable de entorno bloqueada.
- Alertas si el sync Shopify toca un `location_id` distinto al esperado.
- Integración al macrorepo: `apps/wh-transfers` en el orquestador + `VITE_TRANSFERS_URL` en el Shell.
