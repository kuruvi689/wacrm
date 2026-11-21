import { AiError, type ProviderResult, type ProviderTurn } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  openAiAcceptsTemperature,
  parseToolArgs,
  providerHttpError,
  toNetworkError,
  type ChatArgs,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: {
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function mapExtra(extra: ChatArgs['extra']): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of extra ?? []) {
    if (m.role === 'tool_results') {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.content })
      }
    } else if ('toolCalls' in m) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/**
 * One OpenAI Chat Completions turn with the caller's own key, optionally
 * with tools. Returns text and/or the tool calls the model requested.
 */
export async function chatOpenAi(args: ChatArgs): Promise<ProviderTurn> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, extra } = args

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...mergeConsecutive(messages),
      ...mapExtra(extra),
    ],
    max_completion_tokens: args.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
  }
  if (args.temperature !== undefined && openAiAcceptsTemperature(model)) {
    body.temperature = args.temperature
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    if (args.noMoreTools) body.tool_choice = 'none'
  }

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const message = data?.choices?.[0]?.message
  const text = typeof message?.content === 'string' ? message.content : ''
  const toolCalls = (message?.tool_calls ?? [])
    .filter((c) => c?.function?.name)
    .map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function!.name!,
      args: parseToolArgs(c.function!.arguments),
    }))
  if (!text.trim() && toolCalls.length === 0) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, toolCalls, usage }
}

/**
 * Call OpenAI's Chat Completions endpoint (no tools). Returns the raw
 * assistant text + token usage (handoff parsing happens in
 * `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const turn = await chatOpenAi(args)
  return { text: turn.text, usage: turn.usage }
}
