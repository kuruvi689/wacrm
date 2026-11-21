import {
  AiError,
  type ChatMessage,
  type ProviderResult,
  type ProviderTurn,
} from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  parseToolArgs,
  providerHttpError,
  toNetworkError,
  type ChatArgs,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface AnthropicResponse {
  content?: AnthropicBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

function mapExtra(extra: ChatArgs['extra']): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of extra ?? []) {
    if (m.role === 'tool_results') {
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
        })),
      })
    } else if ('toolCalls' in m) {
      const blocks: Record<string, unknown>[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
      }
      out.push({ role: 'assistant', content: blocks })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/**
 * One Anthropic Messages turn with the caller's own key, optionally with
 * tools (`tool_use` blocks come back as `toolCalls`).
 */
export async function chatAnthropic(args: ChatArgs): Promise<ProviderTurn> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, extra } = args

  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    max_tokens: args.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    messages: [...normalizeForAnthropic(messages), ...mapExtra(extra)],
  }
  // Anthropic accepts 0–1 only.
  if (args.temperature !== undefined) {
    body.temperature = Math.min(1, Math.max(0, args.temperature))
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
    if (args.noMoreTools) body.tool_choice = { type: 'none' }
  }

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text =
    data?.content
      ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim() ?? ''
  const toolCalls = (data?.content ?? [])
    .filter((b) => b.type === 'tool_use' && b.name)
    .map((b, i) => ({
      id: b.id ?? `toolu_${i}`,
      name: b.name!,
      args: parseToolArgs(b.input),
    }))
  if (!text && toolCalls.length === 0) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })
  return { text, toolCalls, usage }
}

/**
 * Call Anthropic's Messages endpoint (no tools). Returns the raw
 * assistant text + token usage (handoff parsing happens in
 * `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const turn = await chatAnthropic(args)
  return { text: turn.text, usage: turn.usage }
}
