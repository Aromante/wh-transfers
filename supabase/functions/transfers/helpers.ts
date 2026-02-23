// ── Types ──
export type Env = {
    SUPABASE_URL: string
    SUPABASE_SERVICE_ROLE: string
    ODOO_URL: string
    ODOO_DB: string
    ODOO_UID: string
    ODOO_API_KEY: string
    CORS_ORIGIN?: string
    ODOO_AUTO_VALIDATE?: string
    SHOPIFY_DOMAIN?: string
    SHOPIFY_ACCESS_TOKEN?: string
    SHOPIFY_REPLICATE_TRANSFERS?: string
    SHOPIFY_API_VERSION?: string
    SHOPIFY_API_VERSION_LIST?: string
    SHOPIFY_STRICT_VERSION?: string
    SHOPIFY_INPUT_VARIANT?: string
    SHOPIFY_MUTATION_FIELD?: string
    SHOPIFY_KRONI_LOCATION_ID?: string
    SHOPIFY_CONQUISTA_LOCATION_ID?: string
    ENABLE_MULTI_DRAFTS?: string
    MAX_DRAFTS_PER_OWNER?: string
}

// ── Utilities ──
export function corsHeaders(env: Env) {
    return {
        'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
    }
}

export function json(data: unknown, init: ResponseInit = {}, cors: Record<string, string> = {}) {
    return new Response(JSON.stringify(data), {
        status: (init as any).status ?? 200,
        headers: { 'content-type': 'application/json; charset=utf-8', ...cors, ...((init as any).headers ?? {}) },
    })
}

export function mustEnv(env: Partial<Env>, keys: (keyof Env)[]) {
    const missing = keys.filter((k) => !env[k] || String(env[k]).trim() === '')
    if (missing.length) throw new Error(`missing_env:${missing.join(',')}`)
}

export function boolFlag(v: any, def: boolean) {
    const s = String(v ?? '').toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'off'].includes(s)) return false
    return def
}

export function getOwner(req: Request) {
    const h = req.headers.get('X-User-Id') || req.headers.get('x-user-id')
    return (h && h.trim()) || 'anonymous'
}

export function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
}

export function normCode(code: string) { return String(code || '').trim() }

export function asInt(v: unknown, def = 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : def
}

export function parseListParam(v: string | null | undefined) {
    const s = String(v ?? '').trim()
    if (!s) return [] as string[]
    return s.split(',').map(x => x.trim()).filter(Boolean)
}

export function gidToLegacyId(gidOrId: string | number) {
    const s = String(gidOrId)
    const m = s.match(/\/(\d+)$/)
    return m ? m[1] : s
}
