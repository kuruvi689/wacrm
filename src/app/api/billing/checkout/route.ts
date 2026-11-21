// POST /api/billing/checkout { plan_id }
//
// The browser sends a plan id and nothing else. The amount is derived
// here with computeInvoice() and re-derived from the plan price inside
// billing_open_checkout; any `amount` in the body is ignored.

import { NextResponse } from 'next/server'

import { computeInvoice, parseProrationPolicy, type PlanPrice } from '@/lib/billing/invoice-amount'
import { activePaymentAdapter } from '@/lib/billing/providers'
import { makePaymentReference } from '@/lib/billing/upi'
import {
  authorizeTenant,
  billingErrorResponse,
  jsonError,
  limitMutation,
  parseIdempotencyKey,
  readJsonObject,
  scopeIdempotencyKey,
  supabaseAdmin,
} from '@/lib/billing/server'

const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/
const PLAN_PRICE_COLUMNS = 'id, name, price_minor, currency, period_days, is_active, is_public'

const QUOTE_MESSAGES = {
  plan_not_for_sale: 'That plan is not available for purchase.',
  currency_mismatch: 'You cannot switch to a plan billed in a different currency. Contact support.',
  same_plan_active: 'You are already on this plan. You can renew it once your current period is close to ending.',
  invalid_period: 'That plan has an invalid billing period. Contact support.',
} as const

interface PlanRow extends PlanPrice {
  name: string
  is_active: boolean
  is_public: boolean
}

export async function POST(request: Request) {
  const auth = await authorizeTenant('admin')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx

  const limited = await limitMutation(userId, 'checkout')
  if (limited) return limited

  const body = await readJsonObject(request)
  const planId = typeof body.plan_id === 'string' ? body.plan_id : ''
  if (!PLAN_ID_RE.test(planId)) return jsonError(400, 'invalid_plan', 'Choose a plan.')

  const idem = parseIdempotencyKey(request.headers.get('idempotency-key'))
  if (!idem.ok) return jsonError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8 to 200 characters.')

  const admin = supabaseAdmin()

  const { data: target } = await admin
    .from('plans')
    .select(PLAN_PRICE_COLUMNS)
    .eq('id', planId)
    .maybeSingle<PlanRow>()
  const { data: sub } = await admin.from('subscriptions').select('*').eq('account_id', accountId).maybeSingle()
  // New purchases and switches need a public plan; renewing the plan the
  // workspace is already on (or has queued) only needs it to be active, like the SQL.
  const isOwnPlan = !!sub && (target?.id === sub.plan_id || target?.id === sub.pending_plan_id)
  if (!target || !target.is_active || target.price_minor === null || !(target.is_public || isOwnPlan)) {
    return jsonError(422, 'plan_not_for_sale', 'That plan is not available for purchase.')
  }
  let currentPlan: PlanPrice | null = null
  if (sub) {
    const { data } = await admin
      .from('plans')
      .select('id, price_minor, currency, period_days')
      .eq('id', sub.plan_id)
      .maybeSingle<PlanPrice>()
    currentPlan = data
  }

  const quote = computeInvoice(
    target,
    sub
      ? {
          plan_id: sub.plan_id,
          status: sub.status,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
        }
      : null,
    currentPlan,
    parseProrationPolicy(process.env.BILLING_PRORATION_POLICY),
    new Date(),
  )
  if (!quote.ok) return jsonError(422, quote.error, QUOTE_MESSAGES[quote.error])

  // Cheaper plan: no money moves, it takes effect at the next renewal.
  if (quote.kind === 'downgrade') {
    const { data, error } = await admin.rpc('billing_schedule_downgrade', {
      p_account_id: accountId,
      p_plan_id: planId,
      p_actor_user_id: userId,
    })
    if (error) return billingErrorResponse(error)
    return NextResponse.json({ scheduled: true, subscription: data })
  }

  const adapter = activePaymentAdapter()
  if (!adapter.isConfigured()) {
    return jsonError(503, 'billing_not_configured', 'Payments are not set up yet. Please contact support.')
  }

  // Only the credit is passed; the SQL function derives the amount from the plan price.
  const { data: invoice, error: invoiceError } = await admin.rpc('billing_open_checkout', {
    p_account_id: accountId,
    p_plan_id: planId,
    p_kind: quote.kind,
    p_credit_minor: quote.credit_minor,
    p_actor_user_id: userId,
  })
  if (invoiceError || !invoice) return billingErrorResponse(invoiceError)

  // Reuse a live attempt on the same invoice instead of stacking new ones.
  const { data: existing } = await admin
    .from('payment_attempts')
    .select('id, reference, amount_minor, currency, status, upi_uri, customer_utr, expires_at')
    .eq('invoice_id', invoice.id)
    .in('status', ['awaiting_customer', 'pending_verification'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing && (existing.status === 'pending_verification' || new Date(existing.expires_at) > new Date())) {
    return NextResponse.json({ scheduled: false, invoice, attempt: existing, instructions: [] })
  }

  const reference = makePaymentReference(crypto.getRandomValues(new Uint8Array(10)))
  const created = adapter.createRequest({
    reference,
    amountMinor: Number(invoice.amount_minor),
    currency: invoice.currency,
    description: `Teddy CRM ${target.name} ${invoice.number}`,
  })
  if (!created.ok) {
    console.error('[billing] payment request failed', created.error)
    return jsonError(503, created.error, 'Could not create the payment request. Please contact support.')
  }

  const idempotencyKey = scopeIdempotencyKey(accountId, idem.key ?? crypto.randomUUID())
  const { data: attempt, error: attemptError } = await admin.rpc('billing_create_payment_attempt', {
    p_invoice_id: invoice.id,
    p_account_id: accountId,
    p_provider: adapter.id,
    p_idempotency_key: idempotencyKey,
    p_reference: reference,
    p_upi_uri: created.request.upiUri,
    p_checkout_url: created.request.checkoutUrl,
    p_provider_session_id: created.request.providerSessionId,
  })
  if (attemptError || !attempt) return billingErrorResponse(attemptError)

  return NextResponse.json({
    scheduled: false,
    invoice,
    attempt: {
      id: attempt.id,
      reference: attempt.reference,
      amount_minor: attempt.amount_minor,
      currency: attempt.currency,
      status: attempt.status,
      upi_uri: attempt.upi_uri,
      customer_utr: attempt.customer_utr,
      expires_at: attempt.expires_at,
    },
    instructions: created.request.instructions,
  })
}
