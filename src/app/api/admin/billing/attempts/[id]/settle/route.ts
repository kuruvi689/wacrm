// POST /api/admin/billing/attempts/:id/settle
//   { bank_utr, amount, received_into, received_at, note }
//
// The ONLY way money becomes a plan. The operator types what they saw
// on the bank statement; checkSettlement() compares it with the stored
// attempt (exact amount, currency, receiving account, UTR shape and
// uniqueness) and billing_settle_payment repeats the checks in SQL.

import { NextResponse } from 'next/server'

import {
  billingErrorResponse,
  isUuid,
  jsonError,
  limitMutation,
  readJsonObject,
  readString,
  receivingAccount,
} from '@/lib/billing/server'
import {
  VERIFICATION_MESSAGES,
  checkSettlement,
  normalizeUtr,
  type AttemptForVerification,
} from '@/lib/billing/verification'
import { parseAmountToMinor } from '@/lib/products/money'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'

const CONFLICT = new Set(['attempt_not_verifiable', 'invoice_not_open', 'duplicate_utr'])

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response
  const { admin, userId, email } = auth.ctx

  const expectedAccount = receivingAccount()
  if (!expectedAccount) {
    return jsonError(503, 'billing_not_configured', 'BILLING_RECEIVING_ACCOUNT is not set; settlement is disabled.')
  }

  const limited = await limitMutation(userId, 'admin-settle')
  if (limited) return limited

  const { id } = await params
  if (!isUuid(id)) return jsonError(400, 'invalid_attempt', 'Invalid payment id.')

  const body = await readJsonObject(request)
  const bankUtr = readString(body, 'bank_utr', 60)
  const receivedInto = readString(body, 'received_into', 120)
  const receivedAtRaw = readString(body, 'received_at', 40)
  const note = readString(body, 'note', 500)
  const amountRaw = typeof body.amount === 'string' || typeof body.amount === 'number' ? String(body.amount) : ''

  const receivedAt = new Date(receivedAtRaw)
  if (!bankUtr || !receivedInto || !amountRaw || !receivedAtRaw || Number.isNaN(receivedAt.getTime())) {
    return jsonError(400, 'invalid_request', 'Bank UTR, amount, receiving account and received time are all required.')
  }

  const { data: attempt, error: attemptError } = await admin
    .from('payment_attempts')
    .select('id, account_id, invoice_id, status, amount_minor, currency')
    .eq('id', id)
    .maybeSingle()
  if (attemptError) return billingErrorResponse(attemptError)
  if (!attempt) return jsonError(404, 'not_found', 'Payment attempt not found.')

  const { data: invoice } = await admin.from('invoices').select('id, status').eq('id', attempt.invoice_id).maybeSingle()
  if (!invoice) return jsonError(404, 'not_found', 'Invoice not found.')

  const amountMinor = parseAmountToMinor(amountRaw, attempt.currency)
  if (amountMinor === null) return jsonError(400, 'invalid_amount', 'Enter the amount as a plain number, e.g. 2999.00.')

  const utr = normalizeUtr(bankUtr)
  const { data: used } = await admin
    .from('billing_ledger')
    .select('id')
    .eq('entry_type', 'settlement')
    .eq('bank_utr', utr)
    .limit(1)
  const utrAlreadyUsed = (used ?? []).length > 0

  const attemptForCheck: AttemptForVerification = {
    status: attempt.status,
    amount_minor: Number(attempt.amount_minor),
    currency: attempt.currency,
    account_id: attempt.account_id,
    invoice_status: invoice.status,
  }
  const verdict = checkSettlement(
    attemptForCheck,
    {
      utr: bankUtr,
      amount_minor: amountMinor,
      currency: attempt.currency,
      received_into: receivedInto,
      received_at: receivedAt.toISOString(),
    },
    {
      expectedReceivingAccount: expectedAccount,
      accountId: attempt.account_id,
      utrAlreadyUsed,
      now: new Date(),
    },
  )
  if (!verdict.ok) {
    return jsonError(CONFLICT.has(verdict.error) ? 409 : 422, verdict.error, VERIFICATION_MESSAGES[verdict.error])
  }

  const { data, error } = await admin.rpc('billing_settle_payment', {
    p_attempt_id: id,
    p_bank_utr: verdict.utr,
    p_amount_minor: amountMinor,
    p_currency: attempt.currency,
    p_received_into: receivedInto,
    p_received_at: receivedAt.toISOString(),
    p_actor_user_id: userId,
    p_actor_email: email,
    p_note: note || null,
  })
  if (error) return billingErrorResponse(error)
  return NextResponse.json({ settled: true, result: data })
}
