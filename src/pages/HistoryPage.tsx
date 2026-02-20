import React, { useEffect, useMemo, useState } from 'react'
import { getUserId } from '../lib/user'
import useLocations from '../hooks/useLocations'

function ep() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '') || '/api/transfers'
}

type Line = { id?: string; barcode?: string | null; sku?: string | null; qty: number; product_name?: string | null; box_barcode?: string | null }

type Row = {
  id: string
  client_transfer_id: string
  origin_id: string
  dest_id: string
  origin_name?: string | null
  dest_name?: string | null
  status: string
  draft_owner: string
  draft_title: string | null
  picking_name: string | null
  created_at: string
  lines?: Line[] | null
}

export default function HistoryPage() {
  const [status, setStatus] = useState<string>('')
  const [origin, setOrigin] = useState<string>('')
  const [dest, setDest] = useState<string>('')
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')
  const [search, setSearch] = useState<string>('')
  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(20)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const { locations } = useLocations()

  // EF uses limit/offset — compute from page/pageSize
  const qs = useMemo(() => {
    const usp = new URLSearchParams()
    if (status) usp.set('status', status)
    if (origin) usp.set('origin', origin)
    if (dest) usp.set('dest', dest)
    if (from) usp.set('from', from)
    if (to) usp.set('to', to)
    if (search) usp.set('search', search)
    usp.set('limit', String(pageSize))
    usp.set('offset', String((page - 1) * pageSize))
    return usp.toString()
  }, [status, origin, dest, from, to, search, page, pageSize])

  useEffect(() => {
    let aborted = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const url = `${ep()}/history?${qs}`
        const r = await fetch(url, { headers: { 'X-User-Id': getUserId() } })
        const json = await r.json()
        if (!r.ok) throw new Error(json?.error || 'fetch_failed')
        // EF returns { data: [...] } — lines are embedded in each row by transfer_log view
        const list: Row[] = Array.isArray(json?.data) ? json.data : []
        if (!aborted) setRows(list)
      } catch (e: any) { if (!aborted) setError(String(e?.message || e)) }
      finally { if (!aborted) setLoading(false) }
    }
    load()
    return () => { aborted = true }
  }, [qs])

  const hasMore = rows.length === pageSize
  const totalPages = page + (hasMore ? 1 : 0)

  const downloadCsv = () => {
    window.open(`${ep()}/history/csv?${qs}`, '_blank')
  }

  const duplicate = async (id: string) => {
    try {
      // EF: POST /duplicate with { transfer_id } in body
      const r = await fetch(`${ep()}/duplicate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-User-Id': getUserId() },
        body: JSON.stringify({ transfer_id: id }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data?.error || r.status)
      alert('Borrador creado a partir del historial')
    } catch (e: any) {
      alert(`No se pudo duplicar: ${String(e?.message || e)}`)
    }
  }

  // Lines are embedded in each row from the transfer_log view — no separate fetch needed
  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = { ...prev }
      if (next[id]) { delete next[id] } else { next[id] = true }
      return next
    })
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Historial de transferencias</h1>
      <div className="mt-4 grid gap-3 grid-cols-1 md:grid-cols-6">
        <label className="text-sm">Estado
          <select value={status} onChange={e => { setPage(1); setStatus(e.target.value) }} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="">Todos</option>
            <option value="validated">validated</option>
            <option value="cancelled">cancelled</option>
            <option value="odoo_created">odoo_created</option>
            <option value="draft">draft</option>
            <option value="ready">ready</option>
          </select>
        </label>
        <label className="text-sm">Origen
          <select value={origin} onChange={e => { setPage(1); setOrigin(e.target.value) }} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="">Todos</option>
            {(locations || []).map(l => <option key={l.code} value={l.code}>{l.code}</option>)}
          </select>
        </label>
        <label className="text-sm">Destino
          <select value={dest} onChange={e => { setPage(1); setDest(e.target.value) }} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="">Todos</option>
            {(locations || []).map(l => <option key={l.code} value={l.code}>{l.code}</option>)}
          </select>
        </label>
        <label className="text-sm">Desde
          <input type="datetime-local" value={from} onChange={e => { setPage(1); setFrom(e.target.value) }} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </label>
        <label className="text-sm">Hasta
          <input type="datetime-local" value={to} onChange={e => { setPage(1); setTo(e.target.value) }} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </label>
        <label className="text-sm">Buscar SKU/Código
          <input value={search} onChange={e => { setPage(1); setSearch(e.target.value) }} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" placeholder="SKU123" />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => setPage(1)} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">Aplicar</button>
        <button onClick={downloadCsv} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">Descargar CSV</button>
        <div className="ml-auto text-sm text-slate-600">{rows.length} resultados</div>
      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left">
              <th className="px-3 py-2 border-b" />
              <th className="px-3 py-2 border-b">Fecha</th>
              <th className="px-3 py-2 border-b">Origen</th>
              <th className="px-3 py-2 border-b">Destino</th>
              <th className="px-3 py-2 border-b">Estado</th>
              <th className="px-3 py-2 border-b">Picking</th>
              <th className="px-3 py-2 border-b">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const embeddedLines: Line[] = Array.isArray(r.lines) ? r.lines : []
              return (
                <React.Fragment key={r.id}>
                  <tr className="odd:bg-white even:bg-slate-50/50">
                    <td className="px-3 py-2 border-b">
                      <button onClick={() => toggleExpand(r.id)} className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">
                        {expanded[r.id] ? 'Ocultar' : 'Ver'}
                      </button>
                    </td>
                    <td className="px-3 py-2 border-b">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 border-b">{r.origin_name || r.origin_id}</td>
                    <td className="px-3 py-2 border-b">{r.dest_name || r.dest_id}</td>
                    <td className="px-3 py-2 border-b">{r.status}</td>
                    <td className="px-3 py-2 border-b">{r.picking_name || '—'}</td>
                    <td className="px-3 py-2 border-b">
                      <button onClick={() => duplicate(r.id)} className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Duplicar como borrador</button>
                    </td>
                  </tr>
                  {expanded[r.id] && (
                    <tr>
                      <td className="px-3 py-2 border-b bg-slate-50" colSpan={7}>
                        {embeddedLines.length ? (
                          <div className="overflow-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-left">
                                  <th className="px-2 py-1 border-b">SKU / Código</th>
                                  <th className="px-2 py-1 border-b">Producto</th>
                                  <th className="px-2 py-1 border-b">Cantidad</th>
                                  <th className="px-2 py-1 border-b">Caja</th>
                                </tr>
                              </thead>
                              <tbody>
                                {embeddedLines.map((ln, idx) => (
                                  <tr key={ln.id || idx}>
                                    <td className="px-2 py-1 border-b font-mono text-xs">{ln.sku || ln.barcode || '—'}</td>
                                    <td className="px-2 py-1 border-b text-xs">{ln.product_name || '—'}</td>
                                    <td className="px-2 py-1 border-b">{ln.qty}</td>
                                    <td className="px-2 py-1 border-b font-mono text-xs">{ln.box_barcode || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="text-sm text-slate-600">Sin líneas registradas</div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
            {!rows.length && (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={7}>{loading ? 'Cargando…' : (error || 'Sin resultados')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button disabled={page<=1} onClick={() => setPage(p => Math.max(1, p-1))} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-sm disabled:opacity-50">Prev</button>
        <div className="text-sm">Página {page}{hasMore ? '+' : ''}</div>
        <button disabled={!hasMore} onClick={() => setPage(p => p+1)} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-sm disabled:opacity-50">Next</button>
        <div className="ml-auto text-sm">
          <label>PageSize
            <select value={pageSize} onChange={e => { setPage(1); setPageSize(Number(e.target.value)) }} className="ml-2 rounded-md border border-slate-300 px-2 py-1 text-sm">
              {[20,50,100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      </div>
    </div>
  )
}
