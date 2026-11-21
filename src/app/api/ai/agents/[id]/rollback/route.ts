import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { rollbackAgent } from '@/lib/ai/agent-admin'
import { agentErrorResponse } from '@/lib/ai/agent-routes'

/**
 * POST /api/ai/agents/[id]/rollback  (admin+)
 *   Body: { version_id: string }  — a version of THIS agent.
 *   Points the agent at that older version (no data is copied or edited)
 *   and records a 'rollback' event.
 *   → { agent }  | 404 { code: 'version_not_found' } | 409 { code: 'already_current' }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimitShared(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.version_id !== 'string' || !body.version_id) {
      return NextResponse.json({ error: 'version_id is required', code: 'invalid_input' }, { status: 400 })
    }
    const agent = await rollbackAgent(supabaseAdmin(), {
      accountId,
      actor: userId,
      agentId: id,
      versionId: body.version_id,
    })
    return NextResponse.json({ agent })
  } catch (err) {
    return agentErrorResponse(err)
  }
}
