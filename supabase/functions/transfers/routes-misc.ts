// History, locations, health, duplicate, CSV routes
import { type Env, boolFlag, parseListParam } from './helpers.ts'
import { sbSelect, sbInsert, sbLogTransfer, sbGetTransferById, sbGetTransferLinesByTransferId, sbListLocations, resolveBox } from './supabase-helpers.ts'
import { findProductByCode, findProductsByCodes } from './odoo.ts'
import { shopifyGraphQLWithVersion, adjustShopifyPlantaInventory } from './shopify.ts'

export async function handleGetLocations(env: Env) {
    // Reads from the transfer_locations VIEW (join of shopify_locations + odoo_locations)
    // Returns can_be_origin and can_be_destination computed dynamically from Shopify flags
    const rows = await sbListLocations(env)
    return { data: rows }
}

export async function handleGetTransfer(req: Request, env: Env) {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return { error: 'id requerido', status: 400 }
    const transfer = await sbGetTransferById(env, id)
    if (!transfer) return { error: 'Transfer no encontrado', status: 404 }
    const lines = await sbGetTransferLinesByTransferId(env, id)
    return { data: { ...transfer, lines } }
}

export async function handleHistory(req: Request, env: Env) {
    const url = new URL(req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200)
    const offset = Number(url.searchParams.get('offset') || 0)
    const search = url.searchParams.get('search') || ''
    const status = url.searchParams.get('status') || ''
    const origin = url.searchParams.get('origin') || ''
    const dest = url.searchParams.get('dest') || ''
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''

    // Use transfer_log VIEW which joins transfers + transfer_lines + transfer_locations
    let q = `select=id,client_transfer_id,origin_id,dest_id,origin_name,dest_name,status,picking_name,odoo_picking_id,draft_owner,draft_title,created_at,updated_at,lines&order=created_at.desc&limit=${limit}&offset=${offset}`
    if (status) q += `&status=eq.${encodeURIComponent(status)}`
    if (origin) q += `&origin_id=eq.${encodeURIComponent(origin)}`
    if (dest) q += `&dest_id=eq.${encodeURIComponent(dest)}`
    if (from) q += `&created_at=gte.${encodeURIComponent(from)}`
    if (to) q += `&created_at=lte.${encodeURIComponent(to)}`
    if (search) q += `&or=(picking_name.ilike.*${encodeURIComponent(search)}*,client_transfer_id.ilike.*${encodeURIComponent(search)}*)`

    const rows = await sbSelect(env, 'transfer_log', q)
    return { data: rows }
}

export async function handleHistoryCSV(req: Request, env: Env) {
    const result = await handleHistory(req, env)
    const rows: any[] = (result as any).data || []
    if (!rows.length) return { csv: 'No data', contentType: 'text/csv' }

    const headers = ['id', 'client_transfer_id', 'origin_id', 'dest_id', 'origin_name', 'dest_name', 'status', 'picking_name', 'created_at']
    const csvLines = [headers.join(',')]
    for (const r of rows) {
        csvLines.push(headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','))
    }
    return { csv: csvLines.join('\n'), contentType: 'text/csv' }
}

export async function handleDuplicateTransfer(req: Request, env: Env) {
    const body = await req.json()
    const { transfer_id } = body as any
    if (!transfer_id) return { error: 'transfer_id requerido', status: 400 }
    const transfer = await sbGetTransferById(env, transfer_id)
    if (!transfer) return { error: 'Transfer no encontrado', status: 404 }
    const lines = await sbGetTransferLinesByTransferId(env, transfer_id)

    const newId = crypto.randomUUID()
    await sbInsert(env, 'transfers', [{
        id: newId, origin_id: transfer.origin_id, dest_id: transfer.dest_id,
        status: 'draft', client_transfer_id: null,
        draft_owner: transfer.draft_owner, draft_title: transfer.draft_title,
    }])
    if (lines.length) {
        const newLines = lines.map((l: any) => ({
            transfer_id: newId, barcode: l.barcode, sku: l.sku, qty: l.qty,
            product_name: l.product_name, odoo_product_id: l.odoo_product_id, uom_name: l.uom_name,
        }))
        try { await sbInsert(env, 'transfer_lines', newLines) } catch { }
    }
    await sbLogTransfer(env, newId, 'duplicated_from', { source_id: transfer_id })
    return { data: { id: newId, duplicated_from: transfer_id } }
}

export async function handleHealth(env: Env) {
    const checks: Record<string, any> = { ok: true, ts: new Date().toISOString() }
    // Odoo check
    try {
        const base = String(env.ODOO_URL).replace(/\/$/, '')
        const r = await fetch(`${base}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service: 'common', method: 'version' }, id: 1 }) })
        checks.odoo = r.ok ? 'ok' : 'error'
    } catch (e: any) { checks.odoo = `error: ${e.message}` }
    // Supabase check (use transfer_locations VIEW)
    try {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_locations?select=odoo_location_code&limit=1`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}` } })
        checks.supabase = r.ok ? 'ok' : 'error'
    } catch (e: any) { checks.supabase = `error: ${e.message}` }
    // Shopify check
    if (env.SHOPIFY_DOMAIN && env.SHOPIFY_ACCESS_TOKEN) {
        try {
            const ver = String(env.SHOPIFY_API_VERSION || '2023-10')
            const result = await shopifyGraphQLWithVersion(env, ver, `{ shop { name } }`)
            checks.shopify = result.ok ? 'ok' : 'error'
        } catch (e: any) { checks.shopify = `error: ${e.message}` }
    } else {
        checks.shopify = 'not_configured'
    }
    return { data: checks }
}

export async function handleGetLogs(req: Request, env: Env) {
    const url = new URL(req.url)
    const transferId = url.searchParams.get('transfer_id')
    if (!transferId) return { error: 'transfer_id requerido', status: 400 }
    const rows = await sbSelect(env, 'transfer_logs', `transfer_id=eq.${encodeURIComponent(transferId)}&select=*&order=created_at.desc`)
    return { data: rows }
}

// GET /resolve?code=X
// Resolves a single barcode/SKU: checks transfer_boxes first, then Odoo.
// Returns { source: 'box'|'odoo', sku, name, qty_per_box? } or 404.
export async function handleResolveCode(req: Request, env: Env) {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')?.trim()
    if (!code) return { error: 'code requerido', status: 400 }

    // 1. Check transfer_boxes
    const box = await resolveBox(env, code)
    if (box) {
        return {
            data: {
                source: 'box',
                barcode: box.barcode,
                sku: box.sku,
                name: box.product_name || box.label || box.sku,
                qty_per_box: Number(box.qty_per_box),
            }
        }
    }

    // 2. Check Odoo
    try {
        const prod = await findProductByCode(env, code)
        return {
            data: {
                source: 'odoo',
                barcode: code,
                sku: code,
                name: prod.name,
                qty_per_box: null,
            }
        }
    } catch {
        return { error: `Producto no encontrado: ${code}`, status: 404 }
    }
}

// ── POST /shopify/adjust-planta ───────────────────────────────────────────────
// Ajuste manual de inventario en Planta Productora (Shopify).
// Úsalo para sincronizar producciones/manufacturas de Odoo que no llegan
// automáticamente a Shopify.
//
// Body: { lines: [{ sku: "PER-ABUINF-30", delta: 50 }, ...] }
//   delta > 0 → suma (nueva producción)
//   delta < 0 → resta (corrección)
export async function handleAdjustPlantaInventory(req: Request, env: Env) {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN)
        return { error: 'Shopify no configurado', status: 500 }

    const body = await req.json()
    const { lines } = body as any
    if (!Array.isArray(lines) || !lines.length)
        return { error: 'lines requerido: [{ sku, delta }]', status: 400 }

    // Parse and validate lines
    const parsed: Array<{ sku: string; delta: number }> = []
    for (const ln of lines) {
        const sku = String(ln.sku || '').trim()
        const delta = Number(ln.delta || 0)
        if (!sku) continue
        if (delta === 0) continue
        parsed.push({ sku, delta })
    }
    if (!parsed.length) return { error: 'No hay líneas válidas (sku + delta != 0)', status: 400 }

    // Resolve shopify_inventory_item_id for each SKU via Odoo product catalog
    const skus = parsed.map(l => l.sku)
    const prodMap = await findProductsByCodes(env, skus)

    // Build itemQtyMap: inventoryItemId → delta (signed, not negated here)
    const itemQtyMap = new Map<number, number>()
    const notFound: string[] = []

    for (const { sku, delta } of parsed) {
        const prod = prodMap.get(sku)
        if (!prod?.shopify_inventory_item_id) {
            notFound.push(sku)
            continue
        }
        itemQtyMap.set(
            prod.shopify_inventory_item_id,
            (itemQtyMap.get(prod.shopify_inventory_item_id) || 0) + delta,
        )
    }

    if (itemQtyMap.size === 0) {
        return {
            status: 404,
            data: { adjusted: 0, not_found: notFound, error: 'Ningún SKU tiene shopify_inventory_item_id en Odoo' },
        }
    }

    // negate=false: usamos delta directo del caller (puede ser + o -)
    await adjustShopifyPlantaInventory(
        env,
        itemQtyMap,
        async (event, data) => {
            // Log sin transfer_id (ajuste manual, no asociado a un transfer)
            const logUrl = `${env.SUPABASE_URL}/rest/v1/transfer_logs`
            await fetch(logUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    apikey: env.SUPABASE_SERVICE_ROLE,
                    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
                    prefer: 'return=minimal',
                },
                body: JSON.stringify({
                    transfer_id: null,
                    event: 'shopify_planta_manual_adjust',
                    data: { sub_event: event, ...data, skus: parsed.map(l => l.sku), lines: parsed.length },
                    created_at: new Date().toISOString(),
                }),
            }).catch(() => {})
        },
        false, // negate=false — delta viene tal cual del caller
    )

    return {
        data: {
            adjusted: itemQtyMap.size,
            not_found: notFound,
            message: `Ajuste aplicado a ${itemQtyMap.size} SKU(s) en Planta Productora (Shopify).`,
        },
    }
}
