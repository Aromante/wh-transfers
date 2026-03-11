import React, { useEffect, useMemo, useRef, useState } from 'react'
import useLocations from '../hooks/useLocations'
import LocationSelect, { LocationLabel, locMeta } from '../components/LocationSelect'
import { ep, apiHeaders } from '../lib/api'

type Line = {
  id?: string
  barcode?: string | null
  sku?: string | null
  qty: number
  product_name?: string | null
  box_barcode?: string | null
}

type Row = {
  transfer_id: string
  client_transfer_id?: string | null
  origin_id: string
  dest_id: string
  origin_name?: string | null
  dest_name?: string | null
  status: string
  draft_owner?: string | null
  draft_title?: string | null
  odoo_transfer_id?: string | null
  odoo_picking_id?: number | null
  shopify_transfer_id?: string | null
  created_at: string
  updated_at?: string | null
  // embedded by transfer_log view (may be null if view doesn't aggregate them)
  lines?: Line[] | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  const d = new Date(iso)
  const day = d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
  return { day, time }
}

function folio(id: string) {
  return id.slice(0, 8).toUpperCase()
}

/** Strips "[SKU-CODE] " prefix and parentheses → "Eclipse Certero 30 ML" */
function cleanProductName(name: string | null | undefined): string {
  if (!name) return '—'
  return name
    .replace(/^\[.*?\]\s*/, '')   // remove [SKU] prefix
    .replace(/[()]/g, '')          // remove parentheses
    .replace(/\s+/g, ' ')          // collapse extra spaces
    .trim()
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending:      { label: 'Pendiente',  cls: 'bg-amber-100 text-amber-800' },
  validated:    { label: 'Validado',   cls: 'bg-green-100 text-green-800' },
  cancelled:    { label: 'Cancelado',  cls: 'bg-red-100 text-red-800' },
  draft:        { label: 'Borrador',   cls: 'bg-slate-100 text-slate-600' },
  ready:        { label: 'Listo',      cls: 'bg-blue-100 text-blue-700' },
  odoo_created: { label: 'En Odoo',    cls: 'bg-purple-100 text-purple-700' },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_LABELS[status] || { label: status, cls: 'bg-slate-100 text-slate-600' }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  )
}

function lineStats(lines: Line[]) {
  const skus = new Set(lines.map(l => l.sku || l.barcode)).size
  const boxes = lines.filter(l => !!l.box_barcode).length
  const units = lines.reduce((a, l) => a + (l.qty || 0), 0)
  return { skus, boxes, units }
}

export default function HistoryPage() {
  const [status, setStatus]     = useState('')
  const [origin, setOrigin]     = useState('')
  const [dest, setDest]         = useState('')
  const [from, setFrom]         = useState('')
  const [to, setTo]             = useState('')
  const [search, setSearch]     = useState('')
  const [page, setPage]         = useState(1)
  const PAGE_SIZE               = 20

  const [rows, setRows]         = useState<Row[]>([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // Box catalog: barcode → qty_per_box (loaded once for CSV export)
  const [boxCatalog, setBoxCatalog] = useState<Record<string, number>>({})
  const boxCatalogLoaded = useRef(false)

  const ensureBoxCatalog = async (): Promise<Record<string, number>> => {
    if (boxCatalogLoaded.current) return boxCatalog
    try {
      const r = await fetch(ep('/boxes'), { headers: apiHeaders() })
      const json = await r.json()
      const boxes: Array<{ barcode: string; qty_per_box: number }> = json?.data || json || []
      const map: Record<string, number> = {}
      for (const b of boxes) map[b.barcode] = b.qty_per_box
      setBoxCatalog(map)
      boxCatalogLoaded.current = true
      return map
    } catch {
      return boxCatalog
    }
  }

  // Lines loaded per transfer id
  const [linesMap, setLinesMap] = useState<Record<string, Line[]>>({})
  const [loadingLines, setLoadingLines] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const { locations } = useLocations()

  const qs = useMemo(() => {
    const usp = new URLSearchParams()
    if (status) usp.set('status', status)
    if (origin) usp.set('origin', origin)
    if (dest)   usp.set('dest', dest)
    if (from)   usp.set('from', from)
    if (to)     usp.set('to', to)
    if (search) usp.set('search', search)
    usp.set('limit', String(PAGE_SIZE))
    usp.set('offset', String((page - 1) * PAGE_SIZE))
    return usp.toString()
  }, [status, origin, dest, from, to, search, page])

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch(ep(`/history?${qs}`), {
          headers: apiHeaders(),
          signal: ctrl.signal,
        })
        const json = await r.json()
        if (!r.ok) throw new Error(json?.error || `Error ${r.status}`)
        // API returns { data: [...] }
        const list: Row[] = Array.isArray(json?.data) ? json.data
          : Array.isArray(json) ? json
          : []
        setRows(list)
        // If lines came embedded (transfer_log view aggregates them), store them
        const embedded: Record<string, Line[]> = {}
        for (const row of list) {
          if (Array.isArray(row.lines) && row.lines.length > 0) {
            embedded[row.transfer_id] = row.lines
          }
        }
        if (Object.keys(embedded).length > 0) {
          setLinesMap(prev => ({ ...prev, ...embedded }))
        }
      } catch (e: any) {
        if (e.name !== 'AbortError') setError(String(e?.message || e))
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }
    load()
    return () => ctrl.abort()
  }, [qs])

  const hasMore = rows.length === PAGE_SIZE

  const downloadCsv = () => {
    const csvQs = qs.replace(/limit=\d+/, 'limit=500').replace(/offset=\d+/, 'offset=0')
    window.open(ep(`/history/csv?${csvQs}`), '_blank')
  }

  const exportTransferCsv = async (row: Row) => {
    let lines = linesMap[row.transfer_id]
    if (!lines) {
      try {
        const r = await fetch(ep(`/transfer?id=${encodeURIComponent(row.transfer_id)}`), {
          headers: apiHeaders(),
        })
        const json = await r.json()
        const meta = json?.data || json
        lines = Array.isArray(meta?.lines) ? meta.lines : []
        setLinesMap(prev => ({ ...prev, [row.transfer_id]: lines! }))
      } catch {
        alert('No se pudieron cargar las líneas para exportar')
        return
      }
    }
    if (!lines || lines.length === 0) {
      alert('Esta transferencia no tiene líneas para exportar')
      return
    }

    const boxes = await ensureBoxCatalog()

    // Expand each line into individual box rows
    const header = 'Producto (SKU),Cantidad,Tarima'
    const csvRows: string[] = []
    for (const ln of lines) {
      const sku = ln.sku || ln.barcode || ''
      const qtyPerBox = ln.box_barcode ? boxes[ln.box_barcode] : null
      if (qtyPerBox && qtyPerBox > 0) {
        const numBoxes = Math.round(ln.qty / qtyPerBox)
        for (let i = 0; i < numBoxes; i++) {
          csvRows.push(`${sku},${qtyPerBox},1`)
        }
        // Remainder (partial box)
        const remainder = ln.qty - numBoxes * qtyPerBox
        if (remainder > 0) {
          csvRows.push(`${sku},${remainder},1`)
        }
      } else {
        // No box info — single row with total qty
        csvRows.push(`${sku},${ln.qty},1`)
      }
    }
    const csv = [header, ...csvRows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transferencia-${folio(row.transfer_id)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Lazy-load lines for a row via /transfer?id=
  const toggleExpand = async (row: Row) => {
    const newState = !expanded[row.transfer_id]
    setExpanded(prev => ({ ...prev, [row.transfer_id]: newState }))
    if (!newState) return

    // Already loaded?
    if (linesMap[row.transfer_id]) return

    setLoadingLines(row.transfer_id)
    try {
      const r = await fetch(ep(`/transfer?id=${encodeURIComponent(row.transfer_id)}`), {
        headers: apiHeaders(),
      })
      const json = await r.json()
      const meta = json?.data || json
      const fetchedLines: Line[] = Array.isArray(meta?.lines) ? meta.lines : []
      setLinesMap(prev => ({ ...prev, [row.transfer_id]: fetchedLines }))
    } catch {
      setLinesMap(prev => ({ ...prev, [row.transfer_id]: [] }))
    } finally {
      setLoadingLines(null)
    }
  }

  const resetFilters = () => {
    setStatus(''); setOrigin(''); setDest(''); setFrom(''); setTo(''); setSearch(''); setPage(1)
  }

  const hasFilters = status || origin || dest || from || to || search

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="font-mono text-xs tracking-widest text-slate-400 uppercase">Historial</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Transferencias</h1>
        </div>
        <button
          onClick={downloadCsv}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
          CSV
        </button>
      </div>

      {/* Filters */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Estado</label>
            <select
              value={status}
              onChange={e => { setPage(1); setStatus(e.target.value) }}
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">Todos</option>
              <option value="pending">Pendiente</option>
              <option value="validated">Validado</option>
              <option value="cancelled">Cancelado</option>
              <option value="draft">Borrador</option>
              <option value="ready">Listo</option>
              <option value="odoo_created">En Odoo</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Origen</label>
            <LocationSelect
              value={origin}
              options={locations || []}
              onChange={v => { setPage(1); setOrigin(v) }}
              allLabel="Todos"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Destino</label>
            <LocationSelect
              value={dest}
              options={locations || []}
              onChange={v => { setPage(1); setDest(v) }}
              allLabel="Todos"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Desde</label>
            <input
              type="datetime-local"
              value={from}
              onChange={e => { setPage(1); setFrom(e.target.value) }}
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Hasta</label>
            <input
              type="datetime-local"
              value={to}
              onChange={e => { setPage(1); setTo(e.target.value) }}
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Buscar</label>
            <input
              value={search}
              onChange={e => { setPage(1); setSearch(e.target.value) }}
              placeholder="Folio, SKU…"
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
        </div>
        {hasFilters && (
          <div className="mt-3 flex justify-end">
            <button
              onClick={resetFilters}
              className="text-xs text-slate-400 hover:text-slate-700 underline underline-offset-2"
            >
              Limpiar filtros
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Results count */}
      <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
        <span>
          {loading ? 'Cargando…' : `${rows.length} resultado${rows.length !== 1 ? 's' : ''}${hasMore ? '+' : ''}`}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading && rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-400">Cargando historial…</div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-400">
            {error ? 'Error al cargar' : 'Sin resultados. Prueba cambiando los filtros.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide border-b border-slate-200">
                <th className="px-3 py-2.5 font-medium w-8" />
                <th className="px-3 py-2.5 font-medium">Folio</th>
                <th className="px-3 py-2.5 font-medium">Fecha</th>
                <th className="px-3 py-2.5 font-medium hidden sm:table-cell">Origen</th>
                <th className="px-3 py-2.5 font-medium hidden sm:table-cell">Destino</th>
                <th className="px-3 py-2.5 font-medium">Estado</th>
                <th className="px-3 py-2.5 font-medium hidden md:table-cell">Odoo</th>
                <th className="px-3 py-2.5 font-medium hidden md:table-cell">Shopify</th>
                <th className="px-3 py-2.5 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const isExpanded = expanded[row.transfer_id]
                const rowLines = linesMap[row.transfer_id]
                const stats = rowLines ? lineStats(rowLines) : null

                return (
                  <React.Fragment key={row.transfer_id}>
                    <tr
                      className={`border-b border-slate-100 hover:bg-slate-50/70 transition-colors ${isExpanded ? 'bg-slate-50' : 'odd:bg-white even:bg-slate-50/30'}`}
                    >
                      {/* Expand toggle */}
                      <td className="px-2 py-2.5">
                        <button
                          onClick={() => toggleExpand(row)}
                          className="h-6 w-6 inline-flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
                          title={isExpanded ? 'Ocultar' : 'Ver líneas'}
                        >
                          <svg
                            className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            viewBox="0 0 20 20" fill="currentColor"
                          >
                            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                          </svg>
                        </button>
                      </td>

                      {/* Folio */}
                      <td className="px-3 py-2.5">
                        <span className="font-mono text-xs font-semibold text-slate-800">#{folio(row.transfer_id)}</span>
                      </td>

                      {/* Date */}
                      <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                        <div>{fmtDate(row.created_at).day}</div>
                        <div className="text-slate-400">{fmtDate(row.created_at).time}</div>
                      </td>

                      {/* Origin */}
                      <td className="px-3 py-2.5 hidden sm:table-cell">
                        <LocationLabel code={row.origin_id} />
                      </td>

                      {/* Dest */}
                      <td className="px-3 py-2.5 hidden sm:table-cell">
                        <LocationLabel code={row.dest_id} />
                      </td>

                      {/* Status */}
                      <td className="px-3 py-2.5">
                        <StatusPill status={row.status} />
                      </td>

                      {/* Odoo */}
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        {row.odoo_transfer_id && row.odoo_picking_id ? (
                          <a
                            href={`https://aromantemx.odoo.com/odoo/action-380/${row.odoo_picking_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-xs text-purple-700 hover:text-purple-900 underline underline-offset-2"
                          >
                            {row.odoo_transfer_id}
                          </a>
                        ) : row.odoo_transfer_id ? (
                          <span className="font-mono text-xs text-slate-700">{row.odoo_transfer_id}</span>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>

                      {/* Shopify */}
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        {row.shopify_transfer_id && row.shopify_transfer_id !== 'planta_adjusted' ? (
                          <a
                            href={`https://admin.shopify.com/store/aromante-4957/transfers/${row.shopify_transfer_id.split('/').pop()}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-xs text-blue-700 hover:text-blue-900 underline underline-offset-2"
                          >
                            #{row.shopify_transfer_id.split('/').pop()}
                          </a>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-2.5 text-right space-x-1.5">
                        <button
                          onClick={() => exportTransferCsv(row)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 text-slate-600"
                          title="Exportar CSV"
                        >
                          <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
                          </svg>
                          CSV
                        </button>
                      </td>
                    </tr>

                    {/* Expanded lines row */}
                    {isExpanded && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={9} className="px-4 py-3 bg-slate-50/80">
                          {/* Summary chips */}
                          {stats && (
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <span className="inline-flex items-center gap-1 rounded-full bg-white border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 font-medium">
                                📦 {stats.units} pzas
                              </span>
                              <span className="inline-flex items-center gap-1 rounded-full bg-white border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 font-medium">
                                🏷️ {stats.skus} SKUs
                              </span>
                              {stats.boxes > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-white border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 font-medium">
                                  🗃️ {stats.boxes} cajas
                                </span>
                              )}
                              {/* Mobile: show origin/dest here */}
                              <span className="sm:hidden inline-flex items-center gap-1 rounded-full bg-white border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 font-medium">
                                {locMeta(row.origin_id).label} → {locMeta(row.dest_id).label}
                              </span>
                            </div>
                          )}

                          {/* Lines */}
                          {loadingLines === row.transfer_id ? (
                            <div className="text-xs text-slate-400 py-1">Cargando líneas…</div>
                          ) : rowLines === undefined ? null
                          : rowLines.length === 0 ? (
                            <div className="text-xs text-slate-400">Sin líneas registradas.</div>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left text-slate-400 border-b border-slate-200">
                                    <th className="pb-1 font-medium">SKU / Código</th>
                                    <th className="pb-1 font-medium hidden sm:table-cell">Producto</th>
                                    <th className="pb-1 font-medium text-right">Cantidad</th>
                                    <th className="pb-1 font-medium hidden md:table-cell">Caja</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rowLines.map((ln, idx) => (
                                    <tr key={ln.id || idx} className="border-b border-slate-100 last:border-0">
                                      <td className="py-1 pr-3 font-mono text-slate-700">{ln.sku || ln.barcode || '—'}</td>
                                      <td className="py-1 pr-3 text-slate-500 hidden sm:table-cell truncate max-w-[200px]">
                                        {cleanProductName(ln.product_name)}
                                      </td>
                                      <td className="py-1 pr-3 text-right font-semibold text-slate-800">{ln.qty}</td>
                                      <td className="py-1 font-mono text-slate-400 hidden md:table-cell">
                                        {ln.box_barcode || '—'}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between">
        <button
          disabled={page <= 1}
          onClick={() => setPage(p => Math.max(1, p - 1))}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-slate-50"
        >
          ← Anterior
        </button>
        <span className="text-sm text-slate-500">Página {page}</span>
        <button
          disabled={!hasMore}
          onClick={() => setPage(p => p + 1)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-slate-50"
        >
          Siguiente →
        </button>
      </div>
    </div>
  )
}
