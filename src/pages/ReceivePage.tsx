import React, { useCallback, useEffect, useMemo, useState } from 'react'
import ScannerInput from '../components/ScannerInput'
import { genId } from '../lib/uuid'
import { getUserId } from '../lib/user'

function ep() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '') || '/api/transfers'
}

type PendingTransfer = {
  id: string
  origin_id: string
  dest_id: string
  status: string
  created_at: string
  updated_at?: string
  picking_name?: string | null
  lines?: Array<{ id: string; sku: string; barcode: string; qty: number; product_name?: string }>
}

type ReceiveLine = { id: string; code: string; qty: number; originalQty?: number }

type ViewState = 'list' | 'receiving'

export default function ReceivePage() {
  const [view, setView] = useState<ViewState>('list')
  const [transfers, setTransfers] = useState<PendingTransfer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Receiving state
  const [selected, setSelected] = useState<PendingTransfer | null>(null)
  const [lines, setLines] = useState<ReceiveLine[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [confirming, setConfirming] = useState(false)
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const [autoFocus, setAutoFocus] = useState<boolean>(() => {
    try { return localStorage.getItem('wh_auto_focus') !== '0' } catch { return true }
  })

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

  // ── Select a transfer to receive ──────────────────────────────────────────
  const startReceiving = async (transfer: PendingTransfer) => {
    setBusy(true)
    try {
      // Load full transfer with lines
      const r = await fetch(`${ep()}/transfer?id=${encodeURIComponent(transfer.id)}`, {
        headers: { 'X-User-Id': getUserId() },
      })
      const json = await r.json()
      const meta = json?.data || json
      const rawLines: any[] = Array.isArray(meta?.lines) ? meta.lines : []

      // Pre-populate lines with original quantities (receiver can edit)
      const initLines: ReceiveLine[] = rawLines
        .map((ln: any) => ({
          id: genId(),
          code: String(ln.sku || ln.barcode || ''),
          qty: Number(ln.qty || 0),
          originalQty: Number(ln.qty || 0),
        }))
        .filter(l => l.code && l.qty > 0)

      setSelected({ ...transfer, lines: rawLines })
      setLines(initLines)
      setResult(null)
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
        transfer_id: selected.id,
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
        // Refresh the pending list
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
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="font-suisseMono text-xs text-slate-500">OPERACIONES</div>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Recepción de transferencias</h1>
            <p className="mt-2 text-slate-600">Órdenes pendientes de recibir en destino.</p>
          </div>
          <button
            onClick={loadPending}
            className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
          >
            Actualizar
          </button>
        </div>

        {loading && (
          <div className="text-slate-500 text-sm">Cargando órdenes pendientes…</div>
        )}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        )}

        {!loading && !error && transfers.length === 0 && (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-400">
            No hay transferencias pendientes de recepción.
          </div>
        )}

        {!loading && transfers.length > 0 && (
          <div className="space-y-3">
            {transfers.map(t => (
              <div key={t.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900">{t.origin_id}</span>
                      <span className="text-slate-400">→</span>
                      <span className="font-medium text-slate-900">{t.dest_id}</span>
                      <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        pendiente
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-400 font-mono">
                      {new Date(t.created_at).toLocaleString('es-MX')} · {t.id.slice(0, 8)}…
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {cancelingId !== t.id && (
                      <>
                        <button
                          onClick={() => setCancelingId(t.id)}
                          disabled={busy}
                          className="inline-flex items-center rounded-md border border-red-200 text-red-700 px-3 py-1.5 text-sm hover:bg-red-50 disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                        <button
                          onClick={() => startReceiving(t)}
                          disabled={busy}
                          className="inline-flex items-center rounded-md bg-black text-white px-3 py-1.5 text-sm disabled:opacity-50"
                        >
                          Recibir
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {cancelingId === t.id && (
                  <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 flex items-center gap-3">
                    <span className="text-sm text-red-700 flex-1">¿Cancelar esta transferencia? Esta acción no se puede deshacer.</span>
                    <button
                      disabled={busy}
                      onClick={() => { cancelTransfer(t.id); setCancelingId(null) }}
                      className="inline-flex items-center rounded-md bg-red-600 text-white px-3 py-1.5 text-sm hover:bg-red-700 disabled:opacity-50"
                    >
                      {busy ? 'Cancelando…' : 'Sí, cancelar'}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setCancelingId(null)}
                      className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-white disabled:opacity-50"
                    >
                      No
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Render: receiving ─────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => { setView('list'); setResult(null) }}
          className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
        >
          ← Volver a la lista
        </button>
        <div className="font-suisseMono text-xs text-slate-500">RECEPCIÓN</div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Confirmar recepción</h1>
        <div className="mt-2 flex items-center justify-between gap-4">
          <div className="text-slate-600">
            <span className="font-medium">{selected?.origin_id}</span>
            <span className="mx-2 text-slate-400">→</span>
            <span className="font-medium">{selected?.dest_id}</span>
          </div>
          <label className="flex items-center gap-2 text-sm select-none">
            <input
              type="checkbox"
              checked={autoFocus}
              onChange={e => {
                const val = e.target.checked
                setAutoFocus(val)
                try { localStorage.setItem('wh_auto_focus', val ? '1' : '0') } catch {}
              }}
            />
            <span>Auto‑enfoque del escáner</span>
          </label>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
          {result.ok ? (
            <div className="text-slate-800">
              <div className="font-semibold mb-1 text-green-700">✓ Recepción confirmada</div>
              {result.pickingName && (
                <div>Picking Odoo: <span className="font-mono font-medium">{result.pickingName}</span>
                  {result.state && <span className="ml-2 text-slate-500">({result.state})</span>}
                </div>
              )}
              <div className="mt-2">
                <button onClick={() => setView('list')} className="text-sm underline text-slate-600">
                  Ver otras órdenes pendientes
                </button>
              </div>
            </div>
          ) : (
            <div className="text-red-700 font-medium">
              Error: {result.error}
            </div>
          )}
        </div>
      )}

      {/* Scanner */}
      {!result?.ok && (
        <>
          <div className="mb-4">
            <ScannerInput onScan={onScan} autoFocusEnabled={autoFocus} />
          </div>

          {/* Lines table */}
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left">
                  <th className="px-3 py-2 border-b border-slate-200">Código / SKU</th>
                  <th className="px-3 py-2 border-b border-slate-200">Enviado</th>
                  <th className="px-3 py-2 border-b border-slate-200">Recibido</th>
                  <th className="px-3 py-2 border-b border-slate-200" />
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.id} className={`odd:bg-white even:bg-slate-50/50 ${l.qty !== l.originalQty && l.originalQty !== undefined ? 'ring-1 ring-inset ring-amber-300' : ''}`}>
                    <td className="px-3 py-2 border-b border-slate-100 font-mono text-xs">{l.code}</td>
                    <td className="px-3 py-2 border-b border-slate-100 text-slate-400 text-xs">
                      {l.originalQty ?? '—'}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      <div className="inline-flex items-center gap-2">
                        <button type="button" onClick={() => incQty(l.id, -1)} className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">-</button>
                        <input
                          type="number"
                          min={0}
                          value={l.qty}
                          onChange={e => setQty(l.id, Number(e.target.value))}
                          className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
                        />
                        <button type="button" onClick={() => incQty(l.id, +1)} className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">+</button>
                      </div>
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-right">
                      <button type="button" onClick={() => removeLine(l.id)} className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Eliminar</button>
                    </td>
                  </tr>
                ))}
                {!lines.length && (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-slate-400">
                      Sin ítems. Escanea o agrega manualmente arriba.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer actions */}
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <div className="text-slate-600 text-sm">
              Ítems: {lines.filter(l => l.qty > 0).length} · Total unidades: {totalQty}
            </div>
            {!confirming && (
              <>
                <button
                  disabled={busy || !lines.some(l => l.qty > 0)}
                  onClick={() => setConfirming(true)}
                  className="inline-flex items-center rounded-md bg-black text-white px-4 py-2 text-sm disabled:opacity-50"
                >
                  Confirmar recepción
                </button>
                <button
                  disabled={busy}
                  onClick={() => selected && cancelTransfer(selected.id)}
                  className="inline-flex items-center rounded-md border border-red-200 text-red-700 px-3 py-2 text-sm hover:bg-red-50 disabled:opacity-50"
                >
                  Cancelar orden
                </button>
              </>
            )}
          </div>

          {/* Inline confirmation panel */}
          {confirming && (
            <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-800 mb-1">¿Confirmar recepción?</p>
              <p className="text-xs text-slate-500 mb-3">
                {selected?.origin_id} → {selected?.dest_id} · {lines.filter(l => l.qty > 0).length} ítems · {totalQty} unidades totales
                <br />Esto creará el picking en Odoo como <span className="font-mono">done</span>.
              </p>
              <div className="flex items-center gap-2">
                <button
                  disabled={busy}
                  onClick={confirmReceive}
                  className="inline-flex items-center rounded-md bg-black text-white px-4 py-2 text-sm disabled:opacity-50"
                >
                  {busy ? 'Confirmando…' : 'Sí, confirmar'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                  className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-white disabled:opacity-50"
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
