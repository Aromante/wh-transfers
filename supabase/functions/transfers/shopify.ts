import { type Env, chunk, normCode, gidToLegacyId, fetchWithTimeout, deriveIdempotencyKey, sleep } from './helpers.ts'

const DEFAULT_API_VERSION = '2025-10'

export async function shopifyGraphQL(env: Env, query: string, variables?: Record<string, any>) {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) throw new Error('Shopify no configurado')
    const ver = String(env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION)
    const url = `https://${env.SHOPIFY_DOMAIN}/admin/api/${ver}/graphql.json`
    const resp = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN }, body: JSON.stringify({ query, variables }) })
    const data: any = await resp.json().catch(() => ({}))
    if (!resp.ok || data.errors) throw new Error(`Shopify error: ${JSON.stringify(data.errors || data)}`)
    return data.data
}

export async function shopifyRest(env: Env, path: string, params?: Record<string, any>, method: 'GET' | 'POST' = 'GET', body?: Record<string, any>) {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) throw new Error('Shopify no configurado')
    const ver = String(env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION)
    let url = `https://${env.SHOPIFY_DOMAIN}/admin/api/${ver}${path}`
    if (method === 'GET' && params) {
        const usp = new URLSearchParams()
        for (const [k, v] of Object.entries(params)) if (v != null && v !== '') usp.set(k, String(v))
        if (usp.toString()) url += `?${usp}`
    }
    const r = await fetchWithTimeout(url, {
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
    const ver = String(apiVersion || env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION)
    const url = `https://${env.SHOPIFY_DOMAIN}/admin/api/${ver}/graphql.json`
    const resp = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN }, body: JSON.stringify({ query, variables }) })
    const data: any = await resp.json().catch(() => ({}))
    return { ok: resp.ok && !(data && data.errors), raw: data, status: resp.status }
}

export async function getShopifyLocationGid(env: Env, code: string) {
    if (code === 'P-CON/Existencias' && env.SHOPIFY_CONQUISTA_LOCATION_ID) {
        const id = env.SHOPIFY_CONQUISTA_LOCATION_ID
        return String(id).startsWith('gid://') ? id : `gid://shopify/Location/${id}`
    }
    const r = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/transfer_locations?odoo_location_code=eq.${encodeURIComponent(code)}&select=gid`, { method: 'GET', headers: { 'content-type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}` } })
    if (!r.ok) throw new Error(await r.text())
    const rows: any[] = await r.json()
    const gid = rows?.[0]?.gid
    if (!gid) throw new Error(`Falta gid para ubicación ${code}`)
    return String(gid).startsWith('gid://') ? gid : `gid://shopify/Location/${gid}`
}

export async function resolveVariantByCode(env: Env, code: string) {
    const q = `query($q:String!){ productVariants(first:1, query:$q){ edges { node { id sku barcode inventoryItem{ id } } } } }`
    const data = await shopifyGraphQL(env, q, { q: `barcode:${code} OR sku:${code}` })
    return data?.productVariants?.edges?.[0]?.node || null
}

function escapeGqlString(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function resolveVariantsBatch(env: Env, codesIn: string[]) {
    const codes = Array.from(new Set(codesIn.map(normCode).filter(Boolean)))
    const map = new Map<string, any>()
    for (const part of chunk(codes, 40)) {
        const orTerms = part.map(c => {
            const safe = escapeGqlString(c)
            return `(barcode:"${safe}" OR sku:"${safe}")`
        }).join(' OR ')
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

// ── Validación previa de inventory item ids ──────────────────────────────────
// Incidente 2026-09-01: tres productos tenían un ProductVariant ID guardado en
// Odoo (x_shopify_inventory_item_id) en lugar del InventoryItem ID. Shopify
// rechazó inventoryTransferCreate entero — es atómico — y se perdieron 448
// unidades en silencio. Esta función detecta ese caso ANTES de mandar nada.
//
// Read-only: resuelve cada GID con node() y confirma que (a) existe y es un
// InventoryItem, y (b) su sku corresponde al producto de Odoo que dice ser.

export type ItemCandidate = {
    /** clave de la línea tal como llegó (sku o barcode) */
    lineKey: string
    inventoryItemId: number
    /** códigos aceptables para este item: default_code y barcode de Odoo */
    expectedCodes: string[]
}

export type ItemCheck = {
    lineKey: string
    inventoryItemId: number
    reason: 'not_found' | 'sku_mismatch'
    shopifySku?: string | null
}

export async function validateInventoryItemIds(
    env: Env,
    candidates: ItemCandidate[],
): Promise<{ ok: ItemCandidate[]; bad: ItemCheck[] }> {
    const ok: ItemCandidate[] = []
    const bad: ItemCheck[] = []
    if (!candidates.length) return { ok, bad }

    const q = `query($ids:[ID!]!){ nodes(ids:$ids){ __typename ... on InventoryItem { id sku } } }`

    for (const part of chunk(candidates, 100)) {
        const ids = part.map(c => `gid://shopify/InventoryItem/${c.inventoryItemId}`)
        const data = await shopifyGraphQL(env, q, { ids })
        const nodes: any[] = data?.nodes || []
        // nodes() preserva el orden de los ids pedidos
        part.forEach((cand, i) => {
            const node = nodes[i]
            if (!node || node.__typename !== 'InventoryItem') {
                bad.push({ lineKey: cand.lineKey, inventoryItemId: cand.inventoryItemId, reason: 'not_found' })
                return
            }
            const shopifySku = normCode(node.sku || '')
            const expected = cand.expectedCodes.map(c => normCode(c).toLowerCase()).filter(Boolean)
            // Si Shopify no expone sku no se puede cruzar: el item existe, se acepta.
            if (!shopifySku || !expected.length || expected.includes(shopifySku.toLowerCase())) {
                ok.push(cand)
            } else {
                bad.push({
                    lineKey: cand.lineKey,
                    inventoryItemId: cand.inventoryItemId,
                    reason: 'sku_mismatch',
                    shopifySku,
                })
            }
        })
    }
    return { ok, bad }
}

// ── Resolución de inventory items para un conjunto de líneas ─────────────────
// Punto único donde se decide qué inventoryItemId se manda a Shopify.
// Antes del incidente, esta lógica estaba duplicada en tres bloques de
// routes-transfer.ts, y el fallback era todo-o-nada: solo corría si NINGÚN SKU
// resolvía. Con 7 de 10 resueltos nunca se activaba, y los 3 IDs inválidos
// tumbaban el envío completo.
//
// Ahora: por-SKU. Un SKU que falla la validación se reintenta individualmente
// contra Shopify y, si tampoco así resuelve, se reporta sin bloquear a los demás.

export type ResolvedItems = {
    itemQtyMap: Map<number, number>
    /** SKUs que no se pudieron resolver ni por Odoo ni por Shopify */
    failed: Array<{ sku: string; reason: string; detail?: string }>
    stats: {
        fromOdoo: number
        fromFallback: number
        invalidOdooIds: number
        missingOdooIds: number
    }
}

export async function resolveInventoryItemsForLines(
    env: Env,
    linesBySku: Map<string, number>,
    prodMap: Map<string, { shopify_inventory_item_id: number | null; default_code?: string; barcode?: string }>,
    logFn?: (event: string, data: any) => Promise<void>,
): Promise<ResolvedItems> {
    const itemQtyMap = new Map<number, number>()
    const failed: ResolvedItems['failed'] = []
    const stats = { fromOdoo: 0, fromFallback: 0, invalidOdooIds: 0, missingOdooIds: 0 }

    const add = (itemId: number, qty: number) => {
        itemQtyMap.set(itemId, (itemQtyMap.get(itemId) || 0) + qty)
    }

    // 1) Candidatos con id en Odoo · 2) líneas sin id en Odoo
    const candidates: ItemCandidate[] = []
    const needFallback: string[] = []
    for (const [sku] of linesBySku) {
        const prod = prodMap.get(sku)
        if (prod?.shopify_inventory_item_id) {
            candidates.push({
                lineKey: sku,
                inventoryItemId: prod.shopify_inventory_item_id,
                expectedCodes: [prod.default_code || '', prod.barcode || '', sku].filter(Boolean),
            })
        } else {
            needFallback.push(sku)
            stats.missingOdooIds++
        }
    }

    // 3) Validación read-only contra Shopify — ANTES de construir el payload
    let bad: ItemCheck[] = []
    try {
        const res = await validateInventoryItemIds(env, candidates)
        for (const c of res.ok) {
            add(c.inventoryItemId, linesBySku.get(c.lineKey) || 0)
            stats.fromOdoo++
        }
        bad = res.bad
    } catch (e: any) {
        // Si la validación misma falla (red, rate limit), no se bloquea el envío:
        // se cae al comportamiento previo y se registra.
        await logFn?.('shopify_item_validation_error', { error: String(e?.message || e), candidates: candidates.length })
        for (const c of candidates) {
            add(c.inventoryItemId, linesBySku.get(c.lineKey) || 0)
            stats.fromOdoo++
        }
        candidates.length = 0
    }

    if (bad.length) {
        stats.invalidOdooIds = bad.length
        await logFn?.('shopify_item_id_invalid', {
            reason: 'odoo_shopify_item_ids_invalid',
            detail: 'Un x_shopify_inventory_item_id de Odoo no resuelve como InventoryItem en Shopify, o pertenece a otro producto. Se reintenta por SKU.',
            items: bad.map(b => ({ sku: b.lineKey, inventory_item_id: b.inventoryItemId, reason: b.reason, shopify_sku: b.shopifySku ?? null })),
        })
        for (const b of bad) needFallback.push(b.lineKey)
    }

    // 4) Fallback POR-SKU (no todo-o-nada): cubre "campo vacío" y "campo inválido"
    if (needFallback.length) {
        await logFn?.('shopify_item_lookup_fallback', {
            reason: bad.length ? 'invalid_or_missing_odoo_item_ids' : 'odoo_shopify_item_ids_missing',
            missing_skus: needFallback,
        })
        try {
            const shopifyVariants = await resolveVariantsBatch(env, needFallback)
            for (const sku of needFallback) {
                const itemGid: string | undefined = shopifyVariants.get(normCode(sku))?.inventoryItem?.id
                const numericId = itemGid ? Number(gidToLegacyId(itemGid)) : 0
                if (numericId) {
                    add(numericId, linesBySku.get(sku) || 0)
                    stats.fromFallback++
                } else {
                    failed.push({ sku, reason: 'not_resolvable_in_shopify', detail: 'Sin inventory item id válido en Odoo y sin variante con ese SKU/barcode en Shopify.' })
                }
            }
        } catch (fallbackErr: any) {
            await logFn?.('shopify_item_lookup_fallback_error', { error: String(fallbackErr?.message || fallbackErr) })
            for (const sku of needFallback) {
                failed.push({ sku, reason: 'fallback_error', detail: String(fallbackErr?.message || fallbackErr) })
            }
        }
    }

    if (failed.length) {
        await logFn?.('shopify_items_unresolved', { failed, stats })
    }

    return { itemQtyMap, failed, stats }
}

export async function getAvailableAtLocation(env: Env, inventoryItemGid: string, locationGid: string) {
    const itemId = gidToLegacyId(inventoryItemGid), locId = gidToLegacyId(locationGid)
    const data = await shopifyRest(env, '/inventory_levels.json', { inventory_item_ids: itemId, location_ids: locId })
    const lvl = Array.isArray(data?.inventory_levels) ? data.inventory_levels[0] : null
    return Number(lvl?.available ?? 0)
}

// ── Crea una transferencia formal en Shopify y la valida (RECEIVED) ──────────
// Usa inventoryTransferCreate (GraphQL 2024-04+) para máxima trazabilidad.
// inventoryItemQtyMap: shopify_inventory_item_id (numérico) → qty movida
export async function syncShopifyTransfer(
    env: Env,
    originOdooCode: string,
    destOdooCode: string,
    inventoryItemQtyMap: Map<number, number>,
    logFn?: (event: string, data: any) => Promise<void>,
    transferId?: string,
): Promise<{ synced: number; skipped: number; transferGid?: string }> {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) {
        await logFn?.('shopify_sync_skipped', { reason: 'no_credentials' })
        return { synced: 0, skipped: inventoryItemQtyMap.size }
    }

    // Resolve locations from DB instead of hardcoded map
    let originLocGid: string
    let destLocGid: string
    try {
        originLocGid = await getShopifyLocationGid(env, originOdooCode)
        destLocGid = await getShopifyLocationGid(env, destOdooCode)
    } catch (e: any) {
        await logFn?.('shopify_sync_skipped', { reason: 'location_not_mapped', originOdooCode, destOdooCode, error: e?.message })
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
        const ver = String(env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION)
        const num = ver.replace('-', '')
        return num >= '202507' ? ver : DEFAULT_API_VERSION
    })()

    // Derive deterministic idempotency keys from transferId (or fallback to random)
    const idempotencyBase = transferId || crypto.randomUUID()
    const createKey = await deriveIdempotencyKey(idempotencyBase, 'create')

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
        await logFn?.('shopify_transfer_create_error', { errs: JSON.stringify(errs).slice(0, 800), originOdooCode, destOdooCode })
        throw new Error(`inventoryTransferCreate failed: ${JSON.stringify(errs)}`)
    }

    const transferGid: string = createResult.raw?.data?.inventoryTransferCreate?.inventoryTransfer?.id
    if (!transferGid) {
        const userErrs = createResult.raw?.data?.inventoryTransferCreate?.userErrors
        await logFn?.('shopify_transfer_create_error', { error: 'empty_transfer_id', userErrors: JSON.stringify(userErrs).slice(0, 800), originOdooCode, destOdooCode })
        throw new Error('inventoryTransferCreate devolvió id vacío')
    }

    await logFn?.('shopify_transfer_created', { transferGid, lineItems: lineItems.length })

    // ── Step 2: Mark as ready to ship ────────────────────────────────────────
    await sleep(200)
    const readyKey = await deriveIdempotencyKey(idempotencyBase, 'ready_to_ship')
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
    }

    // ── Step 3: Create shipment (in-transit) ─────────────────────────────────
    await sleep(200)
    const shipmentKey = await deriveIdempotencyKey(idempotencyBase, 'shipment')
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
        await logFn?.('shopify_sync_done', { originOdooCode, destOdooCode, transferGid, finalStatus: 'ready_to_ship', synced: lineItems.length, skipped: inventoryItemQtyMap.size - lineItems.length })
        return { synced: lineItems.length, skipped: inventoryItemQtyMap.size - lineItems.length, transferGid }
    }

    const shipmentLineItemEdges: Array<{ node: { id: string; quantity: number } }> =
        shipmentResult.raw?.data?.inventoryShipmentCreate?.inventoryShipment?.lineItems?.edges || []

    await logFn?.('shopify_shipment_created', {
        shipmentGid,
        lineItemCount: shipmentLineItemEdges.length,
        lineItemIds: shipmentLineItemEdges.map((e: any) => e.node.id),
    })

    // ── Step 3.5: Mark shipment as IN_TRANSIT ─────────────────────────────────
    await sleep(200)
    const inTransitKey = await deriveIdempotencyKey(idempotencyBase, 'in_transit')
    const markInTransitMutation = `mutation { inventoryShipmentMarkInTransit(id: "${shipmentGid}") { inventoryShipment { id status } userErrors { field message } } }`
    const inTransitResult = await shopifyGraphQLWithVersion(env, apiVersion, markInTransitMutation)
    const inTransitUserErrs = inTransitResult.raw?.data?.inventoryShipmentMarkInTransit?.userErrors
    if (!inTransitResult.ok || inTransitUserErrs?.length) {
        const errs = inTransitUserErrs?.length ? inTransitUserErrs : inTransitResult.raw?.errors
        await logFn?.('shopify_shipment_in_transit_error', { shipmentGid, error: JSON.stringify(errs) })
        await logFn?.('shopify_sync_done', {
            originOdooCode, destOdooCode, transferGid, shipmentGid,
            finalStatus: 'ready_to_ship',
            synced: lineItems.length,
            skipped: inventoryItemQtyMap.size - lineItems.length,
        })
        return { synced: lineItems.length, skipped: inventoryItemQtyMap.size - lineItems.length, transferGid }
    } else {
        await logFn?.('shopify_shipment_in_transit', { shipmentGid, status: inTransitResult.raw?.data?.inventoryShipmentMarkInTransit?.inventoryShipment?.status })
    }

    // ── Step 4: Receive the shipment (RECEIVED) ───────────────────────────────
    await sleep(200)
    let receiveResult: any
    const receiveKey = await deriveIdempotencyKey(idempotencyBase, 'receive')

    if (shipmentLineItemEdges.length > 0) {
        const lineItemsGql = shipmentLineItemEdges
            .map((e: any) => `{ shipmentLineItemId: "${e.node.id}", quantity: ${e.node.quantity}, reason: ACCEPTED }`)
            .join(', ')
        const receiveMutation = `mutation { inventoryShipmentReceive(id: "${shipmentGid}", lineItems: [${lineItemsGql}]) { inventoryShipment { id status } userErrors { field message } } }`
        receiveResult = await shopifyGraphQLWithVersion(env, apiVersion, receiveMutation)
    } else {
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

    return { synced: lineItems.length, skipped: inventoryItemQtyMap.size - lineItems.length, transferGid }
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

    // Resolve Planta location from DB
    let plantaGid: string
    try {
        plantaGid = await getShopifyLocationGid(env, 'WH/Existencias')
    } catch (e: any) {
        await logFn?.('shopify_planta_adjust_error', { error: `planta_location_not_found: ${e?.message}` })
        return
    }

    const changes: Array<{ inventoryItemGid: string; delta: number }> = []
    for (const [itemId, qty] of inventoryItemQtyMap) {
        if (qty === 0) continue
        const delta = negate ? -Math.abs(qty) : qty
        changes.push({ inventoryItemGid: `gid://shopify/InventoryItem/${itemId}`, delta })
    }

    if (!changes.length) return

    const apiVersion = (() => {
        const ver = String(env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION)
        const num = ver.replace('-', '')
        return num >= '202507' ? ver : DEFAULT_API_VERSION
    })()

    // Query current available quantities at Planta first — unstable API requires
    // changeFromQuantity in every InventoryChangeInput (optimistic concurrency).
    const currentQtyMap = new Map<string, number>()
    try {
        for (const batch of chunk(changes.map(c => c.inventoryItemGid), 250)) {
            const nodeIds = batch.map(id => `"${id}"`).join(', ')
            const qtyQuery = `{ nodes(ids: [${nodeIds}]) { ... on InventoryItem { id inventoryLevel(locationId: "${plantaGid}") { quantities(names: ["available"]) { name quantity } } } } }`
            const qtyResult = await shopifyGraphQLWithVersion(env, apiVersion, qtyQuery)
            for (const node of (qtyResult.raw?.data?.nodes || [])) {
                if (!node?.id) continue
                const qty = node.inventoryLevel?.quantities?.find((q: any) => q.name === 'available')?.quantity ?? 0
                currentQtyMap.set(node.id, qty)
            }
        }
    } catch (e: any) {
        await logFn?.('shopify_planta_adjust_error', { error: `quantity_query_failed: ${e?.message || e}`, changes: changes.length })
        return
    }

    // Inline mutation with changeFromQuantity (required by unstable API)
    const changesGql = changes
        .map(c => `{ inventoryItemId: "${c.inventoryItemGid}", locationId: "${plantaGid}", delta: ${c.delta}, changeFromQuantity: ${currentQtyMap.get(c.inventoryItemGid) ?? 0} }`)
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
