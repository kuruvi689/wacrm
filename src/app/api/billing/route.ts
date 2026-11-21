// GET /api/billing — the signed-in workspace's billing overview.
// Any member may read plans, plan status and usage; invoices and the
// payment request (UPI link, reference) are admin-only, matching RLS.

import { NextResponse } from 'next/server'

import { getCurrentAccount, ForbiddenError, UnauthorizedError } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { activePaymentAdapter } from '@/lib/billing/providers'
import {
  PLAN_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  USAGE_METRICS,
  currentPeriodStart,
  jsonError,
  supabaseAdmin,
} from '@/lib/billing/server'

export async function GET() {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    if (err instanceof UnauthorizedError) return jsonError(401, 'unauthorized', 'Please sign in.')
    if (err instanceof ForbiddenError) return jsonError(403, 'forbidden', err.message)
    console.error('[billing] account context failed', err)
    return jsonError(500, 'internal_error', 'Something went wrong.')
  }

  const admin = supabaseAdmin()
  const accountId = ctx.accountId
  const canManage = hasMinRole(ctx.role, 'admin')

  const [entitlements, plans, subscription, counters] = await Promise.all([
    admin.rpc('billing_entitlements', { p_account_id: accountId }),
    admin
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('is_active', true)
      .eq('is_public', true)
      .not('price_minor', 'is', null)
      .order('sort_order', { ascending: true }),
    // Explicit columns: suspended_reason is an internal operator note, never sent to tenants.
    admin.from('subscriptions').select(SUBSCRIPTION_COLUMNS).eq('account_id', accountId).maybeSingle(),
    admin
      .from('usage_counters')
      .select('metric, used, reserved, blocked')
      .eq('account_id', accountId)
      .eq('period_start', currentPeriodStart()),
  ])

  if (entitlements.error || plans.error || subscription.error || counters.error) {
    console.error('[billing] overview failed', {
      entitlements: entitlements.error?.message,
      plans: plans.error?.message,
      subscription: subscription.error?.message,
      counters: counters.error?.message,
    })
    return jsonError(500, 'internal_error', 'Could not load billing.')
  }

  const limits = (entitlements.data?.limits ?? {}) as Record<string, number | undefined>
  const byMetric = new Map((counters.data ?? []).map((row) => [row.metric as string, row]))
  const usage = USAGE_METRICS.map((metric) => {
    const row = byMetric.get(metric)
    return {
      metric,
      used: Number(row?.used ?? 0),
      reserved: Number(row?.reserved ?? 0),
      blocked: Number(row?.blocked ?? 0),
      limit: limits[metric] ?? null,
    }
  })

  let openInvoice: Record<string, unknown> | null = null
  let openAttempt: Record<string, unknown> | null = null
  let recentInvoices: unknown[] = []

  if (canManage) {
    const [open, recent] = await Promise.all([
      admin.from('invoices').select('*').eq('account_id', accountId).eq('status', 'open').maybeSingle(),
      admin
        .from('invoices')
        .select('id, number, plan_id, kind, status, amount_minor, credit_minor, currency, period_days, created_at, paid_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(12),
    ])
    if (open.error || recent.error) {
      console.error('[billing] invoices failed', { open: open.error?.message, recent: recent.error?.message })
      return jsonError(500, 'internal_error', 'Could not load billing.')
    }
    openInvoice = open.data
    recentInvoices = recent.data ?? []
    if (openInvoice) {
      const { data: attempt } = await admin
        .from('payment_attempts')
        .select('id, reference, amount_minor, currency, status, upi_uri, customer_utr, customer_submitted_at, expires_at, created_at')
        .eq('invoice_id', openInvoice.id as string)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      openAttempt = attempt
    }
  }

  // A workspace may sit on a hidden plan (operator grant). Show that plan, and a queued
  // one, so the customer can renew it even though it is not on public sale.
  const sub = subscription.data as { plan_id: string; pending_plan_id: string | null } | null
  const listed = (plans.data ?? []) as unknown as Array<{ id: string }>
  const missing = [sub?.plan_id, sub?.pending_plan_id].filter(
    (id): id is string => !!id && !listed.some((p) => p.id === id),
  )
  let visiblePlans: unknown[] = listed
  if (missing.length > 0) {
    const { data: own } = await admin
      .from('plans')
      .select(PLAN_COLUMNS)
      .in('id', missing)
      .eq('is_active', true)
      .not('price_minor', 'is', null)
    visiblePlans = [...listed, ...(own ?? [])]
  }

  const adapter = activePaymentAdapter()
  return NextResponse.json({
    can_manage: canManage,
    configured: adapter.isConfigured(),
    entitlements: entitlements.data,
    plans: visiblePlans,
    subscription: subscription.data,
    usage,
    open_invoice: openInvoice,
    open_attempt: openAttempt,
    invoices: recentInvoices,
  })
}
