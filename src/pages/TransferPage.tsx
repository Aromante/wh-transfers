import React, { useEffect, useMemo, useRef, useState } from 'react'
import useLocations from '../hooks/useLocations'
import LocationSelect from '../components/LocationSelect'
import { genId } from '../lib/uuid'
import { getUserId } from '../lib/user'

type Line = { id: string; code: string; qty: number; name?: string | null; qtyPerBox?: number | null }

/** Strips "[SKU-CODE] " prefix and parentheses → "Eclipse Certero 30 ML" */
function cleanProductName(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .replace(/^\[.*?\]\s*/, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function ep() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '') || '/api/transfers'
}

export default function TransferPage() {
  const { locations, loading } = useLocations()
  const [origin, setOrigin] = useState<string>('')
  const [dest, setDest] = useState<string>('')
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [confirming, setConfirming] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  // Single input: scanner + manual entry + autocomplete
  const [manualInput, setManualInput] = useState<string>('')
  const [suggestions, setSuggestions] = useState<Array<{ code: string; name: string; qty_per_box: number | null }>>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const suggestTimeoutRef = useRef<any>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Auto-focus — keeps focus on the input so a scanner can send codes at any time
  useEffect(() => {
    inputRef.current?.focus()
    const id = setInterval(() => inputRef.current?.focus(), 6000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (locations.length) {
      const def = locations.find(l => l.can_be_origin)?.code || locations[0].code
      setOrigin((prev) => prev || def)
      const firstDest = locations.find(l => l.can_be_destination && l.code !== def)?.code || locations[0].code
      setDest((prev) => prev || firstDest)
    }
  }, [locations])

  const totalQty    = useMemo(() => lines.reduce((a, b) => a + b.qty, 0), [lines])
  const totalUnits  = useMemo(() => lines.reduce((a, b) => a + b.qty * (b.qtyPerBox ?? 1), 0), [lines])

  const insuffByCode = useMemo(() => {
    const m = new Map<string, { available: number; requested: number }>()
    if (result && result.kind === 'insufficient' && Array.isArray(result.insufficient)) {
      for (const it of result.insufficient) {
        if (it && it.code != null) m.set(String(it.code), { available: Number(it.available) || 0, requested: Number(it.requested) || 0 })
      }
    }
    return m
  }, [result])

  // ── Scanner / barcode scan ────────────────────────────────────────────────
  const onScan = async (code: string, prefetched?: { name: string; qty_per_box: number | null }) => {
    setScanError(null)
    const existing = lines.find(l => l.code === code)
    if (existing) {
      setLines(prev => prev.map(l => l.id === existing.id ? { ...l, qty: l.qty + 1 } : l))
      return
    }
    // Use prefetched data (from autocomplete) to avoid a second round-trip
    if (prefetched) {
      setLines(prev => [...prev, { id: genId(), code, qty: 1, name: prefetched.name, qtyPerBox: prefetched.qty_per_box }])
      return
    }
    setResolving(true)
    try {
      const r = await fetch(`${ep()}/resolve?code=${encodeURIComponent(code)}`, {
        headers: { 'X-User-Id': getUserId() },
      })
      if (!r.ok) {
        setScanError(`"${code}" no encontrado en el catálogo. Verifica el código e intenta de nuevo.`)
        return
      }
      const data = await r.json()
      const d = data?.data || data
      setLines(prev => [...prev, { id: genId(), code, qty: 1, name: d?.name ?? null, qtyPerBox: d?.qty_per_box ?? null }])
    } catch (e: any) {
      setScanError(`Error validando "${code}": ${String(e?.message || e)}`)
    } finally {
      setResolving(false)
    }
  }

  // ── Manual text input with debounced suggest ──────────────────────────────
  const onManualChange = (val: string) => {
    setManualInput(val)
    setShowSuggestions(true)
    if (suggestTimeoutRef.current) clearTimeout(suggestTimeoutRef.current)
    if (val.trim().length < 2) { setSuggestions([]); return }
    suggestTimeoutRef.current = setTimeout(async () => {
      setSuggestLoading(true)
      try {
        const r = await fetch(`${ep()}/resolve?code=${encodeURIComponent(val.trim())}`, {
          headers: { 'X-User-Id': getUserId() },
        })
        const data = await r.json()
        if (r.ok && data?.data) {
          setSuggestions([{ code: data.data.sku || data.data.barcode, name: data.data.name, qty_per_box: data.data.qty_per_box }])
        } else {
          setSuggestions([])
        }
      } catch { setSuggestions([]) }
      finally { setSuggestLoading(false) }
    }, 350)
  }

  const onManualKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && manualInput.trim()) {
      e.preventDefault()
      onScan(manualInput.trim())
      setManualInput('')
      setSuggestions([])
      setShowSuggestions(false)
    }
    if (e.key === 'Escape') { setShowSuggestions(false); setSuggestions([]) }
  }

  const selectSuggestion = (s: { code: string; name: string; qty_per_box: number | null }) => {
    setShowSuggestions(false)
    setSuggestions([])
    setManualInput('')
    onScan(s.code, { name: s.name, qty_per_box: s.qty_per_box })
  }

  const removeLine = (id: string) => setLines((prev) => prev.filter((l) => l.id !== id))
  const setQty = (id: string, qty: number) => setLines(prev => prev.map(l => l.id === id ? { ...l, qty: Math.max(1, Math.floor(Number(qty) || 0)) } : l))
  const incQty = (id: string, delta: number) => setLines(prev => prev.map(l => l.id === id ? { ...l, qty: Math.max(1, l.qty + delta) } : l))

  const submit = async () => {
    if (!lines.length || !origin || !dest) return
    setBusy(true)
    setResult(null)
    try {
      // Frontend generates transfer_id for idempotency — duplicate submits are safe
      const body = {
        transfer_id: genId(),
        origin_id: origin.trim(),
        dest_id: dest.trim(),
        lines: lines.map((l) => ({ sku: l.code, qty: l.qty })),
      }
      const r = await fetch(ep(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-User-Id': getUserId() },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (r.ok) {
        const t = (data as any)?.data?.transfer || (data as any)?.transfer || data
        const message = (data as any)?.data?.message || null
        setResult({ ok: true, kind: 'success', id: t?.transfer_id || t?.id, status: t?.status, message })
        setLines([])
        setConfirming(false)
      } else {
        const inner = (data as any)?.data || data
        if (inner?.kind === 'insufficient') {
          setResult({ ok: false, kind: 'insufficient', origin: inner.origin, insufficient: inner.insufficient })
        } else {
          setResult({ ok: false, data })
        }
      }
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) })
    } finally { setBusy(false) }
  }

  const confirmAndSubmit = async () => {
    if (!lines.length || !origin || !dest) return
    setConfirming(false)
    await submit()
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <div className="font-suisseMono text-xs text-slate-500">OPERACIONES</div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Nueva transferencia</h1>
        <p className="mt-2 text-slate-600">Escanea productos y confirma el envío. El receptor lo verá en la pestaña Recepción.</p>
      </div>

      {/* Origen / Destino */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <div className="text-xs text-slate-500 mb-1">Origen</div>
          <LocationSelect
            value={origin}
            options={(locations || []).filter(l => l.can_be_origin)}
            onChange={(next) => {
              setOrigin(next)
              if (dest === next) {
                const alt = (locations || []).find(l => l.can_be_destination && l.code !== next)?.code
                if (alt) setDest(alt)
              }
            }}
          />
        </label>
        <label className="block">
          <div className="text-xs text-slate-500 mb-1">Destino</div>
          <LocationSelect
            value={dest}
            options={(locations || []).filter(l => l.can_be_destination && l.code !== origin)}
            onChange={setDest}
          />
        </label>
      </div>

      {/* Scanner / entrada manual — un solo campo */}
      <div className="mt-4">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={manualInput}
            onChange={e => onManualChange(e.target.value)}
            onKeyDown={onManualKeyDown}
            onFocus={() => manualInput.trim().length >= 2 && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            placeholder="Escanea o escribe un código de producto y presiona Enter…"
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          {showSuggestions && (suggestLoading || suggestions.length > 0) && (
            <div className="absolute z-10 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg">
              {suggestLoading && (
                <div className="px-3 py-2 text-xs text-slate-400">Buscando…</div>
              )}
              {!suggestLoading && suggestions.map(s => (
                <button
                  key={s.code}
                  type="button"
                  onMouseDown={() => selectSuggestion(s)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center justify-between gap-2"
                >
                  <span>
                    <span className="font-mono text-xs text-slate-500 mr-2">{s.code}</span>
                    <span className="text-slate-800">{cleanProductName(s.name)}</span>
                  </span>
                  {s.qty_per_box && (
                    <span className="text-xs text-slate-400 shrink-0">{s.qty_per_box} pzs/caja</span>
                  )}
                </button>
              ))}
              {!suggestLoading && suggestions.length === 0 && manualInput.trim().length >= 2 && (
                <div className="px-3 py-2 text-xs text-slate-400">Sin coincidencias</div>
              )}
            </div>
          )}
        </div>

        {resolving && <div className="mt-1 text-xs text-slate-500">Validando código…</div>}
        {scanError && !resolving && (
          <div className="mt-1 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <span className="flex-1">{scanError}</span>
            <button onClick={() => setScanError(null)} className="shrink-0 font-bold hover:text-red-900">✕</button>
          </div>
        )}
      </div>

      {/* Tabla de líneas */}
      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide">
              <th className="px-3 py-2 border-b border-slate-200 font-medium">Código</th>
              <th className="px-3 py-2 border-b border-slate-200 font-medium">Cajas</th>
              <th className="px-3 py-2 border-b border-slate-200 font-medium text-right">Total pzs</th>
              <th className="px-3 py-2 border-b border-slate-200 w-20" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const totalPzs = l.qty * (l.qtyPerBox ?? 1)
              const isBox = !!l.qtyPerBox
              return (
                <tr key={l.id} className="odd:bg-white even:bg-slate-50/50">
                  {/* Código + descripción */}
                  <td className="px-3 py-2 border-b border-slate-100">
                    <span className="font-mono text-xs text-slate-800">{l.code}</span>
                    {l.name && (
                      <div className="text-xs text-slate-400 mt-0.5 truncate max-w-[220px]">
                        {cleanProductName(l.name)}
                        {isBox && <span className="ml-1 text-slate-300">· Caja {l.qtyPerBox} pzs</span>}
                      </div>
                    )}
                    {!l.name && isBox && (
                      <div className="text-xs text-slate-400 mt-0.5">Caja · {l.qtyPerBox} pzs</div>
                    )}
                  </td>
                  {/* Cantidad de cajas */}
                  <td className="px-3 py-2 border-b border-slate-100">
                    <div className="inline-flex items-center gap-1.5">
                      <button type="button" onClick={() => incQty(l.id, -1)} className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">-</button>
                      <input
                        type="number"
                        min={1}
                        value={l.qty}
                        onChange={(e) => setQty(l.id, Number(e.target.value))}
                        className="w-16 rounded-md border border-slate-300 px-2 py-1 text-sm text-center"
                      />
                      <button type="button" onClick={() => incQty(l.id, +1)} className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">+</button>
                    </div>
                    {insuffByCode.has(l.code) && (
                      <div className="mt-1 text-xs text-red-600">Disponible: {insuffByCode.get(l.code)!.available} en "{origin}"</div>
                    )}
                  </td>
                  {/* Total piezas */}
                  <td className="px-3 py-2 border-b border-slate-100 text-right">
                    <span className={`font-semibold tabular-nums ${isBox ? 'text-slate-800' : 'text-slate-400'}`}>
                      {totalPzs}
                    </span>
                    {isBox && <div className="text-xs text-slate-400">pzs</div>}
                  </td>
                  <td className="px-3 py-2 border-b border-slate-100 text-right">
                    <button type="button" onClick={() => removeLine(l.id)} className="inline-flex items-center rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Eliminar</button>
                  </td>
                </tr>
              )
            })}
            {!lines.length && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-slate-400">Sin productos aún</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Acciones */}
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <div className="text-slate-600">
          {lines.length} línea{lines.length !== 1 ? 's' : ''}
          {' · '}
          {totalQty} caja{totalQty !== 1 ? 's' : ''}
          {totalUnits !== totalQty && <> · <span className="font-semibold">{totalUnits} pzs</span></>}
        </div>
        {!confirming && (
          <button
            disabled={!lines.length || busy || loading || !origin || !dest}
            onClick={() => setConfirming(true)}
            className="inline-flex items-center rounded-md bg-black text-white px-3 py-2 text-sm disabled:opacity-50"
          >
            Enviar transferencia
          </button>
        )}
      </div>

      {/* Panel de confirmación */}
      {confirming && (
        <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-800 mb-1">¿Confirmar envío?</p>
          <p className="text-xs text-slate-500 mb-3">
            {origin} → {dest} · {lines.length} líneas · {totalQty} caja{totalQty !== 1 ? 's' : ''} · {totalUnits} pzs
            <br />El receptor verá esta orden en la pestaña <span className="font-medium">Recepción</span>.
          </p>
          <div className="flex items-center gap-2">
            <button disabled={busy} onClick={confirmAndSubmit} className="inline-flex items-center rounded-md bg-black text-white px-4 py-2 text-sm disabled:opacity-50">
              {busy ? 'Enviando…' : 'Sí, enviar'}
            </button>
            <button disabled={busy} onClick={() => setConfirming(false)} className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-white disabled:opacity-50">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Resultado */}
      {result && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
          {result.kind === 'insufficient' && Array.isArray(result.insufficient) ? (
            <div className="text-slate-800">
              <div className="font-semibold mb-2">No se pudo procesar el envío:</div>
              <ul className="list-disc pl-5 space-y-1">
                {result.insufficient.map((it: any, idx: number) => (
                  <li key={idx}>
                    <span className="font-mono">{it.code}</span> — solo hay <strong>{it.available}</strong> pzs disponibles, se intentaron mover <strong>{it.requested}</strong>.
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-slate-600">Ajusta las cantidades o revisa existencias en la ubicación de origen.</div>
            </div>
          ) : result.kind === 'success' ? (
            <div className="text-slate-800">
              <div className="font-semibold mb-1 text-green-700">✓ Orden de transferencia creada</div>
              <div className="text-slate-600 text-xs mt-1">{result.message || 'Pendiente de recepción en destino.'}</div>
              {result.id && <div className="mt-2 text-xs text-slate-400 font-mono">ID: {result.id}</div>}
            </div>
          ) : (
            <pre className="rounded bg-slate-900 text-slate-100 p-3 text-xs overflow-auto">{JSON.stringify(result, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  )
}
