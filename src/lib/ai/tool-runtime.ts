import type { SupabaseClient } from '@supabase/supabase-js'
import { loadToolWebhookSecret, type RuntimeAgent } from './agents'
import type { ToolRuntime } from './generate'
import type { ToolSource } from './tools/types'

/**
 * Build the tool wiring for one reply, or undefined when the agent has no
 * permitted tools. The conversation/contact/account ids come from the
 * caller (the session or the webhook), never from the model.
 */
export async function buildToolRuntime(
  db: SupabaseClient,
  agent: RuntimeAgent | null,
  b: {
    accountId: string
    conversationId: string | null
    contactId: string | null
    embeddingsApiKey: string | null
    source: ToolSource
    dryRun: boolean
  },
): Promise<ToolRuntime | undefined> {
  const permissions = agent?.toolPermissions ?? []
  if (!agent || permissions.length === 0) return undefined
  const webhookSecret = agent.n8nWebhookUrl ? await loadToolWebhookSecret(db, b.accountId) : null
  return {
    permissions,
    ctx: {
      db,
      accountId: b.accountId,
      conversationId: b.conversationId,
      contactId: b.contactId,
      agentId: agent.agentId,
      agentVersionId: agent.versionId,
      source: b.source,
      dryRun: b.dryRun,
      embeddingsApiKey: b.embeddingsApiKey,
      n8nWebhookUrl: agent.n8nWebhookUrl,
      webhookSecret,
      handoff: { request: null },
    },
  }
}
