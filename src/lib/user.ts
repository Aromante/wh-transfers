export function getUserId() {
  try {
    // Prioridad: env para testing local; fallback a localStorage; default 'anonymous'
    const envVal = (import.meta as any).env?.VITE_DRAFTS_USER_ID
    if (envVal) return String(envVal)
    const ls = typeof window !== 'undefined' ? window.localStorage.getItem('wh_user_id') : null
    return (ls && ls.trim()) || 'anonymous'
  } catch {
    return 'anonymous'
  }
}

