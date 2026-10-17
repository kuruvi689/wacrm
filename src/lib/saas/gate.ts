// Server-only: decides where a signed-in user belongs before the
// dashboard renders. Imports the cookie-bound Supabase client, so it
// must never be imported from a client component.

import { createClient } from '@/lib/supabase/server'
import { evaluateAccess, isPlatformAdmin, type BlockReason } from './access'

export type WorkspaceGate =
  | { kind: 'anonymous' }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'needs_onboarding' }
  | { kind: 'ok'; isPlatformAdmin: boolean }

export async function resolveWorkspaceGate(): Promise<WorkspaceGate> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { kind: 'anonymous' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!profile?.account_id) return { kind: 'ok', isPlatformAdmin: false }

  const { data: account } = await supabase
    .from('accounts')
    .select('status, trial_ends_at, onboarding_completed_at')
    .eq('id', profile.account_id)
    .maybeSingle()
  if (!account) return { kind: 'ok', isPlatformAdmin: false }

  const operator = isPlatformAdmin(user.email)

  // Operators are never locked out of their own console by a plan state.
  if (!operator) {
    const access = evaluateAccess({
      status: account.status ?? 'active',
      trial_ends_at: account.trial_ends_at ?? null,
    })
    if (!access.allowed) return { kind: 'blocked', reason: access.reason }
  }

  const canOnboard = profile.account_role === 'owner' || profile.account_role === 'admin'
  if (canOnboard && !account.onboarding_completed_at) {
    return { kind: 'needs_onboarding' }
  }

  return { kind: 'ok', isPlatformAdmin: operator }
}
