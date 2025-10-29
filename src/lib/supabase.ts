import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const hasSupabase = Boolean(url && anon)

export const supabase = hasSupabase
  ? createClient(url!, anon!, { auth: { persistSession: false } })
  : (null as any)

