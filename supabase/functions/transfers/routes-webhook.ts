// Webhook handler: Shopify inventory_transfers → fallback Odoo sync
// This is now a FALLBACK only. The primary flow creates Odoo pickings immediately
// on transfer creation (routes-transfer.ts). This webhook handles edge cases where
// the Shopify transfer was confirmed externally or the EF failed mid-way.
import { type Env } from './helpers.ts'
import {
    sbSelect, sbUpdateTransferById, sbLogTransfer,
} from './supabase-helpers.ts'
import {
    createOdooPickingFromLines,
} from './odoo.ts'
import { shopifyGraphQLWithVersion } from './shopify.ts'

// ── POST /webhook/shopify-transfer ───────────────────────────────────────────
// Called by Shopify when an inventory_transfer is completed/cancelled
// (both topics fire depending on API version — we check status via API)
export async function handleShopifyTransferWebhook(req: Request, env: Env) {
    // Shopify sends JSON payload — extract the transfer ID
    // Due to known Shopify bug: complete fires as cancel, so we never trust
    // the event type. We always query the API for the real status.
    let payload: any = {}
    try { payload = await req.json() } catch { }

    // The payload has the transfer GID in multiple possible fields
    // Shopify webhooks for inventory_transfers send an InventoryTransfer object
    const shopifyTransferId: string | null =
        payload?.id ||           // bare GID: "gid://shopify/InventoryTransfer/..."
        payload?.admin_graphql_api_id || // older format
        null

    if (!shopifyTransferId || !shopifyTransferId.includes('InventoryTransfer')) {
        return { error: 'Payload sin shopify_transfer_id válido', status: 400 }
    }

    // Normalize to full GID
    const gid = shopifyTransferId.startsWith('gid://')
        ? shopifyTransferId
        : `gid://shopify/InventoryTransfer/${shopifyTransferId}`

    // ── Query Shopify for authoritative state ──
    const apiVer = String(env.SHOPIFY_API_VERSION || 'unstable')
    const transferData = await fetchShopifyTransfer(env, apiVer, gid)

    // Only process TRANSFERRED (= fully received) transfers
    // DRAFT / IN_TRANSIT / CANCELLED → ignore
    if (transferData.status !== 'TRANSFERRED') {
        return {
            data: {
                skipped: true,
                reason: `status=${transferData.status} — solo procesamos TRANSFERRED`,
                shopify_transfer_id: gid,
            },
        }
    }

    // ── Find our internal transfer record ──
    const rows = await sbSelect(env, 'transfers',
        `shopify_transfer_id=eq.${encodeURIComponent(gid)}&select=id,origin_id,dest_id,status,odoo_picking_id`)
    const internalTransfer = rows?.[0]

    if (!internalTransfer) {
        // Could be a transfer created manually in Shopify (not via EF) — log and ignore
        return {
            data: {
                skipped: true,
                reason: 'No hay transfer interno asociado a este shopify_transfer_id',
                shopify_transfer_id: gid,
            },
        }
    }

    if (internalTransfer.status === 'validated') {
        // Already processed by the primary flow — nothing to do
        return { data: { skipped: true, reason: 'Transfer ya validado por flujo principal', transfer_id: internalTransfer.id } }
    }

    // ── Build received qty map: sku → acceptedQty ──
    // Aggregate across all shipments (usually just one)
    const receivedQtyBySku = new Map<string, number>()
    for (const shipment of transferData.shipments) {
        if (shipment.status !== 'RECEIVED') continue
        for (const item of shipment.lineItems) {
            const sku = item.inventoryItem?.sku
            if (!sku) continue
            const prev = receivedQtyBySku.get(sku) || 0
            receivedQtyBySku.set(sku, prev + (item.acceptedQuantity || 0))
        }
    }

    if (receivedQtyBySku.size === 0) {
        await sbLogTransfer(env, internalTransfer.id, 'webhook_no_received_qty', {
            shopify_transfer_id: gid, shipments_count: transferData.shipments.length,
        })
        return { data: { skipped: true, reason: 'No hay cantidades aceptadas en los shipments' } }
    }

    // ── Fallback: create Odoo picking (primary flow should have done this already) ──
    let pickingId: number
    let pickingName: string
    let finalState: string

    try {
        const result = await createOdooPickingFromLines(
            env,
            internalTransfer.origin_id,
            internalTransfer.dest_id,
            receivedQtyBySku,
            `shopify-webhook/${gid}`,
            internalTransfer.id,
            sbLogTransfer,
        )
        pickingId = result.pickingId
        pickingName = result.pickingName
        finalState = result.finalState
    } catch (e: any) {
        await sbLogTransfer(env, internalTransfer.id, 'odoo_error', { error: (e as Error).message, shopify_transfer_id: gid })
        return { error: `Error creando picking en Odoo: ${(e as Error).message}`, status: 500 }
    }

    // ── Update internal transfer ──
    await sbUpdateTransferById(env, internalTransfer.id, {
        odoo_picking_id: pickingId,
        picking_name: pickingName,
        status: 'validated',
    })

    await sbLogTransfer(env, internalTransfer.id, 'odoo_created_from_webhook', {
        pickingId,
        pickingName,
        state: finalState,
        shopify_transfer_id: gid,
        received_skus: Object.fromEntries(receivedQtyBySku),
        total_qty: [...receivedQtyBySku.values()].reduce((a, b) => a + b, 0),
    })

    return {
        data: {
            transfer_id: internalTransfer.id,
            picking_id: pickingId,
            picking_name: pickingName,
            state: finalState,
            received_skus: receivedQtyBySku.size,
        },
    }
}

// ── Query Shopify for full transfer data with shipments ───────────────────────
async function fetchShopifyTransfer(env: Env, apiVer: string, gid: string) {
    const query = `{
        inventoryTransfer(id: "${gid}") {
            id name status totalQuantity receivedQuantity
            shipments(first: 10) {
                edges {
                    node {
                        id name status
                        totalAcceptedQuantity totalRejectedQuantity totalReceivedQuantity
                        lineItems(first: 250) {
                            edges {
                                node {
                                    id quantity acceptedQuantity rejectedQuantity unreceivedQuantity
                                    inventoryItem { id sku }
                                }
                            }
                        }
                    }
                }
            }
        }
    }`

    const result = await shopifyGraphQLWithVersion(env, apiVer, query)
    if (!result.ok) throw new Error(`Shopify API error: ${JSON.stringify(result.raw?.errors || result.raw)}`)

    const t = result.raw?.data?.inventoryTransfer
    if (!t) throw new Error(`Transfer no encontrado en Shopify: ${gid}`)

    return {
        id: t.id as string,
        name: t.name as string,
        status: t.status as string,
        totalQuantity: t.totalQuantity as number,
        receivedQuantity: t.receivedQuantity as number,
        shipments: (t.shipments?.edges || []).map((e: any) => ({
            id: e.node.id as string,
            name: e.node.name as string,
            status: e.node.status as string,
            totalAcceptedQuantity: e.node.totalAcceptedQuantity as number,
            lineItems: (e.node.lineItems?.edges || []).map((li: any) => ({
                id: li.node.id as string,
                quantity: li.node.quantity as number,
                acceptedQuantity: li.node.acceptedQuantity as number,
                rejectedQuantity: li.node.rejectedQuantity as number,
                unreceivedQuantity: li.node.unreceivedQuantity as number,
                inventoryItem: {
                    id: li.node.inventoryItem?.id as string,
                    sku: li.node.inventoryItem?.sku as string,
                },
            })),
        })),
    }
}

// ── POST /webhook/register — register Shopify webhooks ───────────────────────
// Call once to register the inventory_transfers webhooks in Shopify
export async function handleRegisterWebhooks(req: Request, env: Env) {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN)
        return { error: 'Shopify no configurado', status: 500 }

    const efUrl = env.SUPABASE_URL
        ?.replace('https://', 'https://')
        .replace('.supabase.co', '.supabase.co/functions/v1') + '/transfers/webhook/shopify-transfer'

    if (!efUrl || !efUrl.startsWith('https://')) {
        return { error: `URL de EF inválida: ${efUrl}`, status: 500 }
    }

    const apiVer = String(env.SHOPIFY_API_VERSION || 'unstable')

    // Subscribe to both topics — bug workaround: cancel fires when received
    const topics = ['INVENTORY_TRANSFERS_COMPLETE', 'INVENTORY_TRANSFERS_CANCEL']
    const results: any[] = []

    for (const topic of topics) {
        const mutation = `mutation {
            webhookSubscriptionCreate(
                topic: ${topic}
                webhookSubscription: {
                    callbackUrl: "${efUrl}"
                    format: JSON
                }
            ) {
                webhookSubscription { id topic }
                userErrors { field message }
            }
        }`
        const result = await shopifyGraphQLWithVersion(env, apiVer, mutation)
        const sub = result.raw?.data?.webhookSubscriptionCreate
        results.push({
            topic,
            ok: result.ok && !(sub?.userErrors?.length),
            subscription: sub?.webhookSubscription,
            errors: sub?.userErrors,
        })
    }

    return { data: { registered: results, callback_url: efUrl } }
}
