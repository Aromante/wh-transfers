import { useEffect, useState } from 'react'
import { hasSupabase, supabase } from '../lib/supabase'

export type Location = {
  id: string
  code: string
  name: string
  is_default_origin: boolean
}

const FALLBACK: Location[] = [
  { id: 'wh', code: 'WH/Existencias', name: 'Bodega de producción', is_default_origin: true },
  { id: 'kroni', code: 'KRONI/Existencias', name: 'CEDIS (KRONI)', is_default_origin: false },
  { id: 'p-cei', code: 'P-CEI/Existencias', name: 'Tienda CEIBA', is_default_origin: false },
  { id: 'p-con', code: 'P-CON/Existencias', name: 'Tienda Conquista', is_default_origin: false },
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
        if (hasSupabase) {
          const { data, error } = await supabase
            .from('transfer_locations')
            .select('id, code, name, is_default_origin')
            .order('is_default_origin', { ascending: false })
            .order('code', { ascending: true })
          if (error) throw error
          if (!aborted) setData((data as any) || [])
        } else {
          if (!aborted) setData(FALLBACK)
        }
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

