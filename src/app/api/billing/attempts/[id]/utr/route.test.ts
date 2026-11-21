import { describe, expect, it, vi } from 'vitest'

import { makeFakeAdmin } from '@/lib/billing/test-support'

const state = vi.hoisted(() => ({ admin: null as unknown }))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => state.admin }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitShared: async () => ({ success: true, remaining: 9, reset: 0, limit: 10 }),
  rateLimitResponse: () => new Response('limited', { status: 429 }),
}))
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    requireRole: async () => ({ userId: 'user-1', accountId: 'acct-1', role: 'admin', account: { id: 'acct-1', name: 'A' }, supabase: {} }),
  }
})

import { POST } from './route'

const ATTEMPT = '11111111-1111-4111-8111-111111111111'
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const req = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) })

describe('POST /api/billing/attempts/:id/utr', () => {
  it('always scopes to the session account, never the body', async () => {
    const admin = makeFakeAdmin({}, () => ({ data: { status: 'pending_verification' }, error: null }))
    state.admin = admin
    const res = await POST(req({ utr: '123456789012', account_id: 'someone-else', p_account_id: 'x' }), ctx(ATTEMPT))
    expect(res.status).toBe(200)
    expect(admin.calls[0]).toEqual({
      fn: 'billing_submit_customer_utr',
      args: { p_attempt_id: ATTEMPT, p_account_id: 'acct-1', p_utr: '123456789012' },
    })
  })

  it('cannot target another account: SQL not-found becomes 404', async () => {
    state.admin = makeFakeAdmin({}, () => ({ data: null, error: { message: 'billing: payment attempt not found', code: 'P0002' } }))
    const res = await POST(req({ utr: '123456789012' }), ctx(ATTEMPT))
    expect(res.status).toBe(404)
  })

  it('gives the same reply for duplicate claims so UTRs cannot be probed', async () => {
    state.admin = makeFakeAdmin({}, () => ({
      data: { status: 'pending_verification', utr_already_settled: true, utr_claimed_elsewhere: false },
      error: null,
    }))
    const json = await (await POST(req({ utr: '123456789012' }), ctx(ATTEMPT))).json()
    expect(json).toEqual({
      status: 'pending_verification',
      message: 'Thanks. We will activate your plan once we see the payment in our bank account.',
    })
  })

  it('rejects bad ids and empty UTRs', async () => {
    state.admin = makeFakeAdmin({})
    expect((await POST(req({ utr: '123456789012' }), ctx('nope'))).status).toBe(400)
    expect((await POST(req({}), ctx(ATTEMPT))).status).toBe(400)
  })
})
