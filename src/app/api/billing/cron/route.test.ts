import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeFakeAdmin } from '@/lib/billing/test-support'

const state = vi.hoisted(() => ({ admin: null as unknown }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => state.admin }))

import { GET, POST } from './route'

const SECRET = 'cron-secret-0123456789'

afterEach(() => {
  delete process.env.CRON_SECRET
  delete process.env.AUTOMATION_CRON_SECRET
})

describe('billing cron', () => {
  it('returns 503 when no cron secret is configured', async () => {
    const admin = makeFakeAdmin({})
    state.admin = admin
    expect((await GET(new Request('http://x'))).status).toBe(503)
    expect(admin.calls).toHaveLength(0)
  })

  it('rejects requests without the secret', async () => {
    process.env.CRON_SECRET = SECRET
    const admin = makeFakeAdmin({})
    state.admin = admin
    expect((await GET(new Request('http://x'))).status).toBe(401)
    expect((await POST(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer wrong-secret-value-1' } }))).status).toBe(401)
    expect(admin.calls).toHaveLength(0)
  })

  it('runs reconcile for an authorized request', async () => {
    process.env.CRON_SECRET = SECRET
    const admin = makeFakeAdmin({}, () => ({ data: { attempts_expired: 2 }, error: null }))
    state.admin = admin
    const res = await GET(new Request('http://x', { headers: { authorization: `Bearer ${SECRET}` } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ attempts_expired: 2 })
    expect(admin.calls[0].fn).toBe('billing_reconcile')
  })
})
