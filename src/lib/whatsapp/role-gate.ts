// ============================================================
// Role gate for cookie-authenticated WhatsApp routes. Call right after
// `auth.getUser()` + workspaceBlockResponse and BEFORE any Meta call.
// Fails closed (403) when the role cannot be determined.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { hasMinRole, isAccountRole, type AccountRole } from '@/lib/auth/roles'

export async function roleBlockResponse(
  supabase: SupabaseClient,
  userId: string,
  min: AccountRole,
): Promise<NextResponse | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_role')
    .eq('user_id', userId)
    .maybeSingle()

  const role = (data as { account_role?: unknown } | null)?.account_role
  if (error || !isAccountRole(role)) {
    return NextResponse.json({ error: 'Could not verify your role' }, { status: 403 })
  }
  if (!hasMinRole(role, min)) {
    return NextResponse.json(
      { error: `This action requires the '${min}' role or higher` },
      { status: 403 },
    )
  }
  return null
}
