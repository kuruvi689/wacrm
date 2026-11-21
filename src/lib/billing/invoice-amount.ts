// ============================================================
// Authoritative invoice amounts — pure, no I/O, unit-tested.
//
// The browser never sends an amount. The server loads the plan and
// the current subscription, calls `computeInvoice()`, and stores the
// result on the invoice. Payment verification later compares the
// money that actually arrived against this stored amount exactly.
//
// Proration is a commercial policy, so it is a parameter
// (`BILLING_PRORATION_POLICY`), defaulting to 'none' until the
// founder approves one.
// ============================================================

export type ProrationPolicy = 'none' | 'daily';

export type InvoiceKind = 'new' | 'renewal' | 'upgrade' | 'downgrade';

export interface PlanPrice {
  id: string;
  /** Price per billing period in minor units; null = not for sale. */
  price_minor: number | null;
  currency: string;
  period_days: number;
}

export interface CurrentSubscription {
  plan_id: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
}

export type InvoiceQuote =
  | {
      ok: true;
      kind: InvoiceKind;
      amount_minor: number;
      currency: string;
      /** When the plan change takes effect: now, or at period end. */
      effective: 'immediately' | 'period_end';
      period_days: number;
      /** Unused value of the current period credited against an upgrade. */
      credit_minor: number;
    }
  | { ok: false; error: 'plan_not_for_sale' | 'currency_mismatch' | 'same_plan_active' | 'invalid_period' };

const DAY_MS = 86_400_000;

export function parseProrationPolicy(raw: string | undefined): ProrationPolicy {
  return raw === 'daily' ? 'daily' : 'none';
}

/**
 * Work out what the customer owes to move to `target`.
 *
 *  - no current paid subscription      → 'new', full price, starts now
 *  - same plan                         → 'renewal', full price, extends from period end
 *  - more expensive plan               → 'upgrade', starts now; with 'daily' proration the
 *                                        unused days of the current plan are credited
 *  - cheaper plan                      → 'downgrade', no charge now; switches at period end
 *                                        (next renewal is billed at the new price)
 */
export function computeInvoice(
  target: PlanPrice,
  current: CurrentSubscription | null,
  currentPlan: PlanPrice | null,
  policy: ProrationPolicy,
  now: Date,
): InvoiceQuote {
  if (target.price_minor === null || target.price_minor < 0) {
    return { ok: false, error: 'plan_not_for_sale' };
  }
  if (!Number.isInteger(target.period_days) || target.period_days <= 0) {
    return { ok: false, error: 'invalid_period' };
  }

  const paidStates = new Set(['active', 'past_due', 'grace']);
  const hasPaidPlan = current !== null && currentPlan !== null && paidStates.has(current.status);

  if (!hasPaidPlan) {
    return quote('new', target.price_minor, target, 'immediately', 0);
  }

  if (currentPlan.currency !== target.currency) {
    return { ok: false, error: 'currency_mismatch' };
  }

  if (current.plan_id === target.id) {
    return quote('renewal', target.price_minor, target, 'immediately', 0);
  }

  const currentPrice = currentPlan.price_minor ?? 0;
  if (target.price_minor < currentPrice) {
    return quote('downgrade', 0, target, 'period_end', 0);
  }

  let credit = 0;
  if (policy === 'daily' && current.current_period_end && current.current_period_start) {
    const end = new Date(current.current_period_end).getTime();
    const start = new Date(current.current_period_start).getTime();
    const totalDays = Math.max(1, Math.round((end - start) / DAY_MS));
    const remainingDays = Math.max(0, Math.floor((end - now.getTime()) / DAY_MS));
    // Round the credit down so rounding never favours the customer by a
    // fraction the ledger can't represent.
    credit = Math.floor((currentPrice * Math.min(remainingDays, totalDays)) / totalDays);
  }

  return quote('upgrade', Math.max(0, target.price_minor - credit), target, 'immediately', credit);
}

function quote(
  kind: InvoiceKind,
  amount: number,
  target: PlanPrice,
  effective: 'immediately' | 'period_end',
  credit: number,
): InvoiceQuote {
  return {
    ok: true,
    kind,
    amount_minor: amount,
    currency: target.currency,
    effective,
    period_days: target.period_days,
    credit_minor: credit,
  };
}

/**
 * New period after a settled payment. A renewal paid early extends
 * from the current period end (customer never loses paid days); any
 * other purchase starts now.
 */
export function nextPeriod(
  kind: InvoiceKind,
  periodDays: number,
  currentPeriodEnd: string | null,
  now: Date,
): { start: Date; end: Date } {
  const currentEnd = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  const start =
    kind === 'renewal' && currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  return { start, end: new Date(start.getTime() + periodDays * DAY_MS) };
}
