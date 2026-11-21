// POST /api/billing/attempts/:id/utr { utr }
//
// A customer UTR is a CLAIM. It moves the attempt to
// pending_verification so an operator can look for the money; it never
// activates a plan. The account always comes from the session.

import { NextResponse } from 'next/server'

import {
  authorizeTenant,
  billingErrorResponse,
  isUuid,
  jsonError,
  limitMutation,
  readJsonObject,
  readString,
  supabaseAdmin,
} from '@/lib/billing/server'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTenant('admin')
  if (!auth.ok) return auth.response

  const limited = await limitMutation(auth.ctx.userId, 'utr')
  if (limited) return limited

  const { id } = await params
  if (!isUuid(id)) return jsonError(400, 'invalid_attempt', 'Invalid payment id.')

  const utr = readString(await readJsonObject(request), 'utr', 60)
  if (!utr) return jsonError(400, 'invalid_utr', 'Enter the UTR from your payment app.')

  const { data, error } = await supabaseAdmin().rpc('billing_submit_customer_utr', {
    p_attempt_id: id,
    p_account_id: auth.ctx.accountId,
    p_utr: utr,
  })
  if (error) return billingErrorResponse(error)

  // Same reply whatever the operator-side flags are: telling the customer
  // "this UTR is already settled / claimed elsewhere" would let anyone probe other tenants' UTRs.
  // The duplicate flags are computed for the operator queue only.
  const result = (data ?? {}) as { status?: string }
  return NextResponse.json({
    status: result.status ?? 'pending_verification',
    message: 'Thanks. We will activate your plan once we see the payment in our bank account.',
  })
}
