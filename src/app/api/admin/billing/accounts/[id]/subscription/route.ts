// GET  /api/admin/billing/accounts/:id/subscription — subscription, invoices, history
// POST /api/admin/billing/accounts/:id/subscription { plan_id, status, ends_at, reason }
// Operator override: put a workspace on a plan without payment (trial or
// complimentary period). Always audited and always needs a reason.

import { NextResponse } from 'next/server'

import {
  billingErrorResponse,
  isUuid,
  jsonError,
  limitMutation,
  readJsonObject,
  readString,
} from '@/lib/billing/server'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUuid(id)) return jsonError(400, 'invalid_account', 'Invalid account id.')
  const admin = auth.ctx.admin

  const [subscription, invoices, events] = await Promise.all([
    admin.from('subscriptions').select('*').eq('account_id', id).maybeSingle(),
    admin
      .from('invoices')
      .select('id, number, plan_id, kind, status, amount_minor, currency, created_at, paid_at')
      .eq('account_id', id)
      .order('created_at', { ascending: false })
      .limit(12),
    admin
      .from('subscription_events')
      .select('id, event, from_status, to_status, actor_kind, reason, created_at')
      .eq('account_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
  ])
  if (subscription.error || invoices.error || events.error) {
    console.error('[admin/billing] account load failed')
    return jsonError(500, 'internal_error', 'Could not load this workspace.')
  }
  return NextResponse.json({
    subscription: subscription.data,
    invoices: invoices.data ?? [],
    events: events.data ?? [],
  })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response
  const { admin, userId, email } = auth.ctx

  const limited = await limitMutation(userId, 'admin-override')
  if (limited) return limited

  const { id } = await params
  if (!isUuid(id)) return jsonError(400, 'invalid_account', 'Invalid account id.')

  const body = await readJsonObject(request)
  const planId = readString(body, 'plan_id', 40)
  const status = body.status
  const reason = readString(body, 'reason')
  const endsAt = new Date(readString(body, 'ends_at', 40))

  if (!planId) return jsonError(400, 'invalid_plan', 'Choose a plan.')
  if (status !== 'trialing' && status !== 'active') {
    return jsonError(400, 'invalid_status', 'Status must be trialing or active.')
  }
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= Date.now()) {
    return jsonError(400, 'invalid_end_date', 'The end date must be in the future.')
  }
  if (!reason) return jsonError(400, 'reason_required', 'A reason is required.')

  const { data, error } = await admin.rpc('billing_admin_set_subscription', {
    p_account_id: id,
    p_plan_id: planId,
    p_status: status,
    p_ends_at: endsAt.toISOString(),
    p_reason: reason,
    p_actor_user_id: userId,
    p_actor_email: email,
  })
  if (error) return billingErrorResponse(error)
  return NextResponse.json({ subscription: data })
}
