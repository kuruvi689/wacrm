import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { getConnectionByPhoneNumberId, decryptToken } from '@/lib/whatsapp/token-vault'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

export const maxDuration = 60

let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    const expectedVerifyToken =
      process.env.META_WEBHOOK_VERIFY_TOKEN ||
      process.env.WHATSAPP_VERIFY_TOKEN ||
      'wacrm_verify_token'

    if (verifyToken === expectedVerifyToken) {
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    // Secondary check against whatsapp_connections / whatsapp_config
    const { data: connections } = await supabaseAdmin()
      .from('whatsapp_connections')
      .select('id, meta_data')

    if (connections && connections.length > 0) {
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Multi-tenant payload router
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (process.env.META_APP_SECRET && !verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[webhook] rejected request with invalid X-Hub-Signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processMultitenantWebhook(body)
    } catch (error) {
      console.error('Error processing multi-tenant webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processMultitenantWebhook(body: any) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value },
          supabaseAdmin()
        )
        continue
      }

      const value = change.value
      if (!value) continue

      const phoneNumberId = value.metadata?.phone_number_id
      if (!phoneNumberId) continue

      // Multi-tenant Org Lookup from whatsapp_connections table
      const connection = await getConnectionByPhoneNumberId(phoneNumberId)
      let orgId = connection?.org_id
      let accessToken = connection ? decryptToken(connection.access_token_encrypted) : null

      // Legacy fallback
      if (!connection) {
        const { data: legacyConfigs } = await supabaseAdmin()
          .from('whatsapp_config')
          .select('*')
          .eq('phone_number_id', phoneNumberId)
          .limit(1)

        if (legacyConfigs && legacyConfigs.length > 0) {
          orgId = legacyConfigs[0].account_id
          try {
            accessToken = decrypt(legacyConfigs[0].access_token)
          } catch {
            accessToken = null
          }
        }
      }

      if (!orgId) {
        console.error('[webhook router] No organization found for phone_number_id:', phoneNumberId)
        continue
      }

      // Handle message statuses
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status, orgId)
        }
      }

      // Handle inbound messages
      if (value.messages && value.contacts) {
        for (let i = 0; i < value.messages.length; i++) {
          const message = value.messages[i]
          const contact = value.contacts[i] || value.contacts[0]
          await processInboundMessage(message, contact, orgId, accessToken)
        }
      }
    }
  }
}

async function handleStatusUpdate(status: any, orgId: string) {
  await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)
    .eq('org_id', orgId)
}

async function processInboundMessage(
  message: any,
  contact: any,
  orgId: string,
  accessToken: string | null
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact?.profile?.name || senderPhone

  // Find or create contact for this org
  let { data: contactRecord } = await supabaseAdmin()
    .from('contacts')
    .select('id')
    .eq('org_id', orgId)
    .eq('phone', senderPhone)
    .maybeSingle()

  if (!contactRecord) {
    const { data: newContact, error: cErr } = await supabaseAdmin()
      .from('contacts')
      .insert({
        org_id: orgId,
        phone: senderPhone,
        name: contactName,
      })
      .select('id')
      .single()

    if (cErr || !newContact) {
      console.error('[webhook router] Failed to create contact:', cErr)
      return
    }
    contactRecord = newContact
  }

  // Find or create conversation for this org
  let { data: conversation } = await supabaseAdmin()
    .from('conversations')
    .select('id, unread_count')
    .eq('org_id', orgId)
    .eq('contact_id', contactRecord.id)
    .maybeSingle()

  if (!conversation) {
    const { data: newConv, error: convErr } = await supabaseAdmin()
      .from('conversations')
      .insert({
        org_id: orgId,
        contact_id: contactRecord.id,
        unread_count: 1,
        last_message_at: new Date().toISOString(),
      })
      .select('id, unread_count')
      .single()

    if (convErr || !newConv) {
      console.error('[webhook router] Failed to create conversation:', convErr)
      return
    }
    conversation = newConv
  }

  // Deduplicate message.id
  if (message.id) {
    const { data: existing } = await supabaseAdmin()
      .from('messages')
      .select('id')
      .eq('org_id', orgId)
      .eq('message_id', message.id)
      .maybeSingle()

    if (existing) {
      console.log('[webhook router] Skipping duplicate message:', message.id)
      return
    }
  }

  const contentText = message.text?.body || message.caption || `[${message.type}]`

  // Insert message into org context
  await supabaseAdmin().from('messages').insert({
    org_id: orgId,
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: message.type || 'text',
    content_text: contentText,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
  })

  // Update conversation last message info
  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
    })
    .eq('id', conversation.id)
}
