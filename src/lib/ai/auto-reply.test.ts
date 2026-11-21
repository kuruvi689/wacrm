import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'
import { AiError } from './types'
import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { WindowClosedError } from '@/lib/whatsapp/service-window'
import { OptedOutError } from '@/lib/whatsapp/opt-out'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadRuntimeAi: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  reserveUsage: vi.fn(),
  commitUsage: vi.fn(),
  releaseUsage: vi.fn(),
  deferWork: vi.fn(),
  notifyQuotaExhausted: vi.fn(),
  logAiUsage: vi.fn(),
  rateLimit: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./agents', () => ({
  loadRuntimeAi: h.loadRuntimeAi,
  providerMismatch: (r: { keyProvider: string; config: { provider: string } }) =>
    r.keyProvider !== r.config.provider,
}))
vi.mock('./tool-runtime', () => ({ buildToolRuntime: async () => undefined }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./usage', () => ({ logAiUsage: h.logAiUsage }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitShared: h.rateLimit,
  RATE_LIMITS: { aiAutoReplyAccount: { limit: 30, windowMs: 60_000 } },
}))
vi.mock('@/lib/billing/metering', () => ({
  reserveUsage: h.reserveUsage,
  commitUsage: h.commitUsage,
  releaseUsage: h.releaseUsage,
  deferWork: h.deferWork,
  notifyQuotaExhausted: h.notifyQuotaExhausted,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () => Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: h.state.conv, error: null }) }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          const chain: Record<string, unknown> = {
            eq: () => chain,
            then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
          }
          return chain
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply, estimateTokens } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundWamid: 'wamid.ABC',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function runtime(overrides: Partial<AiConfig> = {}) {
  return { keyProvider: 'openai' as const, config: aiConfig(overrides), agent: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadRuntimeAi.mockResolvedValue(runtime())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({
    text: 'Hello!',
    handoff: false,
    usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
    toolCalls: [],
  })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.rateLimit.mockResolvedValue({ success: true })
  h.reserveUsage.mockImplementation(async (_a: string, metric: string) => ({
    ok: true,
    reservationId: `res-${metric}`,
    duplicate: false,
  }))
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      { name: 'claim_ai_reply_slot', args: { conversation_id: 'conv-1', max_replies: 3 } },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.reserveUsage).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it.each([
    ['AI is off / no active agent', () => h.loadRuntimeAi.mockResolvedValue(null)],
    [
      'a human is assigned',
      () => (h.state.conv = { assigned_agent_id: 'a', ai_autoreply_disabled: false, ai_reply_count: 0 }),
    ],
    [
      'auto-reply is disabled on the thread',
      () => (h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: true, ai_reply_count: 0 }),
    ],
    [
      'the per-conversation cap is reached',
      () => (h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 3 }),
    ],
    ['there is nothing to reply to', () => h.buildConversationContext.mockResolvedValue([])],
    ['the shared account rate limit is hit', () => h.rateLimit.mockResolvedValue({ success: false })],
  ])('skips silently when %s', async (_name, arrange) => {
    arrange()
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.reserveUsage).not.toHaveBeenCalled()
  })

  it('uses the shared limiter, keyed by account', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.rateLimit).toHaveBeenCalledWith('ai-autoreply:acct-1', expect.anything())
  })
})

describe('dispatchInboundToAiReply — metering', () => {
  it('reserves a response and a token estimate before the provider call, keyed by the wamid', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.reserveUsage).toHaveBeenNthCalledWith(
      1, 'acct-1', 'ai_responses', 1, 'ai_reply:wamid.ABC', undefined, expect.anything(),
    )
    const tokenCall = h.reserveUsage.mock.calls[1]
    expect(tokenCall.slice(0, 2)).toEqual(['acct-1', 'ai_tokens'])
    expect(tokenCall[2]).toBeGreaterThan(1024) // context + max output tokens
    expect(tokenCall[3]).toBe('ai_reply:wamid.ABC')
    expect(h.reserveUsage.mock.invocationCallOrder[0]).toBeLessThan(h.generateReply.mock.invocationCallOrder[0])
  })

  it('commits 1 response and the ACTUAL token total on success, and logs awaited', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.commitUsage).toHaveBeenCalledWith('res-ai_responses', 1, expect.anything())
    expect(h.commitUsage).toHaveBeenCalledWith('res-ai_tokens', 50, expect.anything())
    expect(h.releaseUsage).not.toHaveBeenCalled()
    expect(h.logAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'ok', source: 'auto_reply' }),
    )
  })

  it('refused (quota): no provider call, work deferred, owner notified, nothing to release', async () => {
    h.reserveUsage.mockResolvedValueOnce({ ok: false, duplicate: false, reason: 'quota_exceeded' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.deferWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ai_reply', reference: 'wamid.ABC', reason: 'quota_exceeded' }),
      expect.anything(),
    )
    expect(h.notifyQuotaExhausted).toHaveBeenCalledWith('acct-1', 'ai_responses', 'quota_exceeded', expect.anything())
    expect(h.logAiUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'blocked' }))
  })

  it('token reservation refused: releases the response reservation already taken', async () => {
    h.reserveUsage
      .mockResolvedValueOnce({ ok: true, reservationId: 'res-r', duplicate: false })
      .mockResolvedValueOnce({ ok: false, duplicate: false, reason: 'quota_exceeded' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.releaseUsage).toHaveBeenCalledWith('res-r', expect.anything())
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.notifyQuotaExhausted).toHaveBeenCalledWith('acct-1', 'ai_tokens', 'quota_exceeded', expect.anything())
  })

  it.each([
    ['active reservation', { ok: true, duplicate: true, reservationId: 'x' }],
    ['released reservation', { ok: false, duplicate: true, reason: 'duplicate_released' }],
  ])('duplicate (%s): this inbound was already handled → skip without defer or provider call', async (_n, res) => {
    h.reserveUsage.mockResolvedValueOnce(res)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.deferWork).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('provider failure: releases BOTH reservations and never commits', async () => {
    h.generateReply.mockRejectedValue(new AiError('boom', { code: 'provider_error' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.releaseUsage).toHaveBeenCalledWith('res-ai_responses', expect.anything())
    expect(h.releaseUsage).toHaveBeenCalledWith('res-ai_tokens', expect.anything())
    expect(h.commitUsage).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.logAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'error', errorCode: 'provider_error' }),
    )
  })

  it('timeout is logged as timeout', async () => {
    h.generateReply.mockRejectedValue(new AiError('slow', { code: 'timeout', status: 504 }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.logAiUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'timeout' }))
  })

  it('makes ZERO provider calls (no knowledge/embeddings) when the reservation is refused', async () => {
    h.reserveUsage.mockResolvedValueOnce({ ok: false, duplicate: false, reason: 'quota_exceeded' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('makes ZERO provider calls on a duplicate inbound', async () => {
    h.reserveUsage.mockResolvedValueOnce({ ok: true, duplicate: true, reservationId: 'x' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).not.toHaveBeenCalled()
  })

  it('releases the reservation if something throws after it was taken', async () => {
    h.retrieveKnowledge.mockRejectedValue(new Error('embeddings down'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.releaseUsage).toHaveBeenCalledWith('res-ai_responses', expect.anything())
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('releases the response (not charged) when the slot claim is lost, but still commits tokens', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.commitUsage).toHaveBeenCalledWith('res-ai_tokens', 50, expect.anything())
    expect(h.commitUsage).not.toHaveBeenCalledWith('res-ai_responses', 1, expect.anything())
    expect(h.releaseUsage).toHaveBeenCalledWith('res-ai_responses', expect.anything())
  })

  it('blocks with provider_mismatch and never reserves or calls the provider', async () => {
    h.loadRuntimeAi.mockResolvedValue({ keyProvider: 'openai', config: aiConfig({ provider: 'anthropic' }), agent: null })
    await dispatchInboundToAiReply(ARGS)
    expect(h.reserveUsage).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.logAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'blocked', errorCode: 'provider_mismatch' }),
    )
  })

  it.each([
    ['MetaApiError', () => new MetaApiError('rejected', { httpStatus: 400 })],
    ['WindowClosedError', () => new WindowClosedError()],
    ['OptedOutError', () => new OptedOutError()],
  ])('send rejected before Meta accepted (%s): slot and response quota go back', async (_n, mk) => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 1 }
    h.engineSendText.mockRejectedValue(mk())
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ ai_reply_count: 0 })
    expect(h.releaseUsage).toHaveBeenCalledWith('res-ai_responses', expect.anything())
    expect(h.commitUsage).not.toHaveBeenCalledWith('res-ai_responses', 1, expect.anything())
  })

  it('failure AFTER Meta accepted (DB insert threw): keeps the slot and commits the response', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 1 }
    h.engineSendText.mockRejectedValue(new Error('sent to Meta but DB insert failed: boom'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toBeNull() // slot not given back
    expect(h.commitUsage).toHaveBeenCalledWith('res-ai_responses', 1, expect.anything())
    expect(h.releaseUsage).not.toHaveBeenCalledWith('res-ai_responses', expect.anything())
  })

  it('logs status ok only AFTER the send succeeded, with tokens', async () => {
    h.engineSendText.mockImplementation(async () => {
      expect(h.logAiUsage).not.toHaveBeenCalled() // nothing logged before the send
      return { whatsapp_message_id: 'm1' }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.logAiUsage).toHaveBeenCalledTimes(1)
    expect(h.logAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'ok', usage: expect.objectContaining({ totalTokens: 50 }) }),
    )
  })

  it('logs status handoff (with tokens) for a handoff turn, never ok', async () => {
    h.generateReply.mockResolvedValue({
      text: '', handoff: true, toolCalls: [],
      usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.logAiUsage).toHaveBeenCalledTimes(1)
    expect(h.logAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'handoff', handoff: true, usage: expect.objectContaining({ totalTokens: 5 }) }),
    )
  })

  it('logs error/send_failed (not ok) when the send fails, and error when the slot is lost', async () => {
    h.engineSendText.mockRejectedValue(new Error('boom'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.logAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'error', errorCode: 'send_failed' }),
    )
    expect(h.logAiUsage).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'ok' }))
    h.logAiUsage.mockClear()
    h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm' })
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.logAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'error', errorCode: 'reply_cap_reached' }),
    )
  })

  it('estimateTokens is chars/4 plus the output cap', () => {
    expect(estimateTokens(['a'.repeat(400)], 100)).toBe(200)
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true, usage: null, toolCalls: [] })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('AI agent handed off')
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadRuntimeAi.mockResolvedValue(runtime({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true, usage: null, toolCalls: [] })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true, assigned_agent_id: 'agent-7' })
  })

  it('provider failure hands off with "AI unavailable" by default', async () => {
    h.loadRuntimeAi.mockResolvedValue(runtime({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockRejectedValue(new AiError('down', { code: 'network_error' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({
      ai_autoreply_disabled: true,
      ai_handoff_summary: 'AI unavailable',
      assigned_agent_id: 'agent-7',
    })
  })

  it('provider failure leaves the thread alone when handoff_on_failure is off', async () => {
    h.loadRuntimeAi.mockResolvedValue(runtime({ handoffOnFailure: false }))
    h.generateReply.mockRejectedValue(new AiError('down', { code: 'network_error' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toBeNull()
  })
})
