// GET  /api/admin/billing/plans — every plan, including hidden ones
// POST /api/admin/billing/plans — create or update a plan (upsert by id)
// The founder enters prices here; nothing is seeded in code.

import { NextResponse } from 'next/server'

import { PLAN_COLUMNS, jsonError, limitMutation, readJsonObject } from '@/lib/billing/server'
import { missingLimitKeys, parsePlanInput } from '@/lib/billing/plan-input'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'

export async function GET() {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const { data, error } = await auth.ctx.admin
    .from('plans')
    .select(PLAN_COLUMNS)
    .order('sort_order', { ascending: true })
  if (error) {
    console.error('[admin/billing] plans failed', error)
    return jsonError(500, 'internal_error', 'Could not load plans.')
  }
  return NextResponse.json({ plans: data ?? [] })
}

export async function POST(request: Request) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response
  const { admin, userId, email } = auth.ctx

  const limited = await limitMutation(userId, 'admin-plans')
  if (limited) return limited

  const body = await readJsonObject(request)
  const missing = missingLimitKeys(body)
  if (missing.length > 0) {
    return jsonError(400, 'invalid_plan', `Send every limit (empty = unlimited). Missing: ${missing.join(', ')}.`)
  }
  const parsed = parsePlanInput(body)
  if (!parsed.ok) return jsonError(400, 'invalid_plan', parsed.error)

  const { data, error } = await admin.from('plans').upsert(parsed.value, { onConflict: 'id' }).select(PLAN_COLUMNS).single()
  if (error) {
    console.error('[admin/billing] plan upsert failed', error)
    return jsonError(500, 'internal_error', 'Could not save the plan.')
  }

  const { updated_at: _savedAt, ...details } = parsed.value
  void _savedAt
  const { error: auditError } = await admin.from('billing_audit_log').insert({
    actor_user_id: userId,
    actor_email: email,
    action: 'plan.saved',
    account_id: null,
    target_type: 'plan',
    target_id: String(parsed.value.id),
    details,
  })
  if (auditError) console.error('[admin/billing] plan audit insert failed', auditError)

  return NextResponse.json({ plan: data })
}
