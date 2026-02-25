// Route handlers for transfer creation and reception
// FLOW:
//   POST /  → handleCreateTransfer  → inserts lines to transfer_lines with status='pending'
//   POST /receive → handleReceiveTransfer → patches lines with odoo_transfer_id, shopify_transfer_id, status='validated'
// Shopify is NOT involved in creation. Odoo syncs Shopify inventory automatically via its own connector.

// Odoo location ID for "Traslado interno a Kroni"
// (Physical Locations/Inter-warehouse transit/Traslado interno a Kroni)
// Source: Odoo stock.location id=43 — update here if the location is ever recreated in Odoo
const KRONI_TRANSIT_LOC_ID = 43

import { type Env, getOwner } from './helpers.ts'
import { validatePicking, createOdooPickingFromLines, findProductsByCodes, getStockAtLocation } from './odoo.ts'
import { syncShopifyTransfer, adjustShopifyPlantaInventory } from './shopify.ts'
import {
    sbInsert,
    sbGetLocation, sbGetTransferById,
    sbUpdateTransferById, sbLogTransfer, resolveBox,
} from './supabase-helpers.ts'

// ── POST / — Create transfer order (pending, no Odoo yet) ─────────────────────
// The frontend generates transfer_id (UUID) before sending — duplicate requests
// will fail on PK conflict and return the existing record (idempotent).
export async function handleCreateTransfer(req: Request, env: Env) {
    const body = await req.json()
    const { transfer_id: clientTransferId, origin_id, dest_id, lines } = body as any
    if (!origin_id || !dest_id || !Array.isArray(lines) || !lines.length)
        return { error: 'origin_id, dest_id y lines son requeridos', status: 400 }

    // Use client-provided transfer_id for idempotency, or generate one
    const transferId: string = clientTransferId || crypto.randomUUID()

    // Validate locations
    const [originLoc, destLoc] = await Promise.all([
        sbGetLocation(env, origin_id),
        sbGetLocation(env, dest_id),
    ])
    if (!originLoc) return { error: `Ubicación de origen no encontrada: ${origin_id}`, status: 400 }
    if (!destLoc) return { error: `Ubicación de destino no encontrada: ${dest_id}`, status: 400 }
    if (!originLoc.can_be_origin) return { error: `${origin_id} no puede ser origen`, status: 400 }
    if (!destLoc.can_be_destination) return { error: `${dest_id} no puede ser destino`, status: 400 }

    // Expand box barcodes and resolve product names from Odoo
    const expandedLines: Array<{ sku: string; qty: number; product_name: string | null; box_barcode?: string }> = []
    for (const ln of lines) {
        const rawBarcode = String(ln.code || ln.barcode || ln.sku || '').trim()
        const qty = Number(ln.qty || 1)
        const box = await resolveBox(env, rawBarcode)
        if (box) {
            expandedLines.push({
                sku: box.sku,
                qty: box.qty_per_box * qty,
                product_name: box.product_name || box.label || null,
                box_barcode: rawBarcode,
            })
        } else {
            expandedLines.push({
                sku: rawBarcode,
                qty,
                product_name: ln.product_name || null, // caller may pass it from /resolve
                box_barcode: undefined,
            })
        }
    }

    // ── Stock availability check (Odoo stock.quant) ──────────────────────────
    const requestedBySku = new Map<string, number>()
    for (const ln of expandedLines) {
        requestedBySku.set(ln.sku, (requestedBySku.get(ln.sku) || 0) + ln.qty)
    }

    // Resolve product names from Odoo for any lines that don't already have one
    let prodMap: Map<string, { id: number; name: string; shopify_inventory_item_id: number | null }> = new Map()
    try {
        const skus = [...requestedBySku.keys()]
        const [resolvedProdMap] = await Promise.all([
            findProductsByCodes(env, skus),
        ])
        const originLocId = originLoc.odoo_id
        prodMap = resolvedProdMap

        // Fill in product_name for lines that don't have one
        for (const ln of expandedLines) {
            if (!ln.product_name) {
                const prod = prodMap.get(ln.sku)
                if (prod?.name) ln.product_name = prod.name
            }
        }

        const productIds = skus.map(s => prodMap.get(s)?.id).filter((id): id is number => id != null)
        const stockMap = await getStockAtLocation(env, productIds, originLocId)

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
        // Flag SKUs with no quant record at all (available = 0)
        for (const sku of skus) {
            const prod = prodMap.get(sku)
            if (!prod) continue
            if (!stockMap.has(prod.id)) {
                const requested = requestedBySku.get(sku) || 0
                if (requested > 0) insufficient.push({ code: sku, requested, available: 0 })
            }
        }

        if (insufficient.length > 0) {
            return {
                status: 409,
                data: { kind: 'insufficient', origin: origin_id, insufficient, error: 'Stock insuficiente en origen' },
            }
        }
    } catch (e: any) {
        // Stock check failure is non-blocking — log and continue (Odoo may be unreachable)
        console.error('Stock check failed (non-blocking):', e?.message || e)
    }

    // ── Single INSERT to transfer_lines — all header columns per line ──────────
    // This is the only write. transfer_summary VIEW derives everything from here.
    const now = new Date().toISOString()
    const toInsert = expandedLines.map(ln => ({
        transfer_id: transferId,
        origin_id,
        dest_id,
        origin_odoo_id: originLoc.odoo_id ?? null,
        dest_odoo_id: destLoc.odoo_id ?? null,
        origin_shopify_id: originLoc.shopify_id ?? null,
        dest_shopify_id: destLoc.shopify_id ?? null,
        status: 'pending',
        odoo_transfer_id: null,
        shopify_transfer_id: null,
        sku: ln.sku,
        qty: ln.qty,
        product_name: ln.product_name || null,
        box_barcode: ln.box_barcode || null,
        created_at: now,
    }))

    try {
        await sbInsert(env, 'transfer_lines', toInsert)
    } catch (e: any) {
        const msg = String(e?.message || '')
        // PK conflict → duplicate request, return existing record
        if (msg.includes('duplicate') || msg.includes('unique')) {
            const existing = await sbGetTransferById(env, transferId)
            if (existing) return { data: { transfer: existing, duplicate: true } }
        }
        throw e
    }

    await sbLogTransfer(env, transferId, 'transfer_created', {
        origin_id,
        dest_id,
        lines: expandedLines.length,
        total_qty: expandedLines.reduce((a, b) => a + b.qty, 0),
    })

    return {
        data: {
            transfer: {
                transfer_id: transferId,
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

    // Load transfer from summary view
    const t = await sbGetTransferById(env, transfer_id)
    if (!t) return { error: 'Transfer no encontrado', status: 404 }
    if (t.status === 'validated') return { error: 'Este transfer ya fue recibido', status: 400 }
    if (t.status === 'cancelled') return { error: 'Este transfer fue cancelado', status: 400 }

    // Build final lines map: sku → qty (from receiver's input)
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
            t.origin_odoo_id ?? undefined,
            isKroni ? KRONI_TRANSIT_LOC_ID : (t.dest_odoo_id ?? undefined),
        )
        pickingId = result.pickingId
        pickingName = result.pickingName
        finalState = result.finalState
    } catch (e: any) {
        await sbLogTransfer(env, transfer_id, 'odoo_error', { error: (e as Error).message })
        return { error: `Error creando picking en Odoo: ${(e as Error).message}`, status: 500 }
    }

    // ── Shopify inventory sync (non-blocking, fire & forget) ──────────────────
    let shopifyTransferId: string | null = null
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
                // shopify_transfer_id is captured via the log event 'shopify_transfer_created'
                // in the logFn callback — persist it from there for reliability
                syncShopifyTransfer(
                    env,
                    t.origin_id,
                    t.dest_id,
                    itemQtyMap,
                    async (event, data) => {
                        await sbLogTransfer(env, transfer_id, event, data)
                        // Capture the Shopify transfer GID as soon as it's created
                        if (event === 'shopify_transfer_created' && data?.transferGid) {
                            sbUpdateTransferById(env, transfer_id, { shopify_transfer_id: data.transferGid })
                                .catch(e => console.error('Persist shopify_transfer_id failed:', e?.message || e))
                        }
                    },
                ).catch(e => console.error('Shopify sync failed:', e?.message || e))
            }
        }
    } catch (e: any) {
        console.error('Shopify sync setup failed:', e?.message || e)
        await sbLogTransfer(env, transfer_id, 'shopify_sync_error', { error: (e as Error).message })
    }

    // Patch all lines of this transfer: status + odoo_transfer_id
    await sbUpdateTransferById(env, transfer_id, {
        odoo_transfer_id: pickingName,
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
