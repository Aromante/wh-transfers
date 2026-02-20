// Route handlers for transfer creation / validation / Shopify replication
import { type Env, boolFlag, getOwner } from './helpers.ts'
import { odooExecuteKw, findInternalPickingType, findLocationIdByCompleteName, findProductsByCodes, validatePicking, odooRead, odooCreate } from './odoo.ts'
import {
    sbInsert, sbUpsertForecastingTodayStrict,
    sbGetLocation, sbGetByClientTransferId, sbGetTransferById,
    sbUpdateTransferById, sbLogTransfer, resolveBox, type LocationRow,
} from './supabase-helpers.ts'
import { shopifyGraphQL, shopifyGraphQLWithVersion, resolveVariantsBatch } from './shopify.ts'

export async function handleCreateTransfer(req: Request, env: Env) {
    const body = await req.json()
    const { origin_id, dest_id, lines, shopify_replicate, auto_validate, client_transfer_id, kroni_transit } = body as any
    if (!origin_id || !dest_id || !Array.isArray(lines) || !lines.length)
        return { error: 'origin_id, dest_id y lines son requeridos', status: 400 }

    // Validate locations from DB (no hardcodes)
    const [originLoc, destLoc] = await Promise.all([
        sbGetLocation(env, origin_id),
        sbGetLocation(env, dest_id),
    ])
    if (!originLoc) return { error: `Ubicación de origen no encontrada: ${origin_id}`, status: 400 }
    if (!destLoc) return { error: `Ubicación de destino no encontrada: ${dest_id}`, status: 400 }
    if (!originLoc.can_be_origin) return { error: `${origin_id} no puede ser origen`, status: 400 }
    if (!destLoc.can_be_destination) return { error: `${dest_id} no puede ser destino`, status: 400 }

    // Dedupe check
    if (client_transfer_id) {
        const existing = await sbGetByClientTransferId(env, client_transfer_id)
        if (Array.isArray(existing) && existing.length)
            return { data: { transfer: existing[0], duplicate: true } }
    }

    // ── Expand box barcodes into product lines ──
    // Each line may have a box barcode (e.g. BOXS_ABUINF_30) or a direct product barcode/SKU
    const expandedLines: Array<{ barcode: string; sku: string; qty: number; box_barcode?: string }> = []
    for (const ln of lines) {
        const rawBarcode = String(ln.code || ln.barcode || '').trim()
        const qty = Number(ln.qty || 1)
        const box = await resolveBox(env, rawBarcode)
        if (box) {
            // Box scan → expand to product line using box.sku and box.qty_per_box
            expandedLines.push({
                barcode: box.sku,  // use SKU as the product lookup code
                sku: box.sku,
                qty: box.qty_per_box * qty,
                box_barcode: rawBarcode,
            })
        } else {
            // Direct product scan
            expandedLines.push({ barcode: rawBarcode, sku: rawBarcode, qty })
        }
    }

    // Resolve products in Odoo
    const codes = expandedLines.map(l => l.barcode).filter(Boolean)
    const prodMap = await findProductsByCodes(env, codes)
    const pickingTypeId = await findInternalPickingType(env)
    const originLocId = await findLocationIdByCompleteName(env, origin_id)
    const destLocId = await findLocationIdByCompleteName(env, dest_id)

    // Build enrichment map: code → { name, id, uom_name }
    type ProdEnrich = { id: number; name: string; uom_name: string }
    const enrichMap = new Map<string, ProdEnrich>()

    const moveLines = expandedLines.map(ln => {
        const prod = prodMap.get(ln.barcode)
        if (!prod) throw new Error(`Producto no encontrado en Odoo: ${ln.barcode}`)
        enrichMap.set(ln.barcode, {
            id: prod.id,
            name: String(prod.name),
            uom_name: String(prod.uom_name || prod.uom_id?.[1] || ''),
        })
        return [0, 0, {
            product_id: prod.id,
            product_uom: prod.uom_id,
            product_uom_qty: Number(ln.qty),
            name: prod.name,
            location_id: originLocId,
            location_dest_id: destLocId,
        }]
    })

    const pickingId = await odooCreate(env, 'stock.picking', {
        picking_type_id: pickingTypeId, location_id: originLocId, location_dest_id: destLocId,
        move_ids_without_package: moveLines, origin: client_transfer_id || undefined,
    })
    const pickRows = await odooRead(env, 'stock.picking', [pickingId], ['name', 'state'])
    const pickingName = pickRows?.[0]?.name || ''
    const pickingState = pickRows?.[0]?.state || 'draft'

    // Confirm picking
    try { await odooExecuteKw(env, 'stock.picking', 'action_confirm', [[pickingId]]) } catch { }

    // Auto-validate
    let finalState = pickingState
    if (boolFlag(auto_validate ?? env.ODOO_AUTO_VALIDATE, false)) {
        try {
            const ok = await validatePicking(env, pickingId)
            if (ok) finalState = 'done'
        } catch { }
    }

    // Persist to Supabase (real tables: transfers + transfer_lines)
    const transferId = crypto.randomUUID()
    await sbInsert(env, 'transfers', [{
        id: transferId,
        client_transfer_id: client_transfer_id || null,
        origin_id,
        dest_id,
        odoo_picking_id: pickingId,
        picking_name: pickingName,
        status: finalState === 'done' ? 'validated' : 'pending',
        draft_owner: getOwner(req),
    }])

    // Persist lines with enrichment from Odoo (product_name, odoo_product_id, uom_name, box_barcode)
    const toPersistLines = expandedLines.map(ln => {
        const enrich = enrichMap.get(ln.barcode)
        return {
            transfer_id: transferId,
            barcode: ln.barcode,
            sku: ln.sku,
            qty: ln.qty,
            product_name: enrich?.name || null,
            odoo_product_id: enrich?.id || null,
            uom_name: enrich?.uom_name || null,
            box_barcode: ln.box_barcode || null,
        }
    })
    try { await sbInsert(env, 'transfer_lines', toPersistLines) } catch { }
    await sbLogTransfer(env, transferId, 'odoo_created', { pickingId, pickingName, state: pickingState })

    // KRONI transit (when dest is KRONI, create transit picking in Odoo)
    if (destLoc.can_be_destination && kroni_transit) {
        try { await handleKroniTransit(env, transferId, expandedLines, enrichMap, prodMap) } catch (e: any) {
            await sbLogTransfer(env, transferId, 'kroni_transit_error', { error: e.message })
        }
    }

    // Shopify replication
    const doShopify = boolFlag(shopify_replicate ?? env.SHOPIFY_REPLICATE_TRANSFERS, false)
    let shopifyResult: any = null
    if (doShopify && env.SHOPIFY_DOMAIN && env.SHOPIFY_ACCESS_TOKEN) {
        try {
            shopifyResult = await replicateToShopify(env, transferId, originLoc, destLoc, expandedLines, enrichMap)
        } catch (e: any) {
            await sbLogTransfer(env, transferId, 'shopify_error', { error: e.message })
        }
    }

    return { data: { transfer: { id: transferId, pickingId, pickingName, state: finalState }, shopify: shopifyResult } }
}

async function handleKroniTransit(env: Env, transferId: string, lines: any[], enrichMap: Map<string, { id: number; name: string; uom_name: string }>, prodMap: Map<string, any>) {
    const kroniLocName = env.ODOO_KRONI_TRANSIT_COMPLETE_NAME || 'KRONI/Tránsito'
    const kroniLocId = await findLocationIdByCompleteName(env, kroniLocName).catch(() => null)
    if (!kroniLocId) return
    const destKroni = await findLocationIdByCompleteName(env, 'KRONI/Existencias')
    const pickTypeId = await findInternalPickingType(env)
    const moveLines2 = lines.map((ln: any) => {
        const code = String(ln.barcode || '').trim()
        const prod = prodMap.get(code)
        if (!prod) return null
        return [0, 0, { product_id: prod.id, product_uom: prod.uom_id, product_uom_qty: Number(ln.qty || 1), name: prod.name, location_id: kroniLocId, location_dest_id: destKroni }]
    }).filter(Boolean)
    if (!moveLines2.length) return
    const pickingId2 = await odooCreate(env, 'stock.picking', { picking_type_id: pickTypeId, location_id: kroniLocId, location_dest_id: destKroni, move_ids_without_package: moveLines2 })
    try { await odooExecuteKw(env, 'stock.picking', 'action_confirm', [[pickingId2]]) } catch { }
    await sbLogTransfer(env, transferId, 'kroni_transit_created', { pickingId: pickingId2 })

    // Forecasting update
    const kroniShopifyLocId = env.SHOPIFY_KRONI_LOCATION_ID
    if (kroniShopifyLocId) {
        const items = lines.map((ln: any) => {
            const code = String(ln.barcode || '').trim()
            // Use SKU from the line (box-expanded lines already have sku = product SKU)
            return { sku: ln.sku || code, location_id: Number(kroniShopifyLocId), in_transit_units: Number(ln.qty || 1) }
        })
        try { await sbUpsertForecastingTodayStrict(env, items) } catch { }
    }
}

async function replicateToShopify(env: Env, transferId: string, originLoc: LocationRow, destLoc: LocationRow, lines: any[], enrichMap: Map<string, { id: number; name: string; uom_name: string }>) {
    // Use pre-resolved GIDs from LocationRow — no extra Shopify lookup needed
    const originGid = originLoc.gid
    const destGid = destLoc.gid
    // For Shopify, resolve by SKU (box-expanded lines already use sku = product SKU)
    const codes = lines.map((l: any) => String(l.sku || l.barcode || '').trim())
    const varMap = await resolveVariantsBatch(env, codes)

    const inputVariant = String(env.SHOPIFY_INPUT_VARIANT || 'inventoryTransferCreate')

    if (inputVariant === 'inventoryTransferCreate') {
        const lineItems = lines.map((ln: any) => {
            const code = String(ln.sku || ln.barcode || '').trim()
            const v = varMap.get(code)
            if (!v) return null
            return { inventoryItemId: v.inventoryItem.id, quantity: Number(ln.qty || 1) }
        }).filter(Boolean)
        if (!lineItems.length) return { skipped: true, reason: 'no variants resolved' }

        const mutation = `mutation($input: InventoryTransferCreateInput!) { inventoryTransferCreate(input: $input) { inventoryTransfer { id name status } userErrors { field message } } }`
        const variables = { input: { originLocationId: originGid, destinationLocationId: destGid, lineItems } }
        const data = await shopifyGraphQL(env, mutation, variables)
        const transfer = data?.inventoryTransferCreate?.inventoryTransfer
        const errors = data?.inventoryTransferCreate?.userErrors
        if (errors?.length) throw new Error(`Shopify userErrors: ${JSON.stringify(errors)}`)
        if (transfer) {
            await sbLogTransfer(env, transferId, 'shopify_created', { shopifyTransferId: transfer.id, shopifyStatus: transfer.status })
        }
        return transfer
    }

    // ── origin/destination variant (inventoryTransfer field mutation — "unstable" API) ──
    // This is the proven variant used by the Cloudflare worker for all production transfers.
    if (inputVariant === 'origin/destination') {
        const mutField = String(env.SHOPIFY_MUTATION_FIELD || 'inventoryTransfer')
        const apiVer = String(env.SHOPIFY_API_VERSION || 'unstable')

        const lineItems = lines.map((ln: any) => {
            const code = String(ln.sku || ln.barcode || '').trim()
            const v = varMap.get(code)
            if (!v) return null
            return { inventoryItemId: v.inventoryItem.id, quantity: Number(ln.qty || 1) }
        }).filter(Boolean)
        if (!lineItems.length) return { skipped: true, reason: 'no variants resolved' }

        const mutation = `mutation {
            ${mutField}(
                origin: { locationId: "${originGid}" }
                destination: { locationId: "${destGid}" }
                lineItems: [${lineItems.map((li: any) => `{ inventoryItemId: "${li.inventoryItemId}", quantity: ${li.quantity} }`).join(', ')}]
            ) {
                inventoryTransfer { id name status }
                userErrors { field message }
            }
        }`

        const result = await shopifyGraphQLWithVersion(env, apiVer, mutation)
        if (!result.ok) throw new Error(`Shopify error: ${JSON.stringify(result.raw?.errors || result.raw)}`)
        const transfer = result.raw?.data?.[mutField]?.inventoryTransfer
        const errors = result.raw?.data?.[mutField]?.userErrors
        if (errors?.length) throw new Error(`Shopify userErrors: ${JSON.stringify(errors)}`)
        if (transfer) {
            await sbLogTransfer(env, transferId, 'shopify_draft_created', {
                shopify_transfer_id: transfer.id,
                name: transfer.name,
                status: transfer.status,
                origin_gid: originGid,
                dest_gid: destGid,
                api_version: apiVer,
                input_variant: inputVariant,
                mutation: `${mutField}-field`,
            })
        }
        return transfer
    }

    return null
}

export async function handleValidateTransfer(req: Request, env: Env) {
    const body = await req.json()
    const { transfer_id } = body as any
    if (!transfer_id) return { error: 'transfer_id requerido', status: 400 }
    const t = await sbGetTransferById(env, transfer_id)
    if (!t) return { error: 'Transfer no encontrado', status: 404 }
    if (!t.odoo_picking_id) return { error: 'Sin picking de Odoo asociado', status: 400 }
    const ok = await validatePicking(env, t.odoo_picking_id)
    if (ok) {
        await sbUpdateTransferById(env, transfer_id, { status: 'validated' })
        await sbLogTransfer(env, transfer_id, 'validated', {})
    }
    return { data: { validated: ok } }
}
