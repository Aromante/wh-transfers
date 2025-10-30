# Progreso — Warehouse Transfers

Fecha: 2025-10-29

Resumen de cambios desde la última versión estable subida a GitHub

1) Frontend (Vite + React + TS)
- UI base lista: escaneo por código de barra, selección de Origen/Destino desde Supabase y tabla de líneas.
- Rediseño visual con Tailwind (alineado al Shell), ErrorBoundary y mejoras de mensajes.
- Edición de cantidades: input numérico y botones +/- por SKU.
- Validación previa (UX) contra Shopify antes de crear: bloquea con mensaje legible y marca “Disponible: X” por línea.
- Mensajes amigables:
  - Éxito: “Transferencia creada correctamente” + Picking (nombre/ID) y estado.
  - Insuficiencia: texto legible con (SKU, disponible en origen, solicitado) y guía para ajustar.
  - Draft Shopify: si no se puede crear automático, botón “Descargar Draft CSV para Shopify”.

2) Worker (Cloudflare Workers)
- Odoo JSON‑RPC: crea `stock.picking` interno + `stock.move`, confirma, asigna y valida (Done).
  - Manejo de wizards: `stock.immediate.transfer` y `stock.backorder.confirmation`.
  - Idempotencia por `client_transfer_id`.
  - Ubicaciones permitidas (whitelist): `WH/Existencias`, `KRONI/Existencias`, `P-CEI/Existencias`, `P-CON/Existencias`.
- Bloqueo de parciales: validación Shopify server‑side (blocking) antes de tocar Odoo.
  - Resolución de variantes por GraphQL (productVariants; scope `read_products`).
  - Disponibles por ubicación vía REST (inventory_levels; scope `read_inventory`).
  - Devuelve 409 con `insufficient` y NO crea picking en Odoo si no solventa.
- Replicación a Shopify (post‑Odoo Done):
  - Excepción: destino `KRONI/Existencias` no replica en Shopify.
  - Intenta crear Transfer en estado Draft (GraphQL; scopes `read_inventory_transfer`, `write_inventory_transfer`) — credenciales ya configuradas.
  - Registra en Supabase `shopify_transfer_drafts` el draft (auto o fallback) y logs `shopify_draft_created` o `shopify_draft_create_failed`.
  - CSV de apoyo: GET `/api/transfers/:id/shopify-draft.csv` (code,qty,origin_shopify_location_id,dest_shopify_location_id).

3) Supabase
- Tablas:
  - `transfers`, `transfer_lines`, `transfer_logs` (auditoría de transferencias)
  - `transfer_locations` (catálogo; se agregó columna `shopify_location_id`)
  - `shopify_transfer_drafts` (registro de draft automáticos/fallback)
- Migraciones añadidas:
  - `20251029_init_transfers.sql`
  - `20251029_transfer_locations.sql`
  - `20251029_add_shopify_location_id.sql`
  - `20251029_shopify_transfer_drafts.sql`
 - Estado actual: `transfer_locations.shopify_location_id` ya está poblado para ubicaciones clave (WH/Existencias, KRONI/Existencias, P-CEI/Existencias, P-CON/Existencias).

4) Variables de entorno (Worker)
- Odoo: `ODOO_URL`, `ODOO_DB`, `ODOO_UID`, `ODOO_API_KEY`, `ODOO_AUTO_VALIDATE=1`
- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`
- Shopify:
  - `SHOPIFY_STORE` (p. ej. `tu-store.myshopify.com`)
  - `SHOPIFY_ACCESS_TOKEN` (Admin API; scopes: `read_products`, `read_inventory`, `read_inventory_transfer`, `write_inventory_transfer`)
  - `SHOPIFY_REPLICATE_TRANSFERS=1` (flag; default ON)
  - Estado: configuradas en el entorno de producción.
- CORS opcional: `CORS_ORIGIN` (si deseas restringir origenes)

5) Endpoints Worker
- `POST /api/transfers` → crea y valida en Odoo; intenta/ registra draft en Shopify (excepción KRONI). Bloquea si insuficiente en origen.
- `POST /api/transfers/validate` → pre‑check Shopify (ok/insufficient/skipped).
- `GET /api/transfers/:id` → cabecera de transfer.
- `GET /api/transfers/:id/shopify-draft.csv` → CSV para creación manual del draft en Shopify.

6) README y git
- Se añadió `.gitignore` y `README.md` con guia de deploy, variables y subtree.
- Instrucciones para crear repo `Aromante/wh-transfers` y push por SSH.

7) Pruebas recomendadas
- Insuficiencia: pedir más del disponible (esperar 409 y no crear Odoo; ver UI amigable y badge “Disponible: X”).
- Éxito: solicitar dentro del disponible → Odoo Done.
  - Destino = KRONI → no se crea draft Shopify.
  - Otro destino → intento de draft Shopify:
    - Si API lo soporta → “Draft en Shopify creado (ID …)”.
    - Si no → botón “Descargar Draft CSV”.

8) Siguientes pasos sugeridos
- Endpoint `/api/transfers/shopify-health` para verificar soporte de creación de Drafts y reportar scopes.
- UI: enlace directo a Shopify Admin (si nos comparten el dominio base) y botón “Copiar Picking”.
- Retries/cola para creación de Drafts en segundo plano.
