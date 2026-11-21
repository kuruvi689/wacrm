// POST /api/billing/cancel { cancel: boolean } — cancel at period end
// (or withdraw the cancellation). Service continues until the paid
// period ends.

import { NextResponse } from 'next/server'

import {
  authorizeTenant,
  billingErrorResponse,
  jsonError,
  limitMutation,
  readJsonObject,
  supabaseAdmin,
} from '@/lib/billing/server'

export async function POST(request: Request) {
  const auth = await authorizeTenant('admin')
  if (!auth.ok) return auth.response

  const limited = await limitMutation(auth.ctx.userId, 'cancel')
  if (limited) return limited

  const body = await readJsonObject(request)
  if (typeof body.cancel !== 'boolean') return jsonError(400, 'invalid_request', 'cancel must be true or false.')

  const { data, error } = await supabaseAdmin().rpc('billing_cancel_at_period_end', {
    p_account_id: auth.ctx.accountId,
    p_cancel: body.cancel,
    p_actor_user_id: auth.ctx.userId,
  })
  if (error) return billingErrorResponse(error)
  return NextResponse.json({ subscription: data })
}
