# Worker API — Warehouse Transfers

Endpoints:
- POST /api/transfers — Crea transferencia en Odoo (picking + moves) y la registra en Supabase
- GET  /api/transfers/:id — Estado/detalle

Secrets/vars (wrangler):
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE
- ODOO_URL, ODOO_DB, ODOO_UID (o login vía uid/password), ODOO_API_KEY
- CORS_ORIGIN (dominio del Shell)

Desarrollo: `wrangler dev` (si el proyecto se independiza con su propio repo).
