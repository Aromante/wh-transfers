// Draft management routes (multi-draft support)
import { type Env, boolFlag, getOwner, normCode } from './helpers.ts'
import { sbInsert, sbSelect, sbPatch, sbDelete, sbGetTransfer, sbLog } from './supabase-helpers.ts'
import { shopifyGraphQL, getShopifyLocationGid, resolveVariantsBatch, resolveVariantByCode, getAvailableAtLocation } from './shopify.ts'
import { findProductsByCodes, findInternalPickingType, findLocationIdByCompleteName, odooCreate, odooExecuteKw, odooRead, validatePicking } from './odoo.ts'

export async function handleListDrafts(req: Request, env: Env) {
    const url = new URL(req.url)
    const owner = url.searchParams.get('owner') || getOwner(req)
    const transferId = url.searchParams.get('transfer_id')
    let q = 'select=*&order=created_at.desc'
    if (transferId) q += `&transfer_id=eq.${encodeURIComponent(transferId)}`
    if (owner && owner !== '*') q += `&or=(transfer_id.in.(select id from transfer_summary_v2 where draft_owner=eq.${encodeURIComponent(owner)}))`
    const rows = await sbSelect(env, 'shopify_transfer_drafts_v2', q)
    return { data: rows }
}

export async function handleCreateDraft(req: Request, env: Env) {
    const body = await req.json()
    const { transfer_id, origin_code, dest_code, lines, notes } = body as any
    if (!transfer_id) return { error: 'transfer_id requerido', status: 400 }
    const owner = getOwner(req)
    const maxDrafts = Number(env.MAX_DRAFTS_PER_OWNER || 10)

    if (boolFlag(env.ENABLE_MULTI_DRAFTS, true)) {
        const existing = await sbSelect(env, 'shopify_transfer_drafts_v2', `transfer_id=eq.${transfer_id}&status=eq.pending&select=id`)
        if (existing.length >= maxDrafts) return { error: `Máximo ${maxDrafts} drafts por transfer`, status: 400 }
    }

    let originGid: string | null = null, destGid: string | null = null
    try { if (origin_code) originGid = await getShopifyLocationGid(env, origin_code) } catch { }
    try { if (dest_code) destGid = await getShopifyLocationGid(env, dest_code) } catch { }

    const draft = {
        transfer_id, origin_code: origin_code || null, dest_code: dest_code || null,
        origin_shopify_location_id: originGid, dest_shopify_location_id: destGid,
        lines: lines || [], status: 'pending', notes: notes || null,
    }
    const result = await sbInsert(env, 'shopify_transfer_drafts_v2', [draft])
    await sbPatch(env, 'transfer_summary_v2', `id=eq.${transfer_id}`, { draft_owner: owner })
    return { data: result?.[0] || draft }
}

export async function handleUpdateDraft(req: Request, env: Env) {
    const body = await req.json()
    const { draft_id, lines, notes, status } = body as any
    if (!draft_id) return { error: 'draft_id requerido', status: 400 }
    const patch: Record<string, any> = {}
    if (lines !== undefined) patch.lines = lines
    if (notes !== undefined) patch.notes = notes
    if (status !== undefined) patch.status = status
    const result = await sbPatch(env, 'shopify_transfer_drafts_v2', `id=eq.${draft_id}`, patch)
    return { data: result?.[0] || null }
}

export async function handleDeleteDraft(req: Request, env: Env) {
    const url = new URL(req.url)
    const draft_id = url.searchParams.get('draft_id')
    if (!draft_id) return { error: 'draft_id requerido', status: 400 }
    await sbDelete(env, 'shopify_transfer_drafts_v2', `id=eq.${draft_id}`)
    return { data: { deleted: true } }
}

export async function handleCommitDraft(req: Request, env: Env) {
    const body = await req.json()
    const { draft_id, auto_validate } = body as any
    if (!draft_id) return { error: 'draft_id requerido', status: 400 }

    const drafts = await sbSelect(env, 'shopify_transfer_drafts_v2', `id=eq.${draft_id}&select=*`)
    const draft = drafts?.[0]
    if (!draft) return { error: 'Draft no encontrado', status: 404 }
    if (draft.status !== 'pending') return { error: 'Draft ya procesado', status: 400 }

    const transfer = await sbGetTransfer(env, draft.transfer_id)
    if (!transfer) return { error: 'Transfer padre no encontrado', status: 404 }

    const lines: any[] = Array.isArray(draft.lines) ? draft.lines : []
    if (!lines.length) return { error: 'Draft sin líneas', status: 400 }

    // Resolve variants in Shopify
    const codes = lines.map((l: any) => String(l.code || l.barcode || '').trim())
    const varMap = await resolveVariantsBatch(env, codes)

    // Validate stock if needed
    const originCode = draft.origin_code || transfer.origin_location
    const destCode = draft.dest_code || transfer.dest_location
    const originGid = draft.origin_shopify_location_id || await getShopifyLocationGid(env, originCode)
    const destGid = draft.dest_shopify_location_id || await getShopifyLocationGid(env, destCode)

    // Create Shopify transfer
    const lineItems = lines.map((ln: any) => {
        const code = String(ln.code || ln.barcode || '').trim()
        const v = varMap.get(code)
        if (!v) return null
        return { inventoryItemId: v.inventoryItem.id, quantity: Number(ln.qty || 1) }
    }).filter(Boolean)

    if (!lineItems.length) return { error: 'No se pudieron resolver variantes en Shopify', status: 400 }

    const mutation = `mutation($input: InventoryTransferCreateInput!) { inventoryTransferCreate(input: $input) { inventoryTransfer { id name status } userErrors { field message } } }`
    const data = await shopifyGraphQL(env, mutation, { input: { originLocationId: originGid, destinationLocationId: destGid, lineItems } })
    const shopifyTransfer = data?.inventoryTransferCreate?.inventoryTransfer
    const errors = data?.inventoryTransferCreate?.userErrors
    if (errors?.length) throw new Error(`Shopify userErrors: ${JSON.stringify(errors)}`)

    // Update draft + transfer
    await sbPatch(env, 'shopify_transfer_drafts_v2', `id=eq.${draft_id}`, { status: 'committed', shopify_transfer_id: shopifyTransfer?.id || null })
    if (shopifyTransfer) {
        await sbPatch(env, 'transfer_summary_v2', `id=eq.${draft.transfer_id}`, { shopify_transfer_id: shopifyTransfer.id, shopify_status: shopifyTransfer.status || 'pending' })
    }
    await sbLog(env, draft.transfer_id, 'draft_committed', { draft_id, shopifyTransferId: shopifyTransfer?.id })

    return { data: { draft_id, shopify: shopifyTransfer } }
}
