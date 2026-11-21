import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { sendTextMessage, sendTemplateMessage } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-2' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'token',
  encrypt: () => 'enc',
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      for (const m of ['update', 'eq']) b[m] = () => b
      b.then = (resolve: (v: unknown) => unknown) => resolve({ error: null })
      return b
    },
  }),
}))

import { sendMessageToConversation, SendMessageError } from './send-message'

const CONTACT = { id: 'ct-1', phone: '+15551234567' }

function makeDb(lastInboundAt: string | null): SupabaseClient {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'update', 'insert']) b[m] = () => b
    const row = () => {
      switch (table) {
        case 'conversations':
          return { data: { id: 'cv-1', contact: CONTACT }, error: null }
        case 'whatsapp_config':
          return { data: { id: 'cfg', phone_number_id: 'PN', access_token: 'x' }, error: null }
        case 'messages':
          return lastInboundAt
            ? { data: { created_at: lastInboundAt, id: 'm-1' }, error: null }
            : { data: null, error: null }
        default:
          return { data: null, error: null }
      }
    }
    b.single = async () =>
      table === 'messages' ? { data: { id: 'm-1' }, error: null } : row()
    b.maybeSingle = async () => row()
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return b
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient
}

const text = { conversationId: 'cv-1', messageType: 'text', contentText: 'hello' }

describe('sendMessageToConversation — 24h service window', () => {
  it('refuses free-form text when there is no inbound message, without calling Meta', async () => {
    sendTextMessage.mockClear()
    const err = await sendMessageToConversation(makeDb(null), 'acct', text).catch((e) => e)
    expect(err).toBeInstanceOf(SendMessageError)
    expect(err.code).toBe('window_closed')
    expect(err.message).toMatch(/template/i)
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('refuses free-form text when the last inbound is older than 24h', async () => {
    sendTextMessage.mockClear()
    const old = new Date(Date.now() - 25 * 3600_000).toISOString()
    await expect(sendMessageToConversation(makeDb(old), 'acct', text)).rejects.toMatchObject({
      code: 'window_closed',
    })
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('allows free-form text inside the window', async () => {
    sendTextMessage.mockClear()
    const recent = new Date(Date.now() - 3600_000).toISOString()
    await sendMessageToConversation(makeDb(recent), 'acct', text)
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
  })

  it('always allows templates, even with a closed window', async () => {
    sendTemplateMessage.mockClear()
    await sendMessageToConversation(makeDb(null), 'acct', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
    })
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })
})
