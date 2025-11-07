import React, { useEffect, useMemo, useState } from 'react'
import { getUserId } from '../lib/user'
import useLocations from '../hooks/useLocations'

function apiBase() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '') || ''
}
function endpointTransfers() {
  const base = apiBase()
  if (!base) return '/api/transfers'
  if (base.endsWith('/api/transfers')) return base
  return `${base}/api/transfers`
}

type Row = {
  id: string
  client_transfer_id: string
  origin_id: string
  dest_id: string
  status: string
  draft_owner: string
  draft_title: string | null
  picking_name: string | null
  created_at: string
}

type Line = { id?: string; barcode?: string | null; sku?: string | null; qty: number }

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
  const [total, setTotal] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, { loading: boolean; error: string | null; lines: Line[] }>>({})

  const { locations } = useLocations()

  const qs = useMemo(() => {
    const usp = new URLSearchParams()
    // owner opcional: por defecto muestra todos
    if (status) usp.set('status', status)
    if (origin) usp.set('origin', origin)
    if (dest) usp.set('dest', dest)
    if (from) usp.set('from', from)
    if (to) usp.set('to', to)
    if (search) usp.set('search', search)
    usp.set('page', String(page))
    usp.set('pageSize', String(pageSize))
    return usp.toString()
  }, [status, origin, dest, from, to, search, page, pageSize])

  useEffect(() => {
    let aborted = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const url = `${endpointTransfers()}/history?${qs}`
        const r = await fetch(url, { headers: { 'X-User-Id': getUserId() } })
        const data = await r.json()
        if (!r.ok || data?.ok === false) throw new Error(data?.error || 'fetch_failed')
        if (!aborted) { setRows(data.rows || []); setTotal(Number(data.total || 0)) }
      } catch (e: any) { if (!aborted) setError(String(e?.message || e)) }
      finally { if (!aborted) setLoading(false) }
    }
    load()
    return () => { aborted = true }
  }, [qs])

  const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize))

  const downloadCsv = () => {
    const url = `${endpointTransfers()}/history?${qs}&format=csv`
    window.open(url, '_blank')
  }

  const duplicate = async (id: string) => {
    try {
      const r = await fetch(`${endpointTransfers()}/${id}/duplicate`, { method: 'POST', headers: { 'X-User-Id': getUserId() } })
      const data = await r.json()
      if (!r.ok || data?.ok === false) throw new Error(data?.error || r.status)
      alert('Borrador creado a partir del historial')
    } catch (e: any) {
      alert(`No se pudo duplicar: ${String(e?.message || e)}`)
    }
  }

  const toggleExpand = async (id: string) => {
    const state = expanded[id]
    // toggle close
    if (state && !state.loading && state.lines && state.lines.length >= 0) {
      const next = { ...expanded }
      delete next[id]
      setExpanded(next)
      return
    }
    // open and fetch if needed
    setExpanded(prev => ({ ...prev, [id]: { loading: true, error: null, lines: [] } }))
    try {
      const r = await fetch(`${endpointTransfers()}/${id}/lines`, { headers: { 'X-User-Id': getUserId() } })
      const data = await r.json()
      if (!r.ok || data?.ok === false) throw new Error(data?.error || 'fetch_lines_failed')
      const lines: Line[] = Array.isArray(data?.lines) ? data.lines : []
      setExpanded(prev => ({ ...prev, [id]: { loading: false, error: null, lines } }))
    } catch (e: any) {
      setExpanded(prev => ({ ...prev, [id]: { loading: false, error: String(e?.message || e), lines: [] } }))
    }
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
        <div className="ml-auto text-sm text-slate-600">{total} resultados</div>
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
            {rows.map(r => (
              <React.Fragment key={r.id}>
                <tr className="odd:bg-white even:bg-slate-50/50">
                  <td className="px-3 py-2 border-b">
                    <button onClick={() => toggleExpand(r.id)} className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">
                      {expanded[r.id] ? 'Ocultar' : 'Ver'}
                    </button>
                  </td>
                  <td className="px-3 py-2 border-b">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 border-b">{r.origin_id}</td>
                  <td className="px-3 py-2 border-b">{r.dest_id}</td>
                  <td className="px-3 py-2 border-b">{r.status}</td>
                  <td className="px-3 py-2 border-b">{r.picking_name || '—'}</td>
                  <td className="px-3 py-2 border-b">
                    <button onClick={() => duplicate(r.id)} className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Duplicar como borrador</button>
                  </td>
                </tr>
                {expanded[r.id] && (
                  <tr>
                    <td className="px-3 py-2 border-b bg-slate-50" colSpan={7}>
                      {expanded[r.id].loading ? (
                        <div className="text-sm text-slate-600">Cargando líneas…</div>
                      ) : expanded[r.id].error ? (
                        <div className="text-sm text-red-600">{expanded[r.id].error}</div>
                      ) : (expanded[r.id].lines.length ? (
                        <div className="overflow-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left">
                                <th className="px-2 py-1 border-b">Código</th>
                                <th className="px-2 py-1 border-b">Cantidad</th>
                              </tr>
                            </thead>
                            <tbody>
                              {expanded[r.id].lines.map((ln, idx) => (
                                <tr key={ln.id || idx}>
                                  <td className="px-2 py-1 border-b font-mono text-xs">{ln.sku || ln.barcode || '—'}</td>
                                  <td className="px-2 py-1 border-b">{ln.qty}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="text-sm text-slate-600">Sin líneas registradas</div>
                      ))}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {!rows.length && (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={6}>{loading ? 'Cargando…' : (error || 'Sin resultados')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button disabled={page<=1} onClick={() => setPage(p => Math.max(1, p-1))} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-sm disabled:opacity-50">Prev</button>
        <div className="text-sm">Página {page} / {totalPages}</div>
        <button disabled={page>=totalPages} onClick={() => setPage(p => p+1)} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-sm disabled:opacity-50">Next</button>
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
