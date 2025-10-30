export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE: string
  ODOO_URL: string
  ODOO_DB: string
  ODOO_UID: string
  ODOO_API_KEY: string
  CORS_ORIGIN?: string
  ODOO_AUTO_VALIDATE?: string
  SHOPIFY_STORE?: string
  SHOPIFY_ACCESS_TOKEN?: string
  SHOPIFY_REPLICATE_TRANSFERS?: string
}

const ALLOWED_LOCATION_CODES = [
  'WH/Existencias',
  'KRONI/Existencias',
  'P-CEI/Existencias',
  'P-CON/Existencias',
] as const

function corsHeaders(origin?: string) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  const body = JSON.stringify(data)
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) }, status: init.status || 200 })
}

async function handleOptions(_req: Request, env: Env) {
  return new Response(null, { headers: corsHeaders(env.CORS_ORIGIN) })
}

function missingEnv(env: Partial<Env>) {
  const req = ['SUPABASE_URL','SUPABASE_SERVICE_ROLE','ODOO_URL','ODOO_DB','ODOO_UID','ODOO_API_KEY']
  return req.filter(k => !(env as any)[k] || String((env as any)[k]).trim() === '')
}

// ---------------- ODOO HELPERS ----------------
async function odooExecuteKw(env: Env, model: string, method: string, args: any[] = [], kwargs: Record<string, any> = {}) {
  const miss = missingEnv(env)
  if (miss.length) throw new Error(`Faltan variables de entorno: ${miss.join(', ')}`)
  const base = String(env.ODOO_URL).replace(/\/$/, '')
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [env.ODOO_DB, Number(env.ODOO_UID), env.ODOO_API_KEY, model, method, args, kwargs],
    },
    id: Math.floor(Math.random() * 1000000),
  }
  const resp = await fetch(`${base}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.error) {
    throw new Error(`Odoo error: ${JSON.stringify(data.error || data)}`)
  }
  return data.result
}

async function odooSearch(env: Env, model: string, domain: any[], kwargs: Record<string, any> = {}) {
  return odooExecuteKw(env, model, 'search', [domain], kwargs)
}

async function odooRead(env: Env, model: string, ids: number[], fields: string[]) {
  return odooExecuteKw(env, model, 'read', [ids, fields])
}

async function findInternalPickingType(env: Env) {
  const ids = await odooSearch(env, 'stock.picking.type', [['code', '=', 'internal']])
  if (!ids?.length) throw new Error('No se encontró picking type interno (code=internal)')
  return ids[0]
}

async function findLocationIdByCompleteName(env: Env, code: string) {
  const ids = await odooSearch(env, 'stock.location', [['complete_name', '=', code]])
  if (!ids?.length) throw new Error(`Ubicación no encontrada en Odoo: ${code}`)
  return ids[0]
}

async function findProductByCode(env: Env, code: string) {
  // Buscar por barcode o default_code
  const domain = ['|', ['barcode', '=', code], ['default_code', '=', code]]
  const ids = await odooSearch(env, 'product.product', domain as any)
  if (!ids?.length) throw new Error(`Producto no encontrado: ${code}`)
  const rows = await odooRead(env, 'product.product', [ids[0]], ['id', 'display_name', 'uom_id'])
  const row = rows?.[0]
  if (!row) throw new Error(`Producto no legible: ${code}`)
  const uomId = Array.isArray(row.uom_id) ? row.uom_id[0] : row.uom_id
  return { id: row.id as number, name: row.display_name as string, uom_id: Number(uomId) }
}

async function odooWrite(env: Env, model: string, ids: number[], vals: Record<string, any>) {
  return odooExecuteKw(env, model, 'write', [ids, vals])
}

async function odooCreate(env: Env, model: string, vals: Record<string, any>) {
  return odooExecuteKw(env, model, 'create', [vals])
}

async function validatePicking(env: Env, pickingId: number) {
  // Intento directo
  const action = await odooExecuteKw(env, 'stock.picking', 'button_validate', [[pickingId]], { context: { skip_backorder: true } })
  if (action === true) return true
  if (action && typeof action === 'object') {
    const resModel = (action as any).res_model
    const resId = (action as any).res_id
    if (resModel === 'stock.immediate.transfer') {
      if (resId) {
        await odooExecuteKw(env, 'stock.immediate.transfer', 'process', [[resId]])
        return true
      }
      const wizId = await odooCreate(env, 'stock.immediate.transfer', { pick_ids: [[6, 0, [pickingId]]] })
      await odooExecuteKw(env, 'stock.immediate.transfer', 'process', [[wizId]])
      return true
    }
    if (resModel === 'stock.backorder.confirmation') {
      if (resId) {
        await odooExecuteKw(env, 'stock.backorder.confirmation', 'process', [[resId]])
        return true
      }
      const wizId = await odooCreate(env, 'stock.backorder.confirmation', { pick_ids: [[6, 0, [pickingId]]] })
      await odooExecuteKw(env, 'stock.backorder.confirmation', 'process', [[wizId]])
      return true
    }
  }
  // Fallback: set qty_done from moves then validate again
  const pickRows = await odooRead(env, 'stock.picking', [pickingId], ['move_ids_without_package'])
  const pick = pickRows?.[0] || {}
  const moveIds: number[] = Array.isArray(pick.move_ids_without_package) ? pick.move_ids_without_package : []
  if (moveIds.length) {
    const moves = await odooRead(env, 'stock.move', moveIds, ['id','product_id','product_uom','product_uom_qty','location_id','location_dest_id','move_line_ids'])
    for (const mv of moves) {
      const lineIds: number[] = Array.isArray(mv.move_line_ids) ? mv.move_line_ids : []
      if (lineIds.length) {
        for (const lid of lineIds) {
          await odooWrite(env, 'stock.move.line', [lid], { qty_done: Number(mv.product_uom_qty) || 0 })
        }
      } else {
        const productId = Array.isArray(mv.product_id) ? mv.product_id[0] : mv.product_id
        const uomId = Array.isArray(mv.product_uom) ? mv.product_uom[0] : mv.product_uom
        const locId = Array.isArray(mv.location_id) ? mv.location_id[0] : mv.location_id
        const dstId = Array.isArray(mv.location_dest_id) ? mv.location_dest_id[0] : mv.location_dest_id
        await odooCreate(env, 'stock.move.line', {
          picking_id: pickingId,
          move_id: mv.id,
          product_id: Number(productId),
          product_uom_id: Number(uomId),
          qty_done: Number(mv.product_uom_qty) || 0,
          location_id: Number(locId),
          location_dest_id: Number(dstId),
        })
      }
    }
    const action2 = await odooExecuteKw(env, 'stock.picking', 'button_validate', [[pickingId]], { context: { skip_backorder: true } })
    if (action2 === true) return true
    if (action2 && typeof action2 === 'object') {
      const resModel2 = (action2 as any).res_model
      const resId2 = (action2 as any).res_id
      if (resModel2 === 'stock.immediate.transfer') {
        if (resId2) await odooExecuteKw(env, 'stock.immediate.transfer', 'process', [[resId2]])
        else {
          const wizId = await odooCreate(env, 'stock.immediate.transfer', { pick_ids: [[6, 0, [pickingId]]] })
          await odooExecuteKw(env, 'stock.immediate.transfer', 'process', [[wizId]])
        }
        return true
      }
      if (resModel2 === 'stock.backorder.confirmation') {
        if (resId2) await odooExecuteKw(env, 'stock.backorder.confirmation', 'process', [[resId2]])
        else {
          const wizId = await odooCreate(env, 'stock.backorder.confirmation', { pick_ids: [[6, 0, [pickingId]]] })
          await odooExecuteKw(env, 'stock.backorder.confirmation', 'process', [[wizId]])
        }
        return true
      }
    }
  }
  return false
}

// ---------------- SUPABASE HELPERS ----------------
function sbHeaders(env: Env) {
  return {
    'content-type': 'application/json',
    apikey: env.SUPABASE_SERVICE_ROLE,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
  }
}

async function sbInsert(env: Env, table: string, rows: any[]) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), prefer: 'return=representation' },
    body: JSON.stringify(rows),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function sbUpsert(env: Env, table: string, rows: any[]) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function sbGetByClientId(env: Env, clientId: string) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?client_transfer_id=eq.${encodeURIComponent(clientId)}&select=id,odoo_picking_id,picking_name,status`, {
    method: 'GET', headers: sbHeaders(env)
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function sbGetTransfer(env: Env, id: string) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?id=eq.${encodeURIComponent(id)}&select=*`, { method: 'GET', headers: sbHeaders(env) })
  if (!r.ok) throw new Error(await r.text())
  const rows = await r.json()
  return rows?.[0] || null
}

async function sbInsertShopifyDraft(env: Env, draft: any) {
  return sbInsert(env, 'shopify_transfer_drafts', [draft])
}

// ---------------- SHOPIFY HELPERS ----------------
async function shopifyGraphQL(env: Env, query: string, variables?: Record<string, any>) {
  if (!env.SHOPIFY_STORE || !env.SHOPIFY_ACCESS_TOKEN) throw new Error('Shopify no configurado')
  const url = `https://${env.SHOPIFY_STORE}/admin/api/2023-10/graphql.json`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.errors) throw new Error(`Shopify error: ${JSON.stringify(data.errors || data)}`)
  return data.data
}

function gidToLegacyId(gidOrId: string | number) {
  const s = String(gidOrId)
  const m = s.match(/\/(\d+)$/)
  return m ? m[1] : s
}

async function shopifyRest(env: Env, path: string, params?: Record<string, any>) {
  if (!env.SHOPIFY_STORE || !env.SHOPIFY_ACCESS_TOKEN) throw new Error('Shopify no configurado')
  const usp = new URLSearchParams()
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') usp.set(k, String(v))
  const url = `https://${env.SHOPIFY_STORE}/admin/api/2023-10${path}${usp.toString() ? `?${usp.toString()}` : ''}`
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN, 'content-type': 'application/json' } })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Shopify REST error: ${r.status} ${JSON.stringify(data)}`)
  return data
}

async function getShopifyLocationGid(env: Env, code: string) {
  // Read mapping from Supabase transfer_locations.shopify_location_id
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_locations?code=eq.${encodeURIComponent(code)}&select=shopify_location_id`, { method: 'GET', headers: sbHeaders(env) })
  if (!r.ok) throw new Error(await r.text())
  const rows = await r.json()
  const id = rows?.[0]?.shopify_location_id
  if (!id) throw new Error(`Falta shopify_location_id para ubicación ${code}`)
  // Convert numeric id to GID if needed
  if (String(id).startsWith('gid://')) return id
  return `gid://shopify/Location/${id}`
}

async function resolveVariantByCode(env: Env, code: string) {
  const q = `query($q:String!){ productVariants(first:1, query:$q){ edges { node { id sku barcode inventoryItem{ id } } } } }`
  const data = await shopifyGraphQL(env, q, { q: `barcode:${code} OR sku:${code}` })
  const edge = data?.productVariants?.edges?.[0]
  if (!edge) return null
  return edge.node
}

async function getAvailableAtLocation(env: Env, inventoryItemGid: string, locationGid: string) {
  // Use REST Admin API for broader version compatibility
  const itemId = gidToLegacyId(inventoryItemGid)
  const locId = gidToLegacyId(locationGid)
  const data = await shopifyRest(env, '/inventory_levels.json', { inventory_item_ids: itemId, location_ids: locId })
  const lvl = Array.isArray(data?.inventory_levels) ? data.inventory_levels[0] : null
  return Number(lvl?.available ?? 0)
}

async function createShopifyTransferDraft(env: Env, originLocGid: string, destLocGid: string, lines: { inventoryItemId: string, quantity: number }[]) {
  // Try GraphQL Admin mutation for inventory transfer creation (may vary by API version/tenant)
  const mutation = `mutation CreateTransfer($input: InventoryTransferCreateInput!) {
    inventoryTransferCreate(input: $input) {
      transfer { id name status }
      userErrors { field message }
    }
  }`
  const input = {
    originLocationId: originLocGid,
    destinationLocationId: destLocGid,
    lineItems: lines.map(l => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantity })),
    // Some tenants require a name or note; optional
  }
  const data = await shopifyGraphQL(env, mutation, { input })
  const res = data?.inventoryTransferCreate
  if (res?.userErrors && res.userErrors.length) {
    throw new Error(`Shopify userErrors: ${JSON.stringify(res.userErrors)}`)
  }
  const tr = res?.transfer
  if (!tr?.id) throw new Error('Shopify did not return transfer id')
  return { id: tr.id, name: tr.name || null, status: tr.status || 'DRAFT' }
}

// ---------------- HANDLERS ----------------
async function createTransfer(req: Request, env: Env) {
  const cors = corsHeaders(env.CORS_ORIGIN)
  try {
    const miss = missingEnv(env)
    if (miss.length) return json({ error: `Faltan variables de entorno: ${miss.join(', ')}` }, { status: 500, headers: cors })
    const payload = await req.json().catch(() => ({}))
    const { client_transfer_id, origin_id, dest_id, lines } = payload || {}
    if (!client_transfer_id || !origin_id || !dest_id || !Array.isArray(lines) || !lines.length) {
      return json({ error: 'payload inválido' }, { status: 400, headers: cors })
    }

    // Validar ubicaciones permitidas
    if (!ALLOWED_LOCATION_CODES.includes(origin_id) || !ALLOWED_LOCATION_CODES.includes(dest_id)) {
      return json({ error: 'Ubicación no permitida' }, { status: 400, headers: cors })
    }
    if (origin_id === dest_id) return json({ error: 'Origen y destino no pueden ser iguales' }, { status: 400, headers: cors })

    // Idempotencia: si ya existe, devuelve
    try {
      const existing: any[] = await sbGetByClientId(env, client_transfer_id)
      if (existing?.length) {
        return json({ ok: true, id: existing[0].id, odoo_picking_id: existing[0].odoo_picking_id, picking_name: existing[0].picking_name, status: existing[0].status }, { headers: cors })
      }
    } catch {}

    // Shopify: validar disponibilidad en origen (bloqueante si está configurado)
    if (env.SHOPIFY_STORE && env.SHOPIFY_ACCESS_TOKEN) {
      try {
        const locGid = await getShopifyLocationGid(env, origin_id)
        const insufficient: any[] = []
        for (const ln of lines) {
          const code = String(ln.barcode || ln.sku || '').trim()
          const qty = Number(ln.qty || 0)
          if (!code || qty <= 0) continue
          const variant = await resolveVariantByCode(env, code)
          if (!variant) { insufficient.push({ code, requested: qty, available: 0, reason: 'no_variant' }); continue }
          const avail = await getAvailableAtLocation(env, variant.inventoryItem.id, locGid)
          if (avail < qty) insufficient.push({ code, requested: qty, available: avail })
        }
        if (insufficient.length) return json({ ok: false, insufficient }, { status: 409, headers: cors })
      } catch (e: any) {
        // Si Shopify falla inesperadamente, evita crear transfer parcial
        return json({ ok: false, error: `Shopify validation failed: ${String(e?.message || e)}` }, { status: 502, headers: cors })
      }
    }

    // Resolver picking type interno y ubicaciones en Odoo
    const pickingTypeId = await findInternalPickingType(env)
    const srcId = await findLocationIdByCompleteName(env, origin_id)
    const dstId = await findLocationIdByCompleteName(env, dest_id)

    // Resolver productos y preparar moves
    const resolved = [] as { product_id: number; name: string; uom_id: number; qty: number }[]
    for (const ln of lines) {
      const code = String(ln.barcode || ln.sku || '').trim()
      const qty = Number(ln.qty || 0)
      if (!code || qty <= 0) continue
      const prod = await findProductByCode(env, code)
      resolved.push({ product_id: prod.id, name: prod.name, uom_id: prod.uom_id, qty })
    }
    if (!resolved.length) return json({ error: 'No hay líneas válidas' }, { status: 400, headers: cors })

    // Crear picking
    const pickingId: number = await odooExecuteKw(env, 'stock.picking', 'create', [{
      picking_type_id: pickingTypeId,
      location_id: srcId,
      location_dest_id: dstId,
      origin: client_transfer_id,
    }])

    // Crear moves
    for (const mv of resolved) {
      await odooExecuteKw(env, 'stock.move', 'create', [{
        name: mv.name,
        product_id: mv.product_id,
        product_uom: mv.uom_id,
        product_uom_qty: mv.qty,
        picking_id: pickingId,
        location_id: srcId,
        location_dest_id: dstId,
      }])
    }

    // Confirmar y asignar
    await odooExecuteKw(env, 'stock.picking', 'action_confirm', [[pickingId]])
    try { await odooExecuteKw(env, 'stock.picking', 'action_assign', [[pickingId]]) } catch {}

    // Auto-validar (Done) si está habilitado (por defecto ON)
    const autoValidate = String(env.ODOO_AUTO_VALIDATE || '1')
    if (autoValidate === '1' || autoValidate.toLowerCase() === 'true') {
      try { await validatePicking(env, pickingId) } catch (e) { /* continúa aunque falle */ }
    }

    // Leer nombre del picking
    const pickRow = await odooRead(env, 'stock.picking', [pickingId], ['name','state'])
    const pickingName = pickRow?.[0]?.name || String(pickingId)
    const pickingState = pickRow?.[0]?.state || 'unknown'

    // Persistir en Supabase
    const transferId = crypto.randomUUID()
    await sbInsert(env, 'transfers', [{
      id: transferId,
      client_transfer_id,
      origin_id,
      dest_id,
      status: pickingState === 'done' ? 'validated' : 'odoo_created',
      odoo_picking_id: String(pickingId),
      picking_name: pickingName,
    }])
    await sbInsert(env, 'transfer_lines', resolved.map((mv) => ({
      transfer_id: transferId,
      product_id: String(mv.product_id),
      barcode: null,
      sku: null,
      qty: mv.qty,
    })))
    await sbInsert(env, 'transfer_logs', [{ transfer_id: transferId, event: 'odoo_created', detail: { pickingId, pickingName, state: pickingState } }])

    // Replicar a Shopify como draft si aplica (excepto KRONI/Existencias)
    try {
      const replicateFlag = String(env.SHOPIFY_REPLICATE_TRANSFERS || '1')
      if ((replicateFlag === '1' || replicateFlag.toLowerCase() === 'true') && env.SHOPIFY_STORE && env.SHOPIFY_ACCESS_TOKEN) {
        if (dest_id !== 'KRONI/Existencias') {
          const originLoc = await getShopifyLocationGid(env, origin_id)
          const destLoc = await getShopifyLocationGid(env, dest_id)
          const draftId = crypto.randomUUID()
          const draftLines: any[] = []
          const createLines: { inventoryItemId: string, quantity: number }[] = []
          for (const ln of lines) {
            const code = String(ln.barcode || ln.sku || '').trim()
            const qty = Number(ln.qty || 0)
            if (!code || qty <= 0) continue
            const variant = await resolveVariantByCode(env, code)
            const invItemId = variant?.inventoryItem?.id || null
            draftLines.push({ code, qty, variantId: variant?.id || null, inventoryItemId: invItemId })
            if (invItemId) createLines.push({ inventoryItemId: invItemId, quantity: qty })
          }
          await sbInsertShopifyDraft(env, {
            id: draftId,
            transfer_id: transferId,
            origin_code: origin_id,
            dest_code: dest_id,
            origin_shopify_location_id: originLoc,
            dest_shopify_location_id: destLoc,
            lines: draftLines,
            status: 'pending',
            notes: 'Created by wh-transfers (draft for manual validation in Shopify)'
          })
          // Try automatic draft creation in Shopify
          try {
            const created = await createShopifyTransferDraft(env, originLoc, destLoc, createLines)
            // Update record with shopify_transfer_id and status
            await fetch(`${env.SUPABASE_URL}/rest/v1/shopify_transfer_drafts?id=eq.${encodeURIComponent(draftId)}`, {
              method: 'PATCH',
              headers: { ...sbHeaders(env), prefer: 'return=representation' },
              body: JSON.stringify({ shopify_transfer_id: created.id, status: 'created' })
            })
            await sbInsert(env, 'transfer_logs', [{ transfer_id: transferId, event: 'shopify_draft_created', detail: { shopify_transfer_id: created.id, name: created.name, status: created.status } }])
          } catch (e) {
            await sbInsert(env, 'transfer_logs', [{ transfer_id: transferId, event: 'shopify_draft_create_failed', detail: { error: String((e as any)?.message || e) } }])
          }
        }
      }
    } catch (e) {
      await sbInsert(env, 'transfer_logs', [{ transfer_id: transferId, event: 'shopify_draft_error', detail: { error: String((e as any)?.message || e) } }])
    }

    // Response: include shopify draft info for UI
    const resp: any = { ok: true, id: transferId, odoo_picking_id: String(pickingId), picking_name: pickingName, status: pickingState === 'done' ? 'validated' : 'odoo_created' }
    try {
      const r3 = await fetch(`${env.SUPABASE_URL}/rest/v1/shopify_transfer_drafts?transfer_id=eq.${encodeURIComponent(transferId)}&select=shopify_transfer_id,status`, { method: 'GET', headers: sbHeaders(env) })
      if (r3.ok) {
        const rows = await r3.json()
        const d = rows?.[0]
        if (d) resp.shopify_draft = { created: Boolean(d.shopify_transfer_id), id: d.shopify_transfer_id || null, status: d.status }
      }
    } catch {}
    return json(resp, { headers: cors })
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, { status: 500, headers: cors })
  }
}

async function getTransfer(_req: Request, env: Env, id: string) {
  const cors = corsHeaders(env.CORS_ORIGIN)
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?id=eq.${encodeURIComponent(id)}&select=id,client_transfer_id,origin_id,dest_id,status,odoo_picking_id,picking_name,created_at`, { method: 'GET', headers: sbHeaders(env) })
    if (!r.ok) throw new Error(await r.text())
    const rows = await r.json()
    return json(rows?.[0] || null, { headers: cors })
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, { status: 500, headers: cors })
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url)
    const { pathname } = url

    if (req.method === 'OPTIONS') return handleOptions(req, env)

    if (req.method === 'POST' && pathname === '/api/transfers/validate') {
      const cors = corsHeaders(env.CORS_ORIGIN)
      try {
        if (!env.SHOPIFY_STORE || !env.SHOPIFY_ACCESS_TOKEN) {
          return json({ ok: true, skipped: true }, { headers: cors })
        }
        const payload = await req.json().catch(() => ({}))
        const { origin_id, lines } = payload || {}
        if (!origin_id || !Array.isArray(lines) || !lines.length) return json({ ok: false, error: 'payload inválido' }, { status: 400, headers: cors })
        const locGid = await getShopifyLocationGid(env, origin_id)
        const insufficient: any[] = []
        for (const ln of lines) {
          const code = String(ln.barcode || ln.sku || '').trim()
          const qty = Number(ln.qty || 0)
          if (!code || qty <= 0) continue
          const variant = await resolveVariantByCode(env, code)
          if (!variant) { insufficient.push({ code, requested: qty, available: 0, reason: 'no_variant' }); continue }
          const avail = await getAvailableAtLocation(env, variant.inventoryItem.id, locGid)
          if (avail < qty) insufficient.push({ code, requested: qty, available: avail })
        }
        if (insufficient.length) return json({ ok: false, insufficient }, { status: 200, headers: cors })
        return json({ ok: true }, { headers: cors })
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: corsHeaders(env.CORS_ORIGIN) })
      }
    }

    if (req.method === 'POST' && pathname === '/api/transfers') {
      return createTransfer(req, env)
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/transfers\/([^/]+)\/shopify-draft\.csv$/)) {
      const id = pathname.split('/')[3]
      try {
        const tr = await sbGetTransfer(env, id)
        if (!tr) return new Response('Not found', { status: 404, headers: corsHeaders(env.CORS_ORIGIN) })
        const r2 = await fetch(`${env.SUPABASE_URL}/rest/v1/shopify_transfer_drafts?transfer_id=eq.${encodeURIComponent(id)}&select=*`, { method: 'GET', headers: sbHeaders(env) })
        if (!r2.ok) throw new Error(await r2.text())
        const rows = await r2.json()
        const draft = rows?.[0]
        const lines = Array.isArray(draft?.lines) ? draft.lines : []
        let csv = 'code,qty,origin_shopify_location_id,dest_shopify_location_id\n'
        for (const ln of lines) {
          csv += `${ln.code},${ln.qty},${draft?.origin_shopify_location_id || ''},${draft?.dest_shopify_location_id || ''}\n`
        }
        return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="shopify_draft_${id}.csv"`, ...corsHeaders(env.CORS_ORIGIN) } })
      } catch (e: any) {
        return json({ error: String(e?.message || e) }, { status: 500, headers: corsHeaders(env.CORS_ORIGIN) })
      }
    }

    if (req.method === 'GET' && pathname.startsWith('/api/transfers/')) {
      const id = pathname.split('/').pop() || ''
      return getTransfer(req, env, id)
    }

    return new Response('Not found', { status: 404 })
  },
}
