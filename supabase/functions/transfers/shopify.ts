import { type Env, chunk, normCode, gidToLegacyId } from './helpers.ts'

export async function shopifyGraphQL(env: Env, query: string, variables?: Record<string, any>) {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) throw new Error('Shopify no configurado')
    const ver = String(env.SHOPIFY_API_VERSION || '2023-10')
    const url = `https://${env.SHOPIFY_DOMAIN}/admin/api/${ver}/graphql.json`
    const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN }, body: JSON.stringify({ query, variables }) })
    const data: any = await resp.json().catch(() => ({}))
    if (!resp.ok || data.errors) throw new Error(`Shopify error: ${JSON.stringify(data.errors || data)}`)
    return data.data
}

export async function shopifyRest(env: Env, path: string, params?: Record<string, any>, method: 'GET' | 'POST' = 'GET', body?: Record<string, any>) {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) throw new Error('Shopify no configurado')
    const ver = String(env.SHOPIFY_API_VERSION || '2023-10')
    let url = `https://${env.SHOPIFY_DOMAIN}/admin/api/${ver}${path}`
    if (method === 'GET' && params) {
        const usp = new URLSearchParams()
        for (const [k, v] of Object.entries(params)) if (v != null && v !== '') usp.set(k, String(v))
        if (usp.toString()) url += `?${usp}`
    }
    const r = await fetch(url, {
        method,
        headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN, 'content-type': 'application/json' },
        ...(method === 'POST' && body ? { body: JSON.stringify(body) } : {}),
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`Shopify REST error: ${r.status} ${JSON.stringify(data)}`)
    return data
}

export async function shopifyGraphQLWithVersion(env: Env, apiVersion: string, query: string, variables?: Record<string, any>) {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) throw new Error('Shopify no configurado')
    const ver = String(apiVersion || env.SHOPIFY_API_VERSION || '2023-10')
    const url = `https://${env.SHOPIFY_DOMAIN}/admin/api/${ver}/graphql.json`
    const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN }, body: JSON.stringify({ query, variables }) })
    const data: any = await resp.json().catch(() => ({}))
    return { ok: resp.ok && !(data && data.errors), raw: data, status: resp.status }
}

export async function getShopifyLocationGid(env: Env, code: string) {
    if (code === 'P-CON/Existencias' && env.SHOPIFY_CONQUISTA_LOCATION_ID) {
        const id = env.SHOPIFY_CONQUISTA_LOCATION_ID
        return String(id).startsWith('gid://') ? id : `gid://shopify/Location/${id}`
    }
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_locations?code=eq.${encodeURIComponent(code)}&select=shopify_location_id`, { method: 'GET', headers: { 'content-type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}` } })
    if (!r.ok) throw new Error(await r.text())
    const rows: any[] = await r.json()
    const id = rows?.[0]?.shopify_location_id
    if (!id) throw new Error(`Falta shopify_location_id para ubicación ${code}`)
    return String(id).startsWith('gid://') ? id : `gid://shopify/Location/${id}`
}

export async function resolveVariantByCode(env: Env, code: string) {
    const q = `query($q:String!){ productVariants(first:1, query:$q){ edges { node { id sku barcode inventoryItem{ id } } } } }`
    const data = await shopifyGraphQL(env, q, { q: `barcode:${code} OR sku:${code}` })
    return data?.productVariants?.edges?.[0]?.node || null
}

export async function resolveVariantsBatch(env: Env, codesIn: string[]) {
    const codes = Array.from(new Set(codesIn.map(normCode).filter(Boolean)))
    const map = new Map<string, any>()
    for (const part of chunk(codes, 40)) {
        const orTerms = part.map(c => `(barcode:"${c}" OR sku:"${c}")`).join(' OR ')
        const q = `query{ productVariants(first:250, query: ${JSON.stringify(orTerms)}) { edges { node { id sku barcode inventoryItem { id } } } } }`
        const data = await shopifyGraphQL(env, q)
        const edges = data?.productVariants?.edges || []
        for (const e of edges) {
            const node = e?.node; if (!node) continue
            const sku = normCode(node.sku), bc = normCode(node.barcode)
            if (sku && !map.has(sku)) map.set(sku, node)
            if (bc && !map.has(bc)) map.set(bc, node)
        }
    }
    return map
}

export async function getAvailableAtLocation(env: Env, inventoryItemGid: string, locationGid: string) {
    const itemId = gidToLegacyId(inventoryItemGid), locId = gidToLegacyId(locationGid)
    const data = await shopifyRest(env, '/inventory_levels.json', { inventory_item_ids: itemId, location_ids: locId })
    const lvl = Array.isArray(data?.inventory_levels) ? data.inventory_levels[0] : null
    return Number(lvl?.available ?? 0)
}

// ── Mapeo fijo: odoo_location_code → Shopify location GID ───────────────────
// Fuente: tabla transfer_locations en Supabase (shopify_id)
const ODOO_TO_SHOPIFY_LOCATION_GID: Record<string, string> = {
    'WH/Existencias':    'gid://shopify/Location/103584596280',  // Planta Productora
    'KRONI/Existencias': 'gid://shopify/Location/98632499512',   // Kroni
    'P-CEI/Existencias': 'gid://shopify/Location/107414356280',  // La Ceiba - Culiacán
    'P-CON/Existencias': 'gid://shopify/Location/80271802680',   // La Conquista - Culiacán
}

// ── Crea una transferencia formal en Shopify y la valida (RECEIVED) ──────────
// Usa inventoryTransferCreate (GraphQL 2024-04+) para máxima trazabilidad.
// inventoryItemQtyMap: shopify_inventory_item_id (numérico) → qty movida
// Non-blocking por diseño: los errores se loguean pero no bloquean la transfer de Odoo.
export async function syncShopifyTransfer(
    env: Env,
    originOdooCode: string,
    destOdooCode: string,
    inventoryItemQtyMap: Map<number, number>,
    logFn?: (event: string, data: any) => Promise<void>,
): Promise<{ synced: number; skipped: number }> {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) {
        await logFn?.('shopify_sync_skipped', { reason: 'no_credentials' })
        return { synced: 0, skipped: inventoryItemQtyMap.size }
    }

    const originLocGid = ODOO_TO_SHOPIFY_LOCATION_GID[originOdooCode]
    const destLocGid   = ODOO_TO_SHOPIFY_LOCATION_GID[destOdooCode]

    if (!originLocGid || !destLocGid) {
        await logFn?.('shopify_sync_skipped', { reason: 'location_not_mapped', originOdooCode, destOdooCode })
        return { synced: 0, skipped: inventoryItemQtyMap.size }
    }

    // Build line items — one per inventory item
    const lineItems: Array<{ inventoryItemId: string; quantity: number }> = []
    for (const [inventoryItemId, qty] of inventoryItemQtyMap) {
        if (qty <= 0) continue
        lineItems.push({
            inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
            quantity: qty,
        })
    }

    if (!lineItems.length) {
        await logFn?.('shopify_sync_skipped', { reason: 'no_valid_items' })
        return { synced: 0, skipped: inventoryItemQtyMap.size }
    }

    // Determine API version — inventoryTransferCreate requires 2024-04+
    const apiVersion = (() => {
        const ver = String(env.SHOPIFY_API_VERSION || '2024-04')
        // If version is older than 2024-04, upgrade to 2024-04
        const num = ver.replace('-', '')
        return num >= '202404' ? ver : '2024-04'
    })()

    // ── Step 1: Create the transfer (status = DRAFT) ──────────────────────────
    const createMutation = `
        mutation inventoryTransferCreate($input: InventoryTransferCreateInput!) {
            inventoryTransferCreate(input: $input) {
                inventoryTransfer {
                    id
                    status
                }
                userErrors {
                    field
                    message
                }
            }
        }`

    const createVars = {
        input: {
            originLocationId: originLocGid,
            destinationLocationId: destLocGid,
            lineItems,
        },
    }

    const createResult = await shopifyGraphQLWithVersion(env, apiVersion, createMutation, createVars)

    if (!createResult.ok) {
        const errs = createResult.raw?.data?.inventoryTransferCreate?.userErrors
            || createResult.raw?.errors
            || createResult.raw
        throw new Error(`inventoryTransferCreate failed: ${JSON.stringify(errs)}`)
    }

    const transferGid: string = createResult.raw?.data?.inventoryTransferCreate?.inventoryTransfer?.id
    if (!transferGid) throw new Error('inventoryTransferCreate devolvió id vacío')

    await logFn?.('shopify_transfer_created', { transferGid, lineItems: lineItems.length })

    // ── Step 2: Mark as ready to ship ────────────────────────────────────────
    const readyMutation = `
        mutation inventoryTransferMarkAsReadyToShip($id: ID!) {
            inventoryTransferMarkAsReadyToShip(id: $id) {
                inventoryTransfer { id status }
                userErrors { field message }
            }
        }`

    const readyResult = await shopifyGraphQLWithVersion(env, apiVersion, readyMutation, { id: transferGid })
    if (!readyResult.ok) {
        const errs = readyResult.raw?.data?.inventoryTransferMarkAsReadyToShip?.userErrors || readyResult.raw?.errors
        await logFn?.('shopify_transfer_ready_error', { transferGid, error: JSON.stringify(errs) })
        // Continue anyway — try to create shipment
    }

    // ── Step 3: Create shipment (in-transit) ─────────────────────────────────
    // inventoryShipmentCreate uses movementId (the transfer GID) + lineItems
    // We also fetch lineItems.edges.node.id so we can use shipmentLineItemId in Step 4
    const shipmentMutation = `
        mutation inventoryShipmentCreate($input: InventoryShipmentCreateInput!) {
            inventoryShipmentCreate(input: $input) {
                inventoryShipment {
                    id
                    lineItems(first: 250) {
                        edges { node { id quantity } }
                    }
                }
                userErrors { field message }
            }
        }`

    const shipmentResult = await shopifyGraphQLWithVersion(env, apiVersion, shipmentMutation, {
        input: {
            movementId: transferGid,
            lineItems: lineItems.map(li => ({ inventoryItemId: li.inventoryItemId, quantity: li.quantity })),
        },
    })

    const shipmentGid: string | null = shipmentResult.raw?.data?.inventoryShipmentCreate?.inventoryShipment?.id || null
    if (!shipmentResult.ok || !shipmentGid) {
        const errs = shipmentResult.raw?.data?.inventoryShipmentCreate?.userErrors || shipmentResult.raw?.errors
        await logFn?.('shopify_shipment_create_error', { transferGid, error: JSON.stringify(errs) })
        // Log and stop — can't receive without a shipment ID
        await logFn?.('shopify_sync_done', { originOdooCode, destOdooCode, transferGid, finalStatus: 'ready_to_ship', synced: lineItems.length, skipped: inventoryItemQtyMap.size - lineItems.length })
        return { synced: lineItems.length, skipped: inventoryItemQtyMap.size - lineItems.length }
    }

    // Extract shipment line item IDs returned by the create mutation
    const shipmentLineItemEdges: Array<{ node: { id: string; quantity: number } }> =
        shipmentResult.raw?.data?.inventoryShipmentCreate?.inventoryShipment?.lineItems?.edges || []

    await logFn?.('shopify_shipment_created', {
        shipmentGid,
        lineItemCount: shipmentLineItemEdges.length,
        lineItemIds: shipmentLineItemEdges.map((e: any) => e.node.id),
    })

    // ── Step 3.5: Mark shipment as IN_TRANSIT ─────────────────────────────────
    // inventoryShipmentCreate always creates in DRAFT status.
    // Must call inventoryShipmentMarkInTransit before receiving.
    const markInTransitMutation = `mutation { inventoryShipmentMarkInTransit(id: "${shipmentGid}") { inventoryShipment { id status } userErrors { field message } } }`
    const inTransitResult = await shopifyGraphQLWithVersion(env, apiVersion, markInTransitMutation)
    if (!inTransitResult.ok) {
        const errs = inTransitResult.raw?.data?.inventoryShipmentMarkInTransit?.userErrors || inTransitResult.raw?.errors
        await logFn?.('shopify_shipment_in_transit_error', { shipmentGid, error: JSON.stringify(errs) })
        // Continue anyway — attempt receive regardless
    } else {
        await logFn?.('shopify_shipment_in_transit', { shipmentGid, status: inTransitResult.raw?.data?.inventoryShipmentMarkInTransit?.inventoryShipment?.status })
    }

    // ── Step 4: Receive the shipment (RECEIVED) ───────────────────────────────
    // Use inline GraphQL (enum literals not wrapped in JSON variables) to avoid
    // enum serialization issues. Variables send strings; inline sends unquoted enum values.
    let receiveResult: any

    if (shipmentLineItemEdges.length > 0) {
        // Build inline mutation with enum literal ACCEPTED (no quotes around enum value)
        const lineItemsGql = shipmentLineItemEdges
            .map((e: any) => `{ shipmentLineItemId: "${e.node.id}", quantity: ${e.node.quantity}, reason: ACCEPTED }`)
            .join(', ')
        const receiveMutation = `mutation { inventoryShipmentReceive(id: "${shipmentGid}", lineItems: [${lineItemsGql}]) { inventoryShipment { id status } userErrors { field message } } }`
        receiveResult = await shopifyGraphQLWithVersion(env, apiVersion, receiveMutation)
    } else {
        // Fallback: bulk accept all items if line item IDs unavailable
        const receiveMutation = `mutation { inventoryShipmentReceive(id: "${shipmentGid}", bulkReceiveAction: ACCEPTED) { inventoryShipment { id status } userErrors { field message } } }`
        receiveResult = await shopifyGraphQLWithVersion(env, apiVersion, receiveMutation)
    }

    const receiveErrs = receiveResult.raw?.data?.inventoryShipmentReceive?.userErrors
    if (!receiveResult.ok || receiveErrs?.length) {
        await logFn?.('shopify_transfer_receive_error', {
            shipmentGid,
            error: JSON.stringify(receiveErrs || receiveResult.raw?.errors),
            rawResponse: JSON.stringify(receiveResult.raw),
        })
    }

    const finalStatus: string = receiveResult.raw?.data?.inventoryShipmentReceive?.inventoryShipment?.status || 'unknown'

    await logFn?.('shopify_sync_done', {
        originOdooCode,
        destOdooCode,
        transferGid,
        shipmentGid,
        finalStatus,
        synced: lineItems.length,
        skipped: inventoryItemQtyMap.size - lineItems.length,
    })

    return { synced: lineItems.length, skipped: inventoryItemQtyMap.size - lineItems.length }
}

// ── Ajusta inventario de Planta Productora en Shopify (sin crear transfer) ────
// Usado cuando el destino es KRONI: no queremos una transfer a la Tienda Online
// (ARGUS la sobreescribiría), solo restamos de Planta. También se usa desde el
// endpoint manual POST /shopify/adjust-planta para sincronizar producciones.
//
// negate=true  (default): invierte el signo de qty → resta de Planta (caso KRONI)
// negate=false: usa qty tal cual como delta → suma/resta según el caller (ajuste manual)
export async function adjustShopifyPlantaInventory(
    env: Env,
    inventoryItemQtyMap: Map<number, number>,
    logFn?: (event: string, data: any) => Promise<void>,
    negate = true,
): Promise<void> {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) {
        await logFn?.('shopify_planta_adjust_skipped', { reason: 'no_credentials' })
        return
    }

    const plantaGid = ODOO_TO_SHOPIFY_LOCATION_GID['WH/Existencias']

    const changes: Array<{ inventoryItemGid: string; delta: number }> = []
    for (const [itemId, qty] of inventoryItemQtyMap) {
        if (qty === 0) continue
        const delta = negate ? -Math.abs(qty) : qty
        changes.push({ inventoryItemGid: `gid://shopify/InventoryItem/${itemId}`, delta })
    }

    if (!changes.length) return

    const apiVersion = (() => {
        const ver = String(env.SHOPIFY_API_VERSION || '2024-04')
        const num = ver.replace('-', '')
        return num >= '202404' ? ver : '2024-04'
    })()

    // Inline mutation — avoids variable serialization quirks with numeric deltas
    const changesGql = changes
        .map(c => `{ inventoryItemId: "${c.inventoryItemGid}", locationId: "${plantaGid}", delta: ${c.delta} }`)
        .join(', ')

    const mutation = `mutation {
        inventoryAdjustQuantities(input: {
            reason: "correction",
            name: "available",
            changes: [${changesGql}]
        }) {
            userErrors { field message }
        }
    }`

    const result = await shopifyGraphQLWithVersion(env, apiVersion, mutation)
    const errs = result.raw?.data?.inventoryAdjustQuantities?.userErrors

    if (!result.ok || errs?.length) {
        await logFn?.('shopify_planta_adjust_error', {
            error: JSON.stringify(errs || result.raw?.errors),
            changes: changes.length,
        })
    } else {
        await logFn?.('shopify_planta_adjusted', {
            changes: changes.length,
            negate,
        })
    }
}
