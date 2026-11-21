import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeAdmin, type FakeAdmin } from '@/lib/billing/test-support'

const state = vi.hoisted(() => ({ admin: null as unknown, role: 'admin' as string }))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => state.admin }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitShared: async () => ({ success: true, remaining: 9, reset: 0, limit: 10 }),
  rateLimitResponse: () => new Response('limited', { status: 429 }),
}))
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    requireRole: async () => {
      if (state.role === 'viewer') throw new actual.ForbiddenError("This action requires the 'admin' role or higher")
      return { userId: 'user-1', accountId: 'acct-1', role: state.role, account: { id: 'acct-1', name: 'A' }, supabase: {} }
    },
  }
})

import { POST } from './route'

const PLAN = { id: 'starter', name: 'Starter', price_minor: 99900, currency: 'INR', period_days: 30, is_active: true, is_public: true }
const INVOICE = { id: 'inv-1', number: 'INV-2026-000001', amount_minor: 99900, currency: 'INR' }

function setup(rpcOverride?: (fn: string) => { data: unknown; error: null } | undefined) {
  const admin: FakeAdmin = makeFakeAdmin({ plans: PLAN, subscriptions: null, payment_attempts: [] }, (fn, args) => {
    const o = rpcOverride?.(fn)
    if (o) return o
    if (fn === 'billing_open_checkout') return { data: INVOICE, error: null }
    if (fn === 'billing_create_payment_attempt') {
      return { data: { id: 'att-1', status: 'awaiting_customer', reference: args.p_reference, amount_minor: 99900, currency: 'INR', upi_uri: args.p_upi_uri, expires_at: 'x' }, error: null }
    }
    return { data: null, error: null }
  })
  state.admin = admin
  return admin
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://x/api/billing/checkout', { method: 'POST', body: JSON.stringify(body), headers })
}

describe('POST /api/billing/checkout', () => {
  beforeEach(() => {
    state.role = 'admin'
    process.env.BILLING_UPI_VPA = 'teddy@okaxis'
    process.env.BILLING_UPI_PAYEE_NAME = 'Teddy'
  })

  it('never trusts an amount sent by the browser', async () => {
    const admin = setup()
    const res = await POST(req({ plan_id: 'starter', amount: 1, amount_minor: 1, price: 1 }))
    expect(res.status).toBe(200)

    const open = admin.calls.find((c) => c.fn === 'billing_open_checkout')!
    expect(Object.keys(open.args).sort()).toEqual(
      ['p_account_id', 'p_actor_user_id', 'p_credit_minor', 'p_kind', 'p_plan_id'],
    )
    expect(open.args.p_credit_minor).toBe(0)
    expect(open.args.p_account_id).toBe('acct-1')

    const create = admin.calls.find((c) => c.fn === 'billing_create_payment_attempt')!
    expect(String(create.args.p_upi_uri)).toContain('am=999.00')
    const json = await res.json()
    expect(json.attempt.amount_minor).toBe(99900)
  })

  it('lets a workspace renew its own hidden plan but not buy another hidden plan', async () => {
    const hidden = { ...PLAN, id: 'custom', is_public: false }
    const sub = { plan_id: 'custom', pending_plan_id: null, status: 'active', current_period_start: '2020-01-01T00:00:00Z', current_period_end: '2999-01-01T00:00:00Z' }
    const own = makeFakeAdmin({ plans: hidden, subscriptions: sub, payment_attempts: [] }, (fn, args) =>
      fn === 'billing_open_checkout'
        ? { data: INVOICE, error: null }
        : { data: { id: 'att-1', status: 'awaiting_customer', reference: args.p_reference, amount_minor: 99900, currency: 'INR', upi_uri: 'x', expires_at: 'x' }, error: null },
    )
    state.admin = own
    expect((await POST(req({ plan_id: 'custom' }))).status).toBe(200)
    expect(own.calls.some((c) => c.fn === 'billing_open_checkout')).toBe(true)

    const other = makeFakeAdmin({ plans: hidden, subscriptions: { ...sub, plan_id: 'starter' }, payment_attempts: [] })
    state.admin = other
    const res = await POST(req({ plan_id: 'custom' }))
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('plan_not_for_sale')
    expect(other.calls).toHaveLength(0)
  })

  it('rejects members below admin', async () => {
    setup()
    state.role = 'viewer'
    expect((await POST(req({ plan_id: 'starter' }))).status).toBe(403)
  })

  it('validates the Idempotency-Key length', async () => {
    setup()
    expect((await POST(req({ plan_id: 'starter' }, { 'idempotency-key': 'short' }))).status).toBe(400)
  })

  it('returns 503 when UPI is not configured', async () => {
    setup()
    delete process.env.BILLING_UPI_VPA
    const res = await POST(req({ plan_id: 'starter' }))
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('billing_not_configured')
  })

  it('rejects a malformed plan id', async () => {
    setup()
    expect((await POST(req({ plan_id: '../x' }))).status).toBe(400)
  })
})
