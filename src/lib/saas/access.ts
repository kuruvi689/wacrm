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

export interface OperatorCandidate {
  id: string
  email?: string | null
  /** Supabase `email_confirmed_at`; null/undefined = unverified. */
  email_confirmed_at?: string | null
}

export interface OperatorConfig {
  userIds?: string
  emails?: string
}

function parseList(raw: string | undefined, lowercase: boolean): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => (lowercase ? entry.trim().toLowerCase() : entry.trim()))
    .filter(Boolean)
}

/**
 * Platform operators are identified by, in order of preference:
 *   1. PLATFORM_ADMIN_USER_IDS — immutable Supabase user ids (safest).
 *   2. PLATFORM_ADMIN_EMAILS — only when that email is VERIFIED
 *      (`email_confirmed_at` set). If your Supabase project has email
 *      confirmation switched off, anyone can sign up with any address
 *      and appear "confirmed", so use user ids in that case.
 */
export function isPlatformAdmin(
  user: OperatorCandidate | null | undefined,
  config: OperatorConfig = {
    userIds: process.env.PLATFORM_ADMIN_USER_IDS,
    emails: process.env.PLATFORM_ADMIN_EMAILS,
  },
): boolean {
  if (!user) return false

  if (parseList(config.userIds, false).includes(user.id)) return true

  if (!user.email || !user.email_confirmed_at) return false
  return parseList(config.emails, true).includes(user.email.trim().toLowerCase())
}
