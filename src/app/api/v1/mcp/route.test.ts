import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---- mocks -------------------------------------------------------
interface Call {
  table: string
  filters: Array<[string, unknown]>
}

const calls: Call[] = []
let conversationOwned = true
let scopes: string[] = ['messages:read']

function queryBuilder(table: string) {
  const call: Call = { table, filters: [] }
  calls.push(call)
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      call.filters.push([column, value])
      return builder
    },
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({
      data: table === 'conversations' && conversationOwned ? { id: 'conv-1' } : null,
      error: null,
    }),
    then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
      resolve({ data: [{ id: 'msg-1' }], error: null }),
  }
  return builder
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    authType: 'api_key',
    supabase: { from: (table: string) => queryBuilder(table) },
    accountId: 'acct-A',
    keyId: 'key-1',
    scopes,
    createdBy: null,
  }),
}))
vi.mock('@/lib/api-keys/store', () => ({ getAccountName: async () => 'Acme' }))
vi.mock('@/lib/api/v1/contacts', () => ({
  CONTACT_SELECT: '*',
  serializeContact: (row: unknown) => row,
  findOrCreateContact: vi.fn(),
  getContactById: vi.fn(),
  resolveAuditUserId: vi.fn(),
}))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: vi.fn() }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: vi.fn() }))

const { POST } = await import('./route')

function rpc(method: string, params?: Record<string, unknown>) {
  return POST(
    new Request('https://crm.example.com/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
}

beforeEach(() => {
  calls.length = 0
  conversationOwned = true
  scopes = ['messages:read']
})

describe('MCP list_messages tenant isolation', () => {
  it("refuses a conversation that is not in the caller's account", async () => {
    conversationOwned = false
    const res = await rpc('tools/call', {
      name: 'list_messages',
      arguments: { conversation_id: 'conv-of-another-tenant' },
    })
    const body = await res.json()

    expect(body.error.message).toBe('Conversation not found')
    expect(calls.some((call) => call.table === 'messages')).toBe(false)
  })

  it('verifies ownership with account_id before reading messages', async () => {
    const res = await rpc('tools/call', {
      name: 'list_messages',
      arguments: { conversation_id: 'conv-1' },
    })
    const body = await res.json()

    expect(body.result.content[0].text).toContain('msg-1')
    const ownership = calls.find((call) => call.table === 'conversations')
    expect(ownership?.filters).toContainEqual(['account_id', 'acct-A'])
  })
})

describe('MCP scope enforcement', () => {
  it('rejects send_message for a read-only key', async () => {
    const res = await rpc('tools/call', {
      name: 'send_message',
      arguments: { to: '+14155550123', message: 'hi' },
    })

    expect(res.status).toBe(403)
    expect((await res.json()).error.message).toContain("'messages:send'")
  })

  it('hides tools the key cannot use from tools/list', async () => {
    const body = await (await rpc('tools/list')).json()
    const names = body.result.tools.map((tool: { name: string }) => tool.name)

    expect(names).toContain('list_messages')
    expect(names).not.toContain('send_message')
  })
})
