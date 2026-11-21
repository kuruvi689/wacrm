// Server-only guard for API routes that authenticate with the cookie
// session directly instead of going through getCurrentAccount().
// Call it right after `auth.getUser()` succeeds.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { BLOCK_MESSAGES, evaluateAccess } from './access'

/**
 * Returns a 403 response when the caller's workspace is suspended or its
 * trial has ended, or when that cannot be verified (fail closed).
 * Returns null when the request may proceed.
 */
export async function workspaceBlockResponse(
  supabase: SupabaseClient,
  userId: string,
): Promise<NextResponse | null> {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (profileError) return unverifiable()
  // No linked account: nothing to gate here; the route's own account
  // resolution rejects this case with its existing error.
  if (!profile?.account_id) return null

  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('status, trial_ends_at')
    .eq('id', profile.account_id)
    .maybeSingle()

  if (accountError || !account) return unverifiable()

  const access = evaluateAccess({
    status: account.status ?? 'active',
    trial_ends_at: account.trial_ends_at ?? null,
  })
  if (access.allowed) return null

  return NextResponse.json({ error: BLOCK_MESSAGES[access.reason] }, { status: 403 })
}

function unverifiable(): NextResponse {
  return NextResponse.json({ error: 'Could not verify workspace access' }, { status: 403 })
}
