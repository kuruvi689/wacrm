import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimitShared, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadRuntimeAi, providerMismatch } from '@/lib/ai/agents'
import { buildToolRuntime } from '@/lib/ai/tool-runtime'
import { logAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = await checkRateLimitShared(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const runtime = await loadRuntimeAi(supabase, accountId, {
      surface: 'draft',
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadRuntimeAi error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    const config = runtime?.config
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    if (runtime && providerMismatch(runtime)) {
      return NextResponse.json(
        { error: "The agent's model doesn't match the saved API key. Fix it in Agents.", code: 'provider_key_mismatch' },
        { status: 422 },
      )
    }

    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages),
    )
    const agent = runtime?.agent ?? null
    // Tools run in dry-run: nothing is written and no webhook is called.
    const tools = await buildToolRuntime(supabaseAdmin(), agent, {
      accountId,
      conversationId: null,
      contactId: null,
      embeddingsApiKey: config.embeddingsApiKey,
      source: 'playground',
      dryRun: true,
    })
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      businessKnowledge: agent?.businessKnowledge,
      constraints: agent?.responseConstraints,
      toolsEnabled: !!tools,
    })

    const started = Date.now()
    const admin = supabaseAdmin()
    const logBase = {
      accountId,
      conversationId: null,
      mode: 'draft' as const,
      provider: config.provider,
      model: config.model,
      agentId: agent?.agentId ?? null,
      agentVersionId: agent?.versionId ?? null,
      source: 'playground' as const,
    }
    try {
      const { text, handoff, usage, toolCalls } = await generateReply({
        config,
        systemPrompt,
        messages,
        tools,
      })
      await logAiUsage(admin, { ...logBase, usage, latencyMs: Date.now() - started, handoff })
      return NextResponse.json({ reply: text, handoff, tool_calls: toolCalls })
    } catch (err) {
      const code = err instanceof AiError ? err.code : 'unknown_error'
      await logAiUsage(admin, {
        ...logBase,
        usage: null,
        latencyMs: Date.now() - started,
        status: code === 'timeout' ? 'timeout' : 'error',
        errorCode: code,
      })
      throw err
    }
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
