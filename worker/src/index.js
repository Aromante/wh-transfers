(() => {
    var __defProp = Object.defineProperty;
    var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

    // src/index.ts
    var ALLOWED_LOCATION_CODES = [
        "WH/Existencias",
        "KRONI/Existencias",
        "P-CEI/Existencias",
        "P-CON/Existencias"
    ];
    function corsHeaders(origin) {
        return {
            "Access-Control-Allow-Origin": origin || "*",
            "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id"
        };
    }
    __name(corsHeaders, "corsHeaders");
    function json(data, init = {}) {
        const body = JSON.stringify(data);
        return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", ...init.headers || {} }, status: init.status || 200 });
    }
    __name(json, "json");
    async function handleOptions(_req, env) {
        return new Response(null, { headers: corsHeaders(env.CORS_ORIGIN) });
    }
    __name(handleOptions, "handleOptions");
    function missingEnv(env) {
        const req = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE", "ODOO_URL", "ODOO_DB", "ODOO_UID", "ODOO_API_KEY"];
        return req.filter((k) => !env[k] || String(env[k]).trim() === "");
    }
    __name(missingEnv, "missingEnv");
    async function odooExecuteKw(env, model, method, args = [], kwargs = {}) {
        const miss = missingEnv(env);
        if (miss.length) throw new Error(`Faltan variables de entorno: ${miss.join(", ")}`);
        const base = String(env.ODOO_URL).replace(/\/$/, "");
        const payload = {
            jsonrpc: "2.0",
            method: "call",
            params: {
                service: "object",
                method: "execute_kw",
                args: [env.ODOO_DB, Number(env.ODOO_UID), env.ODOO_API_KEY, model, method, args, kwargs]
            },
            id: Math.floor(Math.random() * 1e6)
        };
        const resp = await fetch(`${base}/jsonrpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error) {
            throw new Error(`Odoo error: ${JSON.stringify(data.error || data)}`);
        }
        return data.result;
    }
    __name(odooExecuteKw, "odooExecuteKw");
    async function odooSearch(env, model, domain, kwargs = {}) {
        return odooExecuteKw(env, model, "search", [domain], kwargs);
    }
    __name(odooSearch, "odooSearch");
    async function odooRead(env, model, ids, fields) {
        return odooExecuteKw(env, model, "read", [ids, fields]);
    }
    __name(odooRead, "odooRead");
    async function findInternalPickingType(env) {
        const ids = await odooSearch(env, "stock.picking.type", [["code", "=", "internal"]]);
        if (!ids?.length) throw new Error("No se encontr\xF3 picking type interno (code=internal)");
        return ids[0];
    }
    __name(findInternalPickingType, "findInternalPickingType");
    async function findLocationIdByCompleteName(env, code) {
        const ids = await odooSearch(env, "stock.location", [["complete_name", "=", code]]);
        if (!ids?.length) throw new Error(`Ubicaci\xF3n no encontrada en Odoo: ${code}`);
        return ids[0];
    }
    __name(findLocationIdByCompleteName, "findLocationIdByCompleteName");
    async function findProductsByCodes(env, codesIn) {
        const codes = Array.from(new Set(codesIn.map((c) => String(c || "").trim()).filter(Boolean)));
        const map = /* @__PURE__ */ new Map();
        for (const part of chunk(codes, 80)) {
            const domain = ["|", ["barcode", "in", part], ["default_code", "in", part]];
            const rows = await odooExecuteKw(env, "product.product", "search_read", [domain], { fields: ["id", "display_name", "uom_id", "barcode", "default_code"], limit: 2e3 });
            for (const row of rows || []) {
                const uomId = Array.isArray(row.uom_id) ? row.uom_id[0] : row.uom_id;
                const val = { id: Number(row.id), name: String(row.display_name || ""), uom_id: Number(uomId) };
                const bc = String(row.barcode || "").trim();
                const sku = String(row.default_code || "").trim();
                if (bc && !map.has(bc)) map.set(bc, val);
                if (sku && !map.has(sku)) map.set(sku, val);
            }
        }
        return map;
    }
    __name(findProductsByCodes, "findProductsByCodes");
    async function odooWrite(env, model, ids, vals) {
        return odooExecuteKw(env, model, "write", [ids, vals]);
    }
    __name(odooWrite, "odooWrite");
    async function odooCreate(env, model, vals) {
        return odooExecuteKw(env, model, "create", [vals]);
    }
    __name(odooCreate, "odooCreate");
    async function validatePicking(env, pickingId) {
        const action = await odooExecuteKw(env, "stock.picking", "button_validate", [[pickingId]], { context: { skip_backorder: true } });
        if (action === true) return true;
        if (action && typeof action === "object") {
            const resModel = action.res_model;
            const resId = action.res_id;
            if (resModel === "stock.immediate.transfer") {
                if (resId) {
                    await odooExecuteKw(env, "stock.immediate.transfer", "process", [[resId]]);
                    return true;
                }
                const wizId = await odooCreate(env, "stock.immediate.transfer", { pick_ids: [[6, 0, [pickingId]]] });
                await odooExecuteKw(env, "stock.immediate.transfer", "process", [[wizId]]);
                return true;
            }
            if (resModel === "stock.backorder.confirmation") {
                if (resId) {
                    await odooExecuteKw(env, "stock.backorder.confirmation", "process", [[resId]]);
                    return true;
                }
                const wizId = await odooCreate(env, "stock.backorder.confirmation", { pick_ids: [[6, 0, [pickingId]]] });
                await odooExecuteKw(env, "stock.backorder.confirmation", "process", [[wizId]]);
                return true;
            }
        }
        const pickRows = await odooRead(env, "stock.picking", [pickingId], ["move_ids_without_package"]);
        const pick = pickRows?.[0] || {};
        const moveIds = Array.isArray(pick.move_ids_without_package) ? pick.move_ids_without_package : [];
        if (moveIds.length) {
            const moves = await odooRead(env, "stock.move", moveIds, ["id", "product_id", "product_uom", "product_uom_qty", "location_id", "location_dest_id", "move_line_ids"]);
            for (const mv of moves) {
                const lineIds = Array.isArray(mv.move_line_ids) ? mv.move_line_ids : [];
                if (lineIds.length) {
                    for (const lid of lineIds) {
                        await odooWrite(env, "stock.move.line", [lid], { qty_done: Number(mv.product_uom_qty) || 0 });
                    }
                } else {
                    const productId = Array.isArray(mv.product_id) ? mv.product_id[0] : mv.product_id;
                    const uomId = Array.isArray(mv.product_uom) ? mv.product_uom[0] : mv.product_uom;
                    const locId = Array.isArray(mv.location_id) ? mv.location_id[0] : mv.location_id;
                    const dstId = Array.isArray(mv.location_dest_id) ? mv.location_dest_id[0] : mv.location_dest_id;
                    await odooCreate(env, "stock.move.line", {
                        picking_id: pickingId,
                        move_id: mv.id,
                        product_id: Number(productId),
                        product_uom_id: Number(uomId),
                        qty_done: Number(mv.product_uom_qty) || 0,
                        location_id: Number(locId),
                        location_dest_id: Number(dstId)
                    });
                }
            }
            const action2 = await odooExecuteKw(env, "stock.picking", "button_validate", [[pickingId]], { context: { skip_backorder: true } });
            if (action2 === true) return true;
            if (action2 && typeof action2 === "object") {
                const resModel2 = action2.res_model;
                const resId2 = action2.res_id;
                if (resModel2 === "stock.immediate.transfer") {
                    if (resId2) await odooExecuteKw(env, "stock.immediate.transfer", "process", [[resId2]]);
                    else {
                        const wizId = await odooCreate(env, "stock.immediate.transfer", { pick_ids: [[6, 0, [pickingId]]] });
                        await odooExecuteKw(env, "stock.immediate.transfer", "process", [[wizId]]);
                    }
                    return true;
                }
                if (resModel2 === "stock.backorder.confirmation") {
                    if (resId2) await odooExecuteKw(env, "stock.backorder.confirmation", "process", [[resId2]]);
                    else {
                        const wizId = await odooCreate(env, "stock.backorder.confirmation", { pick_ids: [[6, 0, [pickingId]]] });
                        await odooExecuteKw(env, "stock.backorder.confirmation", "process", [[wizId]]);
                    }
                    return true;
                }
            }
        }
        return false;
    }
    __name(validatePicking, "validatePicking");
    function sbHeaders(env) {
        return {
            "content-type": "application/json",
            apikey: env.SUPABASE_SERVICE_ROLE,
            authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`
        };
    }
    __name(sbHeaders, "sbHeaders");
    function boolFlag(v, def) {
        const s = String(v ?? "").toLowerCase();
        if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
        if (s === "0" || s === "false" || s === "no" || s === "off") return false;
        return def;
    }
    __name(boolFlag, "boolFlag");
    function getOwner(req) {
        const h = req.headers.get("X-User-Id") || req.headers.get("x-user-id");
        return h && h.trim() || "anonymous";
    }
    __name(getOwner, "getOwner");
    async function sbInsert(env, table, rows) {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
            method: "POST",
            headers: { ...sbHeaders(env), prefer: "return=representation" },
            body: JSON.stringify(rows)
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
    }
    __name(sbInsert, "sbInsert");
    async function sbUpsertForecastingTodayStrict(env, items) {
        const clean = items.map((it) => ({ sku: String(it.sku || "").trim(), location_id: Number(it.location_id), in_transit_units: Number(it.in_transit_units || 0) })).filter((it) => it.sku.length > 0 && Number.isFinite(it.location_id) && it.location_id > 0);
        const results = [];
        for (const row of clean) {
            const q = new URLSearchParams();
            q.set("sku", `eq.${row.sku}`);
            q.set("location_id", `eq.${String(row.location_id)}`);
            const patchUrl = `${env.SUPABASE_URL}/rest/v1/forecasting_inventory_today?${q.toString()}`;
            const rPatch = await fetch(patchUrl, {
                method: "PATCH",
                headers: { ...sbHeaders(env), prefer: "return=representation" },
                body: JSON.stringify({ in_transit_units: row.in_transit_units })
            });
            if (rPatch.ok) {
                const body = await rPatch.json().catch(() => []);
                if (Array.isArray(body) && body.length > 0) {
                    results.push(body);
                    continue;
                }
            }
            const rPost = await fetch(`${env.SUPABASE_URL}/rest/v1/forecasting_inventory_today`, {
                method: "POST",
                headers: { ...sbHeaders(env), prefer: "return=representation" },
                body: JSON.stringify([row])
            });
            if (!rPost.ok) {
                const errTxt = await rPost.text().catch(() => "");
                throw new Error(`forecasting strict upsert failed: row=${JSON.stringify(row)} ; post=${errTxt}`);
            }
            results.push(await rPost.json());
        }
        return results.flat();
    }
    __name(sbUpsertForecastingTodayStrict, "sbUpsertForecastingTodayStrict");
    async function sbGetByClientId(env, clientId) {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?client_transfer_id=eq.${encodeURIComponent(clientId)}&select=id,odoo_picking_id,picking_name,status`, {
            method: "GET",
            headers: sbHeaders(env)
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
    }
    __name(sbGetByClientId, "sbGetByClientId");
    async function sbGetTransfer(env, id) {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?id=eq.${encodeURIComponent(id)}&select=*`, { method: "GET", headers: sbHeaders(env) });
        if (!r.ok) throw new Error(await r.text());
        const rows = await r.json();
        return rows?.[0] || null;
    }
    __name(sbGetTransfer, "sbGetTransfer");
    async function sbGetTransferLines(env, id) {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_lines?transfer_id=eq.${encodeURIComponent(id)}&select=id,barcode,sku,qty,product_id`, { method: "GET", headers: sbHeaders(env) });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
    }
    __name(sbGetTransferLines, "sbGetTransferLines");
    async function sbUpdateTransfer(env, id, patch) {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?id=eq.${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { ...sbHeaders(env), prefer: "return=representation" },
            body: JSON.stringify(patch)
        });
        if (!r.ok) throw new Error(await r.text());
        const rows = await r.json();
        return rows?.[0] || null;
    }
    __name(sbUpdateTransfer, "sbUpdateTransfer");
    async function sbDelete(env, table, qp) {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${qp}`, { method: "DELETE", headers: sbHeaders(env) });
        if (!r.ok) throw new Error(await r.text());
        return true;
    }
    __name(sbDelete, "sbDelete");
    function parseListParam(v) {
        const s = String(v ?? "").trim();
        if (!s) return [];
        return s.split(",").map((x) => x.trim()).filter(Boolean);
    }
    __name(parseListParam, "parseListParam");
    async function sbInsertShopifyDraft(env, draft) {
        return sbInsert(env, "shopify_transfer_drafts", [draft]);
    }
    __name(sbInsertShopifyDraft, "sbInsertShopifyDraft");
    async function shopifyGraphQL(env, query, variables) {
        if (!env.SHOPIFY_STORE || !env.SHOPIFY_ACCESS_TOKEN) throw new Error("Shopify no configurado");
        const ver = String(env.SHOPIFY_API_VERSION || "2023-10");
        const url = `https://${env.SHOPIFY_STORE}/admin/api/${ver}/graphql.json`;
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN
            },
            body: JSON.stringify({ query, variables })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.errors) throw new Error(`Shopify error: ${JSON.stringify(data.errors || data)}`);
        return data.data;
    }
    __name(shopifyGraphQL, "shopifyGraphQL");
    function gidToLegacyId(gidOrId) {
        const s = String(gidOrId);
        const m = s.match(/\/(\d+)$/);
        return m ? m[1] : s;
    }
    __name(gidToLegacyId, "gidToLegacyId");
    async function shopifyRest(env, path, params) {
        if (!env.SHOPIFY_STORE || !env.SHOPIFY_ACCESS_TOKEN) throw new Error("Shopify no configurado");
        const usp = new URLSearchParams();
        if (params) {
            for (const [k, v] of Object.entries(params)) if (v !== void 0 && v !== null && v !== "") usp.set(k, String(v));
        }
        const ver = String(env.SHOPIFY_API_VERSION || "2023-10");
        const url = `https://${env.SHOPIFY_STORE}/admin/api/${ver}${path}${usp.toString() ? `?${usp.toString()}` : ""}`;
        const r = await fetch(url, { headers: { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN, "content-type": "application/json" } });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`Shopify REST error: ${r.status} ${JSON.stringify(data)}`);
        return data;
    }
    __name(shopifyRest, "shopifyRest");
    async function shopifyGraphQLWithVersion(env, apiVersion, query, variables) {
        if (!env.SHOPIFY_STORE || !env.SHOPIFY_ACCESS_TOKEN) throw new Error("Shopify no configurado");
        const ver = String(apiVersion || env.SHOPIFY_API_VERSION || "2023-10");
        const url = `https://${env.SHOPIFY_STORE}/admin/api/${ver}/graphql.json`;
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN
            },
            body: JSON.stringify({ query, variables })
        });
        const data = await resp.json().catch(() => ({}));
        return { ok: resp.ok && !(data && data.errors), raw: data, status: resp.status };
    }
    __name(shopifyGraphQLWithVersion, "shopifyGraphQLWithVersion");
    async function getShopifyLocationGid(env, code) {
        if (code === "P-CON/Existencias" && env.SHOPIFY_CONQUISTA_LOCATION_ID) {
            const id2 = env.SHOPIFY_CONQUISTA_LOCATION_ID;
            if (String(id2).startsWith("gid://")) return id2;
            return `gid://shopify/Location/${id2}`;
        }
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_locations?code=eq.${encodeURIComponent(code)}&select=shopify_location_id`, { method: "GET", headers: sbHeaders(env) });
        if (!r.ok) throw new Error(await r.text());
        const rows = await r.json();
        const id = rows?.[0]?.shopify_location_id;
        if (!id) throw new Error(`Falta shopify_location_id para ubicaci\xF3n ${code}`);
        if (String(id).startsWith("gid://")) return id;
        return `gid://shopify/Location/${id}`;
    }
    __name(getShopifyLocationGid, "getShopifyLocationGid");
    function chunk(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }
    __name(chunk, "chunk");
    function normCode(code) {
        return String(code || "").trim();
    }
    __name(normCode, "normCode");
    async function resolveVariantsBatch(env, codesIn) {
        const codes = Array.from(new Set(codesIn.map(normCode).filter(Boolean)));
        const map = /* @__PURE__ */ new Map();
        for (const part of chunk(codes, 40)) {
            const orTerms = part.map((c) => `(barcode:"${c}" OR sku:"${c}")`).join(" OR ");
            const q = `query{ productVariants(first:250, query: ${JSON.stringify(orTerms)}) { edges { node { id sku barcode inventoryItem { id } } } } }`;
            const data = await shopifyGraphQL(env, q);
            const edges = data?.productVariants?.edges || [];
            for (const e of edges) {
                const node = e?.node;
                if (!node) continue;
                const sku = normCode(node.sku);
                const bc = normCode(node.barcode);
                if (sku && part.includes(sku) && !map.has(sku)) map.set(sku, node);
                if (bc && part.includes(bc) && !map.has(bc)) map.set(bc, node);
            }
        }
        return map;
    }
    __name(resolveVariantsBatch, "resolveVariantsBatch");
    async function getAvailableAtLocationBatch(env, inventoryItemGids, locationGid) {
        const locId = gidToLegacyId(locationGid);
        const map = /* @__PURE__ */ new Map();
        const legacyToGid = /* @__PURE__ */ new Map();
        for (const gid of inventoryItemGids) {
            const legacy = String(gidToLegacyId(gid));
            legacyToGid.set(legacy, gid);
        }
        const legacyIds = Array.from(legacyToGid.keys());
        for (const part of chunk(legacyIds, 50)) {
            const data = await shopifyRest(env, "/inventory_levels.json", { inventory_item_ids: part.join(","), location_ids: locId });
            const levels = Array.isArray(data?.inventory_levels) ? data.inventory_levels : [];
            for (const lvl of levels) {
                const itemLegacy = String(lvl?.inventory_item_id);
                const gid = legacyToGid.get(itemLegacy);
                if (gid) map.set(gid, Number(lvl?.available ?? 0));
            }
        }
        return map;
    }
    __name(getAvailableAtLocationBatch, "getAvailableAtLocationBatch");
    async function createShopifyTransferDraft(env, originLocGid, destLocGid, lines) {
        const baseLines = lines.map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantity }));
        let inputs = [
            { key: "origin/destination", val: { originLocationId: originLocGid, destinationLocationId: destLocGid, lineItems: baseLines } },
            { key: "from/to", val: { fromLocationId: originLocGid, toLocationId: destLocGid, lineItems: baseLines } },
            { key: "source/destination", val: { sourceLocationId: originLocGid, destinationLocationId: destLocGid, lineItems: baseLines } }
        ];
        const forcedInput = String(env.SHOPIFY_INPUT_VARIANT || "").toLowerCase();
        if (forcedInput) {
            const mapKey = forcedInput.replace("_", "/").replace("-", "/");
            inputs = inputs.filter((i) => i.key.replace("-", "/") === mapKey);
        }
        let mutations = [
            {
                name: "transfer-field",
                q: `mutation CreateTransfer($input: InventoryTransferCreateInput!) {
  inventoryTransferCreate(input: $input) {
    transfer { id name status }
    userErrors { field message }
  }
}`,
                pick: /* @__PURE__ */ __name((res) => ({ id: res?.inventoryTransferCreate?.transfer?.id, name: res?.inventoryTransferCreate?.transfer?.name, status: res?.inventoryTransferCreate?.transfer?.status, errors: res?.inventoryTransferCreate?.userErrors }), "pick")
            },
            {
                name: "inventoryTransfer-field",
                q: `mutation CreateTransfer($input: InventoryTransferCreateInput!) {
  inventoryTransferCreate(input: $input) {
    inventoryTransfer { id name status }
    userErrors { field message }
  }
}`,
                pick: /* @__PURE__ */ __name((res) => ({ id: res?.inventoryTransferCreate?.inventoryTransfer?.id, name: res?.inventoryTransferCreate?.inventoryTransfer?.name, status: res?.inventoryTransferCreate?.inventoryTransfer?.status, errors: res?.inventoryTransferCreate?.userErrors }), "pick")
            },
            {
                name: "id-only",
                q: `mutation CreateTransfer($input: InventoryTransferCreateInput!) {
  inventoryTransferCreate(input: $input) {
    userErrors { field message }
  }
}`,
                pick: /* @__PURE__ */ __name((res) => ({ id: null, name: null, status: "DRAFT", errors: res?.inventoryTransferCreate?.userErrors }), "pick")
            }
        ];
        const forcedField = String(env.SHOPIFY_MUTATION_FIELD || "").toLowerCase();
        if (forcedField === "transfer") {
            mutations = mutations.filter((m) => m.name === "transfer-field");
        } else if (forcedField === "inventorytransfer") {
            mutations = mutations.filter((m) => m.name === "inventoryTransfer-field");
        }
        let versions = Array.from(new Set([
            String(env.SHOPIFY_API_VERSION || ""),
            ...String(env.SHOPIFY_API_VERSION_LIST || "").split(",").map((s) => s.trim()).filter(Boolean),
            "2025-01",
            "2024-10",
            "2024-07",
            "2024-04",
            "2024-01",
            "2023-10",
            "unstable"
        ].filter(Boolean)));
        const strict = String(env.SHOPIFY_STRICT_VERSION || "0").toLowerCase();
        if (strict === "1" || strict === "true") {
            versions = [String(env.SHOPIFY_API_VERSION || "unstable")];
        }
        const errors = [];
        for (const ver of versions) {
            for (const m of mutations) {
                for (const inp of inputs) {
                    try {
                        const data = await shopifyGraphQLWithVersion(env, ver, m.q, { input: inp.val });
                        if (!data.ok) {
                            errors.push({ version: ver, mutation: m.name, input: inp.key, errors: data.raw?.errors || null });
                            continue;
                        }
                        const resPick = m.pick(data.raw?.data);
                        if (Array.isArray(resPick.errors) && resPick.errors.length) {
                            errors.push({ version: ver, mutation: m.name, input: inp.key, userErrors: resPick.errors });
                            continue;
                        }
                        if (!resPick.id && m.name !== "id-only") {
                            errors.push({ version: ver, mutation: m.name, input: inp.key, msg: "no id returned" });
                            continue;
                        }
                        const id = resPick.id || "unknown";
                        return { id, name: resPick.name || null, status: resPick.status || "DRAFT", meta: { apiVersion: ver, mutation: m.name, input: inp.key } };
                    } catch (e) {
                        errors.push({ version: ver, mutation: m.name, input: inp.key, error: String(e?.message || e) });
                    }
                }
            }
        }
        throw new Error(`Shopify draft creation failed across versions: ${JSON.stringify(errors).slice(0, 4e3)}`);
    }
    __name(createShopifyTransferDraft, "createShopifyTransferDraft");
    async function createTransfer(req, env) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        try {
            const miss = missingEnv(env);
            if (miss.length) return json({ error: `Faltan variables de entorno: ${miss.join(", ")}` }, { status: 500, headers: cors });
            const payload = await req.json().catch(() => ({}));
            const { client_transfer_id, origin_id, dest_id, lines, from_draft_id } = payload || {};
            if ((!client_transfer_id && !from_draft_id) || !origin_id || !dest_id || !Array.isArray(lines) || !lines.length) {
                return json({ error: "payload inv\xE1lido" }, { status: 400, headers: cors });
            }
            if (!ALLOWED_LOCATION_CODES.includes(origin_id) || !ALLOWED_LOCATION_CODES.includes(dest_id)) {
                return json({ error: "Ubicaci\xF3n no permitida" }, { status: 400, headers: cors });
            }
            if (origin_id === dest_id) return json({ error: "Origen y destino no pueden ser iguales" }, { status: 400, headers: cors });

            // Si viene de un draft, verifiquemos que existe y es válido
            if (from_draft_id) {
                const draft = await sbGetTransfer(env, from_draft_id);
                if (!draft) return json({ error: "Borrador no encontrado" }, { status: 404, headers: cors });
                if (draft.status !== 'draft') return json({ error: "El registro no es un borrador (ya procesado o cancelado)" }, { status: 409, headers: cors });
            } else {
                try {
                    const existing = await sbGetByClientId(env, client_transfer_id);
                    if (existing?.length) {
                        return json({ ok: true, id: existing[0].id, odoo_picking_id: existing[0].odoo_picking_id, picking_name: existing[0].picking_name, status: existing[0].status }, { headers: cors });
                    }
                } catch {
                }
            }
            const rawLines = [];
            try {
                for (const ln of lines) {
                    const code = normCode(String(ln.barcode || ln.sku || ""));
                    const qty = Number(ln.qty || 0);
                    if (code && qty > 0) rawLines.push({ code, qty });
                }
            } catch {
            }
            const codeToSku = /* @__PURE__ */ new Map();
            if (env.SHOPIFY_STORE && env.SHOPIFY_ACCESS_TOKEN) {
                try {
                    const locGid = await getShopifyLocationGid(env, origin_id);
                    const codes = rawLines.map((ln) => ln.code);
                    const variantsMap = await resolveVariantsBatch(env, codes);
                    const invItemGids = Array.from(new Set(Array.from(variantsMap.values()).map((v) => v?.inventoryItem?.id).filter(Boolean)));
                    const availMap = await getAvailableAtLocationBatch(env, invItemGids, locGid);
                    const insufficient = [];
                    for (const ln of rawLines) {
                        const code = ln.code;
                        const qty = Number(ln.qty || 0);
                        if (!code || qty <= 0) continue;
                        const variant = variantsMap.get(code);
                        try {
                            const sku = variant?.sku && String(variant.sku).trim() || "";
                            if (sku) codeToSku.set(code, sku);
                        } catch {
                        }
                        if (!variant) {
                            insufficient.push({ code, requested: qty, available: 0, reason: "no_variant" });
                            continue;
                        }
                        const avail = Number(availMap.get(variant.inventoryItem.id) ?? 0);
                        if (avail < qty) insufficient.push({ code, requested: qty, available: avail });
                    }
                    if (insufficient.length) return json({ ok: false, insufficient }, { status: 409, headers: cors });
                } catch (e) {
                    return json({ ok: false, error: `Shopify validation failed: ${String(e?.message || e)}` }, { status: 502, headers: cors });
                }
            }
            const replicateFlag = String(env.SHOPIFY_REPLICATE_TRANSFERS || "1");
            let shopifyDraftCreated = null;
            let originLocGid = null;
            let destLocGid = null;
            let draftLinesCache = [];
            if ((replicateFlag === "1" || replicateFlag.toLowerCase() === "true") && env.SHOPIFY_STORE && env.SHOPIFY_ACCESS_TOKEN && dest_id !== "KRONI/Existencias") {
                try {
                    originLocGid = await getShopifyLocationGid(env, origin_id);
                    destLocGid = await getShopifyLocationGid(env, dest_id);
                    const codesForDraft = rawLines.map((l) => l.code);
                    const variantsMapForDraft = await resolveVariantsBatch(env, codesForDraft);
                    const createLines = [];
                    draftLinesCache = [];
                    for (const ln of rawLines) {
                        const code = ln.code;
                        const qty = Number(ln.qty || 0);
                        if (!code || qty <= 0) continue;
                        const variant = variantsMapForDraft.get(code);
                        const invItemId = variant?.inventoryItem?.id || null;
                        try {
                            const sku = variant?.sku && String(variant.sku).trim() || "";
                            if (sku) codeToSku.set(code, sku);
                        } catch {
                        }
                        draftLinesCache.push({ code, qty, variantId: variant?.id || null, inventoryItemId: invItemId });
                        if (invItemId) createLines.push({ inventoryItemId: invItemId, quantity: qty });
                    }
                    if (!createLines.length) return json({ ok: false, error: "No se pudieron resolver variantes v\xE1lidas para crear el draft en Shopify." }, { status: 422, headers: cors });
                    shopifyDraftCreated = await createShopifyTransferDraft(env, originLocGid, destLocGid, createLines);
                } catch (e) {
                    return json({ ok: false, error: `Shopify draft creation failed: ${String(e?.message || e)}` }, { status: 502, headers: cors });
                }
            }
            const pickingTypeId = await findInternalPickingType(env);
            const srcId = await findLocationIdByCompleteName(env, origin_id);
            let dstId = 0;
            let kroniTransit = false;
            if (dest_id === "KRONI/Existencias") {
                const transitId = Number(env.ODOO_KRONI_TRANSIT_LOCATION_ID || 0);
                if (transitId > 0) dstId = transitId;
                else {
                    const transitName = String(env.ODOO_KRONI_TRANSIT_COMPLETE_NAME || "Physical Locations/Traslado interno a Kroni").trim();
                    dstId = await findLocationIdByCompleteName(env, transitName);
                }
                kroniTransit = true;
            } else {
                dstId = await findLocationIdByCompleteName(env, dest_id);
            }
            const allCodes = lines.map((ln) => String(ln.barcode || ln.sku || "").trim()).filter(Boolean);
            const productsMap = await findProductsByCodes(env, allCodes);
            const resolved = [];
            for (const ln of lines) {
                const code = String(ln.barcode || ln.sku || "").trim();
                const qty = Number(ln.qty || 0);
                if (!code || qty <= 0) continue;
                const prod = productsMap.get(code);
                if (!prod) throw new Error(`Producto no encontrado: ${code}`);
                resolved.push({ product_id: prod.id, name: prod.name, uom_id: prod.uom_id, qty });
            }
            if (!resolved.length) return json({ error: "No hay l\xEDneas v\xE1lidas" }, { status: 400, headers: cors });
            const moveCmds = resolved.map((mv) => [0, 0, {
                name: mv.name,
                product_id: mv.product_id,
                product_uom: mv.uom_id,
                product_uom_qty: mv.qty,
                location_id: srcId,
                location_dest_id: dstId
            }]);
            const pickingVals = {
                picking_type_id: pickingTypeId,
                location_id: srcId,
                location_dest_id: dstId,
                origin: client_transfer_id,
                move_ids_without_package: moveCmds
            };
            if (origin_id === "WH/Existencias" && kroniTransit) {
                pickingVals["x_krn_auto_sync_enabled"] = true;
            }
            const pickingId = await odooExecuteKw(env, "stock.picking", "create", [pickingVals]);
            await odooExecuteKw(env, "stock.picking", "action_confirm", [[pickingId]]);
            try {
                await odooExecuteKw(env, "stock.picking", "action_assign", [[pickingId]]);
            } catch {
            }
            const autoValidate = String(env.ODOO_AUTO_VALIDATE || "1");
            if (autoValidate === "1" || autoValidate.toLowerCase() === "true") {
                try {
                    await validatePicking(env, pickingId);
                } catch (e) {
                }
            }
            const pickRow = await odooRead(env, "stock.picking", [pickingId], ["name", "state"]);
            const pickingName = pickRow?.[0]?.name || String(pickingId);
            const pickingState = pickRow?.[0]?.state || "unknown";

            let transferId = null;
            if (from_draft_id) {
                transferId = from_draft_id;
                // Borrar líneas anteriores del draft para reescribir con las que se enviaron en el request (que son la verdad actual)
                await sbDelete(env, "transfer_lines", `transfer_id=eq.${transferId}`);
                // Actualizar cabecera del draft a estado procesado
                await sbUpdateTransfer(env, transferId, {
                    status: pickingState === "done" ? "validated" : "odoo_created",
                    odoo_picking_id: String(pickingId),
                    picking_name: pickingName,
                    origin_id: origin_id, // Asegurar que coincida con lo enviado
                    dest_id: dest_id
                });
            } else {
                transferId = crypto.randomUUID();
                await sbInsert(env, "transfers", [{
                    id: transferId,
                    client_transfer_id,
                    origin_id,
                    dest_id,
                    status: pickingState === "done" ? "validated" : "odoo_created",
                    odoo_picking_id: String(pickingId),
                    picking_name: pickingName
                }]);
            }

            try {
                const toPersist = rawLines.map((ln) => ({
                    transfer_id: transferId,
                    product_id: null,
                    barcode: ln.code,
                    sku: codeToSku.get(ln.code) || null,
                    qty: ln.qty
                }));
                await sbInsert(env, "transfer_lines", toPersist);
            } catch {
            }
            await sbInsert(env, "transfer_logs", [{ transfer_id: transferId, event: "odoo_created", detail: { pickingId, pickingName, state: pickingState } }]);
            if (origin_id === "WH/Existencias" && kroniTransit) {
                try {
                    await sbInsert(env, "transfer_logs", [{ transfer_id: transferId, event: "odoo_auto_sync_enabled_set", detail: { field: "x_krn_auto_sync_enabled", value: true } }]);
                } catch {
                }
            }
            try {
                if (shopifyDraftCreated && originLocGid && destLocGid) {
                    await sbInsertShopifyDraft(env, {
                        id: crypto.randomUUID(),
                        transfer_id: transferId,
                        origin_code: origin_id,
                        dest_code: dest_id,
                        origin_shopify_location_id: originLocGid,
                        dest_shopify_location_id: destLocGid,
                        lines: draftLinesCache,
                        status: "created",
                        shopify_transfer_id: shopifyDraftCreated.id,
                        notes: `Draft auto creado por wh-transfers (v=${shopifyDraftCreated?.meta?.apiVersion || ""}, m=${shopifyDraftCreated?.meta?.mutation || ""}, input=${shopifyDraftCreated?.meta?.input || ""})`
                    });
                    await sbInsert(env, "transfer_logs", [{ transfer_id: transferId, event: "shopify_draft_created", detail: { shopify_transfer_id: shopifyDraftCreated.id, name: shopifyDraftCreated.name, status: shopifyDraftCreated.status, api_version: shopifyDraftCreated?.meta?.apiVersion, mutation: shopifyDraftCreated?.meta?.mutation, input_variant: shopifyDraftCreated?.meta?.input, origin_gid: originLocGid, dest_gid: destLocGid } }]);
                }
            } catch (e) {
                await sbInsert(env, "transfer_logs", [{ transfer_id: transferId, event: "shopify_draft_error", detail: { error: String(e?.message || e) } }]);
            }
            try {
                if (pickingState === "done" && origin_id === "WH/Existencias" && dest_id === "KRONI/Existencias") {
                    const rLog = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_logs?transfer_id=eq.${encodeURIComponent(transferId)}&event=eq.forecast_in_transit_applied&select=id`, { method: "GET", headers: sbHeaders(env) });
                    if (!rLog.ok) throw new Error(await rLog.text());
                    const existed = await rLog.json();
                    if (!Array.isArray(existed) || existed.length === 0) {
                        const destLocNumeric = 98632499512;
                        await sbInsert(env, "transfer_logs", [{ transfer_id: transferId, event: "forecast_target_location", detail: { chosen_location_id: destLocNumeric, reason: "hardcoded_for_KRONI" } }]);
                        const codesForSku = lines.map((ln) => normCode(String(ln.barcode || ln.sku || ""))).filter(Boolean);
                        let variantsMapForSku = null;
                        try {
                            variantsMapForSku = await resolveVariantsBatch(env, codesForSku);
                        } catch {
                            variantsMapForSku = null;
                        }
                        const items = [];
                        for (const ln of lines) {
                            const code = normCode(String(ln.barcode || ln.sku || ""));
                            const qty = Number(ln.qty || 0);
                            if (!code || qty <= 0) continue;
                            let sku = null;
                            try {
                                const variant = variantsMapForSku?.get(code);
                                sku = variant?.sku && String(variant.sku).trim() || null;
                            } catch {
                            }
                            if (!sku) sku = code;
                            items.push({ sku, location_id: destLocNumeric, in_transit_units: qty });
                        }
                        const up = await sbUpsertForecastingTodayStrict(env, items);
                        await sbInsert(env, "transfer_logs", [{ transfer_id: transferId, event: "forecast_in_transit_applied", detail: { via: "rest_forced_strict", updates: items, result_count: Array.isArray(up) ? up.length : null } }]);
                    }
                }
            } catch (e) {
                await sbInsert(env, "transfer_logs", [{ transfer_id: transferId, event: "forecast_in_transit_error", detail: { error: String(e?.message || e) } }]);
            }
            const resp = { ok: true, id: transferId, odoo_picking_id: String(pickingId), picking_name: pickingName, status: pickingState === "done" ? "validated" : "odoo_created" };
            try {
                const r3 = await fetch(`${env.SUPABASE_URL}/rest/v1/shopify_transfer_drafts?transfer_id=eq.${encodeURIComponent(transferId)}&select=shopify_transfer_id,status`, { method: "GET", headers: sbHeaders(env) });
                if (r3.ok) {
                    const rows = await r3.json();
                    const d = rows?.[0];
                    if (d) resp.shopify_draft = { created: Boolean(d.shopify_transfer_id), id: d.shopify_transfer_id || null, status: d.status };
                }
            } catch {
            }
            return json(resp, { headers: cors });
        } catch (e) {
            return json({ error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(createTransfer, "createTransfer");
    async function getTransfer(_req, env, id) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        try {
            const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?id=eq.${encodeURIComponent(id)}&select=id,client_transfer_id,origin_id,dest_id,status,odoo_picking_id,picking_name,created_at`, { method: "GET", headers: sbHeaders(env) });
            if (!r.ok) throw new Error(await r.text());
            const rows = await r.json();
            return json(rows?.[0] || null, { headers: cors });
        } catch (e) {
            return json({ error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(getTransfer, "getTransfer");
    async function draftsList(req, env) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const owner = getOwner(req);
            const usp = new URL(req.url);
            const limit = Math.max(1, Math.min(3, Number(usp.searchParams.get("limit") || "3")));
            const q = new URLSearchParams();
            q.set("status", "eq.draft");
            q.set("draft_owner", `eq.${owner}`);
            q.set("select", "id,client_transfer_id,origin_id,dest_id,status,draft_title,updated_at,created_at");
            q.set("order", "updated_at.desc");
            q.set("limit", String(limit));
            const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?${q.toString()}`, { headers: sbHeaders(env) });
            if (!r.ok) throw new Error(await r.text());
            const rows = await r.json();
            return json({ ok: true, drafts: rows }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftsList, "draftsList");
    async function draftsCreate(req, env) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const owner = getOwner(req);
            const maxDrafts = Number(env.MAX_DRAFTS_PER_OWNER || "3") || 3;
            const rCount = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?select=id&status=eq.draft&draft_owner=eq.${encodeURIComponent(owner)}`, { headers: sbHeaders(env) });
            if (!rCount.ok) throw new Error(await rCount.text());
            const rows = await rCount.json();
            if (Array.isArray(rows) && rows.length >= maxDrafts) return json({ ok: false, error: `L\xEDmite de borradores alcanzado (${maxDrafts})` }, { status: 409, headers: cors });
            const body = await req.json().catch(() => ({}));
            const { origin_id, dest_id, title, lines } = body || {};
            const clientId = crypto.randomUUID();
            const toInsert = {
                id: crypto.randomUUID(),
                client_transfer_id: clientId,
                origin_id: String(origin_id || ""),
                dest_id: String(dest_id || ""),
                status: "draft",
                draft_owner: owner,
                draft_title: title ? String(title) : null
            };
            const inserted = await sbInsert(env, "transfers", [toInsert]);
            const transferId = inserted?.[0]?.id || toInsert.id;
            if (Array.isArray(lines) && lines.length) {
                const toLines = lines.map((ln) => ({ transfer_id: transferId, barcode: String(ln.barcode || ln.sku || ln.code || ""), sku: ln.sku ? String(ln.sku) : null, qty: Number(ln.qty || 0) })).filter((x) => x.barcode && x.qty > 0);
                if (toLines.length) await sbInsert(env, "transfer_lines", toLines);
            }
            await sbInsert(env, "transfer_logs", [{ transfer_id: transferId, event: "draft_created", detail: { owner, title: toInsert.draft_title || null } }]);
            return json({ ok: true, id: transferId, client_transfer_id: clientId, status: "draft" }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftsCreate, "draftsCreate");
    async function draftsUpdate(req, env, id) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const owner = getOwner(req);
            const tr = await sbGetTransfer(env, id);
            if (!tr) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors });
            if (tr.status !== "draft") return json({ ok: false, error: "not_draft" }, { status: 409, headers: cors });

            // Opcional: Validar que sea el dueño el que edita? Por ahora permitimos si tiene el ID.

            const body = await req.json().catch(() => ({}));
            const { origin_id, dest_id, title, lines } = body || {};

            // Actualizar cabecera
            const patch = {
                origin_id: String(origin_id || tr.origin_id),
                dest_id: String(dest_id || tr.dest_id),
                updated_at: new Date().toISOString()
            };
            if (title !== undefined) patch.draft_title = title ? String(title) : null;

            await sbUpdateTransfer(env, id, patch);

            // Reemplazar líneas: Borrar y Crear nuevas
            if (Array.isArray(lines)) {
                await sbDelete(env, "transfer_lines", `transfer_id=eq.${id}`);
                const toLines = lines.map((ln) => ({ transfer_id: id, barcode: String(ln.barcode || ln.sku || ln.code || ""), sku: ln.sku ? String(ln.sku) : null, qty: Number(ln.qty || 0) })).filter((x) => x.barcode && x.qty > 0);
                if (toLines.length) await sbInsert(env, "transfer_lines", toLines);
            }

            await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "draft_full_update", detail: { owner, lines_count: lines?.length } }]);
            return json({ ok: true, id: id, status: "draft" }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftsUpdate, "draftsUpdate");
    async function draftUpdateMeta(req, env, id) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const tr = await sbGetTransfer(env, id);
            if (!tr) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors });
            if (tr.status !== "draft") return json({ ok: false, error: "not_draft" }, { status: 409, headers: cors });
            const body = await req.json().catch(() => ({}));
            const patch = {};
            if ("title" in body) patch.draft_title = body.title;
            if ("origin_id" in body) patch.origin_id = body.origin_id;
            if ("dest_id" in body) patch.dest_id = body.dest_id;
            const saved = await sbUpdateTransfer(env, id, patch);
            await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "draft_updated", detail: patch }]);
            return json({ ok: true, transfer: saved }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftUpdateMeta, "draftUpdateMeta");
    async function draftGetLines(_req, env, id) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const tr = await sbGetTransfer(env, id);
            if (!tr) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors });
            const rows = await sbGetTransferLines(env, id);
            return json({ ok: true, lines: rows }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftGetLines, "draftGetLines");
    async function draftUpsertLines(req, env, id) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const tr = await sbGetTransfer(env, id);
            if (!tr) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors });
            if (tr.status !== "draft") return json({ ok: false, error: "not_draft" }, { status: 409, headers: cors });
            const body = await req.json().catch(() => ({}));
            const arr = Array.isArray(body) ? body : Array.isArray(body?.lines) ? body.lines : [];
            const items = arr.map((ln) => ({ code: String(ln.code || ln.barcode || ln.sku || ""), qty: Number(ln.qty || 0), sku: ln.sku ? String(ln.sku) : null })).filter((it) => it.code && it.qty > 0);
            if (!items.length) return json({ ok: false, error: "no_lines" }, { status: 400, headers: cors });
            const current = await sbGetTransferLines(env, id);
            const byCode = /* @__PURE__ */ new Map();
            for (const r of current) {
                const key = (r.barcode || r.sku || "").trim();
                if (key) byCode.set(key, r);
            }
            const results = [];
            for (const it of items) {
                const existing = byCode.get(it.code);
                if (existing) {
                    const q = new URLSearchParams();
                    q.set("id", `eq.${existing.id}`);
                    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_lines?${q.toString()}`, { method: "PATCH", headers: { ...sbHeaders(env), prefer: "return=representation" }, body: JSON.stringify({ qty: it.qty, sku: it.sku || null, barcode: existing.barcode || it.code }) });
                    if (!r.ok) throw new Error(await r.text());
                    results.push(await r.json());
                } else {
                    const r = await sbInsert(env, "transfer_lines", [{ transfer_id: id, barcode: it.code, sku: it.sku || null, qty: it.qty }]);
                    results.push(r);
                }
            }
            await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "draft_lines_upserted", detail: { count: items.length } }]);
            return json({ ok: true, updated: results.length }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftUpsertLines, "draftUpsertLines");
    async function draftDeleteLine(_req, env, id, code) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const tr = await sbGetTransfer(env, id);
            if (!tr) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors });
            if (tr.status !== "draft") return json({ ok: false, error: "not_draft" }, { status: 409, headers: cors });
            const q = new URLSearchParams();
            q.set("transfer_id", `eq.${id}`);
            q.set("barcode", `eq.${code}`);
            await sbDelete(env, "transfer_lines", q.toString());
            await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "draft_line_deleted", detail: { code } }]);
            return json({ ok: true }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftDeleteLine, "draftDeleteLine");
    async function draftCancel(_req, env, id) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const tr = await sbGetTransfer(env, id);
            if (!tr) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors });
            if (tr.status !== "draft" && tr.status !== "ready") return json({ ok: false, error: "cannot_cancel" }, { status: 409, headers: cors });
            const saved = await sbUpdateTransfer(env, id, { status: "cancelled" });
            await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "draft_cancelled", detail: {} }]);
            return json({ ok: true, transfer: saved }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftCancel, "draftCancel");
    async function draftValidate(_req, env, id) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const tr = await sbGetTransfer(env, id);
            if (!tr) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors });
            if (tr.status !== "draft" && tr.status !== "ready") return json({ ok: false, error: "not_valid_state" }, { status: 409, headers: cors });
            const origin_id = tr.origin_id;
            const dest_id = tr.dest_id;
            const lines = await sbGetTransferLines(env, id);
            if (!Array.isArray(lines) || lines.length === 0) return json({ ok: false, error: "empty_lines" }, { status: 400, headers: cors });
            const codeToSku = /* @__PURE__ */ new Map();
            if (env.SHOPIFY_STORE && env.SHOPIFY_ACCESS_TOKEN) {
                try {
                    const locGid = await getShopifyLocationGid(env, origin_id);
                    const codes = lines.map((ln) => normCode(String(ln.barcode || ln.sku || ""))).filter(Boolean);
                    const variantsMap = await resolveVariantsBatch(env, codes);
                    const invItemGids = Array.from(new Set(Array.from(variantsMap.values()).map((v) => v?.inventoryItem?.id).filter(Boolean)));
                    const availMap = await getAvailableAtLocationBatch(env, invItemGids, locGid);
                    const insufficient = [];
                    for (const ln of lines) {
                        const code = normCode(String(ln.barcode || ln.sku || ""));
                        const qty = Number(ln.qty || 0);
                        if (!code || qty <= 0) continue;
                        const variant = variantsMap.get(code);
                        try {
                            const sku = variant?.sku && String(variant.sku).trim() || "";
                            if (sku) codeToSku.set(code, sku);
                        } catch {
                        }
                        if (!variant) {
                            insufficient.push({ code, requested: qty, available: 0, reason: "no_variant" });
                            continue;
                        }
                        const avail = Number(availMap.get(variant.inventoryItem.id) ?? 0);
                        if (avail < qty) insufficient.push({ code, requested: qty, available: avail });
                    }
                    if (insufficient.length) return json({ ok: false, insufficient }, { status: 409, headers: cors });
                } catch (e) {
                    return json({ ok: false, error: `Shopify validation failed: ${String(e?.message || e)}` }, { status: 502, headers: cors });
                }
            }
            try {
                for (const ln of lines) {
                    const code = normCode(String(ln.barcode || ln.sku || ""));
                    if (!code) continue;
                    const resolvedSku = codeToSku.get(code) || null;
                    const q = new URLSearchParams();
                    q.set("id", `eq.${ln.id}`);
                    await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_lines?${q.toString()}`, {
                        method: "PATCH",
                        headers: { ...sbHeaders(env), prefer: "return=minimal" },
                        body: JSON.stringify({ barcode: code, sku: resolvedSku })
                    });
                }
            } catch {
            }
            const pickingTypeId = await findInternalPickingType(env);
            const srcId = await findLocationIdByCompleteName(env, origin_id);
            let dstId = 0;
            let kroniTransit = false;
            if (dest_id === "KRONI/Existencias") {
                const transitId = Number(env.ODOO_KRONI_TRANSIT_LOCATION_ID || 0);
                if (transitId > 0) dstId = transitId;
                else {
                    const transitName = String(env.ODOO_KRONI_TRANSIT_COMPLETE_NAME || "Physical Locations/Traslado interno a Kroni").trim();
                    dstId = await findLocationIdByCompleteName(env, transitName);
                }
                kroniTransit = true;
            } else {
                dstId = await findLocationIdByCompleteName(env, dest_id);
            }
            const codesAll = lines.map((ln) => String(ln.barcode || ln.sku || "").trim()).filter(Boolean);
            const productsMap = await findProductsByCodes(env, codesAll);
            const resolved = [];
            for (const ln of lines) {
                const code = String(ln.barcode || ln.sku || "").trim();
                const qty = Number(ln.qty || 0);
                if (!code || qty <= 0) continue;
                const prod = productsMap.get(code);
                if (!prod) throw new Error(`Producto no encontrado: ${code}`);
                resolved.push({ product_id: prod.id, name: prod.name, uom_id: prod.uom_id, qty });
            }
            if (!resolved.length) return json({ ok: false, error: "no_valid_lines" }, { status: 400, headers: cors });
            const moveCmds = resolved.map((mv) => [0, 0, { name: mv.name, product_id: mv.product_id, product_uom: mv.uom_id, product_uom_qty: mv.qty, location_id: srcId, location_dest_id: dstId }]);
            const pickingVals = { picking_type_id: pickingTypeId, location_id: srcId, location_dest_id: dstId, origin: tr.client_transfer_id, move_ids_without_package: moveCmds };
            if (origin_id === "WH/Existencias" && kroniTransit) pickingVals["x_krn_auto_sync_enabled"] = true;
            const pickingId = await odooExecuteKw(env, "stock.picking", "create", [pickingVals]);
            await odooExecuteKw(env, "stock.picking", "action_confirm", [[pickingId]]);
            try {
                await odooExecuteKw(env, "stock.picking", "action_assign", [[pickingId]]);
            } catch {
            }
            const autoValidate = String(env.ODOO_AUTO_VALIDATE || "1");
            if (autoValidate === "1" || autoValidate.toLowerCase() === "true") {
                try {
                    await validatePicking(env, pickingId);
                } catch {
                }
            }
            const pickRow = await odooRead(env, "stock.picking", [pickingId], ["name", "state"]);
            const pickingName = pickRow?.[0]?.name || String(pickingId);
            const pickingState = pickRow?.[0]?.state || "unknown";
            await sbUpdateTransfer(env, id, { status: pickingState === "done" ? "validated" : "odoo_created", odoo_picking_id: String(pickingId), picking_name: pickingName });
            await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "odoo_created", detail: { pickingId, pickingName, state: pickingState } }]);
            try {
                if (pickingState === "done" && origin_id === "WH/Existencias" && dest_id === "KRONI/Existencias") {
                    const rLog = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_logs?transfer_id=eq.${encodeURIComponent(id)}&event=eq.forecast_in_transit_applied&select=id`, { method: "GET", headers: sbHeaders(env) });
                    if (rLog.ok) {
                        const existed = await rLog.json();
                        if (!Array.isArray(existed) || existed.length === 0) {
                            const destLocNumeric = 98632499512;
                            await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "forecast_target_location", detail: { chosen_location_id: destLocNumeric, reason: "hardcoded_for_KRONI" } }]);
                            const items = lines.map((ln) => ({ sku: (String(ln.sku || ln.barcode || "") || "").trim() || String(ln.barcode || ""), location_id: destLocNumeric, in_transit_units: Number(ln.qty || 0) }));
                            const up = await sbUpsertForecastingTodayStrict(env, items);
                            await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "forecast_in_transit_applied", detail: { via: "rest_forced_strict", updates: items, result_count: Array.isArray(up) ? up.length : null } }]);
                        }
                    }
                }
            } catch (e) {
                await sbInsert(env, "transfer_logs", [{ transfer_id: id, event: "forecast_in_transit_error", detail: { error: String(e?.message || e) } }]);
            }
            return json({ ok: true, id, picking_name: pickingName, odoo_picking_id: String(pickingId), status: pickingState === "done" ? "validated" : "odoo_created" }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(draftValidate, "draftValidate");
    async function historyList(req, env) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const url = new URL(req.url);
            const qpIn = url.searchParams;
            const page = Math.max(1, Number(qpIn.get("page") || "1"));
            const pageSize = Math.max(1, Math.min(200, Number(qpIn.get("pageSize") || "50")));
            const statusList = parseListParam(qpIn.get("status"));
            const ownerParam = String(qpIn.get("owner") || "").trim();
            const originId = String(qpIn.get("origin") || "").trim();
            const destId = String(qpIn.get("dest") || "").trim();
            const from = String(qpIn.get("from") || "").trim();
            const to = String(qpIn.get("to") || "").trim();
            const search = String(qpIn.get("search") || "").trim();
            const formatCsv = String(qpIn.get("format") || "").toLowerCase() === "csv";
            const qs = new URLSearchParams();
            qs.set("select", "id,client_transfer_id,origin_id,dest_id,status,draft_owner,draft_title,created_at,updated_at,picking_name");
            qs.set("order", "created_at.desc");
            qs.set("limit", String(pageSize));
            qs.set("offset", String((page - 1) * pageSize));
            if (statusList.length) {
                const inList = "(" + statusList.map((s) => `"${s}"`).join(",") + ")";
                qs.set("status", `in.${inList}`);
            }
            if (ownerParam) qs.set("draft_owner", `eq.${ownerParam}`);
            if (originId) qs.set("origin_id", `eq.${originId}`);
            if (destId) qs.set("dest_id", `eq.${destId}`);
            if (from || to) {
                const ands = [];
                if (from) ands.push(`created_at.gte.${from}`);
                if (to) ands.push(`created_at.lt.${to}`);
                qs.set("and", `(${ands.join(",")})`);
            }
            if (search) {
                const ls = new URLSearchParams();
                ls.set("select", "transfer_id");
                ls.set("or", `sku.ilike.*${search}*,barcode.ilike.*${search}*`);
                ls.set("limit", "10000");
                const rLines = await fetch(`${env.SUPABASE_URL}/rest/v1/transfer_lines?${ls.toString()}`, { headers: sbHeaders(env) });
                if (!rLines.ok) throw new Error(await rLines.text());
                const rows2 = await rLines.json();
                const ids = Array.from(new Set((rows2 || []).map((x) => x.transfer_id).filter(Boolean)));
                if (!ids.length) return json({ ok: true, rows: [], total: 0, page, pageSize }, { headers: cors });
                const idList = "(" + ids.map((id) => `"${id}"`).join(",") + ")";
                qs.set("id", `in.${idList}`);
            }
            const r = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?${qs.toString()}`, { headers: { ...sbHeaders(env), Prefer: "count=exact" } });
            if (!r.ok) throw new Error(await r.text());
            const rows = await r.json();
            const contentRange = r.headers.get("content-range") || "";
            let total = null;
            const m = contentRange.match(/\/(\d+)$/);
            if (m) total = Number(m[1]);
            if (formatCsv) {
                const cols = ["id", "client_transfer_id", "origin_id", "dest_id", "status", "draft_owner", "draft_title", "picking_name", "created_at"];
                const esc = /* @__PURE__ */ __name((v) => {
                    const s = v == null ? "" : String(v);
                    return s.includes(",") || s.includes('"') || s.includes("\n") ? '"' + s.replace(/"/g, '""') + '"' : s;
                }, "esc");
                const lines = [cols.join(",")].concat(rows.map((r2) => cols.map((k) => esc(r2?.[k])).join(",")));
                const csv = lines.join("\n");
                return new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="transfers-history-${Date.now()}.csv"`, ...cors } });
            }
            return json({ ok: true, rows, total, page, pageSize }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: corsHeaders(env.CORS_ORIGIN) });
        }
    }
    __name(historyList, "historyList");
    async function duplicateTransfer(req, env, id) {
        const cors = corsHeaders(env.CORS_ORIGIN);
        const enabled = boolFlag(env.ENABLE_MULTI_DRAFTS, false);
        if (!enabled) return new Response("Not found", { status: 404 });
        try {
            const tr = await sbGetTransfer(env, id);
            if (!tr) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors });
            const owner = getOwner(req);
            const maxDrafts = Number(env.MAX_DRAFTS_PER_OWNER || "3") || 3;
            const rCount = await fetch(`${env.SUPABASE_URL}/rest/v1/transfers?select=id&status=eq.draft&draft_owner=eq.${encodeURIComponent(owner)}`, { headers: sbHeaders(env) });
            if (!rCount.ok) throw new Error(await rCount.text());
            const rows = await rCount.json();
            if (Array.isArray(rows) && rows.length >= maxDrafts) return json({ ok: false, error: `L\xEDmite de borradores alcanzado (${maxDrafts})` }, { status: 409, headers: cors });
            const lines = await sbGetTransferLines(env, id);
            const newId = crypto.randomUUID();
            const toInsert = {
                id: newId,
                client_transfer_id: crypto.randomUUID(),
                origin_id: tr.origin_id,
                dest_id: tr.dest_id,
                status: "draft",
                draft_owner: owner,
                draft_title: tr.draft_title ? `Copia de ${tr.draft_title}` : `Copia ${tr.id.slice(0, 8)}`
            };
            await sbInsert(env, "transfers", [toInsert]);
            const toLines = (lines || []).map((ln) => ({ transfer_id: newId, barcode: ln.barcode || ln.sku || null, sku: ln.sku || null, qty: Number(ln.qty || 0) })).filter((x) => (x.barcode || x.sku) && x.qty > 0);
            if (toLines.length) await sbInsert(env, "transfer_lines", toLines);
            await sbInsert(env, "transfer_logs", [{ transfer_id: newId, event: "draft_created", detail: { owner, from_transfer_id: id, duplicated: true } }]);
            return json({ ok: true, id: newId, status: "draft" }, { headers: cors });
        } catch (e) {
            return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
        }
    }
    __name(duplicateTransfer, "duplicateTransfer");
    async function fetchHandler(req, env) {
        const url = new URL(req.url);
        const { pathname } = url;
        if (req.method === "OPTIONS") return handleOptions(req, env);
        if (req.method === "GET" && pathname === "/api/transfers/shopify-health") {
            const cors = corsHeaders(env.CORS_ORIGIN);
            try {
                const candidates = (env.SHOPIFY_API_VERSION_LIST || "").split(",").map((s) => s.trim()).filter(Boolean);
                const defaults = ["2025-01", "2024-10", "2024-07", "2024-04", "2024-01", "2023-10", "unstable"];
                const versions = candidates.length ? candidates : defaults;
                const results = [];
                const mutation = `mutation CreateTransfer($input: InventoryTransferCreateInput!) {
  inventoryTransferCreate(input: $input) {
    transfer { id name status }
    userErrors { field message }
  }
}`;
                const dummy = { input: { originLocationId: "gid://shopify/Location/1", destinationLocationId: "gid://shopify/Location/1", lineItems: [] } };
                for (const ver of versions) {
                    try {
                        const r = await shopifyGraphQLWithVersion(env, ver, mutation, dummy);
                        const errors = r.raw?.errors || [];
                        const hasUndefined = Array.isArray(errors) && errors.some((e) => String(e?.extensions?.code || "").includes("undefined") || String(e?.message || "").includes("doesn't exist"));
                        const hasTypeMissing = Array.isArray(errors) && errors.some((e) => String(e?.message || "").includes("isn't a defined input type"));
                        const supported2 = r.ok || !hasUndefined && !hasTypeMissing;
                        results.push({ version: ver, supported: supported2, status: r.status, errors });
                    } catch (e) {
                        results.push({ version: ver, supported: false, error: String(e?.message || e) });
                    }
                }
                const supported = results.filter((r) => r.supported);
                const recommended = supported.length ? supported[0].version : null;
                return json({ ok: true, versions: results, recommended }, { headers: cors });
            } catch (e) {
                return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: cors });
            }
        }
        if (req.method === "POST" && pathname === "/api/transfers/validate") {
            const cors = corsHeaders(env.CORS_ORIGIN);
            try {
                const payload = await req.json().catch(() => ({}));
                const { origin_id, dest_id, lines } = payload || {};
                if (dest_id === "KRONI/Existencias") {
                    return json({ ok: true, skipped: true }, { headers: cors });
                }
                if (!env.SHOPIFY_STORE || !env.SHOPIFY_ACCESS_TOKEN) {
                    return json({ ok: true, skipped: true }, { headers: cors });
                }
                if (!origin_id || !Array.isArray(lines) || !lines.length) return json({ ok: false, error: "payload inv\xE1lido" }, { status: 400, headers: cors });
                const locGid = await getShopifyLocationGid(env, origin_id);
                const codes = lines.map((ln) => normCode(String(ln.barcode || ln.sku || ""))).filter(Boolean);
                const variantsMap = await resolveVariantsBatch(env, codes);
                const invItemGids = Array.from(new Set(Array.from(variantsMap.values()).map((v) => v?.inventoryItem?.id).filter(Boolean)));
                const availMap = await getAvailableAtLocationBatch(env, invItemGids, locGid);
                const insufficient = [];
                for (const ln of lines) {
                    const code = normCode(String(ln.barcode || ln.sku || ""));
                    const qty = Number(ln.qty || 0);
                    if (!code || qty <= 0) continue;
                    const variant = variantsMap.get(code);
                    if (!variant) {
                        insufficient.push({ code, requested: qty, available: 0, reason: "no_variant" });
                        continue;
                    }
                    const avail = Number(availMap.get(variant.inventoryItem.id) ?? 0);
                    if (avail < qty) insufficient.push({ code, requested: qty, available: avail });
                }
                if (insufficient.length) return json({ ok: false, insufficient }, { status: 200, headers: cors });
                return json({ ok: true }, { headers: cors });
            } catch (e) {
                return json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: corsHeaders(env.CORS_ORIGIN) });
            }
        }
        if (req.method === "POST" && pathname === "/api/transfers") {
            return createTransfer(req, env);
        }
        if (req.method === "GET" && pathname === "/api/transfers/drafts") {
            return draftsList(req, env);
        }
        if (req.method === "POST" && pathname === "/api/transfers/drafts") {
            return draftsCreate(req, env);
        }
        if (req.method === "PUT" && pathname.match(/^\/api\/transfers\/drafts\/[^/]+$/)) {
            const id = pathname.split("/").pop() || "";
            return draftsUpdate(req, env, id);
        }

        if (req.method === "PATCH" && pathname.match(/^\/api\/transfers\/[^/]+$/)) {
            const id = pathname.split("/").pop() || "";
            return draftUpdateMeta(req, env, id);
        }
        if (req.method === "GET" && pathname.match(/^\/api\/transfers\/[^/]+\/lines$/)) {
            const id = pathname.split("/")[3];
            return draftGetLines(req, env, id);
        }
        if (req.method === "POST" && pathname.match(/^\/api\/transfers\/[^/]+\/lines$/)) {
            const id = pathname.split("/")[3];
            return draftUpsertLines(req, env, id);
        }
        if (req.method === "DELETE" && pathname.match(/^\/api\/transfers\/[^/]+\/lines\//)) {
            const parts = pathname.split("/");
            const id = parts[3];
            const code = decodeURIComponent(parts[5] || "");
            return draftDeleteLine(req, env, id, code);
        }
        if (req.method === "POST" && pathname.match(/^\/api\/transfers\/[^/]+\/cancel$/)) {
            const id = pathname.split("/")[3];
            return draftCancel(req, env, id);
        }
        if (req.method === "POST" && pathname.match(/^\/api\/transfers\/[^/]+\/validate$/)) {
            const id = pathname.split("/")[3];
            return draftValidate(req, env, id);
        }
        if (req.method === "GET" && pathname.match(/^\/api\/transfers\/([^/]+)\/shopify-draft\.csv$/)) {
            const id = pathname.split("/")[3];
            try {
                const tr = await sbGetTransfer(env, id);
                if (!tr) return new Response("Not found", { status: 404, headers: corsHeaders(env.CORS_ORIGIN) });
                const r2 = await fetch(`${env.SUPABASE_URL}/rest/v1/shopify_transfer_drafts?transfer_id=eq.${encodeURIComponent(id)}&select=*`, { method: "GET", headers: sbHeaders(env) });
                if (!r2.ok) throw new Error(await r2.text());
                const rows = await r2.json();
                const draft = rows?.[0];
                const lines = Array.isArray(draft?.lines) ? draft.lines : [];
                let csv = "code,qty,origin_shopify_location_id,dest_shopify_location_id\n";
                for (const ln of lines) {
                    csv += `${ln.code},${ln.qty},${draft?.origin_shopify_location_id || ""},${draft?.dest_shopify_location_id || ""}
`;
                }
                return new Response(csv, { status: 200, headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="shopify_draft_${id}.csv"`, ...corsHeaders(env.CORS_ORIGIN) } });
            } catch (e) {
                return json({ error: String(e?.message || e) }, { status: 500, headers: corsHeaders(env.CORS_ORIGIN) });
            }
        }
        if (req.method === "GET" && pathname === "/api/transfers/history") {
            return historyList(req, env);
        }
        if (req.method === "GET" && pathname.startsWith("/api/transfers/")) {
            const id = pathname.split("/").pop() || "";
            return getTransfer(req, env, id);
        }
        if (req.method === "POST" && pathname.match(/^\/api\/transfers\/[^/]+\/duplicate$/)) {
            const id = pathname.split("/")[3];
            return duplicateTransfer(req, env, id);
        }
        return new Response("Not found: " + pathname, { status: 404, headers: corsHeaders(env.CORS_ORIGIN) });
    }
    __name(fetchHandler, "fetchHandler");
    function getEnv() {
        const g = globalThis;
        return {
            SUPABASE_URL: g.SUPABASE_URL,
            SUPABASE_SERVICE_ROLE: g.SUPABASE_SERVICE_ROLE,
            ODOO_URL: g.ODOO_URL,
            ODOO_DB: g.ODOO_DB,
            ODOO_UID: g.ODOO_UID,
            ODOO_API_KEY: g.ODOO_API_KEY,
            CORS_ORIGIN: g.CORS_ORIGIN,
            ODOO_AUTO_VALIDATE: g.ODOO_AUTO_VALIDATE,
            SHOPIFY_STORE: g.SHOPIFY_STORE,
            SHOPIFY_ACCESS_TOKEN: g.SHOPIFY_ACCESS_TOKEN,
            SHOPIFY_REPLICATE_TRANSFERS: g.SHOPIFY_REPLICATE_TRANSFERS,
            SHOPIFY_API_VERSION: g.SHOPIFY_API_VERSION,
            SHOPIFY_API_VERSION_LIST: g.SHOPIFY_API_VERSION_LIST,
            SHOPIFY_CONQUISTA_LOCATION_ID: g.SHOPIFY_CONQUISTA_LOCATION_ID,
            ENABLE_MULTI_DRAFTS: g.ENABLE_MULTI_DRAFTS,
            MAX_DRAFTS_PER_OWNER: g.MAX_DRAFTS_PER_OWNER
        };
    }
    __name(getEnv, "getEnv");
    addEventListener("fetch", (event) => {
        event.respondWith(fetchHandler(event.request, getEnv()));
    });
})();
//# sourceMappingURL=index.js.map
