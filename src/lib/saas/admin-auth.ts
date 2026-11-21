// Server-only: gate for the operator console and its API.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isPlatformAdmin } from './access'

export interface PlatformAdminContext {
  userId: string
  email: string
  /** Service-role client — RLS-bypassing. Callers must be platform admins. */
  admin: SupabaseClient
}

/**
 * Resolves the signed-in platform operator, or returns the error
 * response to send back. Non-operators get a 404 (not 403) so the
 * console's existence isn't advertised.
 */
export async function requirePlatformAdmin(): Promise<
  { ok: true; ctx: PlatformAdminContext } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!isPlatformAdmin(user)) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }

  return { ok: true, ctx: { userId: user.id, email: user.email ?? '', admin: supabaseAdmin() } }
}
