import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { activateAgent, getAgent } from '@/lib/ai/agent-admin'
import { agentErrorResponse } from '@/lib/ai/agent-routes'

/**
 * POST /api/ai/agents/[id]/activate  (admin+, no body)
 *   Makes this agent the account's single active agent (the one that
 *   answers WhatsApp auto-replies); any previously active agent is paused.
 *   Needs the account's AI provider key to be saved first.
 *   → { agent }   | 409 { code: 'ai_not_configured' } when no key is saved.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimitShared(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const db = supabaseAdmin()
    await getAgent(db, accountId, id)
    const { data: cfg } = await db.from('ai_configs').select('id').eq('account_id', accountId).maybeSingle()
    if (!cfg) {
      return NextResponse.json(
        { error: 'Add your AI provider key in Setup before activating an agent.', code: 'ai_not_configured' },
        { status: 409 },
      )
    }
    await activateAgent(db, { accountId, actor: userId, agentId: id })
    return NextResponse.json({ agent: await getAgent(db, accountId, id) })
  } catch (err) {
    return agentErrorResponse(err)
  }
}
