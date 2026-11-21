// Pure presentation rules for the Billing panel. No React, no I/O.

import type { BillingPlan, BillingSubscription } from './types';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface StatusCopy {
  label: string;
  tone: StatusTone;
  /** Plain-language meaning, with the relevant date filled in. */
  explanation: string;
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** What each of the 8 subscription states means to the customer. */
export function describeStatus(sub: BillingSubscription | null): StatusCopy {
  if (!sub) {
    return {
      label: 'No plan yet',
      tone: 'muted',
      explanation: 'Your workspace is not on a paid plan yet. Choose a plan below to get started.',
    };
  }
  const periodEnd = formatDate(sub.current_period_end);
  const trialEnd = formatDate(sub.trial_ends_at);
  const graceEnd = formatDate(sub.grace_ends_at);

  switch (sub.status) {
    case 'trialing':
      return {
        label: 'Free trial',
        tone: 'ok',
        explanation: `You are on a free trial${trialEnd ? ` until ${trialEnd}` : ''}. Pick a plan before it ends to keep your workspace running.`,
      };
    case 'pending_payment':
      return {
        label: 'Waiting for payment',
        tone: 'warn',
        explanation:
          'You started checkout. Your plan switches on after we confirm your payment in our bank account.',
      };
    case 'active':
      return {
        label: 'Active',
        tone: 'ok',
        explanation: sub.cancel_at_period_end
          ? `Your plan is active and will end${periodEnd ? ` on ${periodEnd}` : ' at the end of this period'}. It will not renew.`
          : `Your plan is active${periodEnd ? ` until ${periodEnd}` : ''}. Renewal is manual: nothing is charged automatically.`,
      };
    case 'past_due':
      return {
        label: 'Renewal due',
        tone: 'warn',
        explanation: `Your paid period ended${periodEnd ? ` on ${periodEnd}` : ''} and we have not received the renewal. Everything still works for now, but please renew soon.`,
      };
    case 'grace':
      return {
        label: 'Grace period',
        tone: 'warn',
        explanation: `Your renewal is overdue. Access continues${graceEnd ? ` until ${graceEnd}` : ' for a short grace period'}, then your workspace is locked until you pay.`,
      };
    case 'suspended':
      return {
        label: 'Suspended',
        tone: 'bad',
        explanation: `This workspace was suspended by Teddy³ support. Contact support to restore access.`,
      };
    case 'cancelled':
      return {
        label: 'Cancelled',
        tone: 'muted',
        explanation: 'Your subscription was cancelled. Your data is kept. Choose a plan to start again.',
      };
    case 'expired':
      return {
        label: 'Expired',
        tone: 'bad',
        explanation: 'Your plan has expired and your workspace is locked. Choose a plan to restore access.',
      };
  }
}

export const USAGE_LABELS: Record<string, string> = {
  messages: 'WhatsApp messages',
  ai_responses: 'AI replies',
  ai_tokens: 'AI tokens',
  workflow_runs: 'Automation runs',
};

export interface UsageMeter {
  label: string;
  used: number;
  limit: number | null;
  /** 0-100, or null when unlimited. */
  percent: number | null;
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

export function buildMeter(metric: string, used: number, reserved: number, limit: number | null): UsageMeter {
  const label = USAGE_LABELS[metric] ?? metric;
  const consumed = used + reserved;
  if (limit === null) {
    return {
      label,
      used: consumed,
      limit: null,
      percent: null,
      tone: 'ok',
      text: `${consumed.toLocaleString('en-IN')} used · Unlimited`,
    };
  }
  const percent = limit <= 0 ? 100 : Math.min(100, Math.round((consumed / limit) * 100));
  const tone = percent >= 100 ? 'bad' : percent >= 80 ? 'warn' : 'ok';
  return {
    label,
    used: consumed,
    limit,
    percent,
    tone,
    text: `${consumed.toLocaleString('en-IN')} of ${limit.toLocaleString('en-IN')}`,
  };
}

export type PlanActionKind = 'renew' | 'upgrade' | 'downgrade' | 'subscribe' | 'pending';

export interface PlanAction {
  kind: PlanActionKind;
  label: string;
  disabled: boolean;
}

/**
 * Button label for a plan card. Display only: the server decides the
 * real invoice kind and amount from the plan prices.
 */
export function planAction(
  plan: BillingPlan,
  current: BillingPlan | null,
  sub: BillingSubscription | null,
): PlanAction {
  if (!sub || sub.status === 'cancelled' || sub.status === 'expired' || sub.status === 'trialing') {
    return { kind: 'subscribe', label: 'Choose plan', disabled: false };
  }
  if (sub.status === 'suspended') return { kind: 'subscribe', label: 'Suspended', disabled: true };
  if (sub.pending_plan_id === plan.id) return { kind: 'pending', label: 'Starts at renewal', disabled: true };
  if (plan.id === sub.plan_id) return { kind: 'renew', label: 'Renew', disabled: false };
  const currentPrice = current?.price_minor ?? 0;
  if ((plan.price_minor ?? 0) > currentPrice) return { kind: 'upgrade', label: 'Upgrade', disabled: false };
  return { kind: 'downgrade', label: 'Switch at renewal', disabled: false };
}

/** Whole seconds left until an ISO deadline, never negative. */
export function secondsUntil(iso: string, nowMs: number): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.floor((target - nowMs) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/** The payee VPA is the `pa` parameter of the upi:// link the server built. */
export function vpaFromUpiUri(uri: string | null): string | null {
  if (!uri) return null;
  const query = uri.split('?')[1];
  if (!query) return null;
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (key === 'pa' && value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Only ever link to a upi://pay URI; never anything else the server returned. */
export function isSafeUpiUri(uri: string | null): uri is string {
  return typeof uri === 'string' && uri.startsWith('upi://pay?');
}

export function limitText(value: number | null, unit = ''): string {
  return value === null ? 'Unlimited' : `${value.toLocaleString('en-IN')}${unit}`;
}
