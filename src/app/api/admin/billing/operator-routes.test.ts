import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeAdmin, type FakeAdmin } from '@/lib/billing/test-support'

const state = vi.hoisted(() => ({ operator: false, admin: null as unknown }))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitShared: async () => ({ success: true, remaining: 9, reset: 0, limit: 10 }),
  rateLimitResponse: () => new Response('limited', { status: 429 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => state.admin }))
vi.mock('@/lib/saas/admin-auth', async () => {
  const { NextResponse } = await import('next/server')
  return {
    requirePlatformAdmin: async () =>
      state.operator
        ? { ok: true, ctx: { userId: 'op-1', email: 'op@example.com', admin: state.admin } }
        : { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) },
  }
})

import { GET as listQueue } from './route'
import { POST as settle } from './attempts/[id]/settle/route'
import { POST as reject } from './attempts/[id]/reject/route'
import { POST as refund } from './invoices/[id]/refund/route'
import { POST as override } from './accounts/[id]/subscription/route'
import { POST as accountEvent } from './accounts/[id]/event/route'
import { GET as listPlans, POST as savePlan } from './plans/route'
import { GET as audit } from './audit/route'
import { GET as accountBilling } from './accounts/[id]/subscription/route'

const ID = '11111111-1111-4111-8111-111111111111'
const ctx = { params: Promise.resolve({ id: ID }) }
const post = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) })

const ATTEMPT = { id: ID, account_id: 'acct-1', invoice_id: 'inv-1', status: 'pending_verification', amount_minor: 99900, currency: 'INR' }
const GOOD = { bank_utr: '412345678901', amount: '999.00', received_into: 'HDFC 1234', received_at: '2020-01-01T10:00:00Z', note: 'ok' }

function operatorWith(tables: Record<string, unknown>): FakeAdmin {
  const admin = makeFakeAdmin(tables, () => ({ data: { invoice_id: 'inv-1' }, error: null }))
  state.admin = admin
  state.operator = true
  return admin
}

describe('operator-only access', () => {
  it('returns 404 to non-operators on every route and touches nothing', async () => {
    const admin = makeFakeAdmin({})
    state.admin = admin
    state.operator = false
    process.env.BILLING_RECEIVING_ACCOUNT = 'HDFC 1234'
    const responses = await Promise.all([
      listQueue(new Request('http://x')),
      settle(post(GOOD), ctx),
      reject(post({ reason: 'no' }), ctx),
      refund(post({ amount: '1', reason: 'x' }), ctx),
      override(post({}), ctx),
      accountEvent(post({ event: 'suspend', reason: 'x' }), ctx),
      listPlans(),
      savePlan(post({ id: 'abc', name: 'x' })),
      audit(new Request('http://x')),
      accountBilling(new Request('http://x'), ctx),
    ])
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(404))
    expect(admin.calls).toHaveLength(0)
  })
})

describe('settle', () => {
  beforeEach(() => {
    process.env.BILLING_RECEIVING_ACCOUNT = 'HDFC 1234'
  })
  afterEach(() => {
    delete process.env.BILLING_RECEIVING_ACCOUNT
  })

  it('refuses with 503 when BILLING_RECEIVING_ACCOUNT is unset', async () => {
    delete process.env.BILLING_RECEIVING_ACCOUNT
    const admin = operatorWith({ payment_attempts: ATTEMPT, invoices: { id: 'inv-1', status: 'open' }, billing_ledger: [] })
    const res = await settle(post(GOOD), ctx)
    expect(res.status).toBe(503)
    expect(admin.calls).toHaveLength(0)
  })

  it('refuses an amount mismatch', async () => {
    const admin = operatorWith({ payment_attempts: ATTEMPT, invoices: { id: 'inv-1', status: 'open' }, billing_ledger: [] })
    const res = await settle(post({ ...GOOD, amount: '500' }), ctx)
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('amount_mismatch')
    expect(admin.calls).toHaveLength(0)
  })

  it('refuses a duplicate UTR', async () => {
    const admin = operatorWith({ payment_attempts: ATTEMPT, invoices: { id: 'inv-1', status: 'open' }, billing_ledger: [{ id: 7 }] })
    const res = await settle(post(GOOD), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('duplicate_utr')
    expect(admin.calls).toHaveLength(0)
  })

  it('refuses money received in a different account', async () => {
    const admin = operatorWith({ payment_attempts: ATTEMPT, invoices: { id: 'inv-1', status: 'open' }, billing_ledger: [] })
    const res = await settle(post({ ...GOOD, received_into: 'SBI 9999' }), ctx)
    expect((await res.json()).error.code).toBe('wrong_receiving_account')
    expect(admin.calls).toHaveLength(0)
  })

  it('settles a matching payment through the SQL function', async () => {
    const admin = operatorWith({ payment_attempts: ATTEMPT, invoices: { id: 'inv-1', status: 'open' }, billing_ledger: [] })
    const res = await settle(post(GOOD), ctx)
    expect(res.status).toBe(200)
    expect(admin.calls[0].fn).toBe('billing_settle_payment')
    expect(admin.calls[0].args).toMatchObject({ p_amount_minor: 99900, p_currency: 'INR', p_actor_user_id: 'op-1', p_bank_utr: '412345678901' })
  })
})

describe('reasons are mandatory', () => {
  it('reject / event / override / refund need a reason', async () => {
    const admin = operatorWith({})
    expect((await reject(post({}), ctx)).status).toBe(400)
    expect((await accountEvent(post({ event: 'suspend' }), ctx)).status).toBe(400)
    expect((await accountEvent(post({ event: 'delete', reason: 'x' }), ctx)).status).toBe(400)
    expect((await override(post({ plan_id: 'starter', status: 'active', ends_at: '2999-01-01' }), ctx)).status).toBe(400)
    expect((await refund(post({ amount: '10' }), ctx)).status).toBe(400)
    expect(admin.calls).toHaveLength(0)
  })
})
