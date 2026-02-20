import { useEffect, useState } from 'react'

export type Location = {
  code: string
  name: string
  is_default_origin: boolean
  can_be_origin: boolean
  can_be_destination: boolean
}

function efBase() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '')
}

const FALLBACK: Location[] = [
  { code: 'WH/Existencias',    name: 'Bodega de producción', is_default_origin: true,  can_be_origin: true,  can_be_destination: false },
  { code: 'KRONI/Existencias', name: 'CEDIS (KRONI)',        is_default_origin: false, can_be_origin: false, can_be_destination: true  },
  { code: 'P-CEI/Existencias', name: 'Tienda CEIBA',         is_default_origin: false, can_be_origin: false, can_be_destination: true  },
  { code: 'P-CON/Existencias', name: 'Tienda Conquista',     is_default_origin: false, can_be_origin: false, can_be_destination: true  },
]

export default function useLocations() {
  const [data, setData] = useState<Location[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    let aborted = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const base = efBase()
        if (!base) { if (!aborted) { setData(FALLBACK); setLoading(false) } return }
        const r = await fetch(`${base}/locations`)
        if (!r.ok) throw new Error(`locations fetch failed: ${r.status}`)
        const json = await r.json()
        const rows: any[] = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : [])
        const mapped: Location[] = rows.map((row: any) => ({
          code: String(row.odoo_location_code || row.code || ''),
          name: String(row.name || ''),
          is_default_origin: Boolean(row.can_be_origin),
          can_be_origin: Boolean(row.can_be_origin),
          can_be_destination: Boolean(row.can_be_destination),
        }))
        if (!aborted) setData(mapped.length ? mapped : FALLBACK)
      } catch (e: any) {
        if (!aborted) {
          setError(String(e?.message || e))
          setData(FALLBACK)
        }
      } finally {
        if (!aborted) setLoading(false)
      }
    }
    load()
    return () => { aborted = true }
  }, [])

  return { locations: data || [], loading, error }
}
