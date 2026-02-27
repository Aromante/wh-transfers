// CRUD for transfer_boxes catalog
// Boxes are physical containers with a fixed SKU and qty_per_box
// Scanning a box barcode during a transfer expands into the associated product line
import { type Env, getOwner } from './helpers.ts'
import { sbSelect, sbInsert, sbPatch, resolveBox } from './supabase-helpers.ts'

export async function handleListBoxes(req: Request, env: Env) {
    const url = new URL(req.url)
    const sku = url.searchParams.get('sku') || ''
    const search = url.searchParams.get('search') || ''
    const inactive = url.searchParams.get('inactive') === 'true'

    let q = 'select=*&order=sku.asc,barcode.asc'
    if (!inactive) q += '&is_active=eq.true'
    if (sku) q += `&sku=eq.${encodeURIComponent(sku)}`
    if (search) q += `&or=(barcode.ilike.*${encodeURIComponent(search)}*,sku.ilike.*${encodeURIComponent(search)}*,label.ilike.*${encodeURIComponent(search)}*)`

    const rows = await sbSelect(env, 'transfer_boxes', q)
    return { data: rows }
}

export async function handleGetBox(req: Request, env: Env) {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    const barcode = url.searchParams.get('barcode')

    if (!id && !barcode) return { error: 'id o barcode requerido', status: 400 }

    const q = id
        ? `id=eq.${encodeURIComponent(id)}&select=*`
        : `barcode=eq.${encodeURIComponent(barcode!)}&is_active=eq.true&select=*`

    const rows = await sbSelect(env, 'transfer_boxes', q)
    if (!rows?.length) return { error: 'Caja no encontrada', status: 404 }
    return { data: rows[0] }
}

export async function handleResolveBox(req: Request, env: Env) {
    // GET /boxes/resolve/:barcode — resolve a box barcode to its SKU + qty
    const url = new URL(req.url)
    // barcode comes from the path: /boxes/resolve/BOXS_ABUINF_30
    const path = url.pathname.replace(/^\/transfers/, '').replace(/^\/+/, '/')
    const barcode = path.replace(/^\/boxes\/resolve\//, '').split('?')[0]

    if (!barcode) return { error: 'barcode requerido', status: 400 }

    const box = await resolveBox(env, barcode)
    if (!box) return { error: `Caja no encontrada: ${barcode}`, status: 404 }
    return { data: box }
}

export async function handleCreateBox(req: Request, env: Env) {
    const body = await req.json() as any
    const { barcode, sku, qty_per_box, label, product_name, odoo_product_id } = body

    if (!barcode || !sku || !qty_per_box)
        return { error: 'barcode, sku y qty_per_box son requeridos', status: 400 }
    if (Number(qty_per_box) <= 0)
        return { error: 'qty_per_box debe ser mayor a 0', status: 400 }

    // Check for duplicate barcode
    const existing = await sbSelect(env, 'transfer_boxes', `barcode=eq.${encodeURIComponent(barcode)}&select=id,is_active`)
    if (existing?.length) {
        const ex = existing[0]
        if (ex.is_active) return { error: `Ya existe una caja activa con barcode: ${barcode}`, status: 409 }
        // Reactivate inactive box
        const updated = await sbPatch(env, 'transfer_boxes', `id=eq.${ex.id}`, {
            sku, qty_per_box: Number(qty_per_box), label: label || null,
            product_name: product_name || null, odoo_product_id: odoo_product_id || null,
            is_active: true, updated_at: new Date().toISOString(),
        })
        return { data: updated?.[0] || null, reactivated: true }
    }

    const rows = await sbInsert(env, 'transfer_boxes', [{
        barcode: String(barcode).trim(),
        sku: String(sku).trim(),
        qty_per_box: Number(qty_per_box),
        label: label || null,
        product_name: product_name || null,
        odoo_product_id: odoo_product_id ? Number(odoo_product_id) : null,
    }])
    return { data: rows?.[0] || null }
}

export async function handleUpdateBox(req: Request, env: Env) {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return { error: 'id requerido', status: 400 }

    const body = await req.json() as any
    const allowed = ['sku', 'qty_per_box', 'label', 'product_name', 'odoo_product_id', 'is_active']
    const patch: Record<string, any> = {}
    for (const k of allowed) {
        if (k in body) patch[k] = body[k]
    }
    if (!Object.keys(patch).length) return { error: 'No hay campos para actualizar', status: 400 }
    if (patch.qty_per_box !== undefined && Number(patch.qty_per_box) <= 0)
        return { error: 'qty_per_box debe ser mayor a 0', status: 400 }

    patch.updated_at = new Date().toISOString()
    const rows = await sbPatch(env, 'transfer_boxes', `id=eq.${encodeURIComponent(id)}`, patch)
    if (!rows?.length) return { error: 'Caja no encontrada', status: 404 }
    return { data: rows[0] }
}

export async function handleDeleteBox(req: Request, env: Env) {
    // Soft-delete: set is_active = false
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return { error: 'id requerido', status: 400 }

    const rows = await sbPatch(env, 'transfer_boxes', `id=eq.${encodeURIComponent(id)}`, {
        is_active: false,
        updated_at: new Date().toISOString(),
    })
    if (!rows?.length) return { error: 'Caja no encontrada', status: 404 }
    return { data: { id, deleted: true } }
}
