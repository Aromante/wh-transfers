import { getUserId } from './user'

const _base = () => {
  const b = (import.meta as any).env?.VITE_API_BASE || ''
  return String(b || '').replace(/\/$/, '') || '/api/transfers'
}

const _apiKey = () => (import.meta as any).env?.VITE_API_KEY || ''

/** Full endpoint URL: ep() or ep('/resolve') */
export function ep(path = '') {
  return `${_base()}${path}`
}

/** Standard headers for all API calls (includes X-Api-Key when configured) */
export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'X-User-Id': getUserId(), ...extra }
  const key = _apiKey()
  if (key) h['X-Api-Key'] = key
  return h
}
