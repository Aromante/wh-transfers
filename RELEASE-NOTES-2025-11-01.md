Warehouse Transfers — Release Notes (2025-11-01)

Resumen
- Se corrige Escenario B (WH→KRONI) para actualizar forecasting en la ubicación correcta y se evita la creación de traslados parciales en Odoo.

Cambios
- Validación previa (Shopify) ahora aplica a todos los destinos, incluido KRONI. Si hay insuficiencia, se responde 409 con detalle por SKU y no se crea picking.
- Forecasting (WH→KRONI):
  - Escritura estricta por fila (PATCH/POST) a `forecasting_inventory_today`, `location_id=98632499512` (Kroni) forzado.
  - Sin uso de RPC `forecast_set_in_transit_batch` para este flujo; se eliminan dependencias de mapeos.
  - Auditoría en `transfer_logs`: `forecast_target_location` y `forecast_in_transit_applied (via=rest_forced_strict)`.
- Frontend: `TransferPage` ahora llama siempre a `/api/transfers/validate` para evitar parciales en Odoo y mostrar el mensaje de insuficiencia (como en Escenario A).

Impacto
- Escenario A se mantiene sin cambios perceptibles; continúa creación de draft y picking si hay stock.
- Escenario B ahora actualiza exclusivamente filas de KRONI en forecasting y bloquea cualquier parcial en Odoo.

Verificación sugerida
- Crear transferencia B con SKUs existentes → ver `forecasting_inventory_today` solo en `location_id=98632499512` y `transfer_logs` con los eventos mencionados.
- Intentar transferencia B con insuficiencia → ver 409 con detalle por SKU; no se crea picking ni se toca forecasting.

Notas futuras
- Considerar parametrizar el `location_id` forzado vía `SHOPIFY_KRONI_LOCATION_ID` con un flag de bloqueo, y agregar guard rails que alerten si algún update de B toca otra ubicación.

