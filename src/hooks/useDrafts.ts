import { useCallback, useEffect, useState } from 'react'
import { getUserId } from '../lib/user'

function apiBase() {
  const base = (import.meta as any).env?.VITE_API_BASE || ''
  return String(base || '').replace(/\/$/, '') || ''
}
function endpointTransfers() {
  const base = apiBase()
  if (!base) return '/api/transfers'
  if (base.endsWith('/api/transfers')) return base
  return `${base}/api/transfers`
}

export type DraftItem = {
  id: string
  client_transfer_id: string
  origin_id: string | null
  dest_id: string | null
  status: string
  draft_title: string | null
  updated_at?: string
}

export default function useDrafts() {
  const [drafts, setDrafts] = useState<DraftItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const url = `${endpointTransfers()}/drafts?limit=3`
      const r = await fetch(url, { headers: { 'X-User-Id': getUserId() } })
      const data = await r.json()
      if (!r.ok || data?.ok === false) throw new Error(data?.error || 'fetch_failed')
      setDrafts(Array.isArray(data?.drafts) ? data.drafts : [])
    } catch (e: any) { setError(String(e?.message || e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { drafts, loading, error, refresh }
}
