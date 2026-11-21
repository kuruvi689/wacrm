import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { roleBlockResponse } from './role-gate'

function supa(role: unknown, error: unknown = null): SupabaseClient {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) b[m] = () => b
  b.maybeSingle = async () => ({
    data: role === undefined ? null : { account_role: role },
    error,
  })
  return { from: () => b } as unknown as SupabaseClient
}

describe('roleBlockResponse', () => {
  it('blocks a viewer from agent-level actions', async () => {
    const res = await roleBlockResponse(supa('viewer'), 'u', 'agent')
    expect(res?.status).toBe(403)
  })
  it('allows agent for agent, blocks agent for admin', async () => {
    expect(await roleBlockResponse(supa('agent'), 'u', 'agent')).toBeNull()
    expect((await roleBlockResponse(supa('agent'), 'u', 'admin'))?.status).toBe(403)
  })
  it('allows admin and owner for admin', async () => {
    expect(await roleBlockResponse(supa('admin'), 'u', 'admin')).toBeNull()
    expect(await roleBlockResponse(supa('owner'), 'u', 'admin')).toBeNull()
  })
  it('fails closed when the role is missing or the query errors', async () => {
    expect((await roleBlockResponse(supa(undefined), 'u', 'agent'))?.status).toBe(403)
    expect((await roleBlockResponse(supa('agent', { message: 'x' }), 'u', 'agent'))?.status).toBe(403)
  })
})
