import type { SupabaseClient } from '@supabase/supabase-js'
import { getEntitlements } from '@/lib/billing/metering'
import { VERSION_COLUMNS, type AgentVersionRow } from './agents'
import { TOOL_NAMES, isToolName } from './tools/definitions'
import type { AiProvider } from './types'

// ============================================================
// Agent management (service-role). Routes call requireRole('admin')
// first, pass the session's account id, and use these helpers. Versions
// are immutable: an edit INSERTS a version and moves current_version_id;
// rollback only moves the pointer. Every change lands in ai_agent_events.
// ============================================================

export class AgentAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'AgentAdminError'
  }
}

export interface VersionInput {
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
}

export const DEFAULT_VERSION: VersionInput = {
  provider: 'openai',
  model: '',
  temperature: 0.4,
  max_output_tokens: 1024,
  context_message_limit: 20,
  system_prompt: null,
  business_knowledge: null,
  response_constraints: null,
  tool_permissions: ['knowledge_search', 'handoff_to_human'],
  n8n_webhook_url: null,
  handoff_on_failure: true,
  notes: null,
}

const TEXT_LIMITS = { system_prompt: 8_000, business_knowledge: 20_000, response_constraints: 4_000, notes: 500 } as const

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

function optText(raw: Record<string, unknown>, key: keyof typeof TEXT_LIMITS): Result<string | null | undefined> {
  const v = raw[key]
  if (v === undefined) return { ok: true, value: undefined }
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false, error: `${key} must be text` }
  if (v.length > TEXT_LIMITS[key]) return { ok: false, error: `${key} is too long (max ${TEXT_LIMITS[key]} characters)` }
  return { ok: true, value: v.trim() === '' ? null : v }
}

/**
 * Validate a (possibly partial) version payload and merge it over
 * `base`. Pure; the n8n URL's SSRF check is async and done by the route.
 */
export function parseVersionInput(raw: unknown, base: VersionInput = DEFAULT_VERSION): Result<VersionInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'version must be an object' }
  const r = raw as Record<string, unknown>
  const out: VersionInput = { ...base }

  if (r.provider !== undefined) {
    if (r.provider !== 'openai' && r.provider !== 'anthropic') return { ok: false, error: 'provider must be "openai" or "anthropic"' }
    out.provider = r.provider
  }
  if (r.model !== undefined) {
    if (typeof r.model !== 'string' || !r.model.trim() || r.model.length > 100) return { ok: false, error: 'model is required (max 100 characters)' }
    out.model = r.model.trim()
  }
  if (!out.model) return { ok: false, error: 'model is required' }

  const num = (key: 'temperature' | 'max_output_tokens' | 'context_message_limit', min: number, max: number, int: boolean) => {
    if (r[key] === undefined) return null
    const v = r[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
      return `${key} must be ${int ? 'a whole number ' : 'a number '}between ${min} and ${max}`
    }
    out[key] = v
    return null
  }
  const numErr =
    num('temperature', 0, 2, false) ?? num('max_output_tokens', 64, 4096, true) ?? num('context_message_limit', 1, 50, true)
  if (numErr) return { ok: false, error: numErr }

  for (const key of ['system_prompt', 'business_knowledge', 'response_constraints', 'notes'] as const) {
    const t = optText(r, key)
    if (!t.ok) return t
    if (t.value !== undefined) out[key] = t.value
  }

  if (r.tool_permissions !== undefined) {
    if (!Array.isArray(r.tool_permissions) || !r.tool_permissions.every((t) => typeof t === 'string' && isToolName(t))) {
      return { ok: false, error: `tool_permissions must be a list of: ${TOOL_NAMES.join(', ')}` }
    }
    out.tool_permissions = Array.from(new Set(r.tool_permissions as string[]))
  }
  if (r.n8n_webhook_url !== undefined) {
    if (r.n8n_webhook_url === null || r.n8n_webhook_url === '') out.n8n_webhook_url = null
    else {
      let ok = false
      try {
        const u = new URL(String(r.n8n_webhook_url))
        ok = u.protocol === 'https:' && !u.username && !u.password
      } catch {
        ok = false
      }
      if (!ok || String(r.n8n_webhook_url).length > 500) return { ok: false, error: 'n8n_webhook_url must be a valid https:// URL' }
      out.n8n_webhook_url = String(r.n8n_webhook_url)
    }
  }
  if (r.handoff_on_failure !== undefined) {
    if (typeof r.handoff_on_failure !== 'boolean') return { ok: false, error: 'handoff_on_failure must be true or false' }
    out.handoff_on_failure = r.handoff_on_failure
  }
  return { ok: true, value: out }
}

/** Drop the fields a new version must not copy (id, version number...). */
export function versionToInput(v: AgentVersionRow): VersionInput {
  return {
    provider: v.provider,
    model: v.model,
    temperature: Number(v.temperature),
    max_output_tokens: v.max_output_tokens,
    context_message_limit: v.context_message_limit,
    system_prompt: v.system_prompt,
    business_knowledge: v.business_knowledge,
    response_constraints: v.response_constraints,
    tool_permissions: v.tool_permissions ?? [],
    n8n_webhook_url: v.n8n_webhook_url,
    handoff_on_failure: v.handoff_on_failure,
    notes: null,
  }
}

async function logEvent(
  db: SupabaseClient,
  e: { accountId: string; agentId: string; event: string; from?: string | null; to?: string | null; actor: string },
): Promise<void> {
  const { error } = await db.from('ai_agent_events').insert({
    account_id: e.accountId,
    agent_id: e.agentId,
    event: e.event,
    from_version_id: e.from ?? null,
    to_version_id: e.to ?? null,
    actor_user_id: e.actor,
  })
  if (error) console.error('[ai agents] event log failed:', error.message)
}

interface AgentRow {
  id: string
  account_id: string
  name: string
  description: string | null
  role: string | null
  status: 'draft' | 'testing' | 'active' | 'paused'
  current_version_id: string | null
  created_at: string
  updated_at: string
}
export const AGENT_COLUMNS = 'id, account_id, name, description, role, status, current_version_id, created_at, updated_at'

export async function getAgent(db: SupabaseClient, accountId: string, agentId: string): Promise<AgentRow> {
  const { data, error } = await db.from('ai_agents').select(AGENT_COLUMNS).eq('id', agentId).eq('account_id', accountId).maybeSingle()
  if (error) throw error
  if (!data) throw new AgentAdminError('Agent not found', 404, 'not_found')
  return data as AgentRow
}

/** Reject a provider the saved API key cannot serve (clear 422). */
async function assertProviderMatchesKey(
  db: SupabaseClient,
  accountId: string,
  provider: AiProvider,
): Promise<void> {
  const { data } = await db.from('ai_configs').select('provider').eq('account_id', accountId).maybeSingle()
  const keyProvider = (data as { provider: AiProvider } | null)?.provider
  if (keyProvider && keyProvider !== provider) {
    throw new AgentAdminError(
      `Your saved API key is for ${keyProvider}, so this agent must use a ${keyProvider} model. Change the key in Setup or pick a ${keyProvider} model.`,
      422,
      'provider_key_mismatch',
    )
  }
}

async function insertVersion(
  db: SupabaseClient,
  accountId: string,
  agentId: string,
  input: VersionInput,
  actor: string,
): Promise<AgentVersionRow> {
  const { data: last } = await db
    .from('ai_agent_versions')
    .select('version_number')
    .eq('agent_id', agentId)
    .eq('account_id', accountId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  const next = ((last as { version_number: number } | null)?.version_number ?? 0) + 1
  const { data, error } = await db
    .from('ai_agent_versions')
    .insert({ ...input, agent_id: agentId, account_id: accountId, version_number: next, created_by: actor })
    .select(VERSION_COLUMNS)
    .single()
  if (error) throw error
  return data as AgentVersionRow
}

/** Create an agent (draft) with version 1. Enforces max_ai_agents. */
export async function createAgent(
  db: SupabaseClient,
  args: { accountId: string; actor: string; name: string; description?: string | null; role?: string | null; version: VersionInput },
): Promise<{ agent: AgentRow; version: AgentVersionRow }> {
  await assertProviderMatchesKey(db, args.accountId, args.version.provider)
  const ent = await getEntitlements(args.accountId, db)
  // Fail closed: an entitlements outage must not let creates bypass the limit.
  if (!ent) throw new AgentAdminError('Could not check your plan right now. Try again shortly.', 503, 'entitlements_unavailable')
  const limit = ent?.limits?.max_ai_agents
  if (limit !== undefined && limit !== null) {
    const { count, error } = await db
      .from('ai_agents')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', args.accountId)
    if (error) throw error
    if ((count ?? 0) >= limit) {
      throw new AgentAdminError(
        `Your plan allows ${limit} AI agent${limit === 1 ? '' : 's'}. Upgrade to add more.`,
        403,
        'plan_limit',
      )
    }
  }
  const { data, error } = await db
    .from('ai_agents')
    .insert({
      account_id: args.accountId,
      name: args.name,
      description: args.description ?? null,
      role: args.role ?? null,
      status: 'draft',
      created_by: args.actor,
    })
    .select(AGENT_COLUMNS)
    .single()
  if (error) throw error
  const agent = data as AgentRow
  const version = await insertVersion(db, args.accountId, agent.id, args.version, args.actor)
  const { error: upErr } = await db
    .from('ai_agents')
    .update({ current_version_id: version.id, updated_at: new Date().toISOString() })
    .eq('id', agent.id)
    .eq('account_id', args.accountId)
  if (upErr) throw upErr
  await logEvent(db, { accountId: args.accountId, agentId: agent.id, event: 'created', to: version.id, actor: args.actor })
  return { agent: { ...agent, current_version_id: version.id }, version }
}

/** Edit = insert a new immutable version and make it current. */
export async function createVersion(
  db: SupabaseClient,
  args: { accountId: string; actor: string; agentId: string; version: VersionInput },
): Promise<AgentVersionRow> {
  const agent = await getAgent(db, args.accountId, args.agentId)
  await assertProviderMatchesKey(db, args.accountId, args.version.provider)
  const version = await insertVersion(db, args.accountId, args.agentId, args.version, args.actor)
  const { error } = await db
    .from('ai_agents')
    .update({ current_version_id: version.id, updated_at: new Date().toISOString() })
    .eq('id', args.agentId)
    .eq('account_id', args.accountId)
  if (error) throw error
  await logEvent(db, {
    accountId: args.accountId,
    agentId: args.agentId,
    event: 'version_created',
    from: agent.current_version_id,
    to: version.id,
    actor: args.actor,
  })
  return version
}

/** Point current_version_id at an OLDER version of the same agent. */
export async function rollbackAgent(
  db: SupabaseClient,
  args: { accountId: string; actor: string; agentId: string; versionId: string },
): Promise<AgentRow> {
  const agent = await getAgent(db, args.accountId, args.agentId)
  const { data: target } = await db
    .from('ai_agent_versions')
    .select('id, version_number, provider')
    .eq('id', args.versionId)
    .eq('agent_id', args.agentId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (!target) throw new AgentAdminError('Version not found for this agent', 404, 'version_not_found')
  await assertProviderMatchesKey(db, args.accountId, (target as { provider: AiProvider }).provider)
  if (agent.current_version_id === args.versionId) {
    throw new AgentAdminError('That version is already current', 409, 'already_current')
  }
  const { data, error } = await db
    .from('ai_agents')
    .update({ current_version_id: args.versionId, updated_at: new Date().toISOString() })
    .eq('id', args.agentId)
    .eq('account_id', args.accountId)
    .select(AGENT_COLUMNS)
    .single()
  if (error) throw error
  await logEvent(db, {
    accountId: args.accountId,
    agentId: args.agentId,
    event: 'rollback',
    from: agent.current_version_id,
    to: args.versionId,
    actor: args.actor,
  })
  return data as AgentRow
}

/** Make this agent the account's one active agent (pauses the previous). */
export async function activateAgent(
  db: SupabaseClient,
  args: { accountId: string; actor: string; agentId: string },
): Promise<void> {
  const agent = await getAgent(db, args.accountId, args.agentId)
  if (agent.current_version_id) {
    const { data: cur } = await db
      .from('ai_agent_versions')
      .select('provider')
      .eq('id', agent.current_version_id)
      .eq('account_id', args.accountId)
      .maybeSingle()
    if (cur) await assertProviderMatchesKey(db, args.accountId, (cur as { provider: AiProvider }).provider)
  }
  const { data, error } = await db.rpc('ai_agent_activate', { p_agent_id: args.agentId, p_account_id: args.accountId })
  if (error) throw error
  if (data !== true) throw new AgentAdminError('Agent has no version to activate', 409, 'no_version')
  // Activating an agent turns the account's bot on (master + auto-reply).
  // Pausing leaves these switches as they are.
  const { error: cfgErr } = await db
    .from('ai_configs')
    .update({ is_active: true, auto_reply_enabled: true })
    .eq('account_id', args.accountId)
  if (cfgErr) throw cfgErr
  await logEvent(db, { accountId: args.accountId, agentId: args.agentId, event: 'activated', actor: args.actor })
}

export async function pauseAgent(
  db: SupabaseClient,
  args: { accountId: string; actor: string; agentId: string },
): Promise<void> {
  await getAgent(db, args.accountId, args.agentId)
  const { error } = await db
    .from('ai_agents')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('id', args.agentId)
    .eq('account_id', args.accountId)
  if (error) throw error
  await logEvent(db, { accountId: args.accountId, agentId: args.agentId, event: 'paused', actor: args.actor })
}
