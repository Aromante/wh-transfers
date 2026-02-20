// Supabase Edge Function: transfers (full Worker replacement)
// Serves as Deno-based equivalent of the Cloudflare Worker
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { type Env, corsHeaders, json, mustEnv } from './helpers.ts'
import { handleCreateTransfer, handleValidateTransfer } from './routes-transfer.ts'
import { handleListDrafts, handleCreateDraft, handleUpdateDraft, handleDeleteDraft, handleCommitDraft } from './routes-drafts.ts'
import { handleGetLocations, handleGetTransfer, handleHistory, handleHistoryCSV, handleDuplicateTransfer, handleHealth, handleGetLogs } from './routes-misc.ts'
import { handleListBoxes, handleGetBox, handleResolveBox, handleCreateBox, handleUpdateBox, handleDeleteBox } from './routes-boxes.ts'

function envFromDeno(): Env {
    const g = (k: string, def = '') => Deno.env.get(k) || def
    return {
        SUPABASE_URL: g('SUPABASE_URL'),
        SUPABASE_SERVICE_ROLE: g('SUPABASE_SERVICE_ROLE_KEY') || g('SUPABASE_SERVICE_ROLE'),
        ODOO_URL: g('ODOO_URL'),
        ODOO_DB: g('ODOO_DB'),
        ODOO_UID: g('ODOO_UID'),
        ODOO_API_KEY: g('ODOO_API_KEY'),
        CORS_ORIGIN: g('CORS_ORIGIN', '*'),
        ODOO_AUTO_VALIDATE: g('ODOO_AUTO_VALIDATE', '1'),
        SHOPIFY_DOMAIN: g('SHOPIFY_DOMAIN'),
        SHOPIFY_ACCESS_TOKEN: g('SHOPIFY_ACCESS_TOKEN'),
        SHOPIFY_REPLICATE_TRANSFERS: g('SHOPIFY_REPLICATE_TRANSFERS', '1'),
        SHOPIFY_API_VERSION: g('SHOPIFY_API_VERSION', 'unstable'),
        SHOPIFY_API_VERSION_LIST: g('SHOPIFY_API_VERSION_LIST'),
        SHOPIFY_STRICT_VERSION: g('SHOPIFY_STRICT_VERSION'),
        SHOPIFY_INPUT_VARIANT: g('SHOPIFY_INPUT_VARIANT', 'origin/destination'),
        SHOPIFY_MUTATION_FIELD: g('SHOPIFY_MUTATION_FIELD', 'inventoryTransfer'),
        SHOPIFY_KRONI_LOCATION_ID: g('SHOPIFY_KRONI_LOCATION_ID'),
        SHOPIFY_CONQUISTA_LOCATION_ID: g('SHOPIFY_CONQUISTA_LOCATION_ID'),
        ODOO_KRONI_TRANSIT_LOCATION_ID: g('ODOO_KRONI_TRANSIT_LOCATION_ID'),
        ODOO_KRONI_TRANSIT_COMPLETE_NAME: g('ODOO_KRONI_TRANSIT_COMPLETE_NAME'),
        ENABLE_MULTI_DRAFTS: g('ENABLE_MULTI_DRAFTS', '1'),
        MAX_DRAFTS_PER_OWNER: g('MAX_DRAFTS_PER_OWNER', '3'),
    }
}

serve(async (req: Request) => {
    const env = envFromDeno()
    const cors = corsHeaders(env)

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

    const url = new URL(req.url)
    // Strip /transfers prefix if present (Supabase routes /functions/v1/transfers/...)
    const path = url.pathname.replace(/^\/transfers/, '').replace(/^\/+/, '/') || '/'

    try {
        mustEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'ODOO_URL', 'ODOO_DB', 'ODOO_UID', 'ODOO_API_KEY'])

        let result: any

        // ── Transfer CRUD ──
        if (req.method === 'POST' && (path === '/' || path === '/create'))
            result = await handleCreateTransfer(req, env)
        else if (req.method === 'POST' && path === '/validate')
            result = await handleValidateTransfer(req, env)
        else if (req.method === 'GET' && path === '/transfer')
            result = await handleGetTransfer(req, env)

        // ── History ──
        else if (req.method === 'GET' && path === '/history')
            result = await handleHistory(req, env)
        else if (req.method === 'GET' && path === '/history/csv')
            result = await handleHistoryCSV(req, env)

        // ── Duplicate ──
        else if (req.method === 'POST' && path === '/duplicate')
            result = await handleDuplicateTransfer(req, env)

        // ── Drafts ──
        else if (req.method === 'GET' && path === '/drafts')
            result = await handleListDrafts(req, env)
        else if (req.method === 'POST' && path === '/drafts')
            result = await handleCreateDraft(req, env)
        else if (req.method === 'PATCH' && path === '/drafts')
            result = await handleUpdateDraft(req, env)
        else if (req.method === 'DELETE' && path === '/drafts')
            result = await handleDeleteDraft(req, env)
        else if (req.method === 'POST' && path === '/drafts/commit')
            result = await handleCommitDraft(req, env)

        // ── Logs ──
        else if (req.method === 'GET' && path === '/logs')
            result = await handleGetLogs(req, env)

        // ── Locations ──
        else if (req.method === 'GET' && path === '/locations')
            result = await handleGetLocations(env)

        // ── Boxes ──
        else if (req.method === 'GET' && path === '/boxes')
            result = await handleListBoxes(req, env)
        else if (req.method === 'GET' && path.startsWith('/boxes/resolve/'))
            result = await handleResolveBox(req, env)
        else if (req.method === 'GET' && path === '/boxes/one')
            result = await handleGetBox(req, env)
        else if (req.method === 'POST' && path === '/boxes')
            result = await handleCreateBox(req, env)
        else if (req.method === 'PATCH' && path === '/boxes')
            result = await handleUpdateBox(req, env)
        else if (req.method === 'DELETE' && path === '/boxes')
            result = await handleDeleteBox(req, env)

        // ── Health ──
        else if (req.method === 'GET' && path === '/health')
            result = await handleHealth(env)

        // ── 404 ──
        else
            return json({ error: 'Not found', path }, { status: 404, headers: cors } as any)

        // Handle special returns (CSV)
        if (result && result.csv) {
            return new Response(result.csv, { headers: { ...cors, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="transfers.csv"' } })
        }

        const status = result?.status || 200
        const body = result?.error ? { error: result.error } : (result?.data ?? result)
        return json(body, { status, headers: cors } as any)

    } catch (e: any) {
        console.error('Edge Function error:', e)
        return json({ error: e.message || 'Internal error' }, { status: 500, headers: cors } as any)
    }
})
