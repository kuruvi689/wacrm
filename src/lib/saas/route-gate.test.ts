import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { workspaceBlockResponse } from './route-gate'

interface Rows {
  profile?: { account_id: string | null } | null
  profileError?: boolean
  account?: { status: string; trial_ends_at: string | null } | null
  accountError?: boolean
}

function fakeClient(rows: Rows): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === 'profiles') {
              return { data: rows.profile ?? null, error: rows.profileError ? new Error('boom') : null }
            }
            return { data: rows.account ?? null, error: rows.accountError ? new Error('boom') : null }
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

const linked = { account_id: 'acct-1' }

describe('workspaceBlockResponse', () => {
  it('lets an active workspace through', async () => {
    const res = await workspaceBlockResponse(
      fakeClient({ profile: linked, account: { status: 'active', trial_ends_at: null } }),
      'user-1',
    )
    expect(res).toBeNull()
  })

  it('returns 403 for a suspended workspace', async () => {
    const res = await workspaceBlockResponse(
      fakeClient({ profile: linked, account: { status: 'suspended', trial_ends_at: null } }),
      'user-1',
    )
    expect(res?.status).toBe(403)
    expect((await res!.json()).error).toMatch(/suspended/i)
  })

  it('returns 403 for an expired trial', async () => {
    const res = await workspaceBlockResponse(
      fakeClient({ profile: linked, account: { status: 'trialing', trial_ends_at: '2020-01-01T00:00:00Z' } }),
      'user-1',
    )
    expect(res?.status).toBe(403)
  })

  it('fails closed when the account cannot be read', async () => {
    const res = await workspaceBlockResponse(fakeClient({ profile: linked, accountError: true }), 'user-1')
    expect(res?.status).toBe(403)
  })

  it('fails closed when the profile lookup errors', async () => {
    const res = await workspaceBlockResponse(fakeClient({ profileError: true }), 'user-1')
    expect(res?.status).toBe(403)
  })

  it('defers to the route when the user has no linked account', async () => {
    const res = await workspaceBlockResponse(fakeClient({ profile: { account_id: null } }), 'user-1')
    expect(res).toBeNull()
  })
})
