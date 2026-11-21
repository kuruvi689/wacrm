import type { ToolCallRequest, ToolSpec } from '../types'
import { TOOL_DEFINITIONS, isToolName } from './definitions'
import { summarizeArgs, validateAgainst } from './schema'
import type { ToolCallRecord, ToolCallStatus, ToolContext, ToolDefinition } from './types'

/** Max tool rounds (model turns that request tools) per reply. */
export const MAX_TOOL_ROUNDS = 3
/** Max tool calls executed from a single model turn. */
export const MAX_CALLS_PER_ROUND = 4
/** Tool output handed back to the model is capped (it is data, not prompt). */
const MAX_RESULT_CHARS = 4_000

export interface ToolExecution {
  call: ToolCallRequest
  /** JSON string given back to the model as the tool result. */
  content: string
  record: ToolCallRecord
}

/** Tools the model may be offered: permitted by the agent version AND
 *  usable in this context (n8n needs a configured URL + secret). */
export function availableToolSpecs(
  permissions: readonly string[],
  ctx: Pick<ToolContext, 'n8nWebhookUrl' | 'webhookSecret'>,
): ToolSpec[] {
  const specs: ToolSpec[] = []
  for (const name of permissions) {
    if (!isToolName(name)) continue
    if (name === 'n8n_webhook' && (!ctx.n8nWebhookUrl || !ctx.webhookSecret)) continue
    const def = TOOL_DEFINITIONS[name]
    specs.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters as unknown as Record<string, unknown>,
    })
  }
  return specs
}

/** Race `run` against a timer; on timeout the signal aborts so the tool
 *  stops and performs no further writes. */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('tool_timeout'))
    }, ms)
  })
  const work = run(controller.signal)
  work.catch(() => undefined) // a late failure after timeout is ignored
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : 'error'
  return m.slice(0, 200)
}

function wrap(data: unknown): string {
  const json = JSON.stringify({ data })
  return json.length > MAX_RESULT_CHARS ? JSON.stringify({ data: json.slice(0, MAX_RESULT_CHARS), truncated: true }) : json
}

function fail(status: ToolCallStatus, error: string, started: number, args: unknown, tool: string): ToolExecution['record'] {
  return { tool, status, latencyMs: Date.now() - started, error, argsSummary: summarizeArgs(args) }
}

/**
 * Run ONE tool call: permission check → schema validation → (dry-run
 * short-circuit) → execute under a timeout. Never throws; the outcome is
 * always a record plus a result string the model can read.
 */
export async function executeToolCall(
  ctx: ToolContext,
  permissions: readonly string[],
  call: ToolCallRequest,
): Promise<ToolExecution> {
  const started = Date.now()
  const reject = (status: ToolCallStatus, error: string): ToolExecution => ({
    call,
    content: wrap({ error: error.slice(0, 200) }),
    record: fail(status, error.slice(0, 200), started, call.args, call.name),
  })

  if (!isToolName(call.name) || !permissions.includes(call.name)) {
    return reject('denied', 'tool_not_permitted')
  }
  const def: ToolDefinition = TOOL_DEFINITIONS[call.name]
  if (call.name === 'n8n_webhook' && (!ctx.n8nWebhookUrl || !ctx.webhookSecret)) {
    return reject('denied', 'tool_not_configured')
  }

  const valid = validateAgainst(def.parameters, call.args)
  if (!valid.ok) return reject('invalid', valid.error)
  const args = valid.value as Record<string, unknown>

  if (ctx.dryRun && def.dryRunResult) {
    const intended = def.dryRunResult(args)
    return {
      call,
      content: wrap({ dry_run: true, intended }),
      record: {
        tool: def.name,
        status: 'dry_run',
        latencyMs: Date.now() - started,
        argsSummary: summarizeArgs(args),
        wouldCall: { tool: def.name, args },
      },
    }
  }

  try {
    const result = await withTimeout((signal) => def.execute(ctx, args, signal), def.timeoutMs)
    return {
      call,
      content: wrap(result),
      record: {
        tool: def.name,
        status: 'ok',
        latencyMs: Date.now() - started,
        argsSummary: summarizeArgs(args),
      },
    }
  } catch (err) {
    const msg = errMessage(err)
    const status: ToolCallStatus = msg === 'tool_timeout' ? 'timeout' : 'error'
    return reject(status, msg)
  }
}

/** Execute a model turn's tool calls (capped) and audit-log each one. */
export async function executeToolCalls(
  ctx: ToolContext,
  permissions: readonly string[],
  calls: ToolCallRequest[],
): Promise<ToolExecution[]> {
  const out: ToolExecution[] = []
  for (const call of calls.slice(0, MAX_CALLS_PER_ROUND)) {
    const exec = await executeToolCall(ctx, permissions, call)
    out.push(exec)
    await logToolCall(ctx, exec.record)
  }
  return out
}

/** Append to ai_tool_calls. Awaited, never throws, never stores values. */
export async function logToolCall(ctx: ToolContext, rec: ToolCallRecord): Promise<void> {
  try {
    const { error } = await ctx.db.from('ai_tool_calls').insert({
      account_id: ctx.accountId,
      agent_id: ctx.agentId,
      agent_version_id: ctx.agentVersionId,
      conversation_id: ctx.conversationId,
      tool: rec.tool,
      status: rec.status,
      latency_ms: rec.latencyMs,
      error: rec.error ?? null,
      args_summary: rec.argsSummary,
      source: ctx.source,
    })
    if (error) console.error('[ai tools] audit insert failed:', error.message)
  } catch (err) {
    console.error('[ai tools] audit insert threw:', errMessage(err))
  }
}
