import React, { useEffect, useMemo, useState } from 'react'
import ScannerInput from '../components/ScannerInput'
import useLocations from '../hooks/useLocations'
import { genId } from '../lib/uuid'
import { isMultiDraftsEnabled } from '../lib/flags'
import useDrafts from '../hooks/useDrafts'
import { getUserId } from '../lib/user'

type Line = { id: string; code: string; qty: number }

// Returns the EF base URL as-is (VITE_API_BASE already points to the EF endpoint)
function ep() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '') || '/api/transfers'
}
// Keep legacy alias used below
const endpointTransfers = ep

export default function TransferPage() {
  const { locations, loading } = useLocations()
  const draftsFlag = isMultiDraftsEnabled()
  const { drafts, refresh: refreshDrafts } = useDrafts()
  const [origin, setOrigin] = useState<string>('')
  const [dest, setDest] = useState<string>('')
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [showDrafts, setShowDrafts] = useState(false)
  const [autoFocus, setAutoFocus] = useState<boolean>(() => {
    try { return localStorage.getItem('wh_auto_focus') !== '0' } catch { return true }
  })

  useEffect(() => {
    if (locations.length) {
      const def = locations.find(l => l.is_default_origin)?.code || locations[0].code
      setOrigin((prev) => prev || def)
      const firstDest = locations.find(l => l.code !== def)?.code || locations[0].code
      setDest((prev) => prev || firstDest)
    }
  }, [locations])

  const totalQty = useMemo(() => lines.reduce((a, b) => a + b.qty, 0), [lines])

  // Mapear insuficiencias por código para marcar en la tabla
  const insuffByCode = useMemo(() => {
    const m = new Map<string, { available: number; requested: number }>()
    if (result && result.kind === 'insufficient' && Array.isArray(result.insufficient)) {
      for (const it of result.insufficient) {
        if (it && it.code != null) m.set(String(it.code), { available: Number(it.available) || 0, requested: Number(it.requested) || 0 })
      }
    }
    return m
  }, [result])

  const onScan = (code: string) => {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.code === code)
      if (idx >= 0) {
        const copy = [...prev]
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 }
        return copy
      }
      return [...prev, { id: genId(), code, qty: 1 }]
    })
  }

  const removeLine = (id: string) => setLines((prev) => prev.filter((l) => l.id !== id))
  const setQty = (id: string, qty: number) => setLines(prev => prev.map(l => l.id === id ? { ...l, qty: Math.max(1, Math.floor(Number(qty) || 0)) } : l))
  const incQty = (id: string, delta: number) => setLines(prev => prev.map(l => l.id === id ? { ...l, qty: Math.max(1, l.qty + delta) } : l))

  const submit = async () => {
    if (!lines.length || !origin || !dest) return
    setBusy(true)
    setResult(null)
    try {
      const o = origin.trim()
      const d = dest.trim()
      const body = {
        client_transfer_id: genId(),
        origin_id: o,
        dest_id: d,
        lines: lines.map((l) => ({ barcode: l.code, qty: l.qty })),
      }
      const r = await fetch(ep(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-User-Id': getUserId() },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (r.ok) {
        // EF returns { data: { transfer: { id, pickingId, pickingName, state }, shopify: ... } }
        const t = (data as any)?.data?.transfer || (data as any)?.transfer || data
        const shopify = (data as any)?.data?.shopify || (data as any)?.shopify || null
        setResult({ ok: true, kind: 'success', id: t?.id, pickingName: t?.pickingName, pickingId: t?.pickingId, status: t?.state || t?.status, shopify })
        setLines([])
      } else {
        setResult({ ok: false, data })
      }
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) })
    } finally { setBusy(false) }
  }

  const confirmAndSubmit = async () => {
    if (!lines.length || !origin || !dest) return
    const total = totalQty
    const msg = `¿Confirmar transferencia?\n\nOrigen: ${origin}\nDestino: ${dest}\nLíneas: ${lines.length}\nUnidades totales: ${total}\n\nEsta acción creará el picking en Odoo${dest === 'KRONI/Existencias' ? ' (destino tránsito KRONI)' : ''}${(import.meta as any).env?.VITE_API_BASE ? ' y replicará borrador en Shopify si aplica.' : '.'}`
    const ok = typeof window !== 'undefined' ? window.confirm(msg) : true
    if (!ok) return
    await submit()
  }

  const saveAsDraft = async () => {
    if (!draftsFlag) return
    if (!origin || !dest || !lines.length) return
    setBusy(true)
    try {
      const body = {
        origin_id: origin,
        dest_id: dest,
        title: null,
        lines: lines.map(l => ({ barcode: l.code, qty: l.qty }))
      }
      const r = await fetch(`${ep()}/drafts`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-User-Id': getUserId() }, body: JSON.stringify(body) })
      const data = await r.json()
      if (!r.ok) {
        alert(`No se pudo guardar el borrador: ${data?.error || r.status}`)
        return
      }
      setLines([])
      const saved = data?.data || data
      setResult({ ok: true, kind: 'draft_saved', id: saved?.id })
      refreshDrafts()
    } catch (e: any) {
      alert(`Error guardando borrador: ${String(e?.message || e)}`)
    } finally { setBusy(false) }
  }

  const resumeDraft = async (id: string) => {
    try {
      // GET /transfer?id=... returns transfer + embedded lines
      const r = await fetch(`${ep()}/transfer?id=${encodeURIComponent(id)}`, { headers: { 'X-User-Id': getUserId() } })
      const json = await r.json()
      const meta = json?.data || json
      if (meta?.origin_id) setOrigin(meta.origin_id)
      if (meta?.dest_id) setDest(meta.dest_id)
      const linesData: any[] = Array.isArray(meta?.lines) ? meta.lines : []
      const next: Line[] = linesData
        .map((ln: any) => ({ id: genId(), code: String(ln.barcode || ln.sku || ''), qty: Number(ln.qty || 0) }))
        .filter(l => l.code && l.qty > 0)
      setLines(next)
      setShowDrafts(false)
      setResult(null)
    } catch {}
  }

  const validateDraft = async (id: string) => {
    if (busy) return
    setBusy(true)
    try {
      // EF: POST /validate with { transfer_id }
      const r = await fetch(`${ep()}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-User-Id': getUserId() },
        body: JSON.stringify({ transfer_id: id }),
      })
      const data = await r.json()
      if (r.ok) {
        const validated = data?.data || data
        setResult({ ok: true, kind: 'success', id, validated: validated?.validated })
        refreshDrafts()
      } else {
        setResult({ ok: false, data })
      }
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) })
    } finally { setBusy(false) }
  }

  const cancelDraft = async (id: string) => {
    if (busy) return
    const ok = typeof window !== 'undefined' ? window.confirm('¿Cancelar este borrador? Esta acción no elimina los datos del historial, pero lo quita de la lista de activos.') : true
    if (!ok) return
    setBusy(true)
    try {
      // Soft-cancel: PATCH /drafts?id=<id> with { status: 'cancelled' }
      const r = await fetch(`${ep()}/drafts?id=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'X-User-Id': getUserId() },
        body: JSON.stringify({ status: 'cancelled' }),
      })
      const data = await r.json().catch(() => null)
      if (!r.ok) alert(`No se pudo cancelar: ${data?.error || r.status}`)
      await refreshDrafts()
    } catch (e: any) {
      alert(`Error al cancelar: ${String(e?.message || e)}`)
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <div className="font-suisseMono text-xs text-slate-500">OPERACIONES</div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Nueva transferencia</h1>
        <div className="mt-2 flex items-center justify-between gap-4">
          <p className="text-slate-600">Escanea productos y confirma para crear el picking en Odoo.</p>
          <label className="flex items-center gap-2 text-sm select-none">
            <input
              type="checkbox"
              checked={autoFocus}
              onChange={(e) => {
                const val = e.target.checked
                setAutoFocus(val)
                try { localStorage.setItem('wh_auto_focus', val ? '1' : '0') } catch {}
              }}
            />
            <span>Auto‑enfoque del escáner</span>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <div className="text-xs text-slate-500 mb-1">Origen</div>
          <select
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
            value={origin}
            onChange={(e) => {
              const next = e.target.value
              setOrigin(next)
              if (dest === next) {
                const alt = (locations || []).find(l => l.code !== next)?.code
                if (alt) setDest(alt)
              }
            }}
          >
            {(locations || []).map((loc) => (
              <option key={loc.code} value={loc.code}>{loc.code} — {loc.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-xs text-slate-500 mb-1">Destino</div>
          <select
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
          >
            {(locations || []).filter(l => l.code !== origin).map((loc) => (
              <option key={loc.code} value={loc.code}>{loc.code} — {loc.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4">
        <ScannerInput onScan={onScan} autoFocusEnabled={autoFocus} />
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left">
              <th className="px-3 py-2 border-b border-slate-200">Código</th>
              <th className="px-3 py-2 border-b border-slate-200">Cantidad</th>
              <th className="px-3 py-2 border-b border-slate-200" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="odd:bg-white even:bg-slate-50/50">
                <td className="px-3 py-2 border-b border-slate-100 font-mono text-xs">{l.code}</td>
                <td className="px-3 py-2 border-b border-slate-100">
                  <div className="inline-flex items-center gap-2">
                    <button type="button" aria-label="Menos" onClick={() => incQty(l.id, -1)} className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">-</button>
                    <input
                      type="number"
                      min={1}
                      value={l.qty}
                      onChange={(e) => setQty(l.id, Number(e.target.value))}
                      className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                    <button type="button" aria-label="Más" onClick={() => incQty(l.id, +1)} className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">+</button>
                  </div>
                  {insuffByCode.has(l.code) && (
                    <div className="mt-1 text-xs text-red-600">Disponible: {insuffByCode.get(l.code)!.available} en "{origin}"</div>
                  )}
                </td>
                <td className="px-3 py-2 border-b border-slate-100 text-right">
                  <button type="button" onClick={() => removeLine(l.id)} className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Eliminar</button>
                </td>
              </tr>
            ))}
            {!lines.length && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-slate-400">Sin productos aún</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="text-slate-600">Items: {lines.length} • Total unidades: {totalQty}</div>
        <button disabled={!lines.length || busy || loading || !origin || !dest} onClick={confirmAndSubmit} className="inline-flex items-center rounded-md bg-black text-white px-3 py-2 text-sm disabled:opacity-50">
          {busy ? 'Creando…' : 'Crear transferencia'}
        </button>
        {draftsFlag && (
          <>
            <button disabled={!lines.length || busy || loading || !origin || !dest} onClick={saveAsDraft} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
              Guardar como borrador
            </button>
            <button type="button" onClick={() => setShowDrafts(v => !v)} className="ml-auto inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
              {showDrafts ? 'Ocultar borradores' : 'Mis borradores'}
            </button>
          </>
        )}
      </div>

      {result && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
          {result.kind === 'insufficient' && Array.isArray(result.insufficient) ? (
            <div className="text-slate-800">
              <div className="font-semibold mb-2">No se pudo procesar el envío:</div>
              <ul className="list-disc pl-5 space-y-1">
                {result.insufficient.map((it: any, idx: number) => (
                  <li key={idx}>
                    El producto <span className="font-mono">{it.code}</span> solo tiene <strong>{it.available}</strong> piezas en existencia en "{result.origin || origin}" y se intentaron mover <strong>{it.requested}</strong>.
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-slate-600">Ajusta las cantidades o revisa existencias en la ubicación de origen.</div>
            </div>
          ) : result.kind === 'success' ? (
            <div className="text-slate-800">
              <div className="font-semibold mb-2">
                {result.validated !== undefined ? 'Transferencia validada' : 'Transferencia creada correctamente'}
              </div>
              {result.pickingName && (
                <div>
                  Picking: <span className="font-mono">{result.pickingName}</span>
                  {result.status && <span className="ml-2 text-slate-500">(estado: {result.status})</span>}
                </div>
              )}
              {result.shopify?.id && (
                <div className="mt-2 text-green-700">Replicado en Shopify (ID: <span className="font-mono">{result.shopify.id}</span>).</div>
              )}
            </div>
          ) : (
            <pre className="rounded bg-slate-900 text-slate-100 p-3 text-xs overflow-auto">{JSON.stringify(result, null, 2)}</pre>
          )}
        </div>
      )}

      {draftsFlag && showDrafts && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Mis borradores</div>
            <button onClick={refreshDrafts} className="text-xs underline">Actualizar</button>
          </div>
          <div className="mt-3 divide-y">
            {drafts.length ? drafts.map((d) => (
              <div key={d.id} className="py-2 flex items-center gap-3">
                <div className="flex-1">
                  <div className="font-medium">{d.draft_title || d.id}</div>
                  <div className="text-xs text-slate-500">{d.origin_id || '—'} → {d.dest_id || '—'} • {new Date(d.updated_at || d.created_at || '').toLocaleString()}</div>
                </div>
                <button onClick={() => resumeDraft(d.id)} className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Reanudar</button>
                <button onClick={() => validateDraft(d.id)} className="inline-flex items-center rounded-md bg-black text-white px-2 py-1 text-xs">Validar</button>
                <button onClick={() => cancelDraft(d.id)} className="inline-flex items-center rounded-md border border-red-300 text-red-700 px-2 py-1 text-xs hover:bg-red-50">Cancelar</button>
              </div>
            )) : (
              <div className="py-2 text-slate-500">No tienes borradores.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
