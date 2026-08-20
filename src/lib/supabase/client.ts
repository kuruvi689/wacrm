import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

let browserClient: SupabaseClient | undefined

export function createClient() {
  if (browserClient) return browserClient

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    'https://uiwddylawrxgshtwyabi.supabase.co'
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpd2RkeWxhd3J4Z3NodHd5YWJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTg3NzEsImV4cCI6MjA5NzM3NDc3MX0._FyB9qDbCVzE9vSUi45zdGWYlq-DmJb0iOtpumV3kM4'

  browserClient = createBrowserClient(supabaseUrl, supabaseKey)

  return browserClient
}
