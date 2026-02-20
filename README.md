# Warehouse Transfers (A→B) — Dashboard + Worker

Interfaz para crear transferencias entre ubicaciones (escáner + edición de cantidades), validando inventario en Shopify y replicando en Odoo (crea y valida). Excepción: transfers hacia `KRONI/Existencias` no se replican en Shopify.

## Estructura
- frontend (Vite + React + TS): `wh-transfers/`
- worker (Cloudflare Worker): `wh-transfers/worker/`
- supabase (migraciones): `wh-transfers/supabase/migrations/`

Nota importante: no agregues la ubicación de tránsito de Odoo ("Physical Locations/Traslado interno a Kroni") al catálogo `transfer_locations`. Esa ubicación es interna de Odoo, no tiene `shopify_location_id` y el Worker la resuelve por variables (`ODOO_KRONI_TRANSIT_*`).

## Variables
- Frontend (`.env.local`):
  - `VITE_API_BASE=https://transfers-worker.<account>.workers.dev/api/transfers`
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
  - (Opcional) `VITE_ENABLE_MULTI_DRAFTS=1` para habilitar UI de borradores simultáneos (máx 3)
- Worker (prod, via secrets):
  - Odoo: `ODOO_URL`, `ODOO_DB`, `ODOO_UID`, `ODOO_API_KEY`, `ODOO_AUTO_VALIDATE=1` (opcional)
  - Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`
  - Shopify: `SHOPIFY_STORE`, `SHOPIFY_ACCESS_TOKEN` (scopes: `read_products`, `read_inventory`, y para drafts: `read_inventory_transfer`/`write_inventory_transfer`).

Nota: En producción, las credenciales de Shopify ya están configuradas para la creación automática de drafts.

## Funciones Clave (2025‑11‑07)
- Borradores simultáneos (máx 3 por owner):
  - UI: botón “Guardar como borrador” y panel “Mis borradores” (Reanudar, Validar, Cancelar).
  - Flags: `VITE_ENABLE_MULTI_DRAFTS=1` (frontend) y `ENABLE_MULTI_DRAFTS=1`, `MAX_DRAFTS_PER_OWNER=3` (Worker).
  - Compatibilidad: el endpoint `POST /api/transfers` sigue funcionando para crear directo.
- Historial con filtros y CSV:
  - Vista “Historial”: filtros por Estado/Origen/Destino (dropdowns) + fechas (calendario) + búsqueda por SKU/Código.
  - Expandible por transfer: muestra líneas (SKU/código y cantidad) desde `transfer_lines`.
  - Acción “Duplicar como borrador” por fila.
- Persistencia de detalle en líneas:
  - Para nuevas transferencias se guarda `barcode` y, si es resoluble, `sku` en `transfer_lines`.
  - Históricos previos pueden no tener este detalle (aparecerán como “—”).

## Estado reciente (2025-10-31)
- Escenario A (WH → Tiendas: CEIBA/CONQUISTA): validación Shopify operativa, creación de Draft y picking en Odoo siguen funcionales.
- Escenario B (WH → KRONI): picking validado en Odoo con destino de tránsito "Physical Locations/Traslado interno a Kroni"; no se crea Draft en Shopify (correcto). Pendiente observado: actualización de `forecasting_inventory_today` no aplicada en algunos entornos.
- Próxima acción: añadir fallback en el Worker para actualizar `forecasting_inventory_today` vía upsert REST cuando la RPC `forecast_set_in_transit_batch` no exista o falle.

## Estado actualizado (2025-11-01)
- Validación previa (Shopify) ahora aplica también para KRONI: si no hay existencias suficientes en el origen, se bloquea el envío y NO se crea picking parcial en Odoo (mismo comportamiento que Escenario A).
- Forecasting (WH→KRONI): se fuerza la escritura de `in_transit_units` en `forecasting_inventory_today` por fila (PATCH/POST) con `location_id=98632499512` (Kroni) SIEMPRE, sin usar RPC ni mapeos. Se evita cualquier desvío a otras ubicaciones.
- Logs: el Worker registra `forecast_target_location` (para auditar el `location_id` aplicado) y `forecast_in_transit_applied` (vía `rest_forced_strict`).

Flujos especiales y ajustes de compatibilidad
- Forzar versión/payload de Shopify (según tenant):
  - `SHOPIFY_STRICT_VERSION=1` y `SHOPIFY_API_VERSION=unstable` (o la recomendada por `/api/transfers/shopify-health`).
  - `SHOPIFY_MUTATION_FIELD=inventoryTransfer` | `transfer`.
  - `SHOPIFY_INPUT_VARIANT=origin_destination` | `from_to` | `source_destination`.
- KRONI (Bodega→CEDIS):
  - No se crea draft en Shopify.
  - Odoo: destino forzado a la ubicación de tránsito (`ODOO_KRONI_TRANSIT_LOCATION_ID` o `ODOO_KRONI_TRANSIT_COMPLETE_NAME`).
  - Supabase (reabastecimiento): set directo de `in_transit_units` por `(sku, location_id)` en `forecasting_inventory_today` con `location_id=98632499512` (Kroni) forzado. Implementación estricta por fila (PATCH y, si no existe, POST). Se evita RPC y mapeos para este flujo.

## Comportamiento por escenarios
- Escenario A (WH→Tiendas):
  - Frontend valida existencias contra Shopify antes de crear; si insuficiente, muestra por SKU (disponible vs solicitado).
  - Worker valida también; crea draft en Shopify (si el tenant/versión lo permite) y luego crea/valida picking en Odoo.
  - No afecta forecasting.
- Escenario B (WH→KRONI):
  - Frontend valida existencias contra Shopify; si insuficiente, bloquea (no hay parciales en Odoo).
  - Worker: crea/valida picking en Odoo con destino de tránsito; no crea draft en Shopify; actualiza forecasting con `location_id=98632499512` (forzado) por fila.

## Observabilidad
- Supabase `transfer_logs`:
  - `odoo_created`: picking creado (detalle: `pickingId`, `state`).
  - `shopify_draft_created` o `shopify_draft_error` (Escenario A).
  - `forecast_target_location` (Escenario B): confirma el `location_id` elegido (98632499512) y motivo.
  - `forecast_in_transit_applied`: confirma la vía usada (`rest_forced_strict`) y el listado de `updates`.

## Pruebas de sanidad
- A: WH→Conquista/Ceiba con SKUs suficientes: draft en Shopify (si aplica) y picking Done en Odoo. UI muestra éxito.
- A (negativo): insuficiencia → UI muestra detalle por SKU, sin crear Odoo.
- B: WH→KRONI con SKUs suficientes: picking Done en Odoo (tránsito), `forecasting_inventory_today` actualizado sólo para `location_id=98632499512`, 1:1 con SKUs enviados.
- B (negativo): insuficiencia → UI muestra detalle, sin crear Odoo ni tocar forecasting.

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
- `20251107_add_draft_columns.sql`: columnas de borradores (`draft_owner`, `draft_title`, `updated_at`, `draft_locked`) + índice y trigger
- `20251107_history_indexes.sql`: índices para acelerar consultas de historial (por fecha/estado/destino)
  
Mantenimiento (retención)
- Script sugerido: `supabase/maintenance/retention.sql` para purgar `cancelled` > 180 días y `validated` > 365 días (ajustable) y sus logs.

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
## Estado adicional (2025-11-07) — Borradores simultáneos
- Se agregan borradores simultáneos (máximo 3 por owner) para capturar y pausar múltiples transfers (p. ej. KRONI semanal + tiendas entre semana).
- Activación controlada por flags:
  - Frontend: `VITE_ENABLE_MULTI_DRAFTS=1` (oculto por defecto; no afecta flujo actual de creación directa).
  - Worker: `ENABLE_MULTI_DRAFTS=1`, `MAX_DRAFTS_PER_OWNER=3`.
- Tablas: `transfers` ahora incluye `draft_owner`, `draft_title`, `updated_at`, `draft_locked` (migración `20251107_add_draft_columns.sql`).
- Rutas nuevas en Worker (cuando habilitado): `GET/POST /api/transfers/drafts`, `GET/POST/DELETE /api/transfers/:id/lines`, `PATCH /api/transfers/:id`, `POST /api/transfers/:id/cancel`, `POST /api/transfers/:id/validate`.
- Compatibilidad: el endpoint actual `POST /api/transfers` sigue intacto; KRONI mantiene comportamiento especial.

## API — Historial y utilidades
- `GET /api/transfers/history` → filtros: `status`, `owner`, `origin`, `dest`, `from`, `to`, `search`, `page`, `pageSize`; `format=csv` para exportar.
- `POST /api/transfers/:id/duplicate` → crea un borrador nuevo copiando meta y líneas del transfer origen.
