import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadRuntimeAi, providerMismatch, type RuntimeAi } from './agents'
import { buildToolRuntime } from './tool-runtime'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { AiError, type ChatMessage } from './types'
import { engineSendText } from '@/lib/flows/meta-send'
import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { WindowClosedError } from '@/lib/whatsapp/service-window'
import { OptedOutError } from '@/lib/whatsapp/opt-out'
import { checkRateLimitShared, RATE_LIMITS } from '@/lib/rate-limit'
import {
  commitUsage,
  deferWork,
  notifyQuotaExhausted,
  releaseUsage,
  reserveUsage,
  type ReserveResult,
} from '@/lib/billing/metering'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** WhatsApp message id (wamid) of the inbound being answered. Keys the
   *  metering reservation; when absent the stored message is looked up. */
  inboundWamid?: string
}

/** Rough prompt size: ~4 characters per token. Estimate only. */
export function estimateTokens(parts: string[], maxOutputTokens: number): number {
  const chars = parts.reduce((n, p) => n + p.length, 0)
  return Math.ceil(chars / 4) + maxOutputTokens
}

async function resolveInboundRef(
  db: SupabaseClient,
  conversationId: string,
  wamid: string | undefined,
): Promise<string | null> {
  if (wamid) return wamid
  const { data } = await db
    .from('messages')
    .select('id, whatsapp_message_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const row = data as { id: string; whatsapp_message_id: string | null } | null
  return row ? (row.whatsapp_message_id ?? row.id) : null
}

/**
 * True only for failures that happen BEFORE Meta accepts the message:
 * a Graph API rejection, a closed 24h window, or an opted-out contact.
 * Distinguished by error class, never by message text. Anything else is
 * treated as possibly delivered (the conservative direction).
 */
export function sendRejectedBeforeAccept(err: unknown): boolean {
  return err instanceof MetaApiError || err instanceof WindowClosedError || err instanceof OptedOutError
}

/** Undo one claimed reply slot after a failed send (best effort,
 *  optimistic: only applies if the count did not move in between). */
export async function releaseReplySlot(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<void> {
  try {
    const { data } = await db
      .from('conversations')
      .select('ai_reply_count')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    const count = (data as { ai_reply_count: number } | null)?.ai_reply_count
    if (!count || count < 1) return
    await db
      .from('conversations')
      .update({ ai_reply_count: count - 1 })
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .eq('ai_reply_count', count)
  } catch (err) {
    console.error('[ai auto-reply] could not release reply slot:', err instanceof Error ? err.message : err)
  }
}

/** Stop the bot on this thread and route it to the handoff agent (or the
 *  shared queue), leaving an internal note. Never stomps a human owner. */
async function handOffToHuman(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    summary: string
    handoffAgentId: string | null
    alreadyAssigned: boolean
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: args.summary,
  }
  if (args.handoffAgentId && !args.alreadyAssigned) {
    update.assigned_agent_id = args.handoffAgentId
  }
  await db
    .from('conversations')
    .update(update)
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
}

async function refuseForQuota(
  db: SupabaseClient,
  r: Extract<ReserveResult, { ok: false }>,
  ctx: {
    accountId: string
    conversationId: string
    inboundRef: string
    metric: 'ai_responses' | 'ai_tokens'
    runtime: RuntimeAi
  },
): Promise<void> {
  const reason = r.reason === 'subscription_inactive' ? 'subscription_inactive' : 'quota_exceeded'
  await deferWork(
    {
      accountId: ctx.accountId,
      kind: 'ai_reply',
      reference: ctx.inboundRef,
      conversationId: ctx.conversationId,
      reason,
      payload: { metric: ctx.metric },
    },
    db,
  )
  await notifyQuotaExhausted(ctx.accountId, ctx.metric, reason, db)
  await logAiUsage(db, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    mode: 'auto_reply',
    provider: ctx.runtime.config.provider,
    model: ctx.runtime.config.model,
    usage: null,
    agentId: ctx.runtime.agent?.agentId ?? null,
    agentVersionId: ctx.runtime.agent?.versionId ?? null,
    status: 'blocked',
    errorCode: reason,
    source: 'auto_reply',
  })
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Owns its
 * try/catch and NEVER throws — a failing or slow LLM call must not
 * affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op): AI off / no active agent, a
 * human is assigned, auto-reply disabled for the thread, per-conversation
 * cap reached, nothing to reply to, shared account rate limit.
 *
 * Metering (before the provider is called): reserve 1 `ai_responses`
 * keyed `ai_reply:<wamid>` and an `ai_tokens` estimate. Refused → no
 * provider call, the work is deferred and the owner notified. A
 * duplicate reservation means this inbound was already handled → skip.
 * Success → commit actuals; provider error/timeout → release both and
 * (by default) hand the thread to a human.
 */
export async function dispatchInboundToAiReply(args: DispatchArgs): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args
  let reservations: (string | null)[] = []

  try {
    const db = supabaseAdmin()
    const runtime = await loadRuntimeAi(db, accountId, { surface: 'auto_reply' })
    if (!runtime) return
    const { config, agent } = runtime

    // A version whose provider doesn't match the stored key can never
    // succeed: block (logged) instead of failing every inbound and
    // handing every thread to a human.
    if (providerMismatch(runtime)) {
      await logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'auto_reply',
        provider: config.provider,
        model: config.model,
        usage: null,
        agentId: agent?.agentId ?? null,
        agentVersionId: agent?.versionId ?? null,
        status: 'blocked',
        errorCode: 'provider_mismatch',
        source: 'auto_reply',
      })
      return
    }

    // Message-level automations win; avoid double-texting the customer.
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId, config.contextMessageLimit)
    if (messages.length === 0) return

    // Account-wide throttle across threads (shared across instances).
    const acctLimit = await checkRateLimitShared(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(`[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`)
      return
    }

    // ---- Metering first: a refused or duplicate inbound must make ZERO
    // provider calls (including the embeddings call for knowledge). ----
    const inboundRef = await resolveInboundRef(db, conversationId, args.inboundWamid)
    if (!inboundRef) return
    const key = `ai_reply:${inboundRef}`
    const refuse = { accountId, conversationId, inboundRef, runtime }

    const respRes = await reserveUsage(accountId, 'ai_responses', 1, key, undefined, db)
    if (!respRes.ok) {
      if (respRes.duplicate) return // already handled
      await refuseForQuota(db, respRes, { ...refuse, metric: 'ai_responses' })
      return
    }
    if (respRes.duplicate) return // reservation exists: this inbound was handled
    reservations = [respRes.reservationId]

    const knowledge = await retrieveKnowledge(db, accountId, config, latestUserMessage(messages))
    const tools = await buildToolRuntime(db, agent, {
      accountId,
      conversationId,
      contactId, // bound by the server, never by the model
      embeddingsApiKey: config.embeddingsApiKey,
      source: 'auto_reply',
      dryRun: false,
    })
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      businessKnowledge: agent?.businessKnowledge,
      constraints: agent?.responseConstraints,
      toolsEnabled: !!tools,
    })
    const estimate = estimateTokens(
      [systemPrompt, ...messages.map((m: ChatMessage) => m.content)],
      config.maxOutputTokens ?? 1024,
    )

    const tokRes = await reserveUsage(accountId, 'ai_tokens', estimate, key, undefined, db)
    if (!tokRes.ok || tokRes.duplicate) {
      await releaseUsage(respRes.reservationId, db)
      reservations = []
      if (!tokRes.ok && !tokRes.duplicate) {
        await refuseForQuota(db, tokRes, { ...refuse, metric: 'ai_tokens' })
      }
      return
    }
    reservations = [respRes.reservationId, tokRes.reservationId]

    // ---- Provider call ----
    const started = Date.now()
    let result
    try {
      result = await generateReply({
        config,
        systemPrompt,
        messages,
        tools,
      })
    } catch (err) {
      await releaseUsage(reservations[0], db)
      await releaseUsage(reservations[1], db)
      reservations = []
      const code = err instanceof AiError ? err.code : 'unknown_error'
      await logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'auto_reply',
        provider: config.provider,
        model: config.model,
        usage: null,
        agentId: agent?.agentId ?? null,
        agentVersionId: agent?.versionId ?? null,
        latencyMs: Date.now() - started,
        status: code === 'timeout' ? 'timeout' : 'error',
        errorCode: code,
        source: 'auto_reply',
      })
      if (config.handoffOnFailure !== false) {
        await handOffToHuman(db, {
          accountId,
          conversationId,
          summary: 'AI unavailable',
          handoffAgentId: config.handoffAgentId,
          alreadyAssigned: !!conv.assigned_agent_id,
        })
      }
      console.error('[ai auto-reply] provider failed:', code)
      return
    }

    const { text, handoff, usage } = result
    // Tokens were spent either way: settle them now. The response is only
    // committed once a reply is actually sent (released otherwise).
    await commitUsage(reservations[1], usage?.totalTokens ?? estimate, db)
    reservations = [reservations[0]]
    await logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
      agentId: agent?.agentId ?? null,
      agentVersionId: agent?.versionId ?? null,
      latencyMs: Date.now() - started,
      status: 'ok',
      source: 'auto_reply',
      handoff: handoff || !text,
    })

    if (handoff || !text) {
      await releaseUsage(reservations[0], db) // no customer reply was sent
      reservations = []
      await handOffToHuman(db, {
        accountId,
        conversationId,
        summary:
          result.handoffSummary ??
          buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0 }),
        handoffAgentId: config.handoffAgentId,
        alreadyAssigned: !!conv.assigned_agent_id,
      })
      return
    }

    // Atomically claim a reply slot (cap check + increment in one UPDATE).
    const { data: claimed, error: claimErr } = await db.rpc('claim_ai_reply_slot', {
      conversation_id: conversationId,
      max_replies: config.autoReplyMaxPerConversation,
    })
    if (claimErr) {
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      await releaseUsage(reservations[0], db)
      reservations = []
      return
    }
    if (claimed !== true) {
      await releaseUsage(reservations[0], db) // lost the per-conversation cap race
      reservations = []
      return
    }

    try {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
        aiGenerated: true,
      })
    } catch (sendErr) {
      if (sendRejectedBeforeAccept(sendErr)) {
        // Meta never accepted the message: the customer got nothing, so
        // give the reply slot and the response quota back.
        await releaseReplySlot(db, accountId, conversationId)
        await releaseUsage(reservations[0], db)
      } else {
        // Unknown/ambiguous failure (e.g. Meta accepted the message and a
        // later DB step threw): the customer may have received it, so the
        // slot stays used and the response is charged.
        await commitUsage(reservations[0], 1, db)
      }
      reservations = []
      console.error('[ai auto-reply] send failed:', sendErr instanceof Error ? sendErr.message : sendErr)
      return
    }
    await commitUsage(reservations[0], 1, db)
    reservations = []
  } catch (err) {
    // Anything unexpected after a reservation: give the quota back.
    try {
      for (const id of reservations) await releaseUsage(id, supabaseAdmin())
    } catch {
      // Best effort: an unreleased reservation expires on its own.
    }
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
