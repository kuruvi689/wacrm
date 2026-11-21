import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { getAgent } from '@/lib/ai/agent-admin'
import { agentErrorResponse } from '@/lib/ai/agent-routes'
import { applyVersion, loadVersion, toRuntimeAgent } from '@/lib/ai/agents'
import { buildToolRuntime } from '@/lib/ai/tool-runtime'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError, type ChatMessage } from '@/lib/ai/types'

const MAX_TURNS = 20
const MAX_TURN_CHARS = 2_000

/**
 * POST /api/ai/agents/[id]/simulate  (admin+)
 *   Body: { messages: [{ role: 'user'|'assistant', content: string }],
 *           version_id?: string }   (default: the agent's current version;
 *           any version of this agent works, drafts and old ones included)
 *   Runs the version against the test transcript with tools in DRY-RUN:
 *   no CRM writes, no webhooks. Read-only tools (knowledge_search,
 *   crm_lookup_contact) still run; there is no customer in a simulation.
 *   → { reply: string, handoff: boolean, version_id, version_number,
 *       tool_calls: [{ tool, status: 'ok'|'dry_run'|'error'|'denied'|
 *         'invalid'|'timeout', latencyMs, error?, argsSummary,
 *         wouldCall?: { tool, args } }],     // wouldCall = intended calls
 *       usage: { promptTokens, completionTokens, totalTokens } | null }
 *   Counts against the shared AI rate limit; logged with source 'simulation'.
 *   Does not use plan AI-reply quota.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const userLimit = await checkRateLimitShared(`ai-sim:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const acctLimit = await checkRateLimitShared(`ai-sim-acct:${accountId}`, RATE_LIMITS.aiDraftAccount)
    if (!acctLimit.success) return rateLimitResponse(acctLimit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const raw = Array.isArray(body?.messages) ? (body.messages as unknown[]) : null
    if (!raw) return NextResponse.json({ error: 'messages is required', code: 'invalid_input' }, { status: 400 })
    const messages: ChatMessage[] = raw
      .filter(
        (m): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TURN_CHARS) }))
    if (messages.length === 0) {
      return NextResponse.json({ error: 'Send at least one test message.', code: 'invalid_input' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const agent = await getAgent(db, accountId, id)
    const versionId = typeof body?.version_id === 'string' ? body.version_id : agent.current_version_id
    const version = versionId ? await loadVersion(db, accountId, versionId) : null
    if (!version || version.agent_id !== id) {
      return NextResponse.json({ error: 'Version not found for this agent', code: 'version_not_found' }, { status: 404 })
    }

    const base = await loadAiConfig(db, accountId, { requireActive: false }).catch(() => {
      throw new AiError('Stored API key could not be decrypted.', { code: 'key_decrypt_failed', status: 400 })
    })
    if (!base) {
      return NextResponse.json(
        { error: 'Add your AI provider key in Setup first.', code: 'ai_not_configured' },
        { status: 400 },
      )
    }
    if (base.provider !== version.provider) {
      return NextResponse.json(
        { error: `This version uses ${version.provider} but your saved API key is for ${base.provider}.`, code: 'provider_key_mismatch' },
        { status: 422 },
      )
    }
    const config = applyVersion(base, version)
    const runtimeAgent = toRuntimeAgent(agent, version)

    const knowledge = await retrieveKnowledge(db, accountId, config, latestUserMessage(messages))
    const tools = await buildToolRuntime(db, runtimeAgent, {
      accountId,
      conversationId: null,
      contactId: null,
      embeddingsApiKey: config.embeddingsApiKey,
      source: 'simulation',
      dryRun: true,
    })
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      businessKnowledge: version.business_knowledge,
      constraints: version.response_constraints,
      toolsEnabled: !!tools,
    })

    const started = Date.now()
    const logBase = {
      accountId,
      conversationId: null,
      mode: 'draft' as const,
      provider: config.provider,
      model: config.model,
      agentId: id,
      agentVersionId: version.id,
      source: 'simulation' as const,
    }
    try {
      const result = await generateReply({ config, systemPrompt, messages, tools })
      await logAiUsage(db, { ...logBase, usage: result.usage, latencyMs: Date.now() - started, handoff: result.handoff })
      return NextResponse.json({
        reply: result.text,
        handoff: result.handoff,
        version_id: version.id,
        version_number: version.version_number,
        tool_calls: result.toolCalls,
        usage: result.usage,
      })
    } catch (err) {
      const code = err instanceof AiError ? err.code : 'unknown_error'
      await logAiUsage(db, {
        ...logBase,
        usage: null,
        latencyMs: Date.now() - started,
        status: code === 'timeout' ? 'timeout' : 'error',
        errorCode: code,
      })
      throw err
    }
  } catch (err) {
    return agentErrorResponse(err)
  }
}
