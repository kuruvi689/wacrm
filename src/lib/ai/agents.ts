import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { loadAiConfig } from './config'
import type { AiConfig, AiProvider } from './types'

// ============================================================
// Runtime view of AI agents. An account's ACTIVE agent (one at most)
// answers WhatsApp auto-replies using its current immutable version.
// The provider API key never leaves ai_configs; a version only picks
// provider + model + behaviour. Accounts with no agents at all keep
// running on the legacy ai_configs row.
// ============================================================

export interface AgentVersionRow {
  id: string
  agent_id: string
  account_id: string
  version_number: number
  provider: AiProvider
  model: string
  temperature: number
  max_output_tokens: number
  context_message_limit: number
  system_prompt: string | null
  business_knowledge: string | null
  response_constraints: string | null
  tool_permissions: string[]
  n8n_webhook_url: string | null
  handoff_on_failure: boolean
  notes: string | null
  created_by: string | null
  created_at: string
}

export const VERSION_COLUMNS =
  'id, agent_id, account_id, version_number, provider, model, temperature, max_output_tokens, context_message_limit, system_prompt, business_knowledge, response_constraints, tool_permissions, n8n_webhook_url, handoff_on_failure, notes, created_by, created_at'

export interface RuntimeAgent {
  agentId: string
  agentName: string
  versionId: string
  versionNumber: number
  businessKnowledge: string | null
  responseConstraints: string | null
  toolPermissions: string[]
  n8nWebhookUrl: string | null
}

export interface RuntimeAi {
  /** Provider the stored API key belongs to (versions must match it). */
  keyProvider: AiProvider
  /** Provider/model/limits already overlaid with the agent version. */
  config: AiConfig
  /** Null on the legacy ai_configs path. */
  agent: RuntimeAgent | null
}

/** Overlay a version's behaviour on the account's key-bearing config. */
export function applyVersion(base: AiConfig, v: AgentVersionRow): AiConfig {
  return {
    ...base,
    provider: v.provider,
    model: v.model,
    systemPrompt: v.system_prompt,
    temperature: Number(v.temperature),
    maxOutputTokens: v.max_output_tokens,
    contextMessageLimit: v.context_message_limit,
    handoffOnFailure: v.handoff_on_failure,
  }
}

export function toRuntimeAgent(agent: { id: string; name: string }, v: AgentVersionRow): RuntimeAgent {
  return {
    agentId: agent.id,
    agentName: agent.name,
    versionId: v.id,
    versionNumber: v.version_number,
    businessKnowledge: v.business_knowledge,
    responseConstraints: v.response_constraints,
    toolPermissions: v.tool_permissions ?? [],
    n8nWebhookUrl: v.n8n_webhook_url,
  }
}

/**
 * Resolve what answers for this account.
 *  - 'auto_reply': needs auto_reply_enabled (account kill switch). Agents
 *    exist → ONLY the active agent answers (none active = silent); no
 *    agents → legacy config.
 *  - 'draft': active agent if any, else the legacy config.
 * Returns null when AI is unavailable (no config / master switch off /
 * no active agent for auto-reply).
 */
export async function loadRuntimeAi(
  db: SupabaseClient,
  accountId: string,
  opts: { surface: 'auto_reply' | 'draft' | 'playground'; requireActive?: boolean },
): Promise<RuntimeAi | null> {
  const base = await loadAiConfig(db, accountId, { requireActive: opts.requireActive ?? true })
  if (!base) return null

  const { data: agents, error } = await db
    .from('ai_agents')
    .select('id, name, status, current_version_id')
    .eq('account_id', accountId)
  if (error) throw error
  const rows = (agents ?? []) as { id: string; name: string; status: string; current_version_id: string | null }[]

  if (rows.length === 0) {
    if (opts.surface === 'auto_reply' && !base.autoReplyEnabled) return null
    return { keyProvider: base.provider, config: base, agent: null }
  }

  // `auto_reply_enabled` stays the account-level kill switch even with
  // agents: the bot replies only if is_active AND auto_reply_enabled AND an
  // agent is active.
  if (opts.surface === 'auto_reply' && !base.autoReplyEnabled) return null

  const active = rows.find((a) => a.status === 'active' && a.current_version_id)
  if (!active) {
    if (opts.surface === 'auto_reply') return null
    if (opts.surface === 'draft') return { keyProvider: base.provider, config: base, agent: null }
    return null
  }
  const version = await loadVersion(db, accountId, active.current_version_id!)
  if (!version) return null
  return {
    keyProvider: base.provider,
    config: applyVersion(base, version),
    agent: toRuntimeAgent(active, version),
  }
}

/** One version, scoped to the account (any status, drafts included). */
export async function loadVersion(
  db: SupabaseClient,
  accountId: string,
  versionId: string,
): Promise<AgentVersionRow | null> {
  const { data, error } = await db
    .from('ai_agent_versions')
    .select(VERSION_COLUMNS)
    .eq('id', versionId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  return (data as AgentVersionRow | null) ?? null
}

/** Decrypted HMAC secret for the n8n tool, or null. Server-side only. */
export async function loadToolWebhookSecret(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data } = await db
    .from('ai_configs')
    .select('tool_webhook_secret')
    .eq('account_id', accountId)
    .maybeSingle()
  const enc = (data as { tool_webhook_secret: string | null } | null)?.tool_webhook_secret
  if (!enc) return null
  try {
    return decrypt(enc)
  } catch {
    console.error(`[ai agents] tool webhook secret for account ${accountId} could not be decrypted.`)
    return null
  }
}

/** True when the version's provider cannot use the stored API key. */
export function providerMismatch(runtime: Pick<RuntimeAi, 'keyProvider' | 'config'>): boolean {
  return runtime.keyProvider !== runtime.config.provider
}
