# Worker API — Warehouse Transfers

Endpoints:
- POST /api/transfers — Crea transferencia en Odoo (picking + moves) y la registra en Supabase
- GET  /api/transfers/:id — Estado/detalle
- GET  /api/transfers/shopify-health — Verifica soporte de mutación de transfer en distintas versiones del Admin API
 - POST /api/transfers/validate — Valida disponibilidad en Shopify por ubicación de origen (bloqueante)

Secrets/vars (wrangler):
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE
- ODOO_URL, ODOO_DB, ODOO_UID (o login vía uid/password), ODOO_API_KEY
- CORS_ORIGIN (dominio del Shell)
- Shopify: `SHOPIFY_STORE`, `SHOPIFY_ACCESS_TOKEN` (para validar disponibilidad y crear drafts)
- Opcional: `SHOPIFY_API_VERSION` (por defecto `2023-10`; si tu tenant soporta el endpoint de transfer, usa una versión más reciente como `2024-10` o `unstable`)
- Opcional: `SHOPIFY_API_VERSION_LIST` (lista separada por comas para probar en `/api/transfers/shopify-health`)
 - Control fino de versión/payload:
   - `SHOPIFY_STRICT_VERSION` (1/true para usar sólo `SHOPIFY_API_VERSION` sin probar otras)
   - `SHOPIFY_INPUT_VARIANT` (`origin_destination` | `from_to` | `source_destination`)
   - `SHOPIFY_MUTATION_FIELD` (`transfer` | `inventoryTransfer`)
 - Drafts (opcional, desactivado por defecto):
   - `ENABLE_MULTI_DRAFTS=1` para habilitar borradores simultáneos (máx 3)
   - `MAX_DRAFTS_PER_OWNER=3` (configurable)
- KRONI (flujo especial Bodega→CEDIS):
  - `SHOPIFY_KRONI_LOCATION_ID` (numérico, p. ej. 98632499512) — se usa como `location_id` en forecasting y para omitir validación Shopify
  - `ODOO_KRONI_TRANSIT_LOCATION_ID` (numérico, p. ej. 43) — ubicación de tránsito en Odoo
  - `ODOO_KRONI_TRANSIT_COMPLETE_NAME` (opcional) — `complete_name` de la ubicación de tránsito si se desea resolver por nombre

- Overrides puntuales de ubicaciones Shopify (hotfix sin tocar catálogo):
  - `SHOPIFY_CONQUISTA_LOCATION_ID` (numérico) — fuerza el destino correcto para `P-CON/Existencias` al crear el draft en Shopify

Estado: En producción, las credenciales de Shopify ya están configuradas; la creación de drafts está habilitada (excepto cuando el destino es `KRONI/Existencias`, donde se omite). La validación previa aplica ahora también para KRONI para evitar parciales en Odoo.

Notas de comportamiento
- Bodega→tienda (≠ KRONI):
  - Valida disponibilidad en Shopify (batched) → crea draft → crea/valida picking en Odoo.
  - Si el tenant no soporta la mutación, se puede forzar versión/payload con las vars anteriores.
- Bodega→CEDIS/KRONI:
  - Valida disponibilidad en Shopify (bloqueante). No crea draft en Shopify.
  - Crea/valida picking en Odoo con destino forzado a la ubicación de tránsito (ID o `complete_name`).
  - Actualiza `forecasting_inventory_today` por fila con `location_id=98632499512` (forzado) — sin RPC.

Logs (Supabase `transfer_logs`): `odoo_created`, `shopify_draft_created`/`shopify_draft_error`, `forecast_target_location`, `forecast_in_transit_applied (via=rest_forced_strict)`.

API de borradores (cuando `ENABLE_MULTI_DRAFTS=1`)
- `GET /api/transfers/drafts` → lista los borradores del owner (header opcional `X-User-Id`), máx 3.
- `POST /api/transfers/drafts` → crea un nuevo borrador con `{ origin_id, dest_id, title?, lines? }`.
- `PATCH /api/transfers/:id` → actualiza metadatos (`title`, `origin_id`, `dest_id`) cuando `status='draft'`.
- `GET /api/transfers/:id/lines` → devuelve líneas del borrador.
- `POST /api/transfers/:id/lines` → upsert de líneas (por `barcode`/`sku`) cuando `status='draft'`.
- `DELETE /api/transfers/:id/lines/:code` → borra línea por código.
- `POST /api/transfers/:id/cancel` → cancela borrador (`status='cancelled'`).
- `POST /api/transfers/:id/validate` → valida el borrador (mantiene reglas actuales: Shopify+Odoo; KRONI conserva comportamiento especial). Devuelve picking y estado.

Historial (cuando `ENABLE_MULTI_DRAFTS=1`)
- `GET /api/transfers/history` → lista histórica con filtros y paginación.
  - Query params (opcionales):
    - `status`: lista separada por comas (ej. `validated,cancelled,odoo_created`)
    - `owner`: si no se envía, se toma de `X-User-Id`.
    - `origin`, `dest`.
    - `from`, `to`: ISO (`2025-11-01T00:00:00Z`).
    - `search`: busca en `sku`/`barcode` (transfer_lines).
    - `page`, `pageSize` (por defecto 1/50).
    - `format=csv` para exportar el resultado actual.
- `POST /api/transfers/:id/duplicate` → crea un borrador nuevo copiando meta/líneas del transfer `:id`.
  - Resp: `{ ok: true, id: <nuevo_id>, status: 'draft' }`.

Desarrollo: `wrangler dev` (si el proyecto se independiza con su propio repo).
