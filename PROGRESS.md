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

- Integración con Forecasting — mercancía en tránsito (implementado):
  - Condición: solo traslados WH/Existencias → KRONI/Existencias con picking validado (estado "done").
  - Tabla destino: `forecasting_inventory_today` (mismo Supabase).
  - Claves: `sku` y `location_id` (numérico de Shopify para la ubicación destino).
  - Escritura: `in_transit_units` SE ESTABLECE (set directo) a la cantidad del transfer por línea; si no existe fila, se inserta.
  - SKU: se resuelve desde Shopify; fallback al código escaneado (1:1 con SKU).
  - Idempotencia: evita duplicados mediante log `forecast_in_transit_applied` en `transfer_logs`.

3) Supabase
- Tablas:
  - `transfers`, `transfer_lines`, `transfer_logs` (auditoría de transferencias)
  - `transfer_locations` (catálogo; se agregó columna `shopify_location_id`)
  - `shopify_transfer_drafts` (registro de draft automáticos/fallback)
  - Integración consumo: `forecasting_inventory_today` (dashboard de reabastecimiento) actualizado por el Worker para WH→KRONI.
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

---

Sesión 2025-10-30 — Iteración integral (Shopify + Odoo + Deploy)

Resumen del día
- Eliminado “Too many subrequests.” con batching en Shopify (resolución de variantes e inventario) y Odoo (search_read masivo y creación de moves en una sola llamada).
- Consistencia: draft en Shopify se crea ANTES de Odoo; si falla, se aborta sin tocar Odoo (excepto KRONI).
- Integración Forecasting (WH→KRONI): Set directo de `in_transit_units` (idempotente).
- Endpoint nuevo `GET /api/transfers/shopify-health` para probar soporte de mutación en varias versiones del Admin API.
- Draft Shopify robusto: el Worker intenta múltiples combinaciones (versión + payload) y registra trazas (api_version, mutation, input_variant, origin_gid, dest_gid).
- Deploy: Worker migrado a service‑worker (addEventListener), sin exports ESM; `wrangler.toml` limpio y scripts a `wrangler deploy`.
- Frontend: auto‑enfoque del escáner ajustado a 6s + toggle persistente.

Alcance cubierto (AS‑IS → cambios)
- Validación y creación soportan alto volumen.
- Draft Shopify obligatorio para tiendas ≠ KRONI (sin CSV por defecto); Odoo solo si el draft existe.
- Forecasting conectado automáticamente para WH→KRONI.
- Observabilidad ampliada via `transfer_logs`.

Estado actual
- Health confirma que versiones estables (2023‑10 → 2025‑01) de este tenant no exponen la mutación `inventoryTransferCreate`.
- `unstable` permite crear draft (varía por tenant y tiempo); el Worker prueba automáticamente variantes.
- Caso 1 (Bodega→Conquista): draft creado + picking validado; “destino” en Shopify no quedó correcto (se puede editar manualmente); pendiente fijar variante para que salga bien de primera instancia.
- Caso 2 (Bodega→Ceiba): listo para re‑probar con Worker actualizado y trazas ampliadas.
- Caso 3 (Bodega→CEDIS): pendiente tras validar caso 2.

TO‑BE (deseado)
- 1→1: un draft en Shopify y un picking en Odoo por transferencia (excepto KRONI), sin pasos manuales.
- Ubicaciones correctas de primera instancia en el draft.
- Batching robusto para >200 líneas, sin errores por subrequests.

Pendientes para llegar al TO‑BE
1) Ubicación destino en draft (bug):
   - Verificar `origin_gid`, `dest_gid`, `input_variant` en `transfer_logs.shopify_draft_created` y `origin_shopify_location_id`/`dest_shopify_location_id` en `shopify_transfer_drafts`.
   - Fijar explícitamente la variante de payload correcta para este tenant.
2) Versión de Admin API:
   - Priorizar `unstable` en `SHOPIFY_API_VERSION`/`SHOPIFY_API_VERSION_LIST` hasta que el tenant exponga la mutación en estable.
   - Si `unstable` llega a fallar, definir fallback de negocio temporal (CSV bloqueante o ajuste directo de inventario) para no frenar operación.
3) Retries/backoff en Shopify: añadir reintentos con exponencial (429/5xx) manteniendo UX.
4) UI: mapear `userErrors` a mensajes legibles.
5) Seguridad: confirmar que secretos no residan en archivos versionados.

---

Sesión 2025-10-31 — Cierre del día

Resultados
- Caso 1 (Bodega→Conquista): OK (draft correcto tras forzar versión/payload) y picking validado.
- Caso 2 (Bodega→Ceiba): OK con versión/payload forzados; destino en Shopify correcto.
- Caso 3 (Bodega→CEDIS/KRONI): parcial — picking validado pero fue a KRONI/Existencias; forecasting se aplicó sobre ubicación equivocada; “Too many subrequests.” persiste por no omitir validación Shopify en KRONI.

Decisiones
- Forzar detección de KRONI por IDs y evitar cualquier validación Shopify en ese flujo.
- Odoo: forzar destino de tránsito mediante `ODOO_KRONI_TRANSIT_LOCATION_ID` (43) o `ODOO_KRONI_TRANSIT_COMPLETE_NAME`.
- Supabase: usar `SHOPIFY_KRONI_LOCATION_ID` (98632499512) como `location_id` en una sola RPC batch (`forecast_set_in_transit_batch`).

Pendientes inmediatos
1) Supabase — saneo + índice + función RPC (para KRONI):
   - Borrar SKUs vacíos: `delete from public.forecasting_inventory_today where btrim(coalesce(sku,''))='' and location_id=98632499512;`
   - Consolidar duplicados por (sku, location_id) si existen.
   - Crear índice único parcial: `create unique index if not exists uq_forecasting_inventory_today_sku_loc_nonempty on public.forecasting_inventory_today (sku, location_id) where btrim(coalesce(sku,''))<>'';`
   - Crear función `forecast_set_in_transit_batch(items)` (contenido en la migración `20251030_forecasting_in_transit_upsert_fn.sql`).
2) Worker — detección robusta KRONI (con secrets ya confirmados):
   - Omitir validación Shopify si destino es KRONI; Odoo → tránsito (ID 43); Supabase → RPC con `location_id=98632499512`.
3) Reprueba Caso 3 (Bodega→KRONI):
   - Esperado: sin draft; picking a la ubicación tránsito; forecasting set por (sku, 98632499512) sin “Too many subrequests.”.

Guía de prueba (actualizada)
- GET https://transfers-worker.wispy-unit-fc23.workers.dev/api/transfers/shopify-health y configurar `SHOPIFY_API_VERSION=unstable` y `SHOPIFY_API_VERSION_LIST=unstable,2025-01,2024-10,2024-07,2024-04,2024-01,2023-10`.
- Caso 2 (Bodega→Ceiba):
  - Verificar draft en Shopify y picking en Odoo.
  - Revisar en Supabase: `shopify_transfer_drafts` y `transfer_logs` (api_version, mutation, input_variant, origin_gid, dest_gid).
- Caso 3 (Bodega→CEDIS): ejecutar tras corregir lo del destino.

---

Sesión 2025-11-01 — Observaciones de validación y plan de corrección

Resumen
- Escenario A (WH→CEIBA/CONQUISTA): confirmado OK después de regresión. Mantener estable.
- Escenario B (WH→KRONI): picking validado en tránsito correcto y sin draft Shopify; pendiente actualización de `forecasting_inventory_today`.

Acciones de documentación
- README y PROJECT actualizados: aclaración de que la ubicación de tránsito no va en `transfer_locations` y que se implementará fallback a upsert REST si la RPC no existe/falla.

Plan técnico inmediato
1) Worker (WH→KRONI): forzar escritura por REST hacia `forecasting_inventory_today` usando `SHOPIFY_KRONI_LOCATION_ID` como truth source para `location_id` (bypass de la RPC para evitar mapeos internos). Si el upsert por bloque falla, realizar ciclo por fila con PATCH y, si no afecta filas, POST.
2) Idempotencia: conservar `transfer_logs.event=forecast_in_transit_applied` para no duplicar.
3) Acotado a B: sólo se activa en WH→KRONI y cuando `picking.state = done`.

Próximo paso
- Implementar fallback y desplegar; ejecutar prueba de Escenario B para verificar escritura en Supabase.

---

Sesión 2025-11-01 (Tarde) — Fix final Escenario B

Cambios aplicados
- Validación previa (Shopify) también para KRONI, bloqueando insuficiencias antes de Odoo. Evita parciales y backorders.
- Forecasting WH→KRONI: escritura estricta por fila (PATCH/POST) a `forecasting_inventory_today` con `location_id=98632499512` forzado; sin RPC.
- Auditoría: evento `forecast_target_location` y `forecast_in_transit_applied` con `via: 'rest_forced_strict'`.

Resultado
- Reprueba del Escenario B correcta: sólo se modifican filas de KRONI y en cuenta con los SKUs enviados. Sin parciales en Odoo.

Notas
- El Escenario A se mantiene estable: validación y flujo de draft/picking sin cambios.
