import { useCallback, useEffect, useState } from 'react'
import { getUserId } from '../lib/user'

function efBase() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '')
}

export type DraftItem = {
  id: string
  client_transfer_id: string
  origin_id: string | null
  dest_id: string | null
  status: string
  draft_title: string | null
  updated_at?: string
  created_at?: string
}

export default function useDrafts() {
  const [drafts, setDrafts] = useState<DraftItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const base = efBase()
      const url = base
        ? `${base}/drafts?limit=3`
        : `/api/transfers/drafts?limit=3`
      const r = await fetch(url, { headers: { 'X-User-Id': getUserId() } })
      const json = await r.json()
      if (!r.ok) throw new Error(json?.error || 'fetch_failed')
      // EF returns { data: [...] }; fallback also handles legacy { drafts: [...] }
      const list = Array.isArray(json?.data) ? json.data
                 : Array.isArray(json?.drafts) ? json.drafts
                 : []
      setDrafts(list)
    } catch (e: any) { setError(String(e?.message || e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { drafts, loading, error, refresh }
}
