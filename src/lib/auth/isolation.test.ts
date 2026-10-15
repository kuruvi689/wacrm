import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getCurrentAccount, requireRole, ForbiddenError, UnauthorizedError } from './account'
import { canEditSettings, canManageMembers, canSendMessages, hasMinRole } from './roles'

// Mock Supabase SSR client for auth/account testing
const mockAccountA = { id: 'account-A', name: 'Client Account A' }
const mockAccountB = { id: 'account-B', name: 'Client Account B' }

const mockProfiles: Record<string, { user_id: string; account_id: string; account_role: string; is_super_admin?: boolean }> = {
  'user-A1': { user_id: 'user-A1', account_id: 'account-A', account_role: 'owner', is_super_admin: false },
  'user-A2': { user_id: 'user-A2', account_id: 'account-A', account_role: 'agent', is_super_admin: false },
  'user-B1': { user_id: 'user-B1', account_id: 'account-B', account_role: 'owner', is_super_admin: false },
  'user-SA': { user_id: 'user-SA', account_id: 'account-A', account_role: 'owner', is_super_admin: true },
}

let activeUserId: string | null = 'user-A1'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        if (!activeUserId) return { data: { user: null }, error: new Error('Logged out') }
        return { data: { user: { id: activeUserId, email: `${activeUserId}@example.com` } } }
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: (field: string, value: string) => ({
          maybeSingle: async () => {
            if (table === 'profiles' && field === 'user_id') {
              const p = mockProfiles[value]
              return { data: p || null, error: null }
            }
            if (table === 'accounts' && field === 'id') {
              if (value === 'account-A') return { data: mockAccountA, error: null }
              if (value === 'account-B') return { data: mockAccountB, error: null }
              return { data: null, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
    }),
  }),
}))

describe('Multi-Tenant Isolation & Role Controls', () => {
  beforeEach(() => {
    activeUserId = 'user-A1'
  })

  it('correctly resolves Account A context for User A1', async () => {
    activeUserId = 'user-A1'
    const ctx = await getCurrentAccount()
    expect(ctx.userId).toBe('user-A1')
    expect(ctx.accountId).toBe('account-A')
    expect(ctx.role).toBe('owner')
    expect(ctx.account.name).toBe('Client Account A')
  })

  it('correctly resolves Account B context for User B1 and prevents cross-tenant leaks', async () => {
    activeUserId = 'user-B1'
    const ctx = await getCurrentAccount()
    expect(ctx.userId).toBe('user-B1')
    expect(ctx.accountId).toBe('account-B')
    expect(ctx.role).toBe('owner')
    expect(ctx.account.name).toBe('Client Account B')
    expect(ctx.accountId).not.toBe('account-A')
  })

  it('throws UnauthorizedError when no authenticated user is present', async () => {
    activeUserId = null
    await expect(getCurrentAccount()).rejects.toThrow(UnauthorizedError)
  })

  it('throws ForbiddenError when user profile has no account link', async () => {
    activeUserId = 'unknown-user'
    await expect(getCurrentAccount()).rejects.toThrow(ForbiddenError)
  })

  it('enforces minimum role permissions within an account', async () => {
    activeUserId = 'user-A2' // agent role
    const ctx = await getCurrentAccount()
    expect(ctx.role).toBe('agent')

    // Agents can send messages but cannot manage members or edit settings
    expect(canSendMessages(ctx.role)).toBe(true)
    expect(canManageMembers(ctx.role)).toBe(false)
    expect(canEditSettings(ctx.role)).toBe(false)

    // requireRole('admin') should throw ForbiddenError for agent
    await expect(requireRole('admin')).rejects.toThrow(ForbiddenError)
  })

  it('allows owner to perform admin/owner actions', async () => {
    activeUserId = 'user-A1' // owner role
    const ctx = await requireRole('admin')
    expect(ctx.role).toBe('owner')
    expect(hasMinRole(ctx.role, 'admin')).toBe(true)
    expect(canManageMembers(ctx.role)).toBe(true)
    expect(canEditSettings(ctx.role)).toBe(true)
  })
})
