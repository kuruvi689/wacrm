// GET /api/admin/billing/audit?account_id= — append-only operator audit log.

import { NextResponse } from 'next/server'

import { isUuid, jsonError } from '@/lib/billing/server'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'

export async function GET(request: Request) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const accountId = new URL(request.url).searchParams.get('account_id')
  if (accountId !== null && !isUuid(accountId)) return jsonError(400, 'invalid_account', 'Invalid account id.')

  let query = auth.ctx.admin
    .from('billing_audit_log')
    .select('id, actor_email, action, account_id, target_type, target_id, details, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (accountId) query = query.eq('account_id', accountId)

  const { data, error } = await query
  if (error) {
    console.error('[admin/billing] audit failed', error)
    return jsonError(500, 'internal_error', 'Could not load the audit log.')
  }
  return NextResponse.json({ entries: data ?? [] })
}
