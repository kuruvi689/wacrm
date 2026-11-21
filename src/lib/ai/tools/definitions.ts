import { buildSignatureHeader } from '@/lib/webhooks/sign'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { retrieveKnowledge } from '../knowledge'
import type { SchemaLite } from './schema'
import type { ToolContext, ToolDefinition } from './types'

// ============================================================
// The tool registry. A closed list: no arbitrary HTTP, no code
// execution, no tool that takes a contact/conversation/account id as an
// argument — those are bound by the server in `ToolContext`. Objects
// reject unknown keys, so a model (or an injected instruction in a tool
// result) cannot smuggle an id in.
// ============================================================

export const TOOL_NAMES = [
  'knowledge_search',
  'crm_lookup_contact',
  'crm_update_contact',
  'handoff_to_human',
  'n8n_webhook',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolName(v: string): v is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(v)
}

const N8N_TIMEOUT_MS = 10_000
const N8N_MAX_RESPONSE_CHARS = 2_000
const N8N_MAX_BODY_CHARS = 8_000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const str = (max: number, min = 1): SchemaLite => ({ type: 'string', minLength: min, maxLength: max })

// ---------------------------------------------------------------- knowledge

const knowledgeSearch: ToolDefinition = {
  name: 'knowledge_search',
  description:
    "Search the business's knowledge base (policies, prices, FAQs). Returns short excerpts. Use before answering factual questions.",
  parameters: {
    type: 'object',
    properties: { query: { ...str(300), description: 'What to look up' } },
    required: ['query'],
    additionalProperties: false,
  },
  timeoutMs: 8_000,
  dryRunResult: null, // read-only
  async execute(ctx, args) {
    const excerpts = await retrieveKnowledge(
      ctx.db,
      ctx.accountId,
      { embeddingsApiKey: ctx.embeddingsApiKey },
      String(args.query),
    )
    return { excerpts: excerpts.map((e) => e.slice(0, 1200)) }
  },
}

// ---------------------------------------------------------------- CRM

const crmLookup: ToolDefinition = {
  name: 'crm_lookup_contact',
  description:
    "Look up the CURRENT customer's CRM record (name, email, company, tags, custom fields). Takes no arguments — it always refers to this conversation's customer.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  timeoutMs: 5_000,
  dryRunResult: null, // read-only
  async execute(ctx) {
    if (!ctx.contactId) return { found: false, note: 'No customer is attached to this test.' }
    const { data: contact, error } = await ctx.db
      .from('contacts')
      .select('name, email, company')
      .eq('id', ctx.contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) throw error
    if (!contact) return { found: false }

    const [{ data: tagRows }, { data: valueRows }] = await Promise.all([
      ctx.db.from('contact_tags').select('tags(name)').eq('contact_id', ctx.contactId),
      ctx.db
        .from('contact_custom_values')
        .select('value, custom_fields(field_name)')
        .eq('contact_id', ctx.contactId),
    ])
    const tags = ((tagRows ?? []) as unknown as { tags: { name: string } | null }[])
      .map((r) => r.tags?.name)
      .filter((n): n is string => !!n)
    const custom_fields: Record<string, string | null> = {}
    for (const r of (valueRows ?? []) as unknown as {
      value: string | null
      custom_fields: { field_name: string } | null
    }[]) {
      if (r.custom_fields?.field_name) custom_fields[r.custom_fields.field_name] = r.value
    }
    return {
      found: true,
      name: contact.name,
      email: contact.email,
      company: contact.company,
      tags,
      custom_fields,
    }
  },
}

const crmUpdate: ToolDefinition = {
  name: 'crm_update_contact',
  description:
    "Update the CURRENT customer's record: name, email, existing custom fields (by name), and add existing tags. Cannot remove tags or touch any other contact.",
  parameters: {
    type: 'object',
    properties: {
      name: str(120),
      email: str(254),
      custom_fields: {
        type: 'object',
        maxProperties: 10,
        additionalProperties: { type: 'string', maxLength: 500 },
      },
      add_tags: { type: 'array', maxItems: 5, items: str(40) },
    },
    additionalProperties: false,
    maxProperties: 4,
  },
  timeoutMs: 8_000,
  dryRunResult: (args) => ({ would_update_current_contact: Object.keys(args) }),
  async execute(ctx, args, signal) {
    // A timed-out call must not land a late write.
    const live = () => {
      if (signal.aborted) throw new Error('tool_timeout')
    }
    live()
    if (!ctx.contactId) throw new Error('no_contact')
    const hasAny = ['name', 'email', 'custom_fields', 'add_tags'].some((k) => args[k] !== undefined)
    if (!hasAny) throw new Error('nothing_to_update')

    const patch: Record<string, unknown> = {}
    if (typeof args.name === 'string') patch.name = args.name.trim()
    if (typeof args.email === 'string') {
      if (!EMAIL_RE.test(args.email)) throw new Error('invalid_email')
      patch.email = args.email.trim().toLowerCase()
    }
    const updated: string[] = []
    const result: Record<string, unknown> = { updated }
    if (Object.keys(patch).length > 0) {
      live()
      const { error } = await ctx.db
        .from('contacts')
        .update(patch)
        .eq('id', ctx.contactId)
        .eq('account_id', ctx.accountId)
      if (error) throw error
      updated.push(...Object.keys(patch))
    }

    const fields = (args.custom_fields ?? {}) as Record<string, string>
    const fieldNames = Object.keys(fields)
    if (fieldNames.length > 0) {
      const { data: defs, error } = await ctx.db
        .from('custom_fields')
        .select('id, field_name')
        .eq('account_id', ctx.accountId)
        .in('field_name', fieldNames)
      if (error) throw error
      live()
      const known = (defs ?? []) as { id: string; field_name: string }[]
      if (known.length > 0) {
        const { error: upErr } = await ctx.db.from('contact_custom_values').upsert(
          known.map((d) => ({
            contact_id: ctx.contactId,
            custom_field_id: d.id,
            value: fields[d.field_name],
          })),
          { onConflict: 'contact_id,custom_field_id' },
        )
        if (upErr) throw upErr
        updated.push(...known.map((d) => `custom:${d.field_name}`))
      }
      const unknown = fieldNames.filter((n) => !known.some((d) => d.field_name === n))
      if (unknown.length > 0) result.unknown_fields = unknown
    }

    const tagNames = (args.add_tags ?? []) as string[]
    if (tagNames.length > 0) {
      const { data: tagDefs, error } = await ctx.db
        .from('tags')
        .select('id, name')
        .eq('account_id', ctx.accountId)
        .in('name', tagNames)
      if (error) throw error
      live()
      const known = (tagDefs ?? []) as { id: string; name: string }[]
      if (known.length > 0) {
        const { error: insErr } = await ctx.db.from('contact_tags').upsert(
          known.map((t) => ({ contact_id: ctx.contactId, tag_id: t.id })),
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
        )
        if (insErr) throw insErr
        updated.push(...known.map((t) => `tag:${t.name}`))
      }
      const unknown = tagNames.filter((n) => !known.some((t) => t.name === n))
      if (unknown.length > 0) result.unknown_tags = unknown
    }
    return result
  },
}

// ---------------------------------------------------------------- handoff

const handoff: ToolDefinition = {
  name: 'handoff_to_human',
  description:
    'Stop replying and pass this conversation to a human teammate. Use when the customer asks for a person, is upset, or you cannot help safely.',
  parameters: {
    type: 'object',
    properties: { reason: str(200), summary: str(500) },
    required: ['reason', 'summary'],
    additionalProperties: false,
  },
  timeoutMs: 2_000,
  // It only records the request; auto-reply performs the assignment.
  // Safe in a dry run, and the simulation should show it happening.
  dryRunResult: null,
  async execute(ctx, args) {
    ctx.handoff.request = { reason: String(args.reason), summary: String(args.summary) }
    return { ok: true, note: 'A human will take over. Do not write a customer reply.' }
  },
}

// ---------------------------------------------------------------- n8n

export async function postToN8n(
  ctx: Pick<ToolContext, 'n8nWebhookUrl' | 'webhookSecret' | 'accountId' | 'conversationId' | 'agentId'>,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = ctx.n8nWebhookUrl
  if (!url) throw new Error('webhook_not_configured')
  if (!ctx.webhookSecret) throw new Error('webhook_secret_missing')
  if (!/^https:\/\//i.test(url) || !(await isDeliverableUrl(url))) {
    throw new Error('webhook_url_not_allowed')
  }
  if (signal?.aborted) throw new Error('tool_timeout')
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({
    event: args.event,
    payload: args.payload ?? {},
    account_id: ctx.accountId,
    conversation_id: ctx.conversationId,
    agent_id: ctx.agentId,
    timestamp,
  })
  if (body.length > N8N_MAX_BODY_CHARS) throw new Error('payload_too_large')

  const res = await fetchImpl(url, {
    method: 'POST',
    redirect: 'manual', // a redirect could point at an internal address
    headers: {
      'Content-Type': 'application/json',
      'X-Wacrm-Signature': buildSignatureHeader(body, ctx.webhookSecret, timestamp),
    },
    body,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(N8N_TIMEOUT_MS)])
      : AbortSignal.timeout(N8N_TIMEOUT_MS),
  })
  if (res.status >= 300 && res.status < 400) throw new Error('webhook_redirect_refused')
  const text = (await res.text().catch(() => '')).slice(0, N8N_MAX_RESPONSE_CHARS)
  if (!res.ok) throw new Error(`webhook_status_${res.status}`)
  return { status: res.status, response: text }
}

const n8nWebhook: ToolDefinition = {
  name: 'n8n_webhook',
  description:
    "Trigger the business's configured n8n workflow (for example to create a booking or notify staff). The destination is fixed by the business; you only choose the event name and a small payload.",
  parameters: {
    type: 'object',
    properties: {
      event: str(64),
      payload: { type: 'object', maxProperties: 20, additionalProperties: true },
    },
    required: ['event'],
    additionalProperties: false,
  },
  timeoutMs: N8N_TIMEOUT_MS + 2_000,
  dryRunResult: (args) => ({
    would_post_event: args.event,
    payload_keys: Object.keys((args.payload as object) ?? {}),
  }),
  execute: (ctx, args, signal) => postToN8n(ctx, args, fetch, signal),
}

export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  knowledge_search: knowledgeSearch,
  crm_lookup_contact: crmLookup,
  crm_update_contact: crmUpdate,
  handoff_to_human: handoff,
  n8n_webhook: n8nWebhook,
}
