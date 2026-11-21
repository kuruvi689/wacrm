import { describe, expect, it } from 'vitest';

import { SUBSCRIPTION_STATUSES } from '@/lib/billing/subscription-state';

import {
  buildMeter,
  describeStatus,
  formatCountdown,
  isSafeUpiUri,
  planAction,
  secondsUntil,
  vpaFromUpiUri,
} from './billing-logic';
import type { BillingPlan, BillingSubscription } from './types';

const sub = (over: Partial<BillingSubscription>): BillingSubscription => ({
  plan_id: 'starter',
  pending_plan_id: null,
  status: 'active',
  trial_ends_at: null,
  current_period_end: '2030-06-15T00:00:00Z',
  grace_ends_at: null,
  cancel_at_period_end: false,
  ...over,
});

const plan = (id: string, price: number | null): BillingPlan =>
  ({ id, name: id, price_minor: price, currency: 'INR', period_days: 30 }) as BillingPlan;

describe('describeStatus', () => {
  it('explains every one of the 8 states', () => {
    const labels = new Set<string>();
    for (const status of SUBSCRIPTION_STATUSES) {
      const copy = describeStatus(sub({ status }));
      expect(copy.explanation.length).toBeGreaterThan(20);
      labels.add(copy.label);
    }
    expect(labels.size).toBe(8);
  });
  it('says renewal is manual when active', () => {
    expect(describeStatus(sub({})).explanation).toMatch(/manual/);
    expect(describeStatus(sub({})).explanation).toMatch(/2030/);
  });
  it('handles a missing subscription', () => {
    expect(describeStatus(null).label).toBe('No plan yet');
  });
});

describe('buildMeter', () => {
  it('shows Unlimited when there is no limit', () => {
    const m = buildMeter('messages', 5, 0, null);
    expect(m.percent).toBeNull();
    expect(m.text).toContain('Unlimited');
  });
  it('warns at 80% and blocks at 100%', () => {
    expect(buildMeter('messages', 80, 0, 100).tone).toBe('warn');
    expect(buildMeter('messages', 90, 20, 100)).toMatchObject({ tone: 'bad', percent: 100 });
  });
});

describe('planAction', () => {
  const starter = plan('starter', 1000);
  it('labels renew, upgrade and downgrade', () => {
    const s = sub({});
    expect(planAction(starter, starter, s).kind).toBe('renew');
    expect(planAction(plan('pro', 5000), starter, s).kind).toBe('upgrade');
    expect(planAction(plan('lite', 500), starter, s).kind).toBe('downgrade');
  });
  it('offers a plain choice to trials and lapsed workspaces, nothing to suspended ones', () => {
    expect(planAction(starter, null, null).kind).toBe('subscribe');
    expect(planAction(starter, starter, sub({ status: 'expired' })).kind).toBe('subscribe');
    expect(planAction(starter, starter, sub({ status: 'suspended' })).disabled).toBe(true);
  });
});

describe('UPI helpers', () => {
  const uri = 'upi://pay?pa=teddy%40okaxis&pn=Teddy&am=999.00';
  it('reads the payee VPA and only trusts upi://pay links', () => {
    expect(vpaFromUpiUri(uri)).toBe('teddy@okaxis');
    expect(isSafeUpiUri(uri)).toBe(true);
    expect(isSafeUpiUri('javascript:alert(1)')).toBe(false);
    expect(isSafeUpiUri(null)).toBe(false);
  });
});

describe('countdown', () => {
  it('never goes negative and formats', () => {
    expect(secondsUntil('2000-01-01T00:00:00Z', Date.now())).toBe(0);
    expect(formatCountdown(125)).toBe('2:05');
    expect(formatCountdown(3725)).toBe('1:02:05');
  });
});
