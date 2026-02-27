export const EF_VERSION = 46

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
    SHOPIFY_CONQUISTA_LOCATION_ID?: string
    SHOPIFY_API_KEY_TRANSFERS?: string
}

// ── Utilities ──
export function corsHeaders(env: Env) {
    return {
        'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id, X-Api-Key',
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

export async function deriveIdempotencyKey(transferId: string, step: string): Promise<string> {
    const data = new TextEncoder().encode(`${transferId}:${step}`)
    const hash = await crypto.subtle.digest('SHA-256', data)
    const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

export function validateApiKey(req: Request, env: Env, cors: Record<string, string>): Response | null {
    const key = env.SHOPIFY_API_KEY_TRANSFERS
    if (!key) return null // no key configured → skip auth
    const provided = req.headers.get('X-Api-Key') || req.headers.get('x-api-key')
    if (provided === key) return null // valid
    return json({ error: 'Unauthorized' }, { status: 401, headers: cors } as any)
}

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
