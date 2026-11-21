import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const m = vi.hoisted(() => ({ getEntitlements: vi.fn() }))
vi.mock('@/lib/billing/metering', () => m)

import {
  AgentAdminError,
  DEFAULT_VERSION,
  createAgent,
  activateAgent,
  createVersion,
  parseVersionInput,
  rollbackAgent,
} from './agent-admin'

/** Minimal stateful fake of the three tables the admin helpers touch. */
function fakeDb(seed: { agents?: Record<string, unknown>[]; versions?: Record<string, unknown>[]; configs?: Record<string, unknown>[] } = {}) {
  const t = {
    ai_agents: [...(seed.agents ?? [])],
    ai_agent_versions: [...(seed.versions ?? [])],
    ai_agent_events: [] as Record<string, unknown>[],
    ai_configs: [...(seed.configs ?? [])],
  }
  let n = 0
  const db = {
    rpc: async (fn: string, a: { p_agent_id: string }) => {
      if (fn !== 'ai_agent_activate') return { data: null, error: null }
      t.ai_agents.forEach((r) => {
        if (r.status === 'active') r.status = 'paused'
      })
      const ag = t.ai_agents.find((r) => r.id === a.p_agent_id)
      if (ag) ag.status = 'active'
      return { data: true, error: null }
    },
    from(table: keyof typeof t) {
      let rows = t[table]
      let mode: 'select' | 'insert' | 'update' = 'select'
      let payload: Record<string, unknown> = {}
      let head = false
      let order: [string, boolean] | null = null
      let lim: number | null = null
      const filters: [string, unknown][] = []
      const run = () => {
        let out = rows.filter((r) => filters.every(([k, v]) => r[k] === v))
        if (mode === 'insert') {
          const row = { id: `${table}-${++n}`, created_at: 'now', updated_at: 'now', ...payload }
          t[table].push(row)
          return [row]
        }
        if (mode === 'update') {
          out.forEach((r) => Object.assign(r, payload))
          return out
        }
        if (order) out = [...out].sort((a, b) => ((a[order![0]] as number) - (b[order![0]] as number)) * (order![1] ? 1 : -1))
        if (lim !== null) out = out.slice(0, lim)
        return out.map((r) => ({ ...r }))
      }
      const chain: Record<string, unknown> = {
        select: (_c?: string, o?: { head?: boolean }) => ((head = !!o?.head), chain),
        insert: (p: Record<string, unknown>) => ((mode = 'insert'), (payload = p), chain),
        update: (p: Record<string, unknown>) => ((mode = 'update'), (payload = p), chain),
        eq: (k: string, v: unknown) => (filters.push([k, v]), chain),
        order: (k: string, o: { ascending: boolean }) => ((order = [k, o.ascending]), chain),
        limit: (x: number) => ((lim = x), chain),
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => {
          const r = run()
          return Promise.resolve(head ? { count: r.length, error: null } : { data: r, error: null }).then(res)
        },
      }
      rows = t[table]
      return chain
    },
  }
  return { db: db as unknown as SupabaseClient, t }
}

const V = { ...DEFAULT_VERSION, model: 'gpt-test' }
beforeEach(() => m.getEntitlements.mockResolvedValue({ limits: {} }))

describe('max_ai_agents', () => {
  it('blocks creation at the plan limit with a plan_limit error', async () => {
    m.getEntitlements.mockResolvedValue({ limits: { max_ai_agents: 1 } })
    const { db } = fakeDb({ agents: [{ id: 'a1', account_id: 'acct' }] })
    await expect(createAgent(db, { accountId: 'acct', actor: 'u', name: 'B', version: V })).rejects.toMatchObject({
      code: 'plan_limit',
      status: 403,
    })
  })

  it('counts only this account and allows creation under the limit', async () => {
    m.getEntitlements.mockResolvedValue({ limits: { max_ai_agents: 1 } })
    const { db, t } = fakeDb({ agents: [{ id: 'a1', account_id: 'other' }] })
    const { agent, version } = await createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: V })
    expect(agent.current_version_id).toBe(version.id)
    expect(version.version_number).toBe(1)
    expect(t.ai_agent_events[0]).toMatchObject({ event: 'created', to_version_id: version.id })
  })

  it('treats a missing limit as unlimited', async () => {
    const { db } = fakeDb({ agents: [{ id: 'a1', account_id: 'acct' }, { id: 'a2', account_id: 'acct' }] })
    await expect(createAgent(db, { accountId: 'acct', actor: 'u', name: 'C', version: V })).resolves.toBeDefined()
  })
})

describe('versions and rollback', () => {
  it('an edit inserts a NEW version and never touches the old one', async () => {
    const { db, t } = fakeDb()
    const { agent, version: v1 } = await createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: V })
    const snapshot = JSON.stringify(v1)
    const v2 = await createVersion(db, { accountId: 'acct', actor: 'u', agentId: agent.id, version: { ...V, model: 'gpt-next' } })
    expect(v2.version_number).toBe(2)
    expect(t.ai_agents[0].current_version_id).toBe(v2.id)
    expect(JSON.stringify(t.ai_agent_versions[0])).toBe(snapshot)
    expect(t.ai_agent_events.map((e) => e.event)).toEqual(['created', 'version_created'])
  })

  it('rollback points at an older version and records an event with from/to', async () => {
    const { db, t } = fakeDb()
    const { agent, version: v1 } = await createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: V })
    const v2 = await createVersion(db, { accountId: 'acct', actor: 'u', agentId: agent.id, version: { ...V, model: 'gpt-next' } })
    await rollbackAgent(db, { accountId: 'acct', actor: 'u', agentId: agent.id, versionId: v1.id })
    expect(t.ai_agents[0].current_version_id).toBe(v1.id)
    expect(t.ai_agent_versions).toHaveLength(2) // nothing deleted or copied
    expect(t.ai_agent_events.at(-1)).toMatchObject({ event: 'rollback', from_version_id: v2.id, to_version_id: v1.id })
  })

  it('rollback refuses a version of another agent/account and a no-op', async () => {
    const { db } = fakeDb()
    const { agent, version: v1 } = await createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: V })
    await expect(rollbackAgent(db, { accountId: 'acct', actor: 'u', agentId: agent.id, versionId: 'nope' })).rejects.toMatchObject({ code: 'version_not_found' })
    await expect(rollbackAgent(db, { accountId: 'other', actor: 'u', agentId: agent.id, versionId: v1.id })).rejects.toBeInstanceOf(AgentAdminError)
    await expect(rollbackAgent(db, { accountId: 'acct', actor: 'u', agentId: agent.id, versionId: v1.id })).rejects.toMatchObject({ code: 'already_current' })
  })
})

describe('parseVersionInput', () => {
  it('enforces the documented bounds', () => {
    const bad = (p: Record<string, unknown>) => parseVersionInput({ model: 'm', ...p }).ok
    expect(bad({ temperature: 2.5 })).toBe(false)
    expect(bad({ temperature: 2 })).toBe(true)
    expect(bad({ max_output_tokens: 63 })).toBe(false)
    expect(bad({ max_output_tokens: 4097 })).toBe(false)
    expect(bad({ context_message_limit: 0 })).toBe(false)
    expect(bad({ context_message_limit: 51 })).toBe(false)
    expect(bad({ tool_permissions: ['rm_rf'] })).toBe(false)
    expect(bad({ n8n_webhook_url: 'http://x.example.com' })).toBe(false)
    expect(bad({ provider: 'gemini' })).toBe(false)
  })

  it('merges a partial edit over the base version', () => {
    const r = parseVersionInput({ temperature: 1 }, { ...V, system_prompt: 'keep me' })
    expect(r).toMatchObject({ ok: true, value: { temperature: 1, system_prompt: 'keep me', model: 'gpt-test' } })
  })
})

describe('provider must match the stored key (422)', () => {
  const cfgOpenAi = [{ account_id: 'acct', provider: 'openai' }]
  const anthropic = { ...V, provider: 'anthropic' as const, model: 'claude-x' }

  it('rejects create and new-version with provider_key_mismatch', async () => {
    const { db } = fakeDb({ configs: cfgOpenAi })
    await expect(createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: anthropic })).rejects.toMatchObject({ status: 422, code: 'provider_key_mismatch' })
    const { agent } = await createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: V })
    await expect(createVersion(db, { accountId: 'acct', actor: 'u', agentId: agent.id, version: anthropic })).rejects.toMatchObject({ code: 'provider_key_mismatch' })
  })

  it('rejects rollback/activate onto a mismatched version', async () => {
    const { db, t } = fakeDb({ configs: cfgOpenAi })
    const { agent, version: v1 } = await createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: V })
    await createVersion(db, { accountId: 'acct', actor: 'u', agentId: agent.id, version: V })
    t.ai_agent_versions[0].provider = 'anthropic' // key was switched later
    await expect(rollbackAgent(db, { accountId: 'acct', actor: 'u', agentId: agent.id, versionId: v1.id })).rejects.toMatchObject({ code: 'provider_key_mismatch' })
    t.ai_agents[0].current_version_id = v1.id
    await expect(activateAgent(db, { accountId: 'acct', actor: 'u', agentId: agent.id })).rejects.toMatchObject({ code: 'provider_key_mismatch' })
  })
})

describe('activation and the kill switch', () => {
  it('activating an agent turns on is_active and auto_reply_enabled', async () => {
    const { db, t } = fakeDb({ configs: [{ account_id: 'acct', provider: 'openai', is_active: false, auto_reply_enabled: false }] })
    const { agent } = await createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: V })
    await activateAgent(db, { accountId: 'acct', actor: 'u', agentId: agent.id })
    expect(t.ai_configs[0]).toMatchObject({ is_active: true, auto_reply_enabled: true })
    expect(t.ai_agents[0].status).toBe('active')
  })
})

describe('entitlements outage', () => {
  it('fails closed with 503 instead of skipping the plan limit', async () => {
    m.getEntitlements.mockResolvedValue(null)
    const { db } = fakeDb()
    await expect(createAgent(db, { accountId: 'acct', actor: 'u', name: 'A', version: V })).rejects.toMatchObject({ status: 503 })
  })
})
