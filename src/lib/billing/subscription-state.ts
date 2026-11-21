// ============================================================
// Subscription state machine — pure, no I/O, unit-tested.
//
// The database stores one current subscription row per account
// (migration 040). Every change of `status` goes through
// `transition()` here AND through the SQL function
// `billing_transition_subscription`, which re-checks the same table
// of allowed moves, so a bug in one layer cannot create an illegal
// state on its own.
// ============================================================

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'pending_payment',
  'active',
  'past_due',
  'grace',
  'suspended',
  'cancelled',
  'expired',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type SubscriptionEvent =
  /** A verified settlement paid the invoice for this period. */
  | 'payment_settled'
  /** Customer picked a plan; an invoice is waiting for payment. */
  | 'checkout_started'
  /** current_period_end (or trial end) passed without a settled renewal. */
  | 'period_ended'
  /** past_due → grace once the operator's grace window opens. */
  | 'grace_started'
  /** grace window ran out. */
  | 'grace_ended'
  /** Operator action (abuse, chargeback, fraud). */
  | 'suspend'
  /** Operator lifts a suspension; resumes the previous paid state. */
  | 'reinstate'
  /** Customer or operator cancels. */
  | 'cancel'
  /** Cancelled/expired subscriptions can be bought again. */
  | 'reactivate_checkout';

/**
 * Allowed moves. Anything not listed is rejected. Kept as data so the
 * SQL function and the docs can be generated from / checked against it.
 */
export const TRANSITIONS: Readonly<
  Record<SubscriptionStatus, Partial<Record<SubscriptionEvent, SubscriptionStatus>>>
> = {
  trialing: {
    checkout_started: 'pending_payment',
    payment_settled: 'active',
    period_ended: 'expired',
    suspend: 'suspended',
    cancel: 'cancelled',
  },
  pending_payment: {
    payment_settled: 'active',
    period_ended: 'expired',
    suspend: 'suspended',
    cancel: 'cancelled',
  },
  active: {
    // Renewal/upgrade invoices are paid while still active.
    payment_settled: 'active',
    period_ended: 'past_due',
    suspend: 'suspended',
    cancel: 'cancelled',
  },
  past_due: {
    payment_settled: 'active',
    grace_started: 'grace',
    suspend: 'suspended',
    cancel: 'cancelled',
  },
  grace: {
    payment_settled: 'active',
    grace_ended: 'expired',
    suspend: 'suspended',
    cancel: 'cancelled',
  },
  suspended: {
    reinstate: 'active',
    cancel: 'cancelled',
  },
  cancelled: {
    reactivate_checkout: 'pending_payment',
    payment_settled: 'active',
  },
  expired: {
    reactivate_checkout: 'pending_payment',
    payment_settled: 'active',
    cancel: 'cancelled',
  },
};

export type TransitionResult =
  | { ok: true; from: SubscriptionStatus; to: SubscriptionStatus }
  | { ok: false; from: SubscriptionStatus; event: SubscriptionEvent; error: 'illegal_transition' };

export function transition(
  from: SubscriptionStatus,
  event: SubscriptionEvent,
): TransitionResult {
  const to = TRANSITIONS[from]?.[event];
  if (!to) return { ok: false, from, event, error: 'illegal_transition' };
  return { ok: true, from, to };
}

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether the workspace may do chargeable work (AI replies, broadcasts,
 * automations). `grace` keeps service running on purpose — that is
 * what a grace period is for; quotas still apply.
 */
export function allowsChargeableWork(status: SubscriptionStatus): boolean {
  return status === 'trialing' || status === 'active' || status === 'past_due' || status === 'grace';
}

/**
 * Whether members can still sign in and read their data. Only a
 * suspension locks the workspace; expired/cancelled tenants keep
 * read access so they can export data and renew.
 */
export function allowsWorkspaceAccess(status: SubscriptionStatus): boolean {
  return status !== 'suspended';
}

export interface PeriodState {
  status: SubscriptionStatus;
  current_period_end: string | null;
  grace_ends_at: string | null;
  trial_ends_at: string | null;
}

/**
 * Time-driven event the reconciliation job should apply now, if any.
 * Pure: the cron passes `now`. Returns null when nothing is due.
 */
export function dueTimeEvent(sub: PeriodState, now: Date): SubscriptionEvent | null {
  const at = (iso: string | null) => (iso ? new Date(iso).getTime() : Number.NaN);
  const t = now.getTime();

  switch (sub.status) {
    case 'trialing':
      return at(sub.trial_ends_at) <= t ? 'period_ended' : null;
    case 'active':
      return at(sub.current_period_end) <= t ? 'period_ended' : null;
    case 'past_due':
      // past_due is a momentary state: open the grace window at once.
      return 'grace_started';
    case 'grace':
      return at(sub.grace_ends_at) <= t ? 'grace_ended' : null;
    default:
      return null;
  }
}
