// ============================================================
// Should chargeable automation (flows, automations, AI auto-reply) run
// for this account? Today: only when the workspace is usable (not
// suspended, trial not expired). Single choke point so a subscription /
// usage entitlement check can replace the body later without touching
// the webhook call sites.
// ============================================================

import { evaluateAccess, type AccountStatus } from '@/lib/saas/access'

export interface AutomationGateAccount {
  status?: AccountStatus | string | null
  trial_ends_at?: string | null
}

export function canRunAutomation(
  account: AutomationGateAccount,
  now: Date = new Date(),
): boolean {
  return evaluateAccess(
    {
      status: (account.status ?? 'active') as AccountStatus,
      trial_ends_at: account.trial_ends_at ?? null,
    },
    now,
  ).allowed
}
