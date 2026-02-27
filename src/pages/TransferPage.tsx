import React, { useEffect, useMemo, useRef, useState } from 'react'
import useLocations from '../hooks/useLocations'
import LocationSelect, { LocationLabel } from '../components/LocationSelect'
import { genId } from '../lib/uuid'
import { ep, apiHeaders } from '../lib/api'

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

/** Groups codes by their base SKU (everything after the first "-")
 *  BOXM-ABUINF-30 → ABUINF-30
 *  PER-ABUINF-30  → ABUINF-30
 */
function baseCode(code: string): string {
  const idx = code.indexOf('-')
  return idx >= 0 ? code.slice(idx + 1) : code
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
  const [bulkPasting, setBulkPasting] = useState(false)

  // Single input: scanner + manual entry + autocomplete
  const [manualInput, setManualInput] = useState<string>('')
  const [suggestions, setSuggestions] = useState<Array<{ code: string; name: string; qty_per_box: number | null }>>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const suggestTimeoutRef = useRef<any>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Initial focus for scanner
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (locations.length) {
      const def = locations.find(l => l.can_be_origin)?.code || locations[0].code
      setOrigin((prev) => prev || def)
      const firstDest = locations.find(l => l.can_be_destination && l.code !== def)?.code || locations[0].code
      setDest((prev) => prev || firstDest)
    }
  }, [locations])

  const totalBoxes  = useMemo(() => lines.filter(l => l.code.startsWith('BOX')).reduce((a, b) => a + b.qty, 0), [lines])
  const totalUnits  = useMemo(() => lines.reduce((a, b) => a + b.qty * (b.qtyPerBox ?? 1), 0), [lines])

  // Sum of units per base SKU (BOXM-ABUINF-30 + PER-ABUINF-30 → ABUINF-30)
  const productTotals = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of lines) {
      const key = baseCode(l.code)
      m.set(key, (m.get(key) ?? 0) + l.qty * (l.qtyPerBox ?? 1))
    }
    return m
  }, [lines])

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
      inputRef.current?.focus()
      return
    }
    // Use prefetched data (from autocomplete) to avoid a second round-trip
    if (prefetched) {
      setLines(prev => [...prev, { id: genId(), code, qty: 1, name: prefetched.name, qtyPerBox: prefetched.qty_per_box }])
      inputRef.current?.focus()
      return
    }
    setResolving(true)
    try {
      const r = await fetch(ep(`/resolve?code=${encodeURIComponent(code)}`), {
        headers: apiHeaders(),
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
      inputRef.current?.focus()
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
        const r = await fetch(ep(`/resolve?code=${encodeURIComponent(val.trim())}`), {
          headers: apiHeaders(),
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

  // ── Multi-line paste: split by newlines and resolve each code ────────────
  const onManualPaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    const codes = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (codes.length <= 1) return // single line → let browser paste normally

    e.preventDefault()
    setManualInput('')
    setSuggestions([])
    setShowSuggestions(false)
    setScanError(null)
    setBulkPasting(true)

    const uniqueCodes = [...new Set(codes)]

    // Codes already in the table → just increment qty
    const existingCodes = uniqueCodes.filter(code => lines.some(l => l.code === code))
    const newCodes      = uniqueCodes.filter(code => !lines.some(l => l.code === code))

    if (existingCodes.length) {
      setLines(prev => prev.map(l => existingCodes.includes(l.code) ? { ...l, qty: l.qty + 1 } : l))
    }

    // Resolve new codes in parallel
    const results = await Promise.allSettled(
      newCodes.map(async code => {
        const r = await fetch(ep(`/resolve?code=${encodeURIComponent(code)}`), {
          headers: apiHeaders(),
        })
        if (!r.ok) throw new Error(code)
        const data = await r.json()
        const d = data?.data || data
        return { id: genId(), code, qty: 1, name: d?.name ?? null, qtyPerBox: d?.qty_per_box ?? null } as Line
      })
    )

    const newLines = results
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<Line>).value)
    const failed = results
      .filter(r => r.status === 'rejected')
      .map(r => (r as PromiseRejectedResult).reason?.message || '?')

    if (newLines.length) setLines(prev => [...prev, ...newLines])
    if (failed.length) setScanError(`No encontrados: ${failed.join(', ')}`)

    setBulkPasting(false)
    inputRef.current?.focus()
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
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (r.ok) {
        const t = (data as any)?.data?.transfer || (data as any)?.transfer || data
        const message = (data as any)?.data?.message || null
        const earlySync = (data as any)?.data?.kroni_early_sync || null
        setResult({
          ok: true, kind: 'success', id: t?.transfer_id || t?.id, status: t?.status, message,
          odoo_transfer_id: t?.odoo_transfer_id || earlySync?.pickingName || null,
          odoo_picking_id: earlySync?.pickingId || null,
        })
        setLines([])
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

  const closeModal = () => { setConfirming(false); setResult(null) }

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
            onPaste={onManualPaste}
            placeholder="Escanea, escribe o pega una lista de códigos…"
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

        {(resolving || bulkPasting) && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <div className="rounded-2xl bg-white shadow-xl px-8 py-6 flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-slate-200 border-t-slate-600" />
              <p className="text-sm text-slate-700 font-medium">
                {bulkPasting ? 'Procesando lista…' : 'Validando código…'}
              </p>
            </div>
          </div>
        )}
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
              <th className="px-3 py-2 border-b border-slate-200 font-medium">
                <div className="flex items-center gap-1.5">
                  Código
                  <button
                    type="button"
                    title="Agrupar por producto"
                    onClick={() => setLines(prev => [...prev].sort((a, b) => baseCode(a.code).localeCompare(baseCode(b.code))))}
                    className="text-slate-400 hover:text-slate-700 transition-colors leading-none"
                  >⇅</button>
                </div>
              </th>
              <th className="px-3 py-2 border-b border-slate-200 font-medium">Cant</th>
              <th className="px-3 py-2 border-b border-slate-200 font-medium text-right">Total pzs</th>
              <th className="px-3 py-2 border-b border-slate-200 w-20" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const isBox = !!l.qtyPerBox
              const productTotal = productTotals.get(baseCode(l.code)) ?? l.qty * (l.qtyPerBox ?? 1)
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
                  {/* Cantidad */}
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
                  {/* Total piezas del mismo producto */}
                  <td className="px-3 py-2 border-b border-slate-100 text-right">
                    <span className="font-semibold tabular-nums text-slate-800">
                      {productTotal}
                    </span>
                    <div className="text-xs text-slate-400">pzs</div>
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
          {totalBoxes > 0 && <>{totalBoxes} caja{totalBoxes !== 1 ? 's' : ''} · </>}
          <span className="font-semibold">{totalUnits} pzs</span>
        </div>
        <button
          disabled={!lines.length || busy || loading || !origin || !dest}
          onClick={() => { setResult(null); setConfirming(true) }}
          className="inline-flex items-center rounded-md bg-black text-white px-3 py-2 text-sm disabled:opacity-50"
        >
          Enviar transferencia
        </button>
      </div>

      {/* Modal de confirmación / resultado */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => { if (!busy) closeModal() }}
        >
          <div
            className="relative max-w-md w-full mx-4 rounded-2xl bg-white shadow-xl p-6"
            onClick={e => e.stopPropagation()}
          >
            {/* Estado A: Confirmar */}
            {!busy && !result && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-slate-900">Confirmar envío</h2>
                  <button onClick={closeModal} className="text-slate-400 hover:text-slate-600">
                    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                  </button>
                </div>
                <div className="flex items-center gap-2 text-sm mb-4">
                  <LocationLabel code={origin} />
                  <span className="text-slate-400">→</span>
                  <LocationLabel code={dest} />
                </div>
                <div className="flex items-center gap-4 text-sm text-slate-600 mb-6">
                  {totalBoxes > 0 && (
                    <span className="flex items-center gap-1.5">
                      <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
                      {totalBoxes} caja{totalBoxes !== 1 ? 's' : ''}
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" /><path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" /></svg>
                    {lines.length} SKU{lines.length !== 1 ? 's' : ''}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>
                    {totalUnits} unidades
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={submit} className="flex-1 rounded-lg bg-black text-white px-4 py-2.5 text-sm font-medium">
                    Confirmar envío
                  </button>
                  <button onClick={closeModal} className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium hover:bg-slate-50">
                    Cancelar
                  </button>
                </div>
              </>
            )}

            {/* Estado B: Enviando */}
            {busy && (
              <div className="flex flex-col items-center py-8 gap-4">
                <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-slate-200 border-t-slate-600" />
                <p className="text-sm text-slate-600 font-medium">Enviando transferencia…</p>
              </div>
            )}

            {/* Estado C: Resultado */}
            {!busy && result && (
              <>
                {result.kind === 'success' ? (
                  <div className="flex flex-col items-center py-4 gap-3">
                    <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                      <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900">Orden creada exitosamente</h3>
                    {result.id && <p className="text-xs text-slate-400 font-mono">ID: {result.id}</p>}
                    {result.odoo_transfer_id && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-sm text-slate-600">Odoo:</span>
                        {result.odoo_picking_id ? (
                          <a
                            href={`https://aromantemx.odoo.com/odoo/action-380/${result.odoo_picking_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-mono text-blue-600 hover:underline"
                          >{result.odoo_transfer_id}</a>
                        ) : (
                          <span className="text-sm font-mono text-slate-700">{result.odoo_transfer_id}</span>
                        )}
                      </div>
                    )}
                    <button onClick={closeModal} className="mt-2 w-full rounded-lg bg-black text-white px-4 py-2.5 text-sm font-medium">
                      Aceptar
                    </button>
                  </div>
                ) : result.kind === 'insufficient' && Array.isArray(result.insufficient) ? (
                  <div className="py-2">
                    <div className="flex flex-col items-center gap-2 mb-4">
                      <div className="h-12 w-12 rounded-full bg-red-100 flex items-center justify-center">
                        <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                      </div>
                      <h3 className="text-lg font-semibold text-slate-900">Stock insuficiente</h3>
                    </div>
                    <ul className="space-y-2 mb-4">
                      {result.insufficient.map((it: any, idx: number) => (
                        <li key={idx} className="flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-sm">
                          <span className="font-mono text-slate-700">{it.code}</span>
                          <span className="text-red-700">
                            disponible <strong>{it.available}</strong> / solicitado <strong>{it.requested}</strong>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <button onClick={closeModal} className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium hover:bg-slate-50">
                      Entendido
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-4 gap-3">
                    <div className="h-12 w-12 rounded-full bg-red-100 flex items-center justify-center">
                      <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900">Error</h3>
                    <p className="text-sm text-slate-600 text-center">{result.error || JSON.stringify(result.data || result)}</p>
                    <button onClick={closeModal} className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium hover:bg-slate-50">
                      Cerrar
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
