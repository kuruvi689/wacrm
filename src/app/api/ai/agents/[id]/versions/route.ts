import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { getAgent } from '@/lib/ai/agent-admin'
import { agentErrorResponse } from '@/lib/ai/agent-routes'
import { VERSION_COLUMNS } from '@/lib/ai/agents'

/**
 * GET /api/ai/agents/[id]/versions  (admin+)
 *   → { current_version_id: string | null,
 *       versions: Version[] }  newest first (see GET /api/ai/agents for the
 *   Version shape). Versions are immutable history; use POST .../rollback
 *   to make an older one current.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const readLimit = await checkRateLimitShared(`ai-agents-read:${userId}`, RATE_LIMITS.adminAction)
    if (!readLimit.success) return rateLimitResponse(readLimit)
    const { id } = await params
    const db = supabaseAdmin()
    const agent = await getAgent(db, accountId, id)
    const { data, error } = await db
      .from('ai_agent_versions')
      .select(VERSION_COLUMNS)
      .eq('agent_id', id)
      .eq('account_id', accountId)
      .order('version_number', { ascending: false })
    if (error) throw error
    return NextResponse.json({ current_version_id: agent.current_version_id, versions: data ?? [] })
  } catch (err) {
    return agentErrorResponse(err)
  }
}
