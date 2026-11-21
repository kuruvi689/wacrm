// ============================================================
// Usage metering — server-only wrapper around the SQL functions in
// migration 040 (usage_reserve / usage_commit / usage_release /
// usage_record, billing_entitlements, deferred_work).
//
// Pattern for every chargeable operation:
//
//   const r = await reserveUsage(accountId, 'ai_responses', 1, `ai_reply:${wamid}`)
//   if (!r.ok) → don't do the work; deferWork(...) + notifyQuota(...)
//   try { work } then commitUsage(r.reservationId, actual)
//   catch → releaseUsage(r.reservationId)
//
// The idempotency key must be stable for the triggering event (the
// inbound wamid), so a retried webhook delivery reuses the same
// reservation instead of charging twice.
//
// Failure policy: if the metering RPC itself fails (database
// unreachable, migration not yet applied) we FAIL OPEN for legacy
// accounts and log loudly — dropping customer replies because of a
// metering outage is worse than a few unmetered replies. Accounts on a
// paid plan are re-checked by the reconcile job; see
// docs/SUBSCRIPTION_ARCHITECTURE.md.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';

export type UsageMetric = 'messages' | 'ai_responses' | 'ai_tokens' | 'workflow_runs';

export type ReserveResult =
  | { ok: true; reservationId: string | null; duplicate: boolean; status?: string; degraded?: boolean }
  | {
      ok: false;
      duplicate: boolean;
      reason: 'quota_exceeded' | 'subscription_inactive' | 'duplicate_released';
      used?: number;
      limit?: number;
    };

interface RawReserve {
  ok: boolean;
  duplicate: boolean;
  reservation_id?: string;
  status?: string;
  reason?: 'quota_exceeded' | 'subscription_inactive';
  used?: number;
  limit?: number;
}

/** Pure: map the SQL jsonb to a typed result. Exported for tests. */
export function parseReserveResult(raw: RawReserve): ReserveResult {
  if (raw.ok) {
    return { ok: true, reservationId: raw.reservation_id ?? null, duplicate: raw.duplicate, status: raw.status };
  }
  if (raw.duplicate) return { ok: false, duplicate: true, reason: 'duplicate_released' };
  return {
    ok: false,
    duplicate: false,
    reason: raw.reason ?? 'subscription_inactive',
    used: raw.used === undefined ? undefined : Number(raw.used),
    limit: raw.limit === undefined || raw.limit === null ? undefined : Number(raw.limit),
  };
}

export async function reserveUsage(
  accountId: string,
  metric: UsageMetric,
  amount: number,
  idempotencyKey: string,
  ttlSeconds = 300,
  db: SupabaseClient = supabaseAdmin(),
): Promise<ReserveResult> {
  const { data, error } = await db.rpc('usage_reserve', {
    p_account_id: accountId,
    p_metric: metric,
    p_amount: Math.max(1, Math.ceil(amount)),
    p_idempotency_key: idempotencyKey,
    p_ttl_seconds: ttlSeconds,
  });
  if (error || !data) {
    console.error('[metering] usage_reserve failed; failing open', { metric, error: error?.message });
    return { ok: true, reservationId: null, duplicate: false, degraded: true };
  }
  return parseReserveResult(data as RawReserve);
}

export async function commitUsage(
  reservationId: string | null,
  actual?: number,
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  if (!reservationId) return;
  const { error } = await db.rpc('usage_commit', {
    p_reservation_id: reservationId,
    p_actual: actual === undefined ? null : Math.max(0, Math.ceil(actual)),
  });
  // Not fatal: an uncommitted reservation expires and is released by
  // billing_reconcile(), so the worst case is under-counting one item.
  if (error) console.error('[metering] usage_commit failed', { reservationId, error: error.message });
}

export async function releaseUsage(
  reservationId: string | null,
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  if (!reservationId) return;
  const { error } = await db.rpc('usage_release', { p_reservation_id: reservationId });
  if (error) console.error('[metering] usage_release failed', { reservationId, error: error.message });
}

/** Meter without ever blocking (inbound messages). Idempotent by key. */
export async function recordUsage(
  accountId: string,
  metric: UsageMetric,
  amount: number,
  idempotencyKey: string,
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  const { error } = await db.rpc('usage_record', {
    p_account_id: accountId,
    p_metric: metric,
    p_amount: Math.max(1, Math.ceil(amount)),
    p_idempotency_key: idempotencyKey,
  });
  if (error) console.error('[metering] usage_record failed', { metric, error: error.message });
}

export interface Entitlements {
  source: 'legacy' | 'subscription';
  status: string;
  chargeable: boolean;
  plan_id: string | null;
  pending_plan_id?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
  grace_ends_at?: string | null;
  cancel_at_period_end?: boolean;
  limits: Partial<Record<string, number>>;
}

export async function getEntitlements(
  accountId: string,
  db: SupabaseClient = supabaseAdmin(),
): Promise<Entitlements | null> {
  const { data, error } = await db.rpc('billing_entitlements', { p_account_id: accountId });
  if (error || !data) {
    console.error('[metering] billing_entitlements failed', { error: error?.message });
    return null;
  }
  return data as Entitlements;
}

/**
 * Remember chargeable work that was refused (quota or billing), so the
 * owner can see what the bot skipped and it can resume after renewal.
 * Idempotent per (kind, reference).
 */
export async function deferWork(
  input: {
    accountId: string;
    kind: 'ai_reply';
    reference: string;
    conversationId?: string | null;
    reason: 'quota_exceeded' | 'subscription_inactive';
    payload?: Record<string, unknown>;
  },
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  const { error } = await db.from('deferred_work').upsert(
    {
      account_id: input.accountId,
      kind: input.kind,
      reference: input.reference,
      conversation_id: input.conversationId ?? null,
      reason: input.reason,
      payload: input.payload ?? {},
    },
    { onConflict: 'kind,reference', ignoreDuplicates: true },
  );
  if (error) console.error('[metering] deferWork failed', { error: error.message });
}

const QUOTA_TITLES: Record<UsageMetric, string> = {
  messages: 'Monthly message limit reached',
  ai_responses: 'Monthly AI reply limit reached',
  ai_tokens: 'Monthly AI credit limit reached',
  workflow_runs: 'Monthly automation run limit reached',
};

/** Tell owners/admins once (the SQL dedupes to one alert per 6 hours). */
export async function notifyQuotaExhausted(
  accountId: string,
  metric: UsageMetric,
  reason: 'quota_exceeded' | 'subscription_inactive',
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  const title =
    reason === 'subscription_inactive' ? 'AI replies paused: subscription inactive' : QUOTA_TITLES[metric];
  const body =
    reason === 'subscription_inactive'
      ? 'Customer messages are still saved. Renew from Settings → Billing to resume AI replies and automations.'
      : 'Customer messages are still saved, but the bot has stopped replying. Upgrade or wait for the next billing month in Settings → Billing.';
  const { error } = await db.rpc('billing_notify_admins', {
    p_account_id: accountId,
    p_type: reason === 'subscription_inactive' ? 'billing' : 'quota_exhausted',
    p_title: title,
    p_body: body,
  });
  if (error) console.error('[metering] notify failed', { error: error.message });
}
