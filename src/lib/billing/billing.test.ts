import { describe, it, expect } from 'vitest';

import {
  SUBSCRIPTION_STATUSES,
  TRANSITIONS,
  allowsChargeableWork,
  allowsWorkspaceAccess,
  dueTimeEvent,
  transition,
} from './subscription-state';
import { computeInvoice, nextPeriod, parseProrationPolicy, type PlanPrice } from './invoice-amount';
import { buildUpiUri, isValidVpa, makePaymentReference } from './upi';
import { checkSettlement, isPlausibleUtr, normalizeUtr, type AttemptForVerification } from './verification';

const NOW = new Date('2026-11-21T10:00:00Z');

describe('subscription state machine', () => {
  it('activates a trial on verified settlement', () => {
    expect(transition('trialing', 'payment_settled')).toEqual({ ok: true, from: 'trialing', to: 'active' });
  });

  it('moves active → past_due → grace → expired over time', () => {
    expect(transition('active', 'period_ended')).toMatchObject({ ok: true, to: 'past_due' });
    expect(transition('past_due', 'grace_started')).toMatchObject({ ok: true, to: 'grace' });
    expect(transition('grace', 'grace_ended')).toMatchObject({ ok: true, to: 'expired' });
  });

  it('renewal payment during grace restores active', () => {
    expect(transition('grace', 'payment_settled')).toMatchObject({ ok: true, to: 'active' });
  });

  it('rejects illegal moves', () => {
    expect(transition('cancelled', 'grace_started')).toMatchObject({ ok: false, error: 'illegal_transition' });
    expect(transition('suspended', 'payment_settled')).toMatchObject({ ok: false });
    expect(transition('expired', 'reinstate')).toMatchObject({ ok: false });
  });

  it('only reinstate leaves suspension for a paid state', () => {
    const exits = Object.entries(TRANSITIONS.suspended).map(([, to]) => to);
    expect(exits.sort()).toEqual(['active', 'cancelled']);
  });

  it('every target state is a known status', () => {
    for (const from of SUBSCRIPTION_STATUSES) {
      for (const to of Object.values(TRANSITIONS[from])) {
        expect(SUBSCRIPTION_STATUSES).toContain(to);
      }
    }
  });

  it('grace keeps chargeable work running; suspension locks the workspace', () => {
    expect(allowsChargeableWork('grace')).toBe(true);
    expect(allowsChargeableWork('expired')).toBe(false);
    expect(allowsChargeableWork('pending_payment')).toBe(false);
    expect(allowsWorkspaceAccess('expired')).toBe(true);
    expect(allowsWorkspaceAccess('suspended')).toBe(false);
  });

  it('computes time-driven events', () => {
    const base = { current_period_end: null, grace_ends_at: null, trial_ends_at: null };
    expect(dueTimeEvent({ ...base, status: 'active', current_period_end: '2026-11-20T00:00:00Z' }, NOW)).toBe(
      'period_ended',
    );
    expect(dueTimeEvent({ ...base, status: 'active', current_period_end: '2026-12-20T00:00:00Z' }, NOW)).toBeNull();
    expect(dueTimeEvent({ ...base, status: 'past_due' }, NOW)).toBe('grace_started');
    expect(dueTimeEvent({ ...base, status: 'grace', grace_ends_at: '2026-11-21T09:59:59Z' }, NOW)).toBe('grace_ended');
    expect(dueTimeEvent({ ...base, status: 'trialing' }, NOW)).toBeNull();
    expect(dueTimeEvent({ ...base, status: 'cancelled' }, NOW)).toBeNull();
  });
});

describe('authoritative invoice amounts', () => {
  const starter: PlanPrice = { id: 'starter', price_minor: 99_900, currency: 'INR', period_days: 30 };
  const growth: PlanPrice = { id: 'growth', price_minor: 299_900, currency: 'INR', period_days: 30 };
  const active = (plan_id: string) => ({
    plan_id,
    status: 'active',
    current_period_start: '2026-11-06T10:00:00Z',
    current_period_end: '2026-12-06T10:00:00Z',
  });

  it('charges the full price for a first purchase', () => {
    expect(computeInvoice(starter, null, null, 'none', NOW)).toMatchObject({
      ok: true,
      kind: 'new',
      amount_minor: 99_900,
      effective: 'immediately',
    });
  });

  it('refuses plans with no price set (not for sale)', () => {
    expect(computeInvoice({ ...starter, price_minor: null }, null, null, 'none', NOW)).toEqual({
      ok: false,
      error: 'plan_not_for_sale',
    });
  });

  it('bills a renewal at full price', () => {
    expect(computeInvoice(starter, active('starter'), starter, 'none', NOW)).toMatchObject({
      kind: 'renewal',
      amount_minor: 99_900,
    });
  });

  it('charges a full upgrade with no proration policy', () => {
    expect(computeInvoice(growth, active('starter'), starter, 'none', NOW)).toMatchObject({
      kind: 'upgrade',
      amount_minor: 299_900,
      credit_minor: 0,
    });
  });

  it('credits unused days with daily proration, rounding the credit down', () => {
    const q = computeInvoice(growth, active('starter'), starter, 'daily', NOW);
    // 15 of 30 days unused → credit floor(99900 * 15 / 30) = 49950
    expect(q).toMatchObject({ kind: 'upgrade', credit_minor: 49_950, amount_minor: 249_950 });
  });

  it('downgrades at period end with nothing to pay now', () => {
    expect(computeInvoice(starter, active('growth'), growth, 'daily', NOW)).toMatchObject({
      kind: 'downgrade',
      amount_minor: 0,
      effective: 'period_end',
    });
  });

  it('treats an expired subscription as a new purchase', () => {
    expect(computeInvoice(starter, { ...active('starter'), status: 'expired' }, starter, 'none', NOW)).toMatchObject({
      kind: 'new',
    });
  });

  it('refuses a currency change mid-subscription', () => {
    expect(computeInvoice({ ...growth, currency: 'USD' }, active('starter'), starter, 'none', NOW)).toEqual({
      ok: false,
      error: 'currency_mismatch',
    });
  });

  it('defaults proration to none for anything unknown', () => {
    expect(parseProrationPolicy(undefined)).toBe('none');
    expect(parseProrationPolicy('weekly')).toBe('none');
    expect(parseProrationPolicy('daily')).toBe('daily');
  });

  it('extends an early renewal from the current period end', () => {
    const { start, end } = nextPeriod('renewal', 30, '2026-12-06T10:00:00Z', NOW);
    expect(start.toISOString()).toBe('2026-12-06T10:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-05T10:00:00.000Z');
  });

  it('starts a late renewal or upgrade now', () => {
    expect(nextPeriod('renewal', 30, '2026-11-01T00:00:00Z', NOW).start.toISOString()).toBe(NOW.toISOString());
    expect(nextPeriod('upgrade', 30, '2026-12-06T10:00:00Z', NOW).start.toISOString()).toBe(NOW.toISOString());
  });
});

describe('UPI request links', () => {
  const req = {
    payeeVpa: 'teddycubed@okaxis',
    payeeName: 'Teddy Cubed',
    amountMinor: 99_905,
    reference: 'TCABC123XYZ',
    note: 'Teddy CRM Starter <script>',
  };

  it('builds an encoded upi://pay link with rupees.paise', () => {
    const r = buildUpiUri(req);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uri).toBe(
        'upi://pay?pa=teddycubed%40okaxis&pn=Teddy%20Cubed&am=999.05&cu=INR&tr=TCABC123XYZ&tn=Teddy%20CRM%20Starter%20script',
      );
    }
  });

  it('rejects bad payee, amount and reference', () => {
    expect(buildUpiUri({ ...req, payeeVpa: 'not-a-vpa' })).toEqual({ ok: false, error: 'invalid_payee_vpa' });
    expect(buildUpiUri({ ...req, amountMinor: 0 })).toEqual({ ok: false, error: 'invalid_amount' });
    expect(buildUpiUri({ ...req, amountMinor: 10.5 })).toEqual({ ok: false, error: 'invalid_amount' });
    expect(buildUpiUri({ ...req, reference: 'x&am=1' })).toEqual({ ok: false, error: 'invalid_reference' });
  });

  it('validates VPAs', () => {
    expect(isValidVpa('name.surname@oksbi')).toBe(true);
    expect(isValidVpa('a@b')).toBe(false);
    expect(isValidVpa('evil@x&pa=attacker@ybl')).toBe(false);
  });

  it('makes uppercase alphanumeric references', () => {
    const ref = makePaymentReference(new Uint8Array([0, 35, 36, 71, 200, 255, 10, 11, 12, 13]));
    expect(ref).toMatch(/^TC[A-Z0-9]{10}$/);
  });
});

describe('settlement verification', () => {
  const attempt: AttemptForVerification = {
    status: 'pending_verification',
    amount_minor: 99_900,
    currency: 'INR',
    account_id: 'acc-1',
    invoice_status: 'open',
  };
  const txn = {
    utr: '4321 0987 6543',
    amount_minor: 99_900,
    currency: 'INR',
    received_into: 'HDFC-XX1234',
    received_at: '2026-11-21T09:30:00Z',
  };
  const ctx = { expectedReceivingAccount: 'hdfc-xx1234', accountId: 'acc-1', utrAlreadyUsed: false, now: NOW };

  it('accepts an exact match and normalises the UTR', () => {
    expect(checkSettlement(attempt, txn, ctx)).toEqual({ ok: true, utr: '432109876543' });
  });

  it('rejects a wrong amount (under or over)', () => {
    expect(checkSettlement(attempt, { ...txn, amount_minor: 99_800 }, ctx)).toEqual({ ok: false, error: 'amount_mismatch' });
    expect(checkSettlement(attempt, { ...txn, amount_minor: 100_000 }, ctx)).toEqual({ ok: false, error: 'amount_mismatch' });
  });

  it('rejects a duplicate UTR', () => {
    expect(checkSettlement(attempt, txn, { ...ctx, utrAlreadyUsed: true })).toEqual({ ok: false, error: 'duplicate_utr' });
  });

  it('rejects a payment for another tenant', () => {
    expect(checkSettlement(attempt, txn, { ...ctx, accountId: 'acc-2' })).toEqual({ ok: false, error: 'tenant_mismatch' });
  });

  it('rejects money received into another account', () => {
    expect(checkSettlement(attempt, { ...txn, received_into: 'ICICI-XX9999' }, ctx)).toEqual({
      ok: false,
      error: 'wrong_receiving_account',
    });
    expect(checkSettlement(attempt, txn, { ...ctx, expectedReceivingAccount: '' })).toEqual({
      ok: false,
      error: 'wrong_receiving_account',
    });
  });

  it('rejects wrong currency and junk UTRs', () => {
    expect(checkSettlement(attempt, { ...txn, currency: 'USD' }, ctx)).toEqual({ ok: false, error: 'currency_mismatch' });
    expect(checkSettlement(attempt, { ...txn, utr: 'paid!!' }, ctx)).toEqual({ ok: false, error: 'invalid_utr' });
  });

  it('allows a late payment against an expired attempt while the invoice is open', () => {
    expect(checkSettlement({ ...attempt, status: 'expired' }, txn, ctx)).toMatchObject({ ok: true });
  });

  it('refuses already verified, rejected or cancelled attempts and closed invoices', () => {
    expect(checkSettlement({ ...attempt, status: 'verified' }, txn, ctx)).toMatchObject({ error: 'attempt_not_verifiable' });
    expect(checkSettlement({ ...attempt, status: 'cancelled' }, txn, ctx)).toMatchObject({ error: 'attempt_not_verifiable' });
    expect(checkSettlement({ ...attempt, invoice_status: 'paid' }, txn, ctx)).toMatchObject({ error: 'invoice_not_open' });
  });

  it('rejects a future received date', () => {
    expect(checkSettlement(attempt, { ...txn, received_at: '2026-11-22T00:00:00Z' }, ctx)).toEqual({
      ok: false,
      error: 'received_in_future',
    });
  });

  it('normalises and sanity-checks UTRs', () => {
    expect(normalizeUtr('ab-12 34')).toBe('AB1234');
    expect(isPlausibleUtr('432109876543')).toBe(true);
    expect(isPlausibleUtr('123')).toBe(false);
  });
});
