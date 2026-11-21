import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { getAgent, pauseAgent } from '@/lib/ai/agent-admin'
import { agentErrorResponse } from '@/lib/ai/agent-routes'

/**
 * POST /api/ai/agents/[id]/pause  (admin+, no body)
 *   Stops this agent answering immediately (status 'paused').
 *   → { agent }
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimitShared(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const db = supabaseAdmin()
    await pauseAgent(db, { accountId, actor: userId, agentId: id })
    return NextResponse.json({ agent: await getAgent(db, accountId, id) })
  } catch (err) {
    return agentErrorResponse(err)
  }
}
