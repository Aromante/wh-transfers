# Worker API — Warehouse Transfers

Endpoints:
- POST /api/transfers — Crea transferencia en Odoo (picking + moves) y la registra en Supabase
- GET  /api/transfers/:id — Estado/detalle
- GET  /api/transfers/shopify-health — Verifica soporte de mutación de transfer en distintas versiones del Admin API

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
 - KRONI (flujo especial Bodega→CEDIS):
   - `SHOPIFY_KRONI_LOCATION_ID` (numérico, p. ej. 98632499512) — se usa como `location_id` en forecasting y para omitir validación Shopify
   - `ODOO_KRONI_TRANSIT_LOCATION_ID` (numérico, p. ej. 43) — ubicación de tránsito en Odoo
   - `ODOO_KRONI_TRANSIT_COMPLETE_NAME` (opcional) — `complete_name` de la ubicación de tránsito si se desea resolver por nombre

Estado: En producción, las credenciales de Shopify ya están configuradas; la creación de drafts está habilitada (excepto cuando el destino es `KRONI/Existencias`, donde se omite).

Notas de comportamiento
- Bodega→tienda (≠ KRONI):
  - Valida disponibilidad en Shopify (batched) → crea draft → crea/valida picking en Odoo.
  - Si el tenant no soporta la mutación, se puede forzar versión/payload con las vars anteriores.
- Bodega→CEDIS/KRONI:
  - No valida ni crea draft en Shopify.
  - Crea/valida picking en Odoo con destino forzado a la ubicación de tránsito (ID o `complete_name`).
  - Actualiza `forecasting_inventory_today` con `location_id=SHOPIFY_KRONI_LOCATION_ID` vía RPC batch (`forecast_set_in_transit_batch`).

Desarrollo: `wrangler dev` (si el proyecto se independiza con su propio repo).
