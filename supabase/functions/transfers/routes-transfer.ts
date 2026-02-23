// Route handlers for transfer creation and reception
// FLOW:
//   POST /  → handleCreateTransfer  → saves to Supabase as status='pending' (no Odoo yet)
//   POST /receive → handleReceiveTransfer → creates Odoo picking as done with final quantities
// Shopify is NOT involved here. Odoo syncs Shopify inventory automatically via its own connector.

// Odoo location ID for "Traslado interno a Kroni"
// (Physical Locations/Inter-warehouse transit/Traslado interno a Kroni)
// Source: Odoo stock.location id=43 — update here if the location is ever recreated in Odoo
const KRONI_TRANSIT_LOC_ID = 43

import { type Env, getOwner } from './helpers.ts'
import { validatePicking, createOdooPickingFromLines, findProductsByCodes, findLocationIdByCompleteName, getStockAtLocation } from './odoo.ts'
import { syncShopifyTransfer, adjustShopifyPlantaInventory } from './shopify.ts'
import {
    sbInsert, sbUpsertForecastingTodayStrict,
    sbGetLocation, sbGetByClientTransferId, sbGetTransferById,
    sbUpdateTransferById, sbLogTransfer, resolveBox,
} from './supabase-helpers.ts'

// ── POST / — Create transfer order (pending, no Odoo yet) ─────────────────────
export async function handleCreateTransfer(req: Request, env: Env) {
    const body = await req.json()
    const { origin_id, dest_id, lines, client_transfer_id, kroni_transit } = body as any
    if (!origin_id || !dest_id || !Array.isArray(lines) || !lines.length)
        return { error: 'origin_id, dest_id y lines son requeridos', status: 400 }

    // Validate locations
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

    // Expand box barcodes
    const expandedLines: Array<{ barcode: string; sku: string; qty: number; box_barcode?: string }> = []
    for (const ln of lines) {
        const rawBarcode = String(ln.code || ln.barcode || '').trim()
        const qty = Number(ln.qty || 1)
        const box = await resolveBox(env, rawBarcode)
        if (box) {
            expandedLines.push({ barcode: box.sku, sku: box.sku, qty: box.qty_per_box * qty, box_barcode: rawBarcode })
        } else {
            expandedLines.push({ barcode: rawBarcode, sku: rawBarcode, qty })
        }
    }

    // ── Stock availability check (Odoo stock.quant) ──────────────────────────
    // Aggregate requested qty per SKU (expandedLines may have dupes if same SKU
    // came both as a box barcode and as a raw SKU scan)
    const requestedBySku = new Map<string, number>()
    for (const ln of expandedLines) {
        requestedBySku.set(ln.sku, (requestedBySku.get(ln.sku) || 0) + ln.qty)
    }

    try {
        // Resolve Odoo product IDs and origin location ID in parallel
        const skus = [...requestedBySku.keys()]
        const [prodMap, originLocId] = await Promise.all([
            findProductsByCodes(env, skus),
            findLocationIdByCompleteName(env, originLoc.odoo_location_code),
        ])

        const productIds = skus.map(s => prodMap.get(s)?.id).filter((id): id is number => id != null)
        const stockMap = await getStockAtLocation(env, productIds, originLocId)

        // Build a reverse map: productId → sku (to look up requested qty)
        const prodIdToSku = new Map<number, string>()
        for (const sku of skus) {
            const prod = prodMap.get(sku)
            if (prod && !prodIdToSku.has(prod.id)) prodIdToSku.set(prod.id, sku)
        }

        const insufficient: Array<{ code: string; requested: number; available: number }> = []
        for (const [prodId, available] of stockMap) {
            const sku = prodIdToSku.get(prodId)
            if (!sku) continue
            const requested = requestedBySku.get(sku) || 0
            if (requested > available) {
                insufficient.push({ code: sku, requested, available })
            }
        }
        // Also flag SKUs with no quant record at all (available = 0)
        for (const sku of skus) {
            const prod = prodMap.get(sku)
            if (!prod) continue
            if (!stockMap.has(prod.id)) {
                const requested = requestedBySku.get(sku) || 0
                if (requested > 0) insufficient.push({ code: sku, requested, available: 0 })
            }
        }

        if (insufficient.length > 0) {
            // Use `data` (not `error`) so index.ts serializes the full object.
            // The frontend detects this via r.status === 409 || data.kind === 'insufficient'.
            return {
                status: 409,
                data: { kind: 'insufficient', origin: origin_id, insufficient, error: 'Stock insuficiente en origen' },
            }
        }
    } catch (e: any) {
        // Stock check failure is non-blocking — log and continue (Odoo may be unreachable)
        console.error('Stock check failed (non-blocking):', e?.message || e)
    }

    // Persist to Supabase — status='pending', Odoo picking created later at reception
    const transferId = crypto.randomUUID()
    await sbInsert(env, 'transfers', [{
        id: transferId,
        client_transfer_id: client_transfer_id || null,
        origin_id,
        dest_id,
        odoo_picking_id: null,
        picking_name: null,
        shopify_transfer_id: null,
        status: 'pending',
        draft_owner: getOwner(req),
    }])

    // Persist lines
    const toPersistLines = expandedLines.map(ln => ({
        transfer_id: transferId,
        barcode: ln.barcode,
        sku: ln.sku,
        qty: ln.qty,
        box_barcode: ln.box_barcode || null,
    }))
    try { await sbInsert(env, 'transfer_lines', toPersistLines) } catch { }

    await sbLogTransfer(env, transferId, 'transfer_created', {
        origin_id,
        dest_id,
        lines: expandedLines.length,
        total_qty: expandedLines.reduce((a, b) => a + b.qty, 0),
    })

    // KRONI forecasting update (immediate in-transit projection)
    if (kroni_transit) {
        const kroniShopifyLocId = env.SHOPIFY_KRONI_LOCATION_ID
        if (kroniShopifyLocId) {
            const items = expandedLines.map(ln => ({
                sku: ln.sku,
                location_id: Number(kroniShopifyLocId),
                in_transit_units: ln.qty,
            }))
            try { await sbUpsertForecastingTodayStrict(env, items) } catch (e: any) {
                await sbLogTransfer(env, transferId, 'forecast_error', { error: (e as Error).message })
            }
        }
    }

    return {
        data: {
            transfer: {
                id: transferId,
                status: 'pending',
                origin_id,
                dest_id,
                lines: expandedLines.length,
                total_qty: expandedLines.reduce((a, b) => a + b.qty, 0),
            },
            message: 'Orden de transferencia creada. Pendiente de recepción en destino.',
        },
    }
}

// ── POST /receive — Confirm reception with final quantities → create Odoo picking ──
// Called by the receiver at the destination. Lines may differ from original order:
// - quantities can be adjusted (partial receipt)
// - lines can be added (extra items received)
// - lines can be omitted (items not received)
export async function handleReceiveTransfer(req: Request, env: Env) {
    const body = await req.json()
    const { transfer_id, lines } = body as any

    if (!transfer_id) return { error: 'transfer_id requerido', status: 400 }
    if (!Array.isArray(lines) || !lines.length) return { error: 'lines requerido con al menos un item', status: 400 }

    // Load transfer
    const t = await sbGetTransferById(env, transfer_id)
    if (!t) return { error: 'Transfer no encontrado', status: 404 }
    if (t.status === 'validated') return { error: 'Este transfer ya fue recibido', status: 400 }
    if (t.status === 'cancelled') return { error: 'Este transfer fue cancelado', status: 400 }

    // Build final lines map: sku/barcode → qty (from receiver's input)
    const linesBySku = new Map<string, number>()
    for (const ln of lines) {
        const code = String(ln.sku || ln.barcode || ln.code || '').trim()
        const qty = Number(ln.qty || 0)
        if (!code || qty <= 0) continue
        linesBySku.set(code, (linesBySku.get(code) || 0) + qty)
    }

    if (linesBySku.size === 0) return { error: 'No hay cantidades válidas en las líneas', status: 400 }

    // ── KRONI special case ─────────────────────────────────────────────────────
    // Transfers to KRONI/Existencias must NOT create a Shopify inventory transfer
    // to the Tienda Online location — ARGUS (Kroni's system) governs that location
    // and would immediately overwrite any changes. Instead:
    //   - Odoo picking goes to the transit location (KRONI_TRANSIT_LOC_ID = 43)
    //   - Shopify only gets a stock decrement on Planta Productora
    const isKroni = t.dest_id === 'KRONI/Existencias'

    // Create Odoo picking as done with FINAL received quantities
    let pickingId: number
    let pickingName: string
    let finalState: string

    try {
        const result = await createOdooPickingFromLines(
            env,
            t.origin_id,
            t.dest_id,
            linesBySku,
            `transfer/${transfer_id}`,
            transfer_id,
            sbLogTransfer,
            isKroni ? KRONI_TRANSIT_LOC_ID : undefined, // bypass lookup — go direct to transit loc
        )
        pickingId = result.pickingId
        pickingName = result.pickingName
        finalState = result.finalState
    } catch (e: any) {
        await sbLogTransfer(env, transfer_id, 'odoo_error', { error: (e as Error).message })
        return { error: `Error creando picking en Odoo: ${(e as Error).message}`, status: 500 }
    }

    // ── Shopify inventory sync (non-blocking, fire & forget) ──────────────────
    // Resolve shopify_inventory_item_id for each SKU and build itemQtyMap
    try {
        const skus = [...linesBySku.keys()]
        const prodMap = await findProductsByCodes(env, skus)
        const itemQtyMap = new Map<number, number>()
        for (const [sku, qty] of linesBySku) {
            const prod = prodMap.get(sku)
            if (prod?.shopify_inventory_item_id) {
                itemQtyMap.set(
                    prod.shopify_inventory_item_id,
                    (itemQtyMap.get(prod.shopify_inventory_item_id) || 0) + qty,
                )
            }
        }
        if (itemQtyMap.size > 0) {
            if (isKroni) {
                // KRONI: only subtract from Planta Productora, do NOT create a Shopify transfer
                adjustShopifyPlantaInventory(
                    env,
                    itemQtyMap,
                    (event, data) => sbLogTransfer(env, transfer_id, event, data),
                    true, // negate=true → delta negativo (restamos de Planta)
                ).catch(e => console.error('Shopify planta adjust failed:', e?.message || e))
            } else {
                // Normal flow: full 5-step Shopify inventory transfer
                syncShopifyTransfer(
                    env,
                    t.origin_id,
                    t.dest_id,
                    itemQtyMap,
                    (event, data) => sbLogTransfer(env, transfer_id, event, data),
                ).catch(e => console.error('Shopify sync failed:', e?.message || e))
            }
        }
    } catch (e: any) {
        // Non-blocking — log but don't fail the reception
        console.error('Shopify sync setup failed:', e?.message || e)
        await sbLogTransfer(env, transfer_id, 'shopify_sync_error', { error: (e as Error).message })
    }

    // Update transfer record
    await sbUpdateTransferById(env, transfer_id, {
        odoo_picking_id: pickingId,
        picking_name: pickingName,
        status: 'validated',
    })

    await sbLogTransfer(env, transfer_id, 'transfer_received', {
        pickingId,
        pickingName,
        state: finalState,
        received_lines: linesBySku.size,
        total_qty: [...linesBySku.values()].reduce((a, b) => a + b, 0),
    })

    return {
        data: {
            transfer_id,
            picking_id: pickingId,
            picking_name: pickingName,
            state: finalState,
            message: `Picking ${pickingName} creado en Odoo (${finalState}).`,
        },
    }
}

// ── POST /cancel — Cancel a pending transfer (before reception) ───────────────
export async function handleCancelTransfer(req: Request, env: Env) {
    const body = await req.json()
    const { transfer_id } = body as any
    if (!transfer_id) return { error: 'transfer_id requerido', status: 400 }

    const t = await sbGetTransferById(env, transfer_id)
    if (!t) return { error: 'Transfer no encontrado', status: 404 }
    if (t.status === 'validated') return { error: 'No se puede cancelar un transfer ya recibido', status: 400 }
    if (t.status === 'cancelled') return { error: 'Transfer ya cancelado', status: 400 }

    await sbUpdateTransferById(env, transfer_id, { status: 'cancelled' })
    await sbLogTransfer(env, transfer_id, 'transfer_cancelled', { by: getOwner(req) })

    return { data: { transfer_id, status: 'cancelled', message: 'Transfer cancelado.' } }
}

// ── POST /validate — Manual validation fallback (kept for compatibility) ──────
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
        await sbLogTransfer(env, transfer_id, 'validated', { via: 'manual' })
    }
    return { data: { validated: ok } }
}
