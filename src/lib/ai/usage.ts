import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, AiUsage } from './types'
import { estimateCostMicros } from './pricing'

export type AiUsageSource = 'auto_reply' | 'draft' | 'playground' | 'simulation'
export type AiUsageStatus = 'ok' | 'error' | 'timeout' | 'blocked' | 'handoff'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft'
  provider: AiProvider
  model: string
  /** Provider usage; with status 'ok' a null usage is a no-op (nothing
   *  worth recording). Error/blocked rows are logged with zero tokens. */
  usage: AiUsage | null
  agentId?: string | null
  agentVersionId?: string | null
  latencyMs?: number | null
  status?: AiUsageStatus
  /** Machine code only (e.g. 'timeout', 'quota_exceeded') — never the
   *  provider's message text, which could echo prompt content. */
  errorCode?: string | null
  source?: AiUsageSource
  handoff?: boolean
}

/**
 * Append one row to `ai_usage_log` — one per LLM call, for cost
 * visibility on the account's BYO key. Callers AWAIT this (it used to be
 * fire-and-forget, which serverless runtimes can cut off), but it still
 * NEVER throws: accounting must not fail a reply the customer is waiting
 * on, so DB errors are logged and swallowed. No message content is ever
 * written — only counts, ids and machine codes.
 *
 * Pass the service-role admin client: there is no `authenticated` INSERT
 * policy on the log.
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  const status = args.status ?? 'ok'
  if (!args.usage && status === 'ok') return
  try {
    const usage = args.usage
    const { error } = await db.from('ai_usage_log').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: usage?.promptTokens ?? 0,
      completion_tokens: usage?.completionTokens ?? 0,
      total_tokens: usage?.totalTokens ?? 0,
      agent_id: args.agentId ?? null,
      agent_version_id: args.agentVersionId ?? null,
      latency_ms: args.latencyMs ?? null,
      status,
      error_code: args.errorCode ?? null,
      estimated_cost_micros: estimateCostMicros(args.model, usage),
      source: args.source ?? args.mode,
      handoff: args.handoff ?? false,
    })
    if (error) {
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
