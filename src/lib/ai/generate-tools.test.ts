import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateReply } from './generate'
import type { AiConfig } from './types'
import type { ToolContext } from './tools/types'

vi.mock('./knowledge', () => ({ retrieveKnowledge: vi.fn(async () => ['fact']) }))

const config: AiConfig = {
  provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', systemPrompt: null, isActive: true,
  autoReplyEnabled: true, autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null,
}

function ctx(): ToolContext {
  const db = { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as SupabaseClient
  return {
    db, accountId: 'a', conversationId: 'c', contactId: 'k', agentId: 'g', agentVersionId: 'v',
    source: 'auto_reply', dryRun: false, embeddingsApiKey: null, n8nWebhookUrl: null,
    webhookSecret: null, handoff: { request: null },
  }
}

const toolTurn = (id: string) =>
  new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [{ id, function: { name: 'knowledge_search', arguments: '{"query":"q"}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }), { status: 200 })
const textTurn = (t: string) =>
  new Response(JSON.stringify({
    choices: [{ message: { content: t } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }), { status: 200 })

afterEach(() => vi.unstubAllGlobals())

describe('generateReply tool loop', () => {
  it('runs a tool, feeds the result back as a tool message (not the system prompt), and sums usage', async () => {
    const f = vi.fn().mockResolvedValueOnce(toolTurn('t1')).mockResolvedValueOnce(textTurn('Done'))
    vi.stubGlobal('fetch', f)
    const res = await generateReply({
      config, systemPrompt: 'SYS', messages: [{ role: 'user', content: 'hi' }],
      tools: { ctx: ctx(), permissions: ['knowledge_search'] },
    })
    expect(res.text).toBe('Done')
    expect(res.toolCalls.map((t) => t.status)).toEqual(['ok'])
    expect(res.usage?.totalTokens).toBe(24)
    const second = JSON.parse(f.mock.calls[1][1].body as string)
    expect(second.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 't1' })
    expect(second.messages.at(-1).content).toContain('"data"')
  })

  it('stops after 3 tool rounds and forces a final text-only turn', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(toolTurn('1')).mockResolvedValueOnce(toolTurn('2')).mockResolvedValueOnce(toolTurn('3'))
      .mockResolvedValueOnce(textTurn('final'))
    vi.stubGlobal('fetch', f)
    const res = await generateReply({
      config, systemPrompt: 'S', messages: [{ role: 'user', content: 'hi' }],
      tools: { ctx: ctx(), permissions: ['knowledge_search'] },
    })
    expect(f).toHaveBeenCalledTimes(4)
    expect(res.toolCalls).toHaveLength(3)
    expect(JSON.parse(f.mock.calls[3][1].body as string).tool_choice).toBe('none')
    expect(JSON.parse(f.mock.calls[2][1].body as string).tool_choice).toBeUndefined()
    expect(res.text).toBe('final')
  })

  it('handoff_to_human ends the turn as a handoff with no customer text', async () => {
    const turn = new Response(JSON.stringify({
      choices: [{ message: { content: 'x', tool_calls: [{ id: 'h', function: { name: 'handoff_to_human', arguments: '{"reason":"angry","summary":"s"}' } }] } }],
    }), { status: 200 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(turn).mockResolvedValueOnce(textTurn('ok')))
    const res = await generateReply({
      config, systemPrompt: 'S', messages: [{ role: 'user', content: 'hi' }],
      tools: { ctx: ctx(), permissions: ['handoff_to_human'] },
    })
    expect(res).toMatchObject({ handoff: true, text: '', handoffReason: 'angry' })
  })
})
