// Arnés de prueba para resolveInventoryItemsForLines / validateInventoryItemIds.
// Simula Shopify con un fetch stub. NO toca produccion.
import { resolveInventoryItemsForLines, validateInventoryItemIds } from '../shopify.ts'

const env: any = {
    SHOPIFY_DOMAIN: 'fake.myshopify.com',
    SHOPIFY_ACCESS_TOKEN: 'shpat_fake',
    SHOPIFY_API_VERSION: '2025-10',
}

// ── Mundo simulado de Shopify ────────────────────────────────────────────────
// inventory_item_id -> sku
const SHOPIFY_ITEMS: Record<string, string> = {
    '54893766246712': 'BOL-KRAFT',
    '54897981882680': 'PER-CABGLO-100',
    '54286740652344': 'PER-ELEETE-100',
    '54897995055416': 'PER-ESEITA-100',
    '47057568497976': 'PER-AURMIS-100',
    '99999999999999': 'OTRO-PRODUCTO',      // existe, pero es de otro producto
}
// variantes por sku/barcode -> inventoryItem gid
const SHOPIFY_VARIANTS: Array<{ sku: string; barcode: string; itemId: string }> = [
    { sku: 'BOL-KRAFT', barcode: '', itemId: '54893766246712' },
    { sku: 'PER-CABGLO-100', barcode: '', itemId: '54897981882680' },
    { sku: 'PER-ELEETE-100', barcode: '', itemId: '54286740652344' },
    { sku: 'PER-ESEITA-100', barcode: '', itemId: '54897995055416' },
    { sku: 'PER-AURMIS-100', barcode: 'BC-AURMIS', itemId: '47057568497976' },
]

const calls: string[] = []

;(globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    const q: string = body.query || ''

    if (/\bmutation\b/.test(q)) {
        calls.push('MUTATION')
        throw new Error('TEST FAIL: no deberia mandarse ninguna mutacion en esta prueba')
    }

    if (q.includes('nodes(ids:')) {
        calls.push('validate')
        const ids: string[] = body.variables?.ids || []
        const nodes = ids.map(gid => {
            const num = String(gid).split('/').pop() as string
            const sku = SHOPIFY_ITEMS[num]
            return sku ? { __typename: 'InventoryItem', id: gid, sku } : null
        })
        return { ok: true, json: async () => ({ data: { nodes } }) } as any
    }

    if (q.includes('productVariants')) {
        calls.push('fallback')
        const edges = SHOPIFY_VARIANTS.map(v => ({
            node: {
                id: `gid://shopify/ProductVariant/X${v.itemId}`,
                sku: v.sku,
                barcode: v.barcode,
                inventoryItem: { id: `gid://shopify/InventoryItem/${v.itemId}` },
            },
        }))
        return { ok: true, json: async () => ({ data: { productVariants: { edges } } }) } as any
    }

    throw new Error('query inesperada en el stub: ' + q.slice(0, 120))
}

// ── Utilidades de aserción ───────────────────────────────────────────────────
let passed = 0, failed = 0
function check(name: string, cond: boolean, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}`) }
    else { failed++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`) }
}
function prod(itemId: number | null, default_code: string, barcode = '') {
    return { shopify_inventory_item_id: itemId, default_code, barcode }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {

// ── CASO A: regresion — todo correcto, nada debe cambiar ────────────────────
console.log('\nCASO A — transferencia normal, los 3 IDs de Odoo son correctos')
{
    calls.length = 0
    const lines = new Map([['BOL-KRAFT', 80], ['PER-CABGLO-100', 24], ['PER-AURMIS-100', 24]])
    const prodMap = new Map<string, any>([
        ['BOL-KRAFT', prod(54893766246712, 'BOL-KRAFT')],
        ['PER-CABGLO-100', prod(54897981882680, 'PER-CABGLO-100')],
        ['PER-AURMIS-100', prod(47057568497976, 'PER-AURMIS-100', 'BC-AURMIS')],
    ])
    const r = await resolveInventoryItemsForLines(env, lines, prodMap)
    check('resuelve los 3 items', r.itemQtyMap.size === 3, `size=${r.itemQtyMap.size}`)
    check('cantidades correctas', r.itemQtyMap.get(54893766246712) === 80 && r.itemQtyMap.get(54897981882680) === 24)
    check('ningun SKU fallido', r.failed.length === 0, JSON.stringify(r.failed))
    check('los 3 vienen de Odoo', r.stats.fromOdoo === 3)
    check('NO se llamo al fallback', !calls.includes('fallback'), calls.join(','))
    check('se valido antes de nada', calls[0] === 'validate', calls.join(','))
}

// ── CASO B: el incidente real — un ID es un ProductVariant ID ───────────────
console.log('\nCASO B — un ID invalido (variant id), como el incidente 2026-09-01')
{
    calls.length = 0
    const lines = new Map([['BOL-KRAFT', 80], ['PER-CABGLO-100', 24], ['PER-ELEETE-100', 24]])
    const prodMap = new Map<string, any>([
        ['BOL-KRAFT', prod(54893766246712, 'BOL-KRAFT')],
        // 52825562841400 es el ProductVariant ID, no existe como InventoryItem
        ['PER-CABGLO-100', prod(52825562841400, 'PER-CABGLO-100')],
        ['PER-ELEETE-100', prod(54286740652344, 'PER-ELEETE-100')],
    ])
    const events: string[] = []
    const r = await resolveInventoryItemsForLines(env, lines, prodMap, async (e) => { events.push(e) })

    check('detecta el ID invalido ANTES de la mutacion', events.includes('shopify_item_id_invalid'), events.join(','))
    check('NO se intento ninguna mutacion', !calls.includes('MUTATION'))
    check('el SKU malo se recupera por fallback', r.itemQtyMap.get(54897981882680) === 24, JSON.stringify([...r.itemQtyMap]))
    check('los SKUs sanos NO se bloquean', r.itemQtyMap.get(54893766246712) === 80 && r.itemQtyMap.get(54286740652344) === 24)
    check('los 3 acaban resueltos', r.itemQtyMap.size === 3, `size=${r.itemQtyMap.size}`)
    check('ninguno queda fallido', r.failed.length === 0, JSON.stringify(r.failed))
    check('stats: 1 invalido, 2 de Odoo, 1 de fallback',
        r.stats.invalidOdooIds === 1 && r.stats.fromOdoo === 2 && r.stats.fromFallback === 1,
        JSON.stringify(r.stats))
}

// ── CASO C: SKU irrecuperable — debe reportarse sin tumbar a los demas ──────
console.log('\nCASO C — un SKU sin ID en Odoo y sin variante en Shopify')
{
    calls.length = 0
    const lines = new Map([['BOL-KRAFT', 80], ['SKU-FANTASMA', 10], ['PER-ELEETE-100', 24]])
    const prodMap = new Map<string, any>([
        ['BOL-KRAFT', prod(54893766246712, 'BOL-KRAFT')],
        ['SKU-FANTASMA', prod(null, 'SKU-FANTASMA')],
        ['PER-ELEETE-100', prod(54286740652344, 'PER-ELEETE-100')],
    ])
    const events: string[] = []
    const r = await resolveInventoryItemsForLines(env, lines, prodMap, async (e) => { events.push(e) })

    check('los SKUs sanos SI se resuelven', r.itemQtyMap.size === 2, `size=${r.itemQtyMap.size}`)
    check('el SKU fantasma se reporta', r.failed.length === 1 && r.failed[0].sku === 'SKU-FANTASMA', JSON.stringify(r.failed))
    check('motivo legible', r.failed[0]?.reason === 'not_resolvable_in_shopify', r.failed[0]?.reason)
    check('se registro el evento de no resueltos', events.includes('shopify_items_unresolved'), events.join(','))
}

// ── CASO D: el ID existe pero es de OTRO producto ───────────────────────────
console.log('\nCASO D — el ID resuelve, pero pertenece a otro producto (sku_mismatch)')
{
    calls.length = 0
    const lines = new Map([['PER-ELEETE-100', 24]])
    const prodMap = new Map<string, any>([
        ['PER-ELEETE-100', prod(99999999999999, 'PER-ELEETE-100')],  // item real de OTRO-PRODUCTO
    ])
    const events: string[] = []
    const r = await resolveInventoryItemsForLines(env, lines, prodMap, async (e) => { events.push(e) })

    check('detecta el cruce de producto', events.includes('shopify_item_id_invalid'), events.join(','))
    check('se corrige por fallback al item correcto', r.itemQtyMap.get(54286740652344) === 24, JSON.stringify([...r.itemQtyMap]))
    check('NO usa el item ajeno', !r.itemQtyMap.has(99999999999999))
}

// ── CASO E: regresion — la linea llega por BARCODE, no por SKU ──────────────
console.log('\nCASO E — regresion: la linea se captura por barcode, no por SKU')
{
    calls.length = 0
    const lines = new Map([['BC-AURMIS', 24]])
    const prodMap = new Map<string, any>([
        ['BC-AURMIS', prod(47057568497976, 'PER-AURMIS-100', 'BC-AURMIS')],
    ])
    const r = await resolveInventoryItemsForLines(env, lines, prodMap)
    check('NO lo marca como mismatch (compara contra default_code y barcode)',
        r.itemQtyMap.get(47057568497976) === 24 && r.stats.fromOdoo === 1,
        JSON.stringify({ map: [...r.itemQtyMap], stats: r.stats }))
    check('sin fallback innecesario', !calls.includes('fallback'), calls.join(','))
}

// ── CASO F: validateInventoryItemIds aislado ────────────────────────────────
console.log('\nCASO F — validateInventoryItemIds directo')
{
    const res = await validateInventoryItemIds(env, [
        { lineKey: 'BOL-KRAFT', inventoryItemId: 54893766246712, expectedCodes: ['BOL-KRAFT'] },
        { lineKey: 'PER-CABGLO-100', inventoryItemId: 52825562841400, expectedCodes: ['PER-CABGLO-100'] },
    ])
    check('1 ok y 1 malo', res.ok.length === 1 && res.bad.length === 1)
    check('el malo es not_found', res.bad[0]?.reason === 'not_found', res.bad[0]?.reason)
    check('conserva el orden de nodes()', res.ok[0]?.lineKey === 'BOL-KRAFT', res.ok[0]?.lineKey)
}

console.log(`\n──────────────────────────────────────────`)
console.log(`RESULTADO:  ${passed} PASS  ·  ${failed} FAIL`)
if (failed > 0) (globalThis as any).process.exitCode = 1
}

main().catch(e => { console.error('ERROR EN EL ARNES:', e); (globalThis as any).process.exitCode = 1 })
