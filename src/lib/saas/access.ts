// ============================================================
// SaaS access rules — pure, no I/O, unit-testable.
//
// An account can be used only while it is 'active', or 'trialing'
// with an unexpired trial. 'suspended' is always blocked (operator
// action: unpaid, abuse, offboarding). Billing is not wired up yet,
// so an expired trial blocks until the operator extends/activates it.
// ============================================================

export type AccountStatus = 'trialing' | 'active' | 'suspended';

export interface AccountPlanState {
  status: AccountStatus;
  trial_ends_at: string | null;
}

export type BlockReason = 'suspended' | 'trial_expired';

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: BlockReason };

export function evaluateAccess(
  account: AccountPlanState,
  now: Date = new Date(),
): AccessDecision {
  if (account.status === 'suspended') {
    return { allowed: false, reason: 'suspended' };
  }
  if (account.status === 'trialing' && account.trial_ends_at) {
    const endsAt = new Date(account.trial_ends_at);
    if (!Number.isNaN(endsAt.getTime()) && endsAt.getTime() <= now.getTime()) {
      return { allowed: false, reason: 'trial_expired' };
    }
  }
  return { allowed: true };
}

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  suspended: 'This workspace has been suspended. Contact support to restore access.',
  trial_expired: 'Your free trial has ended. Contact us to continue using the workspace.',
};

/**
 * Platform operators are listed in PLATFORM_ADMIN_EMAILS
 * (comma-separated). Compared case-insensitively against the
 * Supabase-verified email of the signed-in user.
 */
export function isPlatformAdmin(
  email: string | null | undefined,
  configured: string | undefined = process.env.PLATFORM_ADMIN_EMAILS,
): boolean {
  if (!email || !configured) return false;
  const allowed = configured
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}
