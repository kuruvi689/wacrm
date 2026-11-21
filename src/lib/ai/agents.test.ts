import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({ loadAiConfig: vi.fn() }))
vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s }))

import { loadRuntimeAi, providerMismatch } from './agents'

const cfg = (o: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'openai', model: 'm', apiKey: 'k', systemPrompt: null, isActive: true,
  autoReplyEnabled: true, autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null, ...o,
})
const version = {
  id: 'v1', agent_id: 'a1', account_id: 'acct', version_number: 1, provider: 'openai', model: 'gpt-v', temperature: 0.4,
  max_output_tokens: 512, context_message_limit: 10, system_prompt: 'p', business_knowledge: null, response_constraints: null,
  tool_permissions: [], n8n_webhook_url: null, handoff_on_failure: true, notes: null, created_by: null, created_at: '',
}

function db(agents: unknown[]) {
  return {
    from: (t: string) => {
      const c: Record<string, unknown> = {
        select: () => c,
        eq: () => c,
        maybeSingle: () => Promise.resolve({ data: version, error: null }),
        then: (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: t === 'ai_agents' ? agents : [], error: null }).then(r),
      }
      return c
    },
  } as unknown as SupabaseClient
}
const active = [{ id: 'a1', name: 'A', status: 'active', current_version_id: 'v1' }]

beforeEach(() => h.loadAiConfig.mockResolvedValue(cfg()))

describe('loadRuntimeAi kill switch', () => {
  it('answers with the active agent when is_active AND auto_reply_enabled', async () => {
    const r = await loadRuntimeAi(db(active), 'acct', { surface: 'auto_reply' })
    expect(r?.agent?.agentId).toBe('a1')
    expect(r?.config.model).toBe('gpt-v')
  })

  it('stays silent with an active agent when auto_reply_enabled is off (account kill switch)', async () => {
    h.loadAiConfig.mockResolvedValue(cfg({ autoReplyEnabled: false }))
    expect(await loadRuntimeAi(db(active), 'acct', { surface: 'auto_reply' })).toBeNull()
  })

  it('stays silent when no agent is active, and when the master switch is off', async () => {
    expect(await loadRuntimeAi(db([{ ...active[0], status: 'paused' }]), 'acct', { surface: 'auto_reply' })).toBeNull()
    h.loadAiConfig.mockResolvedValue(null)
    expect(await loadRuntimeAi(db(active), 'acct', { surface: 'auto_reply' })).toBeNull()
  })

  it('drafts are not gated by auto_reply_enabled', async () => {
    h.loadAiConfig.mockResolvedValue(cfg({ autoReplyEnabled: false }))
    expect((await loadRuntimeAi(db(active), 'acct', { surface: 'draft' }))?.agent?.agentId).toBe('a1')
  })

  it('reports a provider/key mismatch', async () => {
    h.loadAiConfig.mockResolvedValue(cfg({ provider: 'anthropic' }))
    const r = await loadRuntimeAi(db(active), 'acct', { surface: 'auto_reply' })
    expect(r && providerMismatch(r)).toBe(true)
  })
})
