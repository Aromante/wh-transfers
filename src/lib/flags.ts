export function isMultiDraftsEnabled() {
  try {
    const v = (import.meta as any).env?.VITE_ENABLE_MULTI_DRAFTS
    const s = String(v ?? '').toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

