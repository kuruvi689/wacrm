// GET|POST /api/billing/cron — runs billing_reconcile(): expires stale
// attempts/invoices, moves subscriptions through past_due/grace/expired
// and releases abandoned usage reservations. Idempotent.

import { NextResponse } from 'next/server'

import { isAuthorizedCronRequest, isCronConfigured } from '@/lib/cron/auth'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export const maxDuration = 60

async function run(request: Request): Promise<NextResponse> {
  if (!isCronConfigured()) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { data, error } = await supabaseAdmin().rpc('billing_reconcile')
  if (error) {
    console.error('[billing/cron] reconcile failed', error)
    return NextResponse.json({ error: 'reconcile failed' }, { status: 500 })
  }
  return NextResponse.json(data ?? {})
}

export const GET = run
export const POST = run
