// POST /api/admin/billing/invoices/:id/refund { amount, bank_reference, reason }
// Records a refund that has ALREADY been sent from the bank. It does not
// move money and does not change the plan.

import { NextResponse } from 'next/server'

import {
  billingErrorResponse,
  isUuid,
  jsonError,
  limitMutation,
  readJsonObject,
  readString,
} from '@/lib/billing/server'
import { parseAmountToMinor } from '@/lib/products/money'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response
  const { admin, userId, email } = auth.ctx

  const limited = await limitMutation(userId, 'admin-refund')
  if (limited) return limited

  const { id } = await params
  if (!isUuid(id)) return jsonError(400, 'invalid_invoice', 'Invalid invoice id.')

  const body = await readJsonObject(request)
  const reason = readString(body, 'reason')
  const bankReference = readString(body, 'bank_reference', 60)
  const amountRaw = typeof body.amount === 'string' || typeof body.amount === 'number' ? String(body.amount) : ''
  if (!reason) return jsonError(400, 'reason_required', 'A refund reason is required.')

  const { data: invoice } = await admin.from('invoices').select('id, currency').eq('id', id).maybeSingle()
  if (!invoice) return jsonError(404, 'not_found', 'Invoice not found.')

  const amountMinor = parseAmountToMinor(amountRaw, invoice.currency)
  if (amountMinor === null || amountMinor <= 0) {
    return jsonError(400, 'invalid_amount', 'Enter the refunded amount as a positive number.')
  }

  const { data, error } = await admin.rpc('billing_record_refund', {
    p_invoice_id: id,
    p_amount_minor: amountMinor,
    p_bank_reference: bankReference,
    p_reason: reason,
    p_actor_user_id: userId,
    p_actor_email: email,
  })
  if (error) return billingErrorResponse(error)
  return NextResponse.json({ refund: data })
}
