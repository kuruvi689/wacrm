// POST /api/admin/billing/accounts/:id/event { event, reason }
// event: suspend | reinstate | cancel. Operator only, reason required.

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

const EVENTS = ['suspend', 'reinstate', 'cancel']

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response
  const { admin, userId, email } = auth.ctx

  const limited = await limitMutation(userId, 'admin-event')
  if (limited) return limited

  const { id } = await params
  if (!isUuid(id)) return jsonError(400, 'invalid_account', 'Invalid account id.')

  const body = await readJsonObject(request)
  const event = readString(body, 'event', 20)
  const reason = readString(body, 'reason')
  if (!EVENTS.includes(event)) return jsonError(400, 'invalid_event', 'Event must be suspend, reinstate or cancel.')
  if (!reason) return jsonError(400, 'reason_required', 'A reason is required.')

  const { data, error } = await admin.rpc('billing_admin_event', {
    p_account_id: id,
    p_event: event,
    p_reason: reason,
    p_actor_user_id: userId,
    p_actor_email: email,
  })
  if (error) return billingErrorResponse(error)
  return NextResponse.json({ subscription: data })
}
