# Warehouse Transfers (A→B) — Dashboard + Worker

Interfaz para crear transferencias entre ubicaciones (escáner + edición de cantidades), validando inventario en Shopify y replicando en Odoo (crea y valida). Excepción: transfers hacia `KRONI/Existencias` no se replican en Shopify.

## Estructura
- frontend (Vite + React + TS): `wh-transfers/`
- worker (Cloudflare Worker): `wh-transfers/worker/`
- supabase (migraciones): `wh-transfers/supabase/migrations/`

## Variables
- Frontend (`.env.local`):
  - `VITE_API_BASE=https://transfers-worker.<account>.workers.dev/api/transfers`
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- Worker (prod, via secrets):
  - Odoo: `ODOO_URL`, `ODOO_DB`, `ODOO_UID`, `ODOO_API_KEY`, `ODOO_AUTO_VALIDATE=1` (opcional)
  - Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`
  - Shopify: `SHOPIFY_STORE`, `SHOPIFY_ACCESS_TOKEN` (scopes: `read_products`, `read_inventory`, y para drafts: `read_inventory_transfer`/`write_inventory_transfer`).

Nota: En producción, las credenciales de Shopify ya están configuradas para la creación automática de drafts.

Flujos especiales y ajustes de compatibilidad
- Forzar versión/payload de Shopify (según tenant):
  - `SHOPIFY_STRICT_VERSION=1` y `SHOPIFY_API_VERSION=unstable` (o la recomendada por `/api/transfers/shopify-health`).
  - `SHOPIFY_MUTATION_FIELD=inventoryTransfer` | `transfer`.
  - `SHOPIFY_INPUT_VARIANT=origin_destination` | `from_to` | `source_destination`.
- KRONI (Bodega→CEDIS):
  - No se crea draft en Shopify.
  - Odoo: destino forzado a la ubicación de tránsito (`ODOO_KRONI_TRANSIT_LOCATION_ID` o `ODOO_KRONI_TRANSIT_COMPLETE_NAME`).
  - Supabase (reabastecimiento): set directo por `(sku, SHOPIFY_KRONI_LOCATION_ID)` mediante RPC batch (`forecast_set_in_transit_batch`).

## Dev rápido
```bash
# Frontend
cd wh-transfers
npm i
npm run dev  # http://127.0.0.1:8086

# Worker (local opcional)
cd wh-transfers/worker
npm i
npm run dev
```

## Deploy Worker (producción)
```bash
cd wh-transfers/worker
npx wrangler login
# Secrets (ejemplos)
npx wrangler secret put SUPABASE_URL --env=production
npx wrangler secret put SUPABASE_SERVICE_ROLE --env=production
npx wrangler secret put ODOO_URL --env=production
npx wrangler secret put ODOO_DB --env=production
npx wrangler secret put ODOO_UID --env=production
npx wrangler secret put ODOO_API_KEY --env=production
npx wrangler secret put SHOPIFY_STORE --env=production
npx wrangler secret put SHOPIFY_ACCESS_TOKEN --env=production
npm run deploy:prod
```

## Supabase (migraciones clave)
- `20251029_init_transfers.sql`: `transfers`, `transfer_lines`, `transfer_logs`
- `20251029_transfer_locations.sql`: catálogo de ubicaciones (`code`, `name`, `is_default_origin`)
- `20251029_add_shopify_location_id.sql`: columna `shopify_location_id` en `transfer_locations`

## Crear repo en GitHub (standalone)
1) Crea un repo vacío en GitHub (por ejemplo `wh-transfers`).
2) Desde PowerShell (Windows):
```powershell
cd wh-transfers
git init -b main
git add .
git commit -m "chore: initial commit (dashboard, worker, supabase)"
# URL HTTPS
git remote add origin https://github.com/<org-or-user>/wh-transfers.git
# o SSH: git remote add origin git@github.com:<org-or-user>/wh-transfers.git
git push -u origin main
```
3) Desde Bash (macOS/Linux/Git Bash):
```bash
cd wh-transfers
git init -b main
git add .
git commit -m "chore: initial commit (dashboard, worker, supabase)"
git remote add origin https://github.com/<org-or-user>/wh-transfers.git
# o SSH: git remote add origin git@github.com:<org-or-user>/wh-transfers.git
git push -u origin main
```

## Integración posterior en el Macrorepo (subtree)
Cuando este repo esté estable, se integra en el `macrorepo/` con:
```bash
# En el macrorepo
git remote add transfers https://github.com/<org-or-user>/wh-transfers.git
# Agregar como subtree
git subtree add --prefix apps/wh-transfers transfers main --squash
# Actualizar más adelante
git subtree pull --prefix apps/wh-transfers transfers main --squash
```
