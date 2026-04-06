// Kroni WMS API client (JSON-RPC 2.0 over HTTPS)
// Docs: docs/API_RECEPCIONES.md
//
// Used during KRONI early sync to create a reception in Kroni's WMS
// so their warehouse team sees the incoming shipment immediately.

import { fetchWithTimeout } from './helpers.ts'

// ── Types ──

type KroniSession = { cookie: string }

export type ExpandedLine = {
    sku: string
    qty: number
    product_name: string | null
    box_barcode?: string
}

export type BoxInfo = {
    sku: string
    qty_per_box: number
    label?: string
}

export type KroniReceptionResult = {
    success: boolean
    reception_id?: number
    reception_name?: string
    error?: string
}

// ── Env ──

function getKroniEnv() {
    const g = (k: string) => Deno.env.get(k) || ''
    const url = g('KRONI_BASE_URL')
    const db = g('KRONI_DB')
    const login = g('KRONI_LOGIN')
    const password = g('KRONI_PASSWORD')
    if (!url || !db || !login || !password) return null
    return { url: url.replace(/\/$/, ''), db, login, password }
}

// ── Auth ──

async function kroniAuth(kEnv: NonNullable<ReturnType<typeof getKroniEnv>>): Promise<KroniSession> {
    const resp = await fetchWithTimeout(`${kEnv.url}/web/session/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', method: 'call', id: 1,
            params: { db: kEnv.db, login: kEnv.login, password: kEnv.password },
        }),
    })

    const data: any = await resp.json()
    if (data.error) throw new Error(`Kroni auth: ${data.error.data?.message || data.error.message}`)
    if (!data.result?.uid) throw new Error('Kroni auth failed: no uid returned')

    // Extract session cookie
    const cookies = resp.headers.get('set-cookie') || ''
    const sessionMatch = cookies.match(/session_id=([^;]+)/)
    if (!sessionMatch) throw new Error('Kroni auth: no session cookie in response')

    return { cookie: `session_id=${sessionMatch[1]}` }
}

// ── Build cajas_data from our expanded lines ──

function buildCajasData(
    expandedLines: ExpandedLine[],
    boxResolver: Map<string, BoxInfo>,
): Array<{ name: string; quantity: number; products: Array<{ sku: string; quantity: number }> }> {
    // Group lines by box_barcode
    const boxGroups = new Map<string, { totalQty: number; sku: string }>()
    const directLines: ExpandedLine[] = []

    for (const ln of expandedLines) {
        if (ln.box_barcode) {
            const existing = boxGroups.get(ln.box_barcode)
            if (existing) {
                existing.totalQty += ln.qty
            } else {
                boxGroups.set(ln.box_barcode, { totalQty: ln.qty, sku: ln.sku })
            }
        } else {
            directLines.push(ln)
        }
    }

    const cajas: Array<{ name: string; quantity: number; products: Array<{ sku: string; quantity: number }> }> = []

    // Box-based lines: reconstruct box count from expanded qty
    for (const [barcode, group] of boxGroups) {
        const box = boxResolver.get(barcode)
        if (box && box.qty_per_box > 0) {
            const numBoxes = Math.round(group.totalQty / box.qty_per_box)
            cajas.push({
                name: box.label || barcode,
                quantity: numBoxes,
                products: [{ sku: group.sku, quantity: box.qty_per_box }],
            })
        } else {
            // Fallback: treat as single caja with all units
            cajas.push({
                name: barcode,
                quantity: 1,
                products: [{ sku: group.sku, quantity: group.totalQty }],
            })
        }
    }

    // Direct SKU lines (no box barcode): 1 caja with all units
    for (const ln of directLines) {
        cajas.push({
            name: ln.product_name || ln.sku,
            quantity: 1,
            products: [{ sku: ln.sku, quantity: ln.qty }],
        })
    }

    return cajas
}

// ── Create reception ──

export async function createKroniReception(
    expandedLines: ExpandedLine[],
    boxResolver: Map<string, BoxInfo>,
    transferId: string,
    odooPickingName?: string,
): Promise<KroniReceptionResult> {
    const kEnv = getKroniEnv()
    if (!kEnv) return { success: false, error: 'Kroni env vars not configured (KRONI_BASE_URL, KRONI_DB, KRONI_LOGIN, KRONI_PASSWORD)' }

    const session = await kroniAuth(kEnv)

    const cajasData = buildCajasData(expandedLines, boxResolver)
    if (!cajasData.length) return { success: false, error: 'No cajas to send to Kroni' }

    const resp = await fetchWithTimeout(`${kEnv.url}/kroni_partners/receptions/create_full`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': session.cookie,
        },
        body: JSON.stringify({
            jsonrpc: '2.0', method: 'call', id: 2,
            params: {
                reception_data: {
                    origin_address: 'Planta Productora Aromante',
                    notes: `Transfer ${transferId}${odooPickingName ? ` | Odoo: ${odooPickingName}` : ''}`,
                },
                cajas_data: cajasData,
            },
        }),
    })

    const data: any = await resp.json()
    if (data.error) {
        return { success: false, error: data.error.data?.message || data.error.message }
    }

    const result = data.result
    if (!result?.success) {
        return { success: false, error: result?.error || 'Unknown Kroni error' }
    }

    return {
        success: true,
        reception_id: result.reception_id,
        reception_name: result.reception_name,
    }
}

// ── Check reception status ──

export async function getKroniReceptionStatus(receptionId: number): Promise<any> {
    const kEnv = getKroniEnv()
    if (!kEnv) throw new Error('Kroni env vars not configured')

    const session = await kroniAuth(kEnv)

    const resp = await fetchWithTimeout(`${kEnv.url}/kroni_partners/receptions/${receptionId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': session.cookie,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: 3, params: {} }),
    })

    const data: any = await resp.json()
    if (data.error) throw new Error(data.error.data?.message || data.error.message)
    return data.result
}
