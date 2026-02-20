// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ===== ENV =====
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHOPIFY_DOMAIN = Deno.env.get("SHOPIFY_DOMAIN") ?? "";
const SHOPIFY_ACCESS_TOKEN = Deno.env.get("SHOPIFY_ACCESS_TOKEN") ?? "";
const SHOPIFY_WEBHOOK_SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") ?? "";

const ODOO_URL = Deno.env.get("ODOO_URL") ?? "";
const ODOO_DB = Deno.env.get("ODOO_DB") ?? "";
const ODOO_UID = Deno.env.get("ODOO_UID") ?? "";
const ODOO_API_KEY = Deno.env.get("ODOO_API_KEY") ?? "";

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const SHOPIFY_API = `https://${SHOPIFY_DOMAIN}/admin/api/2024-10`;

// ===== Helpers =====
function json(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function hasServiceRoleAuth(req: Request) {
    const authHeader = (req.headers.get("authorization") ?? "").trim();
    const token = authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : "";
    if (!SUPABASE_SERVICE_ROLE_KEY) return false;
    return token === SUPABASE_SERVICE_ROLE_KEY;
}

function nextPageUrl(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
    return m ? m[1] : null;
}

function extractNumericId(gid: string): number {
    // "gid://shopify/Location/98632499512" -> 98632499512
    const parts = gid.split("/");
    return Number(parts[parts.length - 1] || 0);
}

function buildAddressLine(loc: any): string {
    const parts = [loc.address1, loc.address2, loc.city, loc.province, loc.zip, loc.country_name || loc.country]
        .filter((p) => p && String(p).trim());
    return parts.join(", ");
}

// ===== Shopify REST =====
async function shopifyGet(url: string) {
    const res = await fetch(url, {
        headers: {
            "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
            "Content-Type": "application/json",
        },
    });
    if (!res.ok) throw new Error(`Shopify GET ${url} -> ${res.status}`);
    const data = await res.json();
    const link = res.headers.get("Link") || res.headers.get("link");
    return { data, next: nextPageUrl(link) };
}

async function fetchAllShopifyLocations() {
    const out: any[] = [];
    let url = `${SHOPIFY_API}/locations.json`;
    while (true) {
        const { data, next } = await shopifyGet(url);
        out.push(...(data?.locations ?? []));
        if (!next) break;
        url = next.startsWith("http") ? next : `${SHOPIFY_API}${next}`;
    }
    return out;
}

// ===== Resolve myshopify.com domain =====
// GraphQL MUST use the .myshopify.com domain. Custom domains (e.g. aromante.mx)
// return a 301 redirect that strips the POST body, breaking GraphQL.
let _cachedMyshopifyDomain: string | null = null;

async function getMyshopifyDomain(): Promise<string> {
    if (_cachedMyshopifyDomain) return _cachedMyshopifyDomain;

    // Try fetching shop.json from the REST API (follows redirects fine)
    try {
        const res = await fetch(`${SHOPIFY_API}/shop.json`, {
            headers: {
                "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
            redirect: "follow",
        });
        if (res.ok) {
            const data = await res.json();
            const domain = data?.shop?.myshopify_domain;
            if (domain) {
                _cachedMyshopifyDomain = domain;
                console.log(`Resolved myshopify domain: ${domain}`);
                return domain;
            }
        }
    } catch (e: any) {
        console.warn("Failed to resolve myshopify domain from shop.json:", e.message);
    }

    // Fallback: use SHOPIFY_DOMAIN as-is
    _cachedMyshopifyDomain = SHOPIFY_DOMAIN;
    return SHOPIFY_DOMAIN;
}

// ===== Shopify GraphQL (for fulfillment details) =====
async function fetchLocationFulfillmentDetails(): Promise<Map<number, any>> {
    const myshopifyDomain = await getMyshopifyDomain();

    const query = `{
    locations(first: 50) {
      edges {
        node {
          id
          name
          isActive
          fulfillsOnlineOrders
          shipsInventory
          fulfillmentService { serviceName type }
          localPickupSettingsV2 { instructions pickupTime }
          address { address1 city countryCode formatted }
        }
      }
    }
  }`;

    const res = await fetch(`https://${myshopifyDomain}/admin/api/2024-10/graphql.json`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query }),
    });
    const jsonData = await res.json();
    const edges = jsonData?.data?.locations?.edges ?? [];

    const map = new Map<number, any>();
    for (const edge of edges) {
        const node = edge?.node;
        if (!node?.id) continue;
        const numericId = extractNumericId(node.id);
        map.set(numericId, {
            fulfillsOnlineOrders: node.fulfillsOnlineOrders ?? false,
            isActive: node.isActive ?? true,
            // localPickupSettingsV2 is null when pickup is disabled, non-null when enabled
            localPickupEnabled: node.localPickupSettingsV2 != null,
            shipsInventory: node.shipsInventory ?? false,
            fulfillmentServiceType: node.fulfillmentService?.type ?? null,
            hasPhysicalAddress: Boolean(node.address?.address1),
        });
    }
    return map;
}

// ===== Odoo JSON-RPC =====
let _odooUid: number | null = null;

async function odooAuthenticate(): Promise<number> {
    if (_odooUid) return _odooUid;
    // If ODOO_UID is already numeric, use it directly
    const parsed = Number(ODOO_UID);
    if (!isNaN(parsed) && parsed > 0) {
        _odooUid = parsed;
        return _odooUid;
    }
    // Otherwise authenticate with email to get numeric UID
    const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "call",
        params: {
            service: "common",
            method: "authenticate",
            args: [ODOO_DB, ODOO_UID, ODOO_API_KEY, {}],
        },
    };
    const res = await fetch(`${ODOO_URL}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data?.error) throw new Error(`Odoo auth error: ${JSON.stringify(data.error)}`);
    const uid = data?.result;
    if (!uid || typeof uid !== "number") throw new Error(`Odoo auth failed – got uid: ${uid}`);
    _odooUid = uid;
    console.log(`Odoo authenticated: ${ODOO_UID} -> uid ${uid}`);
    return uid;
}

async function odooRpc(method: string, args: any[]) {
    const uid = await odooAuthenticate();
    const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "call",
        params: {
            service: "object",
            method: "execute_kw",
            args: [ODOO_DB, uid, ODOO_API_KEY, ...args],
        },
    };
    const res = await fetch(`${ODOO_URL}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data?.error) throw new Error(`Odoo RPC error: ${JSON.stringify(data.error)}`);
    return data?.result;
}

async function fetchOdooLocations() {
    const fields = ["name", "complete_name", "barcode", "location_id", "usage"];
    const records = await odooRpc("execute_kw", [
        "stock.location",
        "search_read",
        [[["usage", "=", "internal"]]],
        { fields, limit: 100 },
    ]);
    return records ?? [];
}

// ===== Webhook verify =====
async function verifyShopifyWebhook(req: Request, rawBody: Uint8Array) {
    const url = new URL(req.url);
    if (url.searchParams.get("insecure") === "1") return true;
    const hmacHeader = req.headers.get("x-shopify-hmac-sha256") ?? "";
    if (!SHOPIFY_WEBHOOK_SECRET) return true;
    if (!hmacHeader) return false;

    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(SHOPIFY_WEBHOOK_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, rawBody);
    const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return computed === hmacHeader;
}

// ===== Upsert logic =====
function shopifyLocationToRow(loc: any, graphqlData?: any) {
    const numericId = Number(loc.id);
    const gid = `gid://shopify/Location/${numericId}`;

    // Parent toggle: "Preparación de pedidos"
    const fulfillsOnlineOrders = graphqlData?.fulfillsOnlineOrders ?? false;

    // Child flags (only meaningful when parent is true)
    // Envío = shipsInventory
    const fulfillsShipping = fulfillsOnlineOrders ? (graphqlData?.shipsInventory ?? false) : false;
    // Retiro en tienda = localPickupSettingsV2 != null
    const fulfillsPickup = fulfillsOnlineOrders ? (graphqlData?.localPickupEnabled ?? false) : false;

    // NOTE: fulfills_local_delivery and is_physical are NOT in GraphQL.
    // They are excluded from the upsert so manual values are preserved.

    return {
        id: numericId,
        gid,
        name: loc.name ?? "",
        address_line: buildAddressLine(loc),
        fulfills_online_orders: fulfillsOnlineOrders,
        fulfills_shipping: fulfillsShipping,
        fulfills_pickup: fulfillsPickup,
        is_active: loc.active ?? true,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
}

async function upsertShopifyLocation(row: any) {
    const { error } = await supa
        .from("shopify_locations")
        .upsert([row], { onConflict: "id" });
    if (error) throw error;
}

async function softDeleteShopifyLocation(locationId: number) {
    const { error } = await supa
        .from("shopify_locations")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", locationId);
    if (error) throw error;
}

async function upsertOdooLocation(record: any) {
    const row = {
        id: record.id,
        name: record.name ?? "",
        complete_name: record.complete_name ?? null,
        barcode: record.barcode ?? null,
        parent_id: record.location_id ? (Array.isArray(record.location_id) ? record.location_id[0] : record.location_id) : null,
        parent_name: record.location_id ? (Array.isArray(record.location_id) ? record.location_id[1] : null) : null,
        usage: record.usage ?? "internal",
        synced_at: new Date().toISOString(),
    };
    const { error } = await supa
        .from("odoo_locations")
        .upsert([row], { onConflict: "id" });
    if (error) throw error;
    return row;
}

// ===== Handlers =====
async function handleShopifyFullSync() {
    const locations = await fetchAllShopifyLocations();

    // Get GraphQL details for fulfillment capabilities
    let graphqlMap = new Map<number, any>();
    try {
        graphqlMap = await fetchLocationFulfillmentDetails();
    } catch (e: any) {
        console.warn("GraphQL fulfillment query failed, using REST-only data:", e.message);
    }

    let upserted = 0;
    for (const loc of locations) {
        const numericId = Number(loc.id);
        const graphqlData = graphqlMap.get(numericId);
        const row = shopifyLocationToRow(loc, graphqlData);
        await upsertShopifyLocation(row);
        upserted++;
    }

    return { mode: "shopify_full", locations_seen: locations.length, upserted };
}

async function handleOdooFullSync() {
    const records = await fetchOdooLocations();
    let upserted = 0;

    for (const record of records) {
        await upsertOdooLocation(record);
        upserted++;
    }

    // Try to auto-match with shopify_locations by name similarity
    const { data: shopifyLocs } = await supa.from("shopify_locations").select("id, name");
    const { data: odooLocs } = await supa.from("odoo_locations").select("id, complete_name, name, shopify_location_id");

    const matched: string[] = [];
    if (shopifyLocs && odooLocs) {
        for (const odoo of odooLocs) {
            if (odoo.shopify_location_id) continue; // already mapped
            const completeLower = (odoo.complete_name ?? "").toLowerCase();
            const odooNameLower = (odoo.name ?? "").toLowerCase();

            for (const shop of shopifyLocs) {
                const shopLower = (shop.name ?? "").toLowerCase();
                // Simple heuristic: if shopify name appears in odoo complete_name or vice versa
                if (completeLower.includes(shopLower) || shopLower.includes(odooNameLower)) {
                    await supa
                        .from("odoo_locations")
                        .update({ shopify_location_id: shop.id })
                        .eq("id", odoo.id);
                    matched.push(`${odoo.complete_name} -> ${shop.name} (${shop.id})`);
                    break;
                }
            }
        }
    }

    return { mode: "odoo_full", records_seen: records.length, upserted, auto_matched: matched };
}

async function handleWebhook(req: Request) {
    const raw = new Uint8Array(await req.arrayBuffer());
    const ok = await verifyShopifyWebhook(req, raw);
    if (!ok) return json({ ok: false, error: "invalid hmac" }, 401);

    const topic = (req.headers.get("x-shopify-topic") ?? "").toLowerCase();
    const payload = JSON.parse(new TextDecoder().decode(raw));

    if (topic === "locations/create" || topic === "locations/update") {
        const numericId = Number(payload?.id ?? 0);
        if (!numericId) return json({ ok: true, topic, skipped: true });

        // Get GraphQL details for this specific location
        let graphqlMap = new Map<number, any>();
        try {
            graphqlMap = await fetchLocationFulfillmentDetails();
        } catch (e: any) {
            console.warn("GraphQL failed:", e.message);
        }

        const row = shopifyLocationToRow(payload, graphqlMap.get(numericId));
        await upsertShopifyLocation(row);

        return json({ ok: true, topic, location_id: numericId, action: "upserted" });
    }

    if (topic === "locations/delete") {
        const numericId = Number(payload?.id ?? 0);
        if (!numericId) return json({ ok: true, topic, skipped: true });

        await softDeleteShopifyLocation(numericId);
        return json({ ok: true, topic, location_id: numericId, action: "soft_deleted" });
    }

    return json({ ok: true, topic, ignored: true });
}

// ===== HTTP =====
serve(async (req) => {
    try {
        const url = new URL(req.url);
        const isWebhook = req.method === "POST" && url.searchParams.get("webhook") === "1";

        // Webhooks bypass auth
        if (isWebhook) {
            return await handleWebhook(req);
        }

        // All other endpoints require service role auth
        if (!hasServiceRoleAuth(req)) {
            return json({ ok: false, error: "Unauthorized" }, 401);
        }

        if (req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            const mode = String(body?.mode ?? "").toLowerCase();

            if (mode === "full" || mode === "shopify_full") {
                const result = await handleShopifyFullSync();
                return json({ ok: true, ...result });
            }

            if (mode === "odoo" || mode === "odoo_full") {
                const result = await handleOdooFullSync();
                return json({ ok: true, ...result });
            }

            if (mode === "all") {
                const shopify = await handleShopifyFullSync();
                const odoo = await handleOdooFullSync();
                return json({ ok: true, shopify, odoo });
            }

            return json({ ok: false, error: `Unknown mode: ${mode}. Use: full, odoo, all` }, 400);
        }

        if (req.method === "GET") {
            // Health / info
            const { data: shopifyCount } = await supa.from("shopify_locations").select("id", { count: "exact", head: true });
            const { data: odooCount } = await supa.from("odoo_locations").select("id", { count: "exact", head: true });

            return json({
                ok: true,
                name: "shopify_locations",
                tables: {
                    shopify_locations: "Shopify locations (PK = Shopify numeric ID)",
                    odoo_locations: "Odoo stock.location (PK = Odoo ID)",
                },
                routes: {
                    "POST full": '{ "mode": "full" } - Sync all Shopify locations',
                    "POST odoo": '{ "mode": "odoo" } - Sync all Odoo locations',
                    "POST all": '{ "mode": "all" } - Sync both',
                    "POST webhook": "?webhook=1 - Shopify webhook",
                },
                config: {
                    has_shopify: Boolean(SHOPIFY_DOMAIN && SHOPIFY_ACCESS_TOKEN),
                    has_odoo: Boolean(ODOO_URL && ODOO_API_KEY),
                },
            });
        }

        return json({ ok: false, error: "method not allowed" }, 405);
    } catch (e: any) {
        console.error(e);
        return json({ ok: false, error: e?.message ?? "error" }, 500);
    }
});
