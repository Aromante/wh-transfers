# Shopify Inventory Transfer — Guía de Referencia

> Lecciones aprendidas tras múltiples sesiones de debugging (v35–v40).
> Última actualización: 2026-02-25

---

## El flujo completo (5 pasos obligatorios)

Shopify NO acepta saltar pasos ni hacer receive directo. El orden es estricto:

```
1. inventoryTransferCreate          → status: DRAFT
2. inventoryTransferMarkAsReadyToShip → status: READY_TO_SHIP
3. inventoryShipmentCreate          → shipment status: DRAFT
4. inventoryShipmentMarkInTransit   → shipment status: IN_TRANSIT  ← OBLIGATORIO
5. inventoryShipmentReceive         → shipment status: RECEIVED
                                       transfer status: TRANSFERRED
```

Si el transfer queda en `READY_TO_SHIP` en Shopify, falló el step 3 o posteriores.
Si queda en `IN_TRANSIT`, falló el step 5.

---

## ❌ DON'Ts — Lo que NO hay que hacer

### 1. NO poner `@idempotent` en la declaración del mutation
```graphql
# ❌ MAL — Shopify rechaza esto
mutation inventoryTransferCreate(...) @idempotent {
    ...
}

# Error: "'@idempotent' can't be applied to mutations (allowed: fields)"
# Error: "Directive 'idempotent' is missing required arguments: key"
```

### 2. NO omitir `@idempotent` en ningún mutation de inventory transfer
```graphql
# ❌ MAL — Shopify lo rechaza en API version unstable/2024-10+
mutation inventoryShipmentCreate($input: InventoryShipmentCreateInput!) {
    inventoryShipmentCreate(input: $input) {   # sin @idempotent
        ...
    }
}

# Error: "The @idempotent directive is required for this mutation but was not provided."
```
Esto aplica a los 5 mutations: create, markReadyToShip, shipmentCreate, markInTransit, receive.

### 3. NO reutilizar la misma key entre mutations
```typescript
// ❌ MAL — misma key para todos
const key = crypto.randomUUID()
// usarla en los 5 mutations
```
Cada mutation necesita su propio UUID único generado en el momento de llamar.

### 4. NO enviar el enum `ACCEPTED` como variable JSON
```typescript
// ❌ MAL — Shopify recibe "ACCEPTED" como string, no como enum
const receiveMutation = `mutation inventoryShipmentReceive(...) { ... }`
const vars = { reason: "ACCEPTED" }  // string ≠ enum
```
Los enums van inline en el query string, nunca en variables.

### 5. NO confiar en el topic del webhook de Shopify
```typescript
// ❌ MAL — Shopify tiene un bug conocido donde COMPLETE dispara como CANCEL
if (webhookTopic === 'INVENTORY_TRANSFERS_COMPLETE') { ... }
```
Siempre hay que consultar el status real via API (`inventoryTransfer(id: ...)`) después de recibir cualquier webhook.

### 6. NO usar `created_at` para ordenar `transfer_logs`
```typescript
// ❌ MAL — la columna no existe en transfer_logs
order=created_at.desc

// ✅ BIEN — la columna correcta es ts
order=ts.asc
```

### 7. NO deployer sin leer los archivos frescos del disco
En sesiones largas o resumidas, el contexto puede tener versiones viejas de los archivos.
Siempre leer con `Read` tool antes de pasar contenido a `deploy_edge_function`.

---

## ✅ COMO SÍ — La forma correcta

### Sintaxis `@idempotent` correcta
```graphql
# ✅ BIEN — el directive va en el FIELD, con key único
mutation inventoryTransferCreate($input: InventoryTransferCreateInput!) {
    inventoryTransferCreate(input: $input) @idempotent(key: "uuid-aquí") {
        inventoryTransfer { id status }
        userErrors { field message }
    }
}
```

### Generar keys únicas por mutation en TypeScript/Deno
```typescript
// ✅ BIEN — UUID fresco para cada mutation
const idempotencyKey = crypto.randomUUID()   // step 1
const readyKey       = crypto.randomUUID()   // step 2
const shipmentKey    = crypto.randomUUID()   // step 3
const inTransitKey   = crypto.randomUUID()   // step 3.5
const receiveKey     = crypto.randomUUID()   // step 4

// Después usarlos inline en el template string:
const mutation = `
    mutation inventoryTransferCreate($input: InventoryTransferCreateInput!) {
        inventoryTransferCreate(input: $input) @idempotent(key: "${idempotencyKey}") {
            ...
        }
    }`
```

### Enum `ACCEPTED` inline (no como variable)
```typescript
// ✅ BIEN — enum literal sin comillas en el query
const lineItemsGql = lineItems
    .map(li => `{ shipmentLineItemId: "${li.id}", quantity: ${li.quantity}, reason: ACCEPTED }`)
    .join(', ')
const receiveMutation = `mutation {
    inventoryShipmentReceive(id: "${shipmentGid}", lineItems: [${lineItemsGql}])
        @idempotent(key: "${receiveKey}") {
        inventoryShipment { id status }
        userErrors { field message }
    }
}`
```

### Versión de API mínima requerida
```typescript
// inventoryTransferCreate requiere 2024-04+
// El env var SHOPIFY_API_VERSION está configurado como "unstable" (más permisivo)
// Nunca bajar a versiones anteriores a 2024-04 para estos mutations
const apiVersion = ver >= '202404' ? ver : '2024-04'
```

### Flujo `syncShopifyTransfer` — referencia de logs esperados
Si el flujo funciona correctamente, en `transfer_logs` deben aparecer en orden:

| event | qué indica |
|-------|-----------|
| `shopify_transfer_created` | Step 1 OK — transfer GID disponible |
| `shopify_shipment_created` | Step 3 OK — shipment GID disponible |
| `shopify_shipment_in_transit` | Step 3.5 OK — status: IN_TRANSIT |
| `shopify_sync_done` | Todo OK — `finalStatus: "RECEIVED"` |

Si aparece `shopify_*_error` en cualquier step, el `detail.error` contiene el mensaje exacto de Shopify.

### Diagnosticar un transfer que falló
```sql
-- Ver todos los eventos de un transfer específico
SELECT event, detail, ts
FROM transfer_logs
WHERE transfer_id = '<uuid>'
ORDER BY ts ASC;

-- Ver los últimos transfers con errores de Shopify
SELECT transfer_id, event, detail->>'error' as error, ts
FROM transfer_logs
WHERE event LIKE 'shopify_%error%'
   OR event = 'shopify_sync_failed'
ORDER BY ts DESC
LIMIT 20;
```

---

## Caso especial: KRONI

Los transfers a `KRONI/Existencias` **no crean un inventory transfer en Shopify**.
En cambio, solo se hace un ajuste negativo en Planta Productora (`inventoryAdjustQuantities`).

Razón: ARGUS (sistema de Kroni) controla la ubicación Tienda Online y sobrescribiría cualquier cambio.

```
WH → KRONI:
  - Odoo: picking va a location_id = 43 (Traslado interno a Kroni)
  - Shopify: adjustShopifyPlantaInventory(negate=true) — solo resta de Planta
  - NO se llama syncShopifyTransfer()
```

---

## Ubicaciones hardcodeadas (ODOO_TO_SHOPIFY_LOCATION_GID)

| Odoo Code | Shopify Location GID | Nombre |
|-----------|---------------------|--------|
| `WH/Existencias` | `gid://shopify/Location/103584596280` | Planta Productora |
| `KRONI/Existencias` | `gid://shopify/Location/98632499512` | Kroni |
| `P-CEI/Existencias` | `gid://shopify/Location/107414356280` | La Ceiba - Culiacán |
| `P-CON/Existencias` | `gid://shopify/Location/80271802680` | La Conquista - Culiacán |

Si se agrega una nueva ubicación, hay que actualizar este mapa en `shopify.ts`.

---

## Deploy — recordatorios

- **No hay CLI token local** — solo se puede deployar vía MCP de Supabase (`deploy_edge_function`)
- **No commitear a GitHub** hasta tener el flujo verificado con logs `finalStatus: "RECEIVED"`
- El deploy incluye **todos los archivos** del directorio `transfers/` (9 archivos actualmente)
- Proyecto Supabase: `bszfkudigjiqddliicri`
- EF activa: versión Supabase interna más reciente (v40 al 2026-02-25)
