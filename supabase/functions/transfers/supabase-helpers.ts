import { type Env, chunk } from './helpers.ts'

// ── Location row from transfer_locations VIEW ──
export type LocationRow = {
    shopify_id: number
    gid: string
    name: string
    is_active: boolean
    odoo_id: number
    odoo_location_code: string
    can_be_origin: boolean
    can_be_destination: boolean
}

// ── Box row from transfer_boxes ──
export type BoxRow = {
    id: string
    barcode: string
    label: string | null
    sku: string
    product_name: string | null
    odoo_product_id: number | null
    qty_per_box: number
    is_active: boolean
}

function sbHeaders(env: Env) {
    return { 'content-type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}` }
}

export async function sbInsert(env: Env, table: string, rows: any[]) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...sbHeaders(env), prefer: 'return=representation' }, body: JSON.stringify(rows) })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
}

export async function sbUpsert(env: Env, table: string, rows: any[]) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...sbHeaders(env), prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
}

export async function sbSelect(env: Env, table: string, query: string) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { method: 'GET', headers: sbHeaders(env) })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
}

export async function sbPatch(env: Env, table: string, query: string, patch: Record<string, any>) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { method: 'PATCH', headers: { ...sbHeaders(env), prefer: 'return=representation' }, body: JSON.stringify(patch) })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
}

export async function sbDelete(env: Env, table: string, query: string) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: sbHeaders(env) })
    if (!r.ok) throw new Error(await r.text())
    return true
}

// ── Location helpers (reads from transfer_locations VIEW) ──
export async function sbGetLocation(env: Env, code: string): Promise<LocationRow | null> {
    const rows = await sbSelect(env, 'transfer_locations', `odoo_location_code=eq.${encodeURIComponent(code)}&select=*`)
    return rows?.[0] || null
}

export async function sbListLocations(env: Env): Promise<LocationRow[]> {
    return sbSelect(env, 'transfer_locations', 'select=*&order=name.asc')
}

// ── Box resolver (reads from transfer_boxes, returns null if not found) ──
export async function resolveBox(env: Env, barcode: string): Promise<BoxRow | null> {
    const rows = await sbSelect(env, 'transfer_boxes', `barcode=eq.${encodeURIComponent(barcode)}&is_active=eq.true&select=*`)
    return rows?.[0] || null
}

// ── Transfer helpers (real tables: transfers + transfer_lines) ──
export async function sbGetTransferById(env: Env, id: string) {
    const rows = await sbSelect(env, 'transfers', `id=eq.${encodeURIComponent(id)}&select=*`)
    return rows?.[0] || null
}

export async function sbGetTransferLinesByTransferId(env: Env, transferId: string) {
    return sbSelect(env, 'transfer_lines', `transfer_id=eq.${encodeURIComponent(transferId)}&select=*&order=id.asc`)
}

export async function sbUpdateTransferById(env: Env, id: string, patch: Record<string, any>) {
    const rows = await sbPatch(env, 'transfers', `id=eq.${encodeURIComponent(id)}`, patch)
    return rows?.[0] || null
}

export async function sbGetByClientTransferId(env: Env, clientId: string) {
    return sbSelect(env, 'transfers', `client_transfer_id=eq.${encodeURIComponent(clientId)}&select=id,odoo_picking_id,picking_name,status`)
}

export async function sbLogTransfer(env: Env, transferId: string, event: string, detail: any) {
    try { await sbInsert(env, 'transfer_logs', [{ transfer_id: transferId, event, detail }]) } catch { }
}

// Forecasting upsert (strict per-row approach)
export async function sbUpsertForecastingTodayStrict(env: Env, items: { sku: string; location_id: number; in_transit_units: number }[]) {
    const clean = items
        .map(it => ({ sku: String(it.sku || '').trim(), location_id: Number(it.location_id), in_transit_units: Number(it.in_transit_units || 0) }))
        .filter(it => it.sku.length > 0 && Number.isFinite(it.location_id) && it.location_id > 0)
    const results: any[] = []
    for (const row of clean) {
        const q = `sku=eq.${row.sku}&location_id=eq.${row.location_id}`
        const patchUrl = `${env.SUPABASE_URL}/rest/v1/forecasting_inventory_today?${q}`
        const rPatch = await fetch(patchUrl, { method: 'PATCH', headers: { ...sbHeaders(env), prefer: 'return=representation' }, body: JSON.stringify({ in_transit_units: row.in_transit_units }) })
        if (rPatch.ok) {
            const body = await rPatch.json().catch(() => [])
            if (Array.isArray(body) && body.length > 0) { results.push(body); continue }
        }
        const rPost = await fetch(`${env.SUPABASE_URL}/rest/v1/forecasting_inventory_today`, { method: 'POST', headers: { ...sbHeaders(env), prefer: 'return=representation' }, body: JSON.stringify([row]) })
        if (!rPost.ok) { const errTxt = await rPost.text().catch(() => ''); throw new Error(`forecasting upsert failed: ${errTxt}`) }
        results.push(await rPost.json())
    }
    return results.flat()
}
