import { type Env } from './helpers.ts'

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

// ── Transfer row from transfer_summary VIEW ──
export type TransferSummaryRow = {
    transfer_id: string
    origin_id: string
    dest_id: string
    origin_odoo_id: number | null
    dest_odoo_id: number | null
    origin_shopify_id: number | null
    dest_shopify_id: number | null
    status: string
    odoo_transfer_id: string | null
    shopify_transfer_id: string | null
    created_at: string
    sku_count: number
    total_units: number
    lines: Array<{ sku: string; qty: number; product_name: string | null; box_barcode: string | null }>
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

// ── Transfer helpers — reads from transfer_summary VIEW ──
// transfer_summary groups transfer_lines by transfer_id.
// NOTE: The view returns one row per transfer; status/odoo_transfer_id/shopify_transfer_id
//       are guaranteed consistent because all lines of a transfer share the same values.
export async function sbGetTransferById(env: Env, id: string): Promise<TransferSummaryRow | null> {
    const rows = await sbSelect(env, 'transfer_summary', `transfer_id=eq.${encodeURIComponent(id)}&select=*`)
    return rows?.[0] || null
}

// Patch all lines belonging to a transfer (status, odoo_transfer_id, shopify_transfer_id, etc.)
export async function sbUpdateTransferById(env: Env, id: string, patch: Record<string, any>) {
    return sbPatch(env, 'transfer_lines', `transfer_id=eq.${encodeURIComponent(id)}`, patch)
}

export async function sbLogTransfer(env: Env, transferId: string, event: string, detail: any) {
    try { await sbInsert(env, 'transfer_logs', [{ transfer_id: transferId, event, detail }]) } catch { }
}
