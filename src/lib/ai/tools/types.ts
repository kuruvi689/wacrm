import type { SupabaseClient } from '@supabase/supabase-js'
import type { SchemaLite } from './schema'

export type ToolSource = 'auto_reply' | 'draft' | 'playground' | 'simulation'

/** Slot a tool fills to end the turn with a handoff to a human. */
export interface HandoffRequest {
  reason: string
  summary: string
}

/**
 * Everything a tool may touch. The conversation and contact are bound
 * HERE by the server — tool arguments can never name a different one.
 */
export interface ToolContext {
  db: SupabaseClient
  accountId: string
  conversationId: string | null
  contactId: string | null
  agentId: string | null
  agentVersionId: string | null
  source: ToolSource
  /** Dry run: no CRM writes, no outbound webhooks. */
  dryRun: boolean
  embeddingsApiKey: string | null
  n8nWebhookUrl: string | null
  /** Decrypted HMAC secret for the n8n tool, or null when unset. */
  webhookSecret: string | null
  handoff: { request: HandoffRequest | null }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: SchemaLite
  timeoutMs: number
  /** What a dry run reports instead of executing; null = the tool is
   *  read-only and runs for real even in a dry run. */
  dryRunResult: ((args: Record<string, unknown>) => unknown) | null
  /** `signal` aborts when the per-call timeout fires; implementations must
   *  stop (and not write) once it is aborted. */
  execute: (ctx: ToolContext, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}

export type ToolCallStatus =
  | 'ok'
  | 'error'
  | 'denied'
  | 'timeout'
  | 'invalid'
  | 'dry_run'

export interface ToolCallRecord {
  tool: string
  status: ToolCallStatus
  latencyMs: number
  error?: string
  /** Redacted summary (keys + sizes). */
  argsSummary: string
  /** Dry-run only: what would have been called. */
  wouldCall?: { tool: string; args: Record<string, unknown> }
}
