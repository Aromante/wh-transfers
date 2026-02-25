import React, { useCallback, useEffect, useMemo, useState } from 'react'
import ScannerInput from '../components/ScannerInput'
import { genId } from '../lib/uuid'
import { getUserId } from '../lib/user'

function ep() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '') || '/api/transfers'
}

type PendingTransfer = {
  transfer_id: string
  origin_id: string
  dest_id: string
  status: string
  created_at: string
  updated_at?: string
  picking_name?: string | null
  lines?: Array<{ id: string; sku: string; barcode: string; qty: number; product_name?: string; box_barcode?: string | null }>
}

type ReceiveLine = { id: string; code: string; qty: number; originalQty?: number }

type ViewState = 'list' | 'receiving'

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
}

function folio(id: string) {
  return id.slice(0, 8).toUpperCase()
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:   { label: 'Pendiente',  cls: 'bg-amber-100 text-amber-800' },
    validated: { label: 'Recibido',   cls: 'bg-green-100 text-green-800' },
    cancelled: { label: 'Cancelado',  cls: 'bg-red-100 text-red-800' },
    draft:     { label: 'Borrador',   cls: 'bg-slate-100 text-slate-600' },
  }
  const s = map[status] || { label: status, cls: 'bg-slate-100 text-slate-600' }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  )
}

// Summary stats from lines
function lineStats(lines: PendingTransfer['lines']) {
  if (!lines?.length) return { skus: 0, boxes: 0, units: 0 }
  const skus = new Set(lines.map(l => l.sku || l.barcode)).size
  const boxes = lines.filter(l => !!l.box_barcode).length
  const units = lines.reduce((a, l) => a + (l.qty || 0), 0)
  return { skus, boxes, units }
}

export default function ReceivePage() {
  const [view, setView] = useState<ViewState>('list')
  const [transfers, setTransfers] = useState<PendingTransfer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null)

  // Receiving state
  const [selected, setSelected] = useState<PendingTransfer | null>(null)
  const [lines, setLines] = useState<ReceiveLine[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [confirming, setConfirming] = useState(false)
  const [cancelingId, setCancelingId] = useState<string | null>(null)

  const loadPending = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`${ep()}/history?status=pending&limit=100`, {
        headers: { 'X-User-Id': getUserId() },
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data?.error || `Error ${r.status}`)
      const list: PendingTransfer[] = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
        ? data
        : []
      setTransfers(list.filter(t => t.status === 'pending'))
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadPending() }, [loadPending])

  // ── Load detail (lines) for a card ───────────────────────────────────────
  const toggleExpand = async (transfer: PendingTransfer) => {
    if (expandedId === transfer.transfer_id) {
      setExpandedId(null)
      return
    }
    // If already has lines loaded, just expand
    if (transfer.lines) {
      setExpandedId(transfer.transfer_id)
      return
    }
    setLoadingDetail(transfer.transfer_id)
    setExpandedId(transfer.transfer_id)
    try {
      const r = await fetch(`${ep()}/transfer?id=${encodeURIComponent(transfer.transfer_id)}`, {
        headers: { 'X-User-Id': getUserId() },
      })
      const json = await r.json()
      const meta = json?.data || json
      const rawLines = Array.isArray(meta?.lines) ? meta.lines : []
      setTransfers(prev => prev.map(t => t.transfer_id === transfer.transfer_id ? { ...t, lines: rawLines } : t))
    } catch { /* leave lines undefined */ }
    finally { setLoadingDetail(null) }
  }

  // ── Select a transfer to receive ──────────────────────────────────────────
  const startReceiving = async (transfer: PendingTransfer) => {
    setBusy(true)
    try {
      // Use already-loaded lines if available, otherwise fetch
      let rawLines: any[] = []
      if (transfer.lines) {
        rawLines = transfer.lines
      } else {
        const r = await fetch(`${ep()}/transfer?id=${encodeURIComponent(transfer.transfer_id)}`, {
          headers: { 'X-User-Id': getUserId() },
        })
        const json = await r.json()
        const meta = json?.data || json
        rawLines = Array.isArray(meta?.lines) ? meta.lines : []
      }

      const initLines: ReceiveLine[] = rawLines
        .map((ln: any) => ({
          id: genId(),
          code: String(ln.sku || ln.barcode || ''),
          qty: Number(ln.qty || 0),
          originalQty: Number(ln.qty || 0),
        }))
        .filter((l: ReceiveLine) => l.code && l.qty > 0)

      setSelected({ ...transfer, lines: rawLines })
      setLines(initLines)
      setResult(null)
      setConfirming(false)
      setView('receiving')
    } catch (e: any) {
      alert(`Error cargando transferencia: ${String(e?.message || e)}`)
    } finally {
      setBusy(false)
    }
  }

  // ── Line operations ────────────────────────────────────────────────────────
  const onScan = (code: string) => {
    setLines(prev => {
      const idx = prev.findIndex(l => l.code === code)
      if (idx >= 0) {
        const copy = [...prev]
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 }
        return copy
      }
      return [...prev, { id: genId(), code, qty: 1 }]
    })
  }

  const setQty = (id: string, qty: number) =>
    setLines(prev => prev.map(l => l.id === id ? { ...l, qty: Math.max(0, Math.floor(Number(qty) || 0)) } : l))

  const incQty = (id: string, delta: number) =>
    setLines(prev => prev.map(l => l.id === id ? { ...l, qty: Math.max(0, l.qty + delta) } : l))

  const removeLine = (id: string) => setLines(prev => prev.filter(l => l.id !== id))

  const totalQty = useMemo(() => lines.reduce((a, b) => a + b.qty, 0), [lines])

  // ── Confirm reception ──────────────────────────────────────────────────────
  const confirmReceive = async () => {
    if (!selected || !lines.length) return
    const validLines = lines.filter(l => l.qty > 0)
    if (!validLines.length) return

    setBusy(true)
    setResult(null)
    setConfirming(false)
    try {
      const body = {
        transfer_id: selected.transfer_id,
        lines: validLines.map(l => ({ sku: l.code, qty: l.qty })),
      }
      const r = await fetch(`${ep()}/receive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-User-Id': getUserId() },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (r.ok) {
        const d = data?.data || data
        setResult({ ok: true, pickingName: d?.picking_name, state: d?.state, message: d?.message })
        await loadPending()
      } else {
        setResult({ ok: false, error: data?.error || `Error ${r.status}` })
      }
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) })
    } finally {
      setBusy(false)
    }
  }

  // ── Cancel transfer ────────────────────────────────────────────────────────
  const cancelTransfer = async (transferId: string) => {
    setCancelingId(null)
    setBusy(true)
    try {
      const r = await fetch(`${ep()}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-User-Id': getUserId() },
        body: JSON.stringify({ transfer_id: transferId }),
      })
      const data = await r.json()
      if (!r.ok) { alert(data?.error || 'Error cancelando'); return }
      await loadPending()
      if (view === 'receiving') setView('list')
    } catch (e: any) {
      alert(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  // ── Render: list ──────────────────────────────────────────────────────────
  if (view === 'list') {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="font-mono text-xs tracking-widest text-slate-400 uppercase">Operaciones</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Recepción</h1>
          </div>
          <button
            onClick={loadPending}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            <svg className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Actualizar
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        {/* Empty */}
        {!loading && !error && transfers.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <div className="text-3xl mb-2">📦</div>
            <div className="text-slate-500 text-sm">No hay transferencias pendientes de recepción.</div>
          </div>
        )}

        {/* Cards */}
        {transfers.length > 0 && (
          <div className="space-y-3">
            {transfers.map(t => {
              const stats = lineStats(t.lines)
              const isExpanded = expandedId === t.transfer_id
              const isLoadingThis = loadingDetail === t.transfer_id

              return (
                <div
                  key={t.transfer_id}
                  className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
                >
                  {/* Card body */}
                  <div className="p-4">
                    {/* Row 1: Folio + Status */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-slate-800">#{folio(t.transfer_id)}</span>
                        <StatusPill status={t.status} />
                      </div>
                      <span className="text-xs text-slate-400">{fmtDate(t.created_at)}</span>
                    </div>

                    {/* Row 2: Origen → Destino */}
                    <div className="mt-2 flex items-center gap-1.5 text-sm">
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-700">{t.origin_id}</span>
                      <svg className="h-3.5 w-3.5 text-slate-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                      </svg>
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-700">{t.dest_id}</span>
                    </div>

                    {/* Row 3: Summary chips */}
                    {t.lines && (
                      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                        <StatChip icon="📦" label={`${stats.units} pzas`} />
                        <StatChip icon="🏷️" label={`${stats.skus} SKUs`} />
                        {stats.boxes > 0 && <StatChip icon="🗃️" label={`${stats.boxes} caja${stats.boxes !== 1 ? 's' : ''}`} />}
                      </div>
                    )}
                    {!t.lines && (
                      <div className="mt-2.5">
                        <button
                          onClick={() => toggleExpand(t)}
                          className="text-xs text-slate-400 hover:text-slate-600 underline underline-offset-2"
                        >
                          Ver resumen
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Expand/collapse detail toggle */}
                  {t.lines && (
                    <button
                      onClick={() => toggleExpand(t)}
                      className="w-full flex items-center justify-between px-4 py-2 border-t border-slate-100 text-xs text-slate-500 hover:bg-slate-50 transition-colors"
                    >
                      <span>{isExpanded ? 'Ocultar contenido' : 'Ver contenido'}</span>
                      <svg
                        className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        viewBox="0 0 20 20" fill="currentColor"
                      >
                        <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    </button>
                  )}

                  {/* Expanded line detail */}
                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
                      {isLoadingThis ? (
                        <div className="text-xs text-slate-400 py-2">Cargando…</div>
                      ) : t.lines?.length ? (
                        <div className="space-y-1">
                          {t.lines.map((ln, i) => (
                            <div key={ln.id || i} className="flex items-center justify-between text-xs">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {ln.box_barcode && (
                                  <span className="text-slate-400" title="Caja">🗃️</span>
                                )}
                                <span className="font-mono text-slate-700 truncate">{ln.sku || ln.barcode}</span>
                                {ln.product_name && (
                                  <span className="text-slate-400 truncate hidden sm:block">· {ln.product_name}</span>
                                )}
                              </div>
                              <span className="ml-3 font-semibold text-slate-800 shrink-0">{ln.qty} u.</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-slate-400">Sin líneas.</div>
                      )}
                    </div>
                  )}

                  {/* Cancel confirm inline */}
                  {cancelingId === t.transfer_id && (
                    <div className="border-t border-red-100 bg-red-50 px-4 py-3 flex items-center gap-3">
                      <span className="text-sm text-red-700 flex-1">¿Cancelar esta transferencia? No se puede deshacer.</span>
                      <button
                        disabled={busy}
                        onClick={() => cancelTransfer(t.transfer_id)}
                        className="rounded-lg bg-red-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-red-700 disabled:opacity-50"
                      >
                        {busy ? 'Cancelando…' : 'Sí, cancelar'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setCancelingId(null)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
                      >
                        No
                      </button>
                    </div>
                  )}

                  {/* Actions */}
                  {cancelingId !== t.transfer_id && (
                    <div className="border-t border-slate-100 px-4 py-3 flex items-center justify-end gap-2">
                      <button
                        onClick={() => setCancelingId(t.transfer_id)}
                        disabled={busy}
                        className="rounded-lg border border-red-200 text-red-700 px-3 py-1.5 text-sm hover:bg-red-50 disabled:opacity-50"
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={() => startReceiving(t)}
                        disabled={busy}
                        className="rounded-lg bg-black text-white px-4 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
                      >
                        {busy ? 'Cargando…' : 'Recibir →'}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // ── Render: receiving ─────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {/* Back + header */}
      <div className="mb-6">
        <button
          onClick={() => { setView('list'); setResult(null) }}
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          Volver a la lista
        </button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-mono text-xs tracking-widest text-slate-400 uppercase">Recepción</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Confirmar recepción</h1>
          </div>
          <StatusPill status={selected?.status || 'pending'} />
        </div>

        {/* Transfer meta */}
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3.5 space-y-2">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-slate-400 w-14 shrink-0 text-xs">Folio</span>
            <span className="font-mono font-semibold text-slate-800">#{folio(selected?.transfer_id || '')}</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-slate-400 w-14 shrink-0 text-xs">Ruta</span>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{selected?.origin_id}</span>
            <svg className="h-3 w-3 text-slate-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{selected?.dest_id}</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-slate-400 w-14 shrink-0 text-xs">Fecha</span>
            <span className="text-xs text-slate-600">{selected?.created_at ? fmtDate(selected.created_at) : '—'}</span>
          </div>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className={`mb-5 rounded-xl border p-4 text-sm ${result.ok ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
          {result.ok ? (
            <div className="text-green-800">
              <div className="font-semibold mb-1">✓ Recepción confirmada</div>
              {result.pickingName && (
                <div className="text-sm">
                  Picking Odoo: <span className="font-mono font-medium">{result.pickingName}</span>
                  {result.state && <span className="ml-2 text-green-600 text-xs">({result.state})</span>}
                </div>
              )}
              <button onClick={() => setView('list')} className="mt-3 text-sm underline text-green-700 underline-offset-2">
                Ver otras órdenes pendientes →
              </button>
            </div>
          ) : (
            <div className="text-red-700 font-medium">
              Error: {result.error}
            </div>
          )}
        </div>
      )}

      {/* Scanner + table */}
      {!result?.ok && (
        <>
          <div className="mb-4">
            <ScannerInput onScan={onScan} autoFocusEnabled={true} />
          </div>

          {/* Lines */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-3 py-2.5 border-b border-slate-200 font-medium">Código / SKU</th>
                  <th className="px-3 py-2.5 border-b border-slate-200 font-medium text-center w-16">Env.</th>
                  <th className="px-3 py-2.5 border-b border-slate-200 font-medium">Recibido</th>
                  <th className="px-3 py-2.5 border-b border-slate-200 w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map(l => {
                  const changed = l.originalQty !== undefined && l.qty !== l.originalQty
                  return (
                    <tr key={l.id} className={`odd:bg-white even:bg-slate-50/50 ${changed ? 'bg-amber-50/60' : ''}`}>
                      <td className="px-3 py-2 border-b border-slate-100 font-mono text-xs text-slate-700">{l.code}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-center text-xs text-slate-400">
                        {l.originalQty ?? '—'}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => incQty(l.id, -1)}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 text-base leading-none"
                          >
                            −
                          </button>
                          <input
                            type="number"
                            min={0}
                            value={l.qty}
                            onChange={e => setQty(l.id, Number(e.target.value))}
                            className="w-16 rounded-md border border-slate-300 px-2 py-1 text-sm text-center"
                          />
                          <button
                            type="button"
                            onClick={() => incQty(l.id, +1)}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 text-base leading-none"
                          >
                            +
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right">
                        <button
                          type="button"
                          onClick={() => removeLine(l.id)}
                          className="text-slate-300 hover:text-red-500 transition-colors"
                          title="Eliminar línea"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
                {!lines.length && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-slate-400">
                      Sin ítems. Escanea un código para empezar.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="mt-3 flex items-center gap-3 flex-wrap text-sm">
            <div className="text-slate-500">
              <span className="font-semibold text-slate-800">{lines.filter(l => l.qty > 0).length}</span> SKUs ·{' '}
              <span className="font-semibold text-slate-800">{totalQty}</span> unidades
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                disabled={busy}
                onClick={() => selected && setCancelingId(selected.transfer_id)}
                className="rounded-lg border border-red-200 text-red-700 px-3 py-2 text-sm hover:bg-red-50 disabled:opacity-50"
              >
                Cancelar orden
              </button>
              <button
                disabled={busy || !lines.some(l => l.qty > 0)}
                onClick={() => setConfirming(true)}
                className="rounded-lg bg-black text-white px-4 py-2 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
              >
                Confirmar recepción
              </button>
            </div>
          </div>

          {/* Cancel confirmation */}
          {cancelingId && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-medium text-red-800 mb-3">¿Cancelar esta transferencia? Esta acción no se puede deshacer.</p>
              <div className="flex items-center gap-2">
                <button
                  disabled={busy}
                  onClick={() => { cancelTransfer(cancelingId!); setCancelingId(null) }}
                  className="rounded-lg bg-red-600 text-white px-4 py-2 text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  {busy ? 'Cancelando…' : 'Sí, cancelar'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setCancelingId(null)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                >
                  No
                </button>
              </div>
            </div>
          )}

          {/* Reception confirmation */}
          {confirming && (
            <div className="mt-3 rounded-xl border border-slate-300 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-800 mb-1">¿Confirmar recepción?</p>
              <p className="text-xs text-slate-500 mb-3">
                {selected?.origin_id} → {selected?.dest_id} · {lines.filter(l => l.qty > 0).length} SKUs · {totalQty} unidades.
                <br />Esto creará el picking en Odoo como <span className="font-mono bg-slate-200 rounded px-1">done</span>.
              </p>
              <div className="flex items-center gap-2">
                <button
                  disabled={busy}
                  onClick={confirmReceive}
                  className="rounded-lg bg-black text-white px-4 py-2 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
                >
                  {busy ? 'Confirmando…' : 'Sí, confirmar'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-white disabled:opacity-50"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Small stat chip ───────────────────────────────────────────────────────────
function StatChip({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600 font-medium">
      <span>{icon}</span>
      {label}
    </span>
  )
}
