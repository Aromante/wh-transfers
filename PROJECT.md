# Warehouse Transfers — Proyecto

## Alcance
- Escaneo y creación de transferencias internas entre ubicaciones predefinidas.
- Replicación en Odoo (picking + moves), confirmación/asignación y validación automática (Done).
- Auditoría en Supabase (`transfers`, `transfer_lines`, `transfer_logs`).
- Catálogo de ubicaciones gestionado en Supabase (`transfer_locations`), con mapeo a `shopify_location_id`.

## Estado Actual
- Frontend operativo (Vite + React + Tailwind). Escáner + tabla de líneas + origen/destino.
- Worker en producción (`transfers-worker`): Odoo JSON‑RPC, validación automática, endpoint de validación Shopify.
- Supabase: migraciones aplicadas (core + `shopify_location_id`) y mapeo `transfer_locations.shopify_location_id` YA poblado para las ubicaciones operativas (WH/Existencias, KRONI/Existencias, P-CEI/Existencias, P-CON/Existencias).
- Shopify: credenciales configuradas (STORE + ACCESS_TOKEN); creación automática de drafts habilitada cuando el destino no es `KRONI/Existencias`.

## Requerimientos Priorizados
1) Validar inventario en Shopify antes de crear la transferencia
   - Implementado: Worker `POST /api/transfers/validate` con GraphQL Admin.
   - Frontend: valida en submit y bloquea si hay insuficiencia; muestra disponibles por SKU.
   - Operativo: Shopify creds están configuradas; el mapeo `transfer_locations.shopify_location_id` ya está poblado.

2) Editable la cantidad por SKU escaneado (WIP)
   - Pendiente: permitir edición inline de `qty` en la tabla; soportar modo “xN”.
   - Nota: coordinar con validación previa (Shopify) para recalcular si el usuario cambia qty.

## Pendientes Técnicos
- UI: edición de cantidad y validaciones en vivo.
- Worker: endpoint opcional `validate-product` para mostrar nombre al escanear.
- Mejorar mensajes de error y toasts.
- Mantenimiento: los mapeos Odoo/Shopify por ubicación ya están poblados en Supabase; mantenerlos actualizados si cambian ubicaciones.

## Variables/Secrets
- Worker (prod): SUPABASE_URL, SUPABASE_SERVICE_ROLE, ODOO_URL, ODOO_DB, ODOO_UID, ODOO_API_KEY, SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, (opcional) ODOO_AUTO_VALIDATE=1.
- Frontend: VITE_API_BASE, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

## Verificación
- E2E: crear transferencia válida y ver “Done” en Odoo, y reflejo en Shopify via n8n (si aplica).
- Validación negativa: intentar qty > disponible en Shopify → bloquear con detalle por SKU.
