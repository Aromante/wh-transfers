import React, { useEffect, useMemo, useState } from 'react'
import ScannerInput from '../components/ScannerInput'
import useLocations from '../hooks/useLocations'
import { genId } from '../lib/uuid'

type Line = { id: string; code: string; qty: number }

function apiBase() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '') || ''
}
function endpointTransfers() {
  const base = apiBase()
  if (!base) return '/api/transfers'
  // If already points to /api/transfers, use as-is
  if (base.endsWith('/api/transfers')) return base
  return `${base}/api/transfers`
}

export default function TransferPage() {
  const { locations, loading } = useLocations()
  const [origin, setOrigin] = useState<string>('')
  const [dest, setDest] = useState<string>('')
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
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
      // Pre-validar inventario en Shopify (si aplica). En el flujo WH -> KRONI se omite totalmente
      try {
        if (dest !== 'KRONI/Existencias') {
          const validateUrl = `${endpointTransfers().replace(/\/api\/transfers$/, '')}/api/transfers/validate`
          const pre = await fetch(validateUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ origin_id: origin, dest_id: dest, lines }),
          })
          const preData = await pre.json()
          if (pre.ok && preData?.ok === false && Array.isArray(preData.insufficient) && preData.insufficient.length) {
            setResult({ ok: false, kind: 'insufficient', insufficient: preData.insufficient, origin })
            setBusy(false)
            return
          }
        }
      } catch {}
      const o = origin.trim()
      const d = dest.trim()
      const body = {
        client_transfer_id: genId(),
        origin_id: o,
        dest_id: d,
        lines: lines.map((l) => ({ barcode: l.code, qty: l.qty })),
      }
      const r = await fetch(endpointTransfers(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (r.ok) {
        const shopify = (data as any)?.shopify_draft || null
        setResult({ ok: true, kind: 'success', id: (data as any)?.id, pickingName: (data as any)?.picking_name, pickingId: (data as any)?.odoo_picking_id, status: (data as any)?.status, shopify })
      } else if (Array.isArray((data as any)?.insufficient)) {
        setResult({ ok: false, kind: 'insufficient', insufficient: (data as any).insufficient, origin })
      } else {
        setResult({ ok: false, data })
      }
      if (r.ok) setLines([])
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) })
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
        <button disabled={!lines.length || busy || loading || !origin || !dest} onClick={submit} className="inline-flex items-center rounded-md bg-black text-white px-3 py-2 text-sm disabled:opacity-50">
          {busy ? 'Creando…' : 'Crear transferencia'}
        </button>
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
              <div className="font-semibold mb-2">Transferencia creada correctamente</div>
              <div>
                Picking: <span className="font-mono">{result.pickingName || result.pickingId}</span>
                {result.status && <span className="ml-2 text-slate-500">(estado: {result.status})</span>}
              </div>
              {result.shopify ? (
                result.shopify.created ? (
                  <div className="mt-2 text-green-700">Draft en Shopify creado (ID: <span className="font-mono">{result.shopify.id}</span>).</div>
                ) : (
                  <div className="mt-2">
                    <a
                      className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                      href={`${endpointTransfers().replace(/\/api\/transfers$/, '')}/api/transfers/${result.id}/shopify-draft.csv`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Descargar Draft CSV para Shopify
                    </a>
                  </div>
                )
              ) : null}
            </div>
          ) : (
            <pre className="rounded bg-slate-900 text-slate-100 p-3 text-xs overflow-auto">{JSON.stringify(result, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  )
}
