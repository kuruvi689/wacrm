import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type ProviderMessage,
  type ProviderTurn,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi, chatOpenAi } from './providers/openai'
import { generateAnthropic, chatAnthropic } from './providers/anthropic'
import type { ChatArgs } from './providers/shared'
import { MAX_TOOL_ROUNDS, availableToolSpecs, executeToolCalls } from './tools/executor'
import type { ToolCallRecord, ToolContext } from './tools/types'

/** Tool wiring for one reply. The context binds conversation/contact. */
export interface ToolRuntime {
  ctx: ToolContext
  permissions: readonly string[]
}

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Optional tools; omitted or empty = plain text generation. */
  tools?: ToolRuntime
}

function sumUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. With `tools`, runs a bounded tool loop (max
 * MAX_TOOL_ROUNDS rounds). Throws `AiError` on any provider failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  }
  if (config.provider !== 'openai' && config.provider !== 'anthropic') {
    throw new AiError(`Unsupported AI provider: ${config.provider}`, {
      code: 'unsupported_provider',
      status: 400,
    })
  }

  const specs = tools ? availableToolSpecs(tools.permissions, tools.ctx) : []
  if (!tools || specs.length === 0) {
    const result =
      config.provider === 'openai'
        ? await generateOpenAi(providerArgs)
        : await generateAnthropic(providerArgs)
    return parseGeneration(result.text, result.usage)
  }

  // Tool loop. The provider call is given a total time budget so up to
  // four sequential calls cannot hold the webhook open indefinitely.
  const chat = config.provider === 'openai' ? chatOpenAi : chatAnthropic
  const deadline = Date.now() + timeoutMs * 2
  const extra: ProviderMessage[] = []
  const records: ToolCallRecord[] = []
  let usage: AiUsage | null = null
  let text = ''

  for (let round = 0; ; round++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new AiError('The AI provider took too long to respond.', { code: 'timeout', status: 504 })
    }
    const last = round >= MAX_TOOL_ROUNDS
    const turn: ProviderTurn = await chat({
      ...providerArgs,
      timeoutMs: Math.min(timeoutMs, remaining),
      tools: specs,
      extra,
      noMoreTools: last,
    } satisfies ChatArgs)
    usage = sumUsage(usage, turn.usage)

    if (turn.toolCalls.length === 0 || last) {
      text = turn.text
      break
    }
    const execs = await executeToolCalls(tools.ctx, tools.permissions, turn.toolCalls)
    records.push(...execs.map((e) => e.record))
    // Results travel as tool-result data, never inside the system prompt.
    extra.push(
      { role: 'assistant', content: turn.text, toolCalls: execs.map((e) => e.call) },
      {
        role: 'tool_results',
        results: execs.map((e) => ({ id: e.call.id, name: e.call.name, content: e.content })),
      },
    )
  }

  const parsed = parseGeneration(text, usage)
  const handoff = tools.ctx.handoff.request
  return {
    ...parsed,
    toolCalls: records,
    handoff: parsed.handoff || handoff !== null,
    handoffReason: handoff?.reason,
    handoffSummary: handoff ? `🤖 AI handed off: ${handoff.reason}. ${handoff.summary}`.slice(0, 600) : undefined,
    text: handoff ? '' : parsed.text,
  }
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage, toolCalls: [] }
}
