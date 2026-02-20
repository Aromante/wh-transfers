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

export async function shopifyRest(env: Env, path: string, params?: Record<string, any>) {
    if (!env.SHOPIFY_DOMAIN || !env.SHOPIFY_ACCESS_TOKEN) throw new Error('Shopify no configurado')
    const usp = new URLSearchParams()
    if (params) for (const [k, v] of Object.entries(params)) if (v != null && v !== '') usp.set(k, String(v))
    const ver = String(env.SHOPIFY_API_VERSION || '2023-10')
    const url = `https://${env.SHOPIFY_DOMAIN}/admin/api/${ver}${path}${usp.toString() ? `?${usp}` : ''}`
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN, 'content-type': 'application/json' } })
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
