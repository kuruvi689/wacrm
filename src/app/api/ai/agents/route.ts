import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AGENT_COLUMNS, DEFAULT_VERSION, createAgent } from '@/lib/ai/agent-admin'
import { agentErrorResponse, cleanName, optionalText, parseAndCheckVersion } from '@/lib/ai/agent-routes'
import { VERSION_COLUMNS } from '@/lib/ai/agents'
import { getEntitlements } from '@/lib/billing/metering'

/**
 * GET /api/ai/agents  (admin+)
 *   → { agents: [{ id, name, description, role, status, current_version_id,
 *        created_at, updated_at, current_version: Version | null }],
 *       has_webhook_secret: boolean,
 *       limits: { max_ai_agents: number | null } }
 *   Version = { id, agent_id, version_number, provider, model, temperature,
 *     max_output_tokens, context_message_limit, system_prompt,
 *     business_knowledge, response_constraints, tool_permissions: string[],
 *     n8n_webhook_url, handoff_on_failure, notes, created_by, created_at }
 *   Provider API keys and the webhook secret are never returned.
 *
 * POST /api/ai/agents  (admin+)
 *   Body: { name, description?, role?, version?: Partial<VersionInput> }
 *     (version.model is required; other fields default — see DEFAULT_VERSION)
 *   → 201 { agent, version }  (status 'draft', version_number 1)
 *   → 403 { code: 'plan_limit' } when the plan's max_ai_agents is reached.
 */
export async function GET() {
  try {
    const { accountId, userId } = await requireRole('admin')
    const readLimit = await checkRateLimitShared(`ai-agents-read:${userId}`, RATE_LIMITS.adminAction)
    if (!readLimit.success) return rateLimitResponse(readLimit)
    const db = supabaseAdmin()

    const { data: agents, error } = await db
      .from('ai_agents')
      .select(AGENT_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    if (error) throw error
    const rows = (agents ?? []) as { current_version_id: string | null }[]

    const versionIds = rows.map((a) => a.current_version_id).filter((v): v is string => !!v)
    const versions = new Map<string, unknown>()
    if (versionIds.length > 0) {
      const { data: vs, error: vErr } = await db
        .from('ai_agent_versions')
        .select(VERSION_COLUMNS)
        .eq('account_id', accountId)
        .in('id', versionIds)
      if (vErr) throw vErr
      for (const v of (vs ?? []) as { id: string }[]) versions.set(v.id, v)
    }

    const [{ data: cfg }, ent] = await Promise.all([
      db.from('ai_configs').select('tool_webhook_secret').eq('account_id', accountId).maybeSingle(),
      getEntitlements(accountId, db),
    ])

    return NextResponse.json({
      agents: rows.map((a) => ({
        ...a,
        current_version: a.current_version_id ? (versions.get(a.current_version_id) ?? null) : null,
      })),
      has_webhook_secret: !!(cfg as { tool_webhook_secret: string | null } | null)?.tool_webhook_secret,
      limits: { max_ai_agents: ent?.limits?.max_ai_agents ?? null },
    })
  } catch (err) {
    return agentErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimitShared(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const name = cleanName(body?.name)
    if (!name) {
      return NextResponse.json({ error: 'name is required (1-80 characters)', code: 'invalid_input' }, { status: 400 })
    }
    const parsed = await parseAndCheckVersion(body?.version ?? {}, DEFAULT_VERSION)
    if (!parsed.ok) return parsed.response

    const created = await createAgent(supabaseAdmin(), {
      accountId,
      actor: userId,
      name,
      description: optionalText(body?.description, 500),
      role: optionalText(body?.role, 80),
      version: parsed.value,
    })
    return NextResponse.json(created, { status: 201 })
  } catch (err) {
    return agentErrorResponse(err)
  }
}
