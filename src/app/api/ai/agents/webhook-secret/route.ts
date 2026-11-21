import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { requireRole } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { agentErrorResponse } from '@/lib/ai/agent-routes'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/ai/agents/webhook-secret  (admin+, no body)
 *   Generates a new HMAC signing secret for the n8n_webhook tool, stores
 *   it encrypted, and returns it ONCE so it can be pasted into n8n to
 *   verify the `X-Wacrm-Signature` header. Rotating replaces the old one.
 *   → { secret: string }   | 409 { code: 'ai_not_configured' } without a saved AI key.
 */
export async function POST() {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimitShared(`ai-agents:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const secret = `whsec_${randomBytes(24).toString('hex')}`
    const { data, error } = await supabaseAdmin()
      .from('ai_configs')
      .update({ tool_webhook_secret: encrypt(secret) })
      .eq('account_id', accountId)
      .select('id')
    if (error) throw error
    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: 'Add your AI provider key in Setup first.', code: 'ai_not_configured' },
        { status: 409 },
      )
    }
    return NextResponse.json({ secret })
  } catch (err) {
    return agentErrorResponse(err)
  }
}
