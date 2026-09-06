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

## Incidente 2026-09-01 — Transferencias validadas que nunca llegaron a Shopify

**Estado: dato corregido y inventario repuesto. El mecanismo que permitió la pérdida silenciosa SIGUE ACTIVO (ver riesgo conocido más abajo).**

Documentos de evidencia:
- [`docs/INCIDENTE-SHOPIFY-TRANSFERS-2026-09-06.txt`](docs/INCIDENTE-SHOPIFY-TRANSFERS-2026-09-06.txt) — diagnóstico forense completo (914 líneas)
- [`docs/ACTA-CIERRE-REPOSICION-2026-09-06.txt`](docs/ACTA-CIERRE-REPOSICION-2026-09-06.txt) — acta de ejecución y cierre (517 líneas)
- [`docs/evidencia-2026-09-06/`](docs/evidencia-2026-09-06/) — snapshots Odoo antes/después (199 campos × 3 productos)

### Qué pasó

Las transferencias `#973F32BF` (WH→Ceiba, 296 u) y `#EC3C2698` (WH→Conquista, 152 u) se completaron sin error visible el 2026-09-01: Odoo movió el stock (pickings `WH/INT/00315` y `WH/INT/00314`, ambos `done`), Supabase quedó en `status='validated'` y la app mostró pantalla verde. **Shopify nunca registró nada.** Descuadre: 448 unidades.

### Causa raíz

Tres productos tenían en Odoo un **ProductVariant ID** de Shopify guardado en `product.product.x_shopify_inventory_item_id`, campo que debe llevar el **InventoryItem ID**:

| SKU | Guardado (malo) | Correcto |
|-----|-----------------|----------|
| `PER-CABGLO-100` | `52825562841400` (variant) | `54897981882680` |
| `PER-ELEETE-100` | `52224875594040` (variant) | `54286740652344` |
| `PER-ESEITA-100` | `52825576210744` (variant) | `54897995055416` |

Escritos el 2026-08-27 23:59:12 UTC por `write_uid=[2,"Admin"]`, en un lote manual de 7 productos donde 4 quedaron bien y 3 mal. El campo es un `char` de Odoo Studio **sin validación de tipo ni de formato**.

Shopify respondió a `inventoryTransferCreate` con `"The inventory item could not be found."` en las líneas afectadas. **La mutación es atómica**: no se creó nada, ni siquiera las 7 líneas sanas del envío de Ceiba.

Hipótesis descartada con evidencia: **no** fue un cambio de la API 2025-10. El código no cambió entre las transferencias buenas (25 y 26 de agosto) y las malas; el último commit es del 2026-04-06. Cambió el dato en Odoo.

### Corrección aplicada en Odoo (2026-09-06)

Los 3 `x_shopify_inventory_item_id` reparados en producción, con guardas previas (releer y abortar si el `default_code` o el valor actual no eran los esperados). Diff sobre snapshot completo de 199 campos: **solo cambió el campo objetivo y `write_date`**. Verificación funcional posterior: los 3 IDs nuevos resuelven como `InventoryItem` con el SKU correcto; los 3 viejos devuelven `null` — exactamente la condición que producía el error.

Re-auditoría del mapeo completo contra Shopify en vivo: **130/130** resuelven y su `sku` coincide con el `default_code` de Odoo. 0 IDs muertos, 0 cruces, 0 duplicados. No hay un cuarto caso.

### Reposición en Shopify (2026-09-06)

Decisión del responsable: **ajuste directo de inventario en destino**, no réplica de la transferencia. Trade-off aceptado explícitamente: en el historial de Shopify queda como ajuste manual, no como movimiento entre ubicaciones.

| Tanda | Ubicación | Líneas | Unidades | AdjustmentGroup |
|-------|-----------|--------|----------|-----------------|
| 1 (canario) | Conquista `80271802680` | 4 | +152 | `77648889708856` |
| 2 | Ceiba `107414356280` | 10 | +296 | `77648974840120` |

`inventoryAdjustQuantities`, `reason: "correction"`, `name: "available"`, una llamada atómica por tanda, `changeFromQuantity` leído en vivo por línea. 14/14 verificadas por relectura independiente. 0 `userErrors`.

**Planta no se tocó** (verificado antes y después en los 10 SKUs): ya reflejaba la salida física real, así que sumar solo en destino no genera doble conteo. Odoo tampoco se tocó. `shopify_transfer_id` se dejó deliberadamente en `NULL` en las 14 filas, porque no existe ninguna transferencia real en Shopify para esos registros; la trazabilidad vive en `transfer_logs`, evento `shopify_backfill_direct_adjust`.

> **Nota de método:** la mutación devolvió `quantityAfterChange: null` pese a `userErrors: []`. Toda verificación de cantidades debe hacerse por relectura independiente, nunca confiando en la respuesta de la escritura.

### Blindaje aplicado (2026-09-06) — defectos (a) y (b)

> ⚠️ **El código está corregido en `main` pero NO DESPLEGADO.** La EF viva sigue siendo la v48 con los defectos. El deploy va por el MCP de Supabase (no hay `SUPABASE_ACCESS_TOKEN` local) y no se pudo hacer desde esta sesión.

**1. Validación previa de `inventoryItemId` — `shopify.ts: validateInventoryItemIds()`**

Antes de construir el payload de `inventoryTransferCreate`, cada ID se resuelve con `node()` (read-only) y se comprueba que (a) existe y es un `InventoryItem`, y (b) su `sku` corresponde al producto de Odoo que dice ser — cruzado contra `default_code` **y** `barcode`, para no marcar falso positivo cuando la línea se capturó por código de barras. El caso del incidente se detecta **antes** de mandar nada, no después del rechazo de Shopify.

**2. Fallback por-SKU — `shopify.ts: resolveInventoryItemsForLines()`**

Punto único donde se decide qué `inventoryItemId` se manda. Sustituye a **tres bloques duplicados** de `routes-transfer.ts` (flujo tienda, KRONI al crear y KRONI al recibir): el defecto estaba en los tres, ahora se corrige en los tres. El fallback ya no es todo-o-nada y cubre las dos formas del problema — *campo vacío* y *campo con valor inválido*. Un SKU que falla se reintenta individualmente contra Shopify; si tampoco resuelve, se reporta en `failed_skus` **sin bloquear a los SKUs sanos del mismo envío**.

Si la validación misma falla (red, rate limit) no se bloquea el envío: se registra `shopify_item_validation_error` y se cae al comportamiento previo.

**3. El error llega a la UI — `routes-transfer.ts` + `ReceivePage.tsx`**

`/receive` devuelve ahora `shopify_ok` y `shopify_warning` además del objeto `shopify`. La pantalla de recepción distingue tres estados: éxito (verde), **"Recepción confirmada en Odoo" con panel ámbar** cuando Shopify no se actualizó o se actualizó parcialmente —con el motivo y la lista de SKUs afectados— y error (rojo). El front tiene fallback para EFs antiguas que no manden los campos nuevos.

**Eventos nuevos en `transfer_logs`:** `shopify_item_id_invalid`, `shopify_items_unresolved`, `shopify_item_validation_error`. El existente `shopify_item_lookup_fallback` ahora distingue `invalid_or_missing_odoo_item_ids` de `odoo_shopify_item_ids_missing`.

**Validación:** 25 aserciones en `supabase/functions/transfers/__tests__/resolve-items.test.ts` (6 casos: regresión normal, el incidente real, SKU irrecuperable, cruce de producto, línea por barcode, y la función de validación aislada). Frontend: `tsc --noEmit` y `vite build` limpios. EF: bundle completo sin imports rotos.

### ⚠️ Riesgo conocido — sin resolver todavía

| # | Defecto | Ubicación | Efecto |
|---|---------|-----------|--------|
| (c) | **Sin reintento ni resync** | rutas de la EF | No existe endpoint para reintentar el tramo Shopify. Una vez que `/receive` responde, la transferencia queda `validated` para siempre sin camino de recuperación automática: hay que reponer a mano, como se hizo con estas dos. |
| (d) | **Idempotencia muerta** | `shopify.ts` | `deriveIdempotencyKey()` calcula `createKey`, `readyKey`, `shipmentKey`, `inTransitKey` y `receiveKey` — y **ninguna se usa** en las mutaciones. El `@idempotent` se quitó tras los errores de feb-2026 y quedó el cálculo huérfano. No hay protección contra duplicados: un reintento ciego crearía transferencias repetidas. |

**Próximo paso, en sesión aparte:** (c) y (d) van juntos y en ese orden — un endpoint de reintento sin idempotencia es peligroso, porque el modo de fallo pasa de "faltan unidades" a "sobran unidades duplicadas". Son cambios de arquitectura, no parches.

### 📌 Pendiente de investigación — posible descuadre adicional

Las tres transferencias del **2026-02-26** siguen `validated` a tienda con `shopify_transfer_id` NULL, exactamente como estaban estas dos:

| Transfer | Picking | Destino |
|----------|---------|---------|
| `d9f6450c` | `WH/INT/00213` | P-CEI/Existencias |
| `9f3e57da` | `WH/INT/00210` | P-CEI/Existencias |
| `f33e4639` | `WH/INT/00212` | P-CEI/Existencias |

Su **causa de código** quedó resuelta en su momento (`Directive @idempotent is not defined` e `InventoryTransferCreateInput isn't a defined input type`). Pero **nunca se verificó si sus unidades llegaron a reflejarse en Shopify**. Puede haber un descuadre adicional ahí. Sin investigar, fuera del alcance autorizado en su momento. **Recomendado revisarlo.**

### Correcciones factuales a este documento

Verificadas contra producción durante el incidente, difieren de lo que decía este PROJECT.md:

- **Versión de la EF:** v48 (commit `d09b21c`, 2026-04-06), no v22.
- **Tablas:** no existen `transfers` ni `shopify_transfer_drafts`. El esquema real es `transfer_lines` (una fila por SKU con las columnas de cabecera repetidas), `transfer_logs`, la vista `transfer_summary`, `transfer_boxes`, `transfer_locations` y `transfer_transit`.
- **Mapeo de ubicaciones:** `getShopifyLocationGid()` lo resuelve leyendo `transfer_locations.gid` desde Supabase, no desde un `ODOO_TO_SHOPIFY_LOCATION_GID` hardcodeado.
- **Rama de producción:** `main`. `origin/master` es una copia rezagada en v45.

---

## Pendientes / Mejoras futuras

- Smoke tests (Vitest) para validación de líneas y confirmación de submit.
- Ajustar CORS a dominios finales de producción.
- Retries con backoff exponencial en llamadas Shopify (429/5xx).
- Parametrizar `location_id=98632499512` de Kroni como variable de entorno bloqueada.
- Alertas si el sync Shopify toca un `location_id` distinto al esperado.
- Integración al macrorepo: `apps/wh-transfers` en el orquestador + `VITE_TRANSFERS_URL` en el Shell.
