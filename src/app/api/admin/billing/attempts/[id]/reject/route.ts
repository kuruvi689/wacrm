// POST /api/admin/billing/attempts/:id/reject { reason } — operator only.

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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response
  const { admin, userId, email } = auth.ctx

  const limited = await limitMutation(userId, 'admin-reject')
  if (limited) return limited

  const { id } = await params
  if (!isUuid(id)) return jsonError(400, 'invalid_attempt', 'Invalid payment id.')

  const reason = readString(await readJsonObject(request), 'reason')
  if (!reason) return jsonError(400, 'reason_required', 'A rejection reason is required.')

  const { data, error } = await admin.rpc('billing_reject_attempt', {
    p_attempt_id: id,
    p_reason: reason,
    p_actor_user_id: userId,
    p_actor_email: email,
  })
  if (error) return billingErrorResponse(error)
  return NextResponse.json({ attempt: data })
}
