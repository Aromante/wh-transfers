import { useEffect, useRef, useState } from 'react'
import type { Location } from '../hooks/useLocations'

// ── Location metadata: pill label, friendly name, colors ─────────────────────
const LOC_META: Record<string, { label: string; name: string; pillCls: string }> = {
  'WH/Existencias':    { label: 'PLANTA', name: 'Aromante Planta Productora', pillCls: 'bg-slate-200 text-slate-600' },
  'KRONI/Existencias': { label: 'KRONI',  name: 'Kroni Guadalajara',          pillCls: 'bg-green-100 text-green-700' },
  'P-CEI/Existencias': { label: 'POS',    name: 'La Ceiba',                   pillCls: 'bg-blue-100 text-blue-700'  },
  'P-CON/Existencias': { label: 'POS',    name: 'La Conquista',               pillCls: 'bg-blue-100 text-blue-700'  },
}

export function locMeta(code: string) {
  return LOC_META[code] ?? {
    label: code.split('/')[0] || code,
    name: code,
    pillCls: 'bg-slate-100 text-slate-500',
  }
}

// ── Pill component ────────────────────────────────────────────────────────────
export function LocationPill({ code }: { code: string }) {
  const m = locMeta(code)
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${m.pillCls}`}>
      {m.label}
    </span>
  )
}

// ── Row display: pill + friendly name ─────────────────────────────────────────
export function LocationLabel({ code }: { code: string }) {
  const m = locMeta(code)
  return (
    <span className="inline-flex items-center gap-1.5">
      <LocationPill code={code} />
      <span>{m.name}</span>
    </span>
  )
}

// ── Custom dropdown ───────────────────────────────────────────────────────────
type Props = {
  value: string
  onChange: (val: string) => void
  options: Location[]
  placeholder?: string
  allLabel?: string   // if set, adds an "all" option with value=""
}

export default function LocationSelect({ value, onChange, options, placeholder = 'Seleccionar…', allLabel }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const selected = options.find(o => o.code === value)
  const meta = selected ? locMeta(selected.code) : null

  return (
    <div ref={ref} className="relative w-full">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-left focus:outline-none focus:ring-2 focus:ring-slate-300"
      >
        {meta ? (
          <>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${meta.pillCls}`}>
              {meta.label}
            </span>
            <span className="truncate text-slate-800">{meta.name}</span>
          </>
        ) : (
          <span className="text-slate-400">{value ? value : (allLabel ?? placeholder)}</span>
        )}
        <svg className="ml-auto h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg overflow-hidden">
          {/* "All" option */}
          {allLabel !== undefined && (
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false) }}
              className={`w-full flex items-center px-3 py-2 text-sm text-left hover:bg-slate-50 ${value === '' ? 'bg-slate-50 font-medium text-slate-900' : 'text-slate-500'}`}
            >
              {allLabel}
              {value === '' && (
                <svg className="ml-auto h-4 w-4 shrink-0 text-slate-600" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </button>
          )}

          {options.map(loc => {
            const m = locMeta(loc.code)
            const isSelected = loc.code === value
            return (
              <button
                key={loc.code}
                type="button"
                onClick={() => { onChange(loc.code); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-slate-50 ${isSelected ? 'bg-slate-50' : ''}`}
              >
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${m.pillCls}`}>
                  {m.label}
                </span>
                <span className={`truncate ${isSelected ? 'font-medium text-slate-900' : 'text-slate-700'}`}>
                  {m.name}
                </span>
                {isSelected && (
                  <svg className="ml-auto h-4 w-4 shrink-0 text-slate-600" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
