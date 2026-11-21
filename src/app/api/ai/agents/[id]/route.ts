import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createVersion, getAgent, versionToInput } from '@/lib/ai/agent-admin'
import { agentErrorResponse, cleanName, optionalText, parseAndCheckVersion } from '@/lib/ai/agent-routes'
import { loadVersion } from '@/lib/ai/agents'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/agents/[id]  (admin+)
 *   → { agent, current_version: Version | null,
 *       events: [{ id, event: 'created'|'version_created'|'activated'|
 *         'paused'|'rollback', from_version_id, to_version_id,
 *         actor_user_id, created_at }] }  (newest first, last 50)
 *
 * PATCH /api/ai/agents/[id]  (admin+)
 *   Body: { name?, description?, role?, version?: Partial<VersionInput> }
 *   A `version` object creates a NEW immutable version (partial fields are
 *   merged over the current version) and makes it current. Versions are
 *   never edited in place.
 *   → { agent, version: Version | null }
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const readLimit = await checkRateLimitShared(`ai-agents-read:${userId}`, RATE_LIMITS.adminAction)
    if (!readLimit.success) return rateLimitResponse(readLimit)
    const { id } = await params
    const db = supabaseAdmin()
    const agent = await getAgent(db, accountId, id)
    const current = agent.current_version_id ? await loadVersion(db, accountId, agent.current_version_id) : null
    const { data: events, error } = await db
      .from('ai_agent_events')
      .select('id, event, from_version_id, to_version_id, actor_user_id, created_at')
      .eq('agent_id', id)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return NextResponse.json({ agent, current_version: current, events: events ?? [] })
  } catch (err) {
    return agentErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimitShared(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body', code: 'invalid_input' }, { status: 400 })
    }
    const db = supabaseAdmin()
    const agent = await getAgent(db, accountId, id)

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = cleanName(body.name)
      if (!name) return NextResponse.json({ error: 'name must be 1-80 characters', code: 'invalid_input' }, { status: 400 })
      patch.name = name
    }
    const description = optionalText(body.description, 500)
    if (description !== undefined) patch.description = description
    const role = optionalText(body.role, 80)
    if (role !== undefined) patch.role = role

    let version = null
    if (body.version !== undefined) {
      const current = agent.current_version_id ? await loadVersion(db, accountId, agent.current_version_id) : null
      const base = current ? versionToInput(current) : undefined
      const parsed = await parseAndCheckVersion(body.version, base)
      if (!parsed.ok) return parsed.response
      version = await createVersion(db, { accountId, actor: userId, agentId: id, version: parsed.value })
    }
    if (Object.keys(patch).length > 0) {
      const { error } = await db
        .from('ai_agents')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', accountId)
      if (error) throw error
    }
    return NextResponse.json({ agent: await getAgent(db, accountId, id), version })
  } catch (err) {
    return agentErrorResponse(err)
  }
}
