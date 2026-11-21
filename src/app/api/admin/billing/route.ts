// GET /api/admin/billing?status=pending_verification|awaiting_customer|expired|verified|rejected
// Payment attempts for the operator queue, with invoice number,
// workspace name, the customer's claimed UTR and a duplicate-UTR flag.

import { NextResponse } from 'next/server'

import { jsonError } from '@/lib/billing/server'
import { normalizeUtr } from '@/lib/billing/verification'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'

const STATUSES = ['pending_verification', 'awaiting_customer', 'expired', 'verified', 'rejected'] as const
type QueueStatus = (typeof STATUSES)[number]
const MAX_ROWS = 200

export async function GET(request: Request) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response
  const admin = auth.ctx.admin

  const raw = new URL(request.url).searchParams.get('status') ?? 'pending_verification'
  if (!(STATUSES as readonly string[]).includes(raw)) {
    return jsonError(400, 'invalid_status', 'Unknown status filter.')
  }
  const status = raw as QueueStatus

  const { data: attempts, error } = await admin
    .from('payment_attempts')
    .select(
      'id, invoice_id, account_id, provider, reference, amount_minor, currency, status, customer_utr, customer_submitted_at, expires_at, rejected_reason, created_at',
    )
    .eq('status', status)
    .order('created_at', { ascending: status === 'pending_verification' })
    .limit(MAX_ROWS)
  if (error) {
    console.error('[admin/billing] attempts failed', error)
    return jsonError(500, 'internal_error', 'Could not load payments.')
  }

  const rows = attempts ?? []
  const invoiceIds = [...new Set(rows.map((r) => r.invoice_id as string))]
  const accountIds = [...new Set(rows.map((r) => r.account_id as string))]
  const utrs = [...new Set(rows.map((r) => r.customer_utr as string | null).filter((u): u is string => !!u))]

  const [invoices, accounts, sameUtr, ledger] = await Promise.all([
    invoiceIds.length
      ? admin.from('invoices').select('id, number, plan_id, kind, status').in('id', invoiceIds)
      : Promise.resolve({ data: [], error: null }),
    accountIds.length
      ? admin.from('accounts').select('id, name').in('id', accountIds)
      : Promise.resolve({ data: [], error: null }),
    utrs.length
      ? admin.from('payment_attempts').select('id, customer_utr').in('customer_utr', utrs)
      : Promise.resolve({ data: [], error: null }),
    utrs.length
      ? admin.from('billing_ledger').select('bank_utr').eq('entry_type', 'settlement').in('bank_utr', utrs)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (invoices.error || accounts.error || sameUtr.error || ledger.error) {
    console.error('[admin/billing] lookups failed')
    return jsonError(500, 'internal_error', 'Could not load payments.')
  }

  const invoiceById = new Map((invoices.data ?? []).map((i) => [i.id as string, i]))
  const accountById = new Map((accounts.data ?? []).map((a) => [a.id as string, a]))
  const settledUtrs = new Set((ledger.data ?? []).map((l) => normalizeUtr(String(l.bank_utr))))
  const now = Date.now()

  const items = rows.map((row) => {
    const utr = row.customer_utr ? normalizeUtr(row.customer_utr as string) : null
    const claimedElsewhere = utr
      ? (sameUtr.data ?? []).some((o) => o.id !== row.id && normalizeUtr(String(o.customer_utr)) === utr)
      : false
    // A settled row's own UTR is in the ledger by definition; only flag it elsewhere.
    const alreadySettled = utr && status !== 'verified' ? settledUtrs.has(utr) : false
    const invoice = invoiceById.get(row.invoice_id as string)
    return {
      ...row,
      invoice_number: invoice?.number ?? null,
      invoice_status: invoice?.status ?? null,
      invoice_kind: invoice?.kind ?? null,
      plan_id: invoice?.plan_id ?? null,
      account_name: accountById.get(row.account_id as string)?.name ?? null,
      duplicate_utr: claimedElsewhere || alreadySettled,
      utr_already_settled: alreadySettled,
      utr_claimed_elsewhere: claimedElsewhere,
      age_minutes: Math.max(0, Math.floor((now - new Date(row.created_at as string).getTime()) / 60_000)),
    }
  })

  return NextResponse.json({
    status,
    attempts: items,
    receiving_account_configured: Boolean(process.env.BILLING_RECEIVING_ACCOUNT?.trim()),
  })
}
