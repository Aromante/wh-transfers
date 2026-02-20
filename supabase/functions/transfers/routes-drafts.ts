// Draft management — uses the real `transfers` table (status='draft')
// A draft is a transfer in status 'draft' with transfer_lines but no Odoo picking yet.
import { type Env, boolFlag, getOwner } from './helpers.ts'
import { sbInsert, sbSelect, sbPatch, sbDelete, sbGetTransferById, sbGetTransferLinesByTransferId, sbLogTransfer, sbUpdateTransferById } from './supabase-helpers.ts'
import { findProductsByCodes, findInternalPickingType, findLocationIdByCompleteName, odooCreate, odooExecuteKw } from './odoo.ts'
import { sbGetLocation, resolveBox } from './supabase-helpers.ts'

export async function handleListDrafts(req: Request, env: Env) {
    const url = new URL(req.url)
    const owner = url.searchParams.get('owner') || getOwner(req)
    const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50)

    let q = `select=id,client_transfer_id,origin_id,dest_id,status,draft_owner,draft_title,created_at,updated_at&status=eq.draft&order=updated_at.desc&limit=${limit}`
    if (owner && owner !== '*') q += `&draft_owner=eq.${encodeURIComponent(owner)}`
    const rows = await sbSelect(env, 'transfers', q)
    return { data: rows }
}

export async function handleCreateDraft(req: Request, env: Env) {
    const body = await req.json()
    const { origin_id, dest_id, lines, title } = body as any
    const owner = getOwner(req)
    const maxDrafts = Number(env.MAX_DRAFTS_PER_OWNER || 3)

    if (boolFlag(env.ENABLE_MULTI_DRAFTS, true)) {
        const existing = await sbSelect(env, 'transfers', `status=eq.draft&draft_owner=eq.${encodeURIComponent(owner)}&select=id`)
        if (existing.length >= maxDrafts) return { error: `Máximo ${maxDrafts} borradores activos`, status: 400 }
    }

    const transferId = crypto.randomUUID()
    await sbInsert(env, 'transfers', [{
        id: transferId,
        origin_id: origin_id || null,
        dest_id: dest_id || null,
        status: 'draft',
        draft_owner: owner,
        draft_title: title || null,
        client_transfer_id: null,
    }])

    // Persist draft lines if provided
    if (Array.isArray(lines) && lines.length) {
        const draftLines = lines.map((ln: any) => ({
            transfer_id: transferId,
            barcode: String(ln.barcode || ln.code || '').trim(),
            sku: String(ln.sku || ln.barcode || ln.code || '').trim(),
            qty: Number(ln.qty || 1),
        })).filter((l: any) => l.barcode && l.qty > 0)
        if (draftLines.length) try { await sbInsert(env, 'transfer_lines', draftLines) } catch { }
    }

    await sbLogTransfer(env, transferId, 'draft_created', { owner })
    const draft = await sbGetTransferById(env, transferId)
    return { data: draft || { id: transferId } }
}

export async function handleUpdateDraft(req: Request, env: Env) {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return { error: 'id requerido', status: 400 }

    const body = await req.json()
    const { status, draft_title, origin_id, dest_id, lines } = body as any
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (status !== undefined) patch.status = status
    if (draft_title !== undefined) patch.draft_title = draft_title
    if (origin_id !== undefined) patch.origin_id = origin_id
    if (dest_id !== undefined) patch.dest_id = dest_id

    const rows = await sbPatch(env, 'transfers', `id=eq.${encodeURIComponent(id)}`, patch)
    if (!rows?.length) return { error: 'Borrador no encontrado', status: 404 }

    // Replace lines if provided
    if (Array.isArray(lines)) {
        // Delete existing lines and re-insert
        try { await sbDelete(env, 'transfer_lines', `transfer_id=eq.${encodeURIComponent(id)}`) } catch { }
        if (lines.length) {
            const newLines = lines.map((ln: any) => ({
                transfer_id: id,
                barcode: String(ln.barcode || ln.code || '').trim(),
                sku: String(ln.sku || ln.barcode || ln.code || '').trim(),
                qty: Number(ln.qty || 1),
            })).filter((l: any) => l.barcode && l.qty > 0)
            if (newLines.length) try { await sbInsert(env, 'transfer_lines', newLines) } catch { }
        }
    }

    return { data: rows[0] }
}

export async function handleDeleteDraft(req: Request, env: Env) {
    const url = new URL(req.url)
    const id = url.searchParams.get('draft_id') || url.searchParams.get('id')
    if (!id) return { error: 'id requerido', status: 400 }
    // Soft-delete: set status = 'cancelled'
    const rows = await sbPatch(env, 'transfers', `id=eq.${encodeURIComponent(id)}`, { status: 'cancelled', updated_at: new Date().toISOString() })
    if (!rows?.length) return { error: 'Borrador no encontrado', status: 404 }
    return { data: { deleted: true, id } }
}

export async function handleCommitDraft(req: Request, env: Env) {
    // Commit = create Odoo picking from draft lines
    const body = await req.json()
    const { draft_id } = body as any
    if (!draft_id) return { error: 'draft_id requerido', status: 400 }

    const draft = await sbGetTransferById(env, draft_id)
    if (!draft) return { error: 'Borrador no encontrado', status: 404 }
    if (draft.status !== 'draft') return { error: 'Solo se pueden confirmar borradores', status: 400 }

    const lines = await sbGetTransferLinesByTransferId(env, draft_id)
    if (!lines.length) return { error: 'Borrador sin líneas', status: 400 }

    // Validate locations
    const [originLoc, destLoc] = await Promise.all([
        sbGetLocation(env, draft.origin_id),
        sbGetLocation(env, draft.dest_id),
    ])
    if (!originLoc) return { error: `Ubicación de origen no encontrada: ${draft.origin_id}`, status: 400 }
    if (!destLoc) return { error: `Ubicación de destino no encontrada: ${draft.dest_id}`, status: 400 }

    // Expand box barcodes
    const expandedLines: Array<{ barcode: string; sku: string; qty: number; box_barcode?: string }> = []
    for (const ln of lines) {
        const rawBarcode = String(ln.barcode || '').trim()
        const qty = Number(ln.qty || 1)
        const box = await resolveBox(env, rawBarcode)
        if (box) {
            expandedLines.push({ barcode: box.sku, sku: box.sku, qty: box.qty_per_box * qty, box_barcode: rawBarcode })
        } else {
            expandedLines.push({ barcode: rawBarcode, sku: rawBarcode, qty })
        }
    }

    const codes = expandedLines.map(l => l.barcode).filter(Boolean)
    const prodMap = await findProductsByCodes(env, codes)
    const pickingTypeId = await findInternalPickingType(env)
    const originLocId = await findLocationIdByCompleteName(env, draft.origin_id)
    const destLocId = await findLocationIdByCompleteName(env, draft.dest_id)

    const moveLines = expandedLines.map(ln => {
        const prod = prodMap.get(ln.barcode)
        if (!prod) throw new Error(`Producto no encontrado en Odoo: ${ln.barcode}`)
        return [0, 0, {
            product_id: prod.id, product_uom: prod.uom_id,
            product_uom_qty: Number(ln.qty), name: prod.name,
            location_id: originLocId, location_dest_id: destLocId,
        }]
    })

    const pickingId = await odooCreate(env, 'stock.picking', {
        picking_type_id: pickingTypeId, location_id: originLocId, location_dest_id: destLocId,
        move_ids_without_package: moveLines, origin: draft.client_transfer_id || undefined,
    })

    try { await odooExecuteKw(env, 'stock.picking', 'action_confirm', [[pickingId]]) } catch { }

    // Update draft → committed
    await sbUpdateTransferById(env, draft_id, {
        status: 'pending',
        odoo_picking_id: pickingId,
        updated_at: new Date().toISOString(),
    })

    await sbLogTransfer(env, draft_id, 'draft_committed', { pickingId })
    return { data: { id: draft_id, pickingId, committed: true } }
}
