import { type Env, chunk } from './helpers.ts'

export async function odooExecuteKw(env: Env, model: string, method: string, args: any[] = [], kwargs: Record<string, any> = {}) {
    const base = String(env.ODOO_URL).replace(/\/$/, '')
    const payload = {
        jsonrpc: '2.0', method: 'call',
        params: { service: 'object', method: 'execute_kw', args: [env.ODOO_DB, Number(env.ODOO_UID), env.ODOO_API_KEY, model, method, args, kwargs] },
        id: Math.floor(Math.random() * 1e6),
    }
    const resp = await fetch(`${base}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const data: any = await resp.json().catch(() => ({}))
    if (!resp.ok || data.error) throw new Error(`Odoo error: ${JSON.stringify(data.error || data)}`)
    return data.result
}

export const odooSearch = (env: Env, model: string, domain: any[], kwargs: Record<string, any> = {}) =>
    odooExecuteKw(env, model, 'search', [domain], kwargs)

export const odooRead = (env: Env, model: string, ids: number[], fields: string[]) =>
    odooExecuteKw(env, model, 'read', [ids, fields])

export const odooWrite = (env: Env, model: string, ids: number[], vals: Record<string, any>) =>
    odooExecuteKw(env, model, 'write', [ids, vals])

export const odooCreate = (env: Env, model: string, vals: Record<string, any>) =>
    odooExecuteKw(env, model, 'create', [vals])

export async function findInternalPickingType(env: Env) {
    const ids = await odooSearch(env, 'stock.picking.type', [['code', '=', 'internal']])
    if (!ids?.length) throw new Error('No se encontró picking type interno')
    return ids[0]
}

export async function findLocationIdByCompleteName(env: Env, code: string) {
    const ids = await odooSearch(env, 'stock.location', [['complete_name', '=', code]])
    if (!ids?.length) throw new Error(`Ubicación no encontrada en Odoo: ${code}`)
    return ids[0]
}

export async function findProductByCode(env: Env, code: string) {
    const domain = ['|', ['barcode', '=', code], ['default_code', '=', code]]
    const ids = await odooSearch(env, 'product.product', domain as any)
    if (!ids?.length) throw new Error(`Producto no encontrado: ${code}`)
    const rows = await odooRead(env, 'product.product', [ids[0]], ['id', 'display_name', 'uom_id'])
    const row = rows?.[0]
    if (!row) throw new Error(`Producto no legible: ${code}`)
    const uomId = Array.isArray(row.uom_id) ? row.uom_id[0] : row.uom_id
    return { id: row.id as number, name: row.display_name as string, uom_id: Number(uomId) }
}

export async function findProductsByCodes(env: Env, codesIn: string[]) {
    const codes = Array.from(new Set(codesIn.map(c => String(c || '').trim()).filter(Boolean)))
    const map = new Map<string, { id: number; name: string; uom_id: number }>()
    for (const part of chunk(codes, 80)) {
        const domain = ['|', ['barcode', 'in', part], ['default_code', 'in', part]] as any
        const rows: any[] = await odooExecuteKw(env, 'product.product', 'search_read', [domain], { fields: ['id', 'display_name', 'uom_id', 'barcode', 'default_code'], limit: 2000 })
        for (const row of rows || []) {
            const uomId = Array.isArray(row.uom_id) ? row.uom_id[0] : row.uom_id
            const val = { id: Number(row.id), name: String(row.display_name || ''), uom_id: Number(uomId) }
            const bc = String(row.barcode || '').trim()
            const sku = String(row.default_code || '').trim()
            if (bc && !map.has(bc)) map.set(bc, val)
            if (sku && !map.has(sku)) map.set(sku, val)
        }
    }
    return map
}

export async function validatePicking(env: Env, pickingId: number) {
    const action = await odooExecuteKw(env, 'stock.picking', 'button_validate', [[pickingId]], { context: { skip_backorder: true } })
    if (action === true) return true
    if (action && typeof action === 'object') {
        const resModel = (action as any).res_model, resId = (action as any).res_id
        if (resModel === 'stock.immediate.transfer') {
            if (resId) { await odooExecuteKw(env, 'stock.immediate.transfer', 'process', [[resId]]); return true }
            const wizId = await odooCreate(env, 'stock.immediate.transfer', { pick_ids: [[6, 0, [pickingId]]] })
            await odooExecuteKw(env, 'stock.immediate.transfer', 'process', [[wizId]]); return true
        }
        if (resModel === 'stock.backorder.confirmation') {
            if (resId) { await odooExecuteKw(env, 'stock.backorder.confirmation', 'process', [[resId]]); return true }
            const wizId = await odooCreate(env, 'stock.backorder.confirmation', { pick_ids: [[6, 0, [pickingId]]] })
            await odooExecuteKw(env, 'stock.backorder.confirmation', 'process', [[wizId]]); return true
        }
    }
    // Fallback: set qty_done from moves
    const pickRows = await odooRead(env, 'stock.picking', [pickingId], ['move_ids_without_package'])
    const pick = pickRows?.[0] || {}
    const moveIds: number[] = Array.isArray(pick.move_ids_without_package) ? pick.move_ids_without_package : []
    if (moveIds.length) {
        const moves = await odooRead(env, 'stock.move', moveIds, ['id', 'product_id', 'product_uom', 'product_uom_qty', 'location_id', 'location_dest_id', 'move_line_ids'])
        for (const mv of moves) {
            const lineIds: number[] = Array.isArray(mv.move_line_ids) ? mv.move_line_ids : []
            if (lineIds.length) {
                for (const lid of lineIds) await odooWrite(env, 'stock.move.line', [lid], { qty_done: Number(mv.product_uom_qty) || 0 })
            } else {
                const productId = Array.isArray(mv.product_id) ? mv.product_id[0] : mv.product_id
                const uomId = Array.isArray(mv.product_uom) ? mv.product_uom[0] : mv.product_uom
                const locId = Array.isArray(mv.location_id) ? mv.location_id[0] : mv.location_id
                const dstId = Array.isArray(mv.location_dest_id) ? mv.location_dest_id[0] : mv.location_dest_id
                await odooCreate(env, 'stock.move.line', { picking_id: pickingId, move_id: mv.id, product_id: Number(productId), product_uom_id: Number(uomId), qty_done: Number(mv.product_uom_qty) || 0, location_id: Number(locId), location_dest_id: Number(dstId) })
            }
        }
        const action2 = await odooExecuteKw(env, 'stock.picking', 'button_validate', [[pickingId]], { context: { skip_backorder: true } })
        if (action2 === true) return true
        if (action2 && typeof action2 === 'object') {
            const rm2 = (action2 as any).res_model, ri2 = (action2 as any).res_id
            if (rm2 === 'stock.immediate.transfer') {
                if (ri2) await odooExecuteKw(env, 'stock.immediate.transfer', 'process', [[ri2]])
                else { const w = await odooCreate(env, 'stock.immediate.transfer', { pick_ids: [[6, 0, [pickingId]]] }); await odooExecuteKw(env, 'stock.immediate.transfer', 'process', [[w]]) }
                return true
            }
            if (rm2 === 'stock.backorder.confirmation') {
                if (ri2) await odooExecuteKw(env, 'stock.backorder.confirmation', 'process', [[ri2]])
                else { const w = await odooCreate(env, 'stock.backorder.confirmation', { pick_ids: [[6, 0, [pickingId]]] }); await odooExecuteKw(env, 'stock.backorder.confirmation', 'process', [[w]]) }
                return true
            }
        }
    }
    return false
}
