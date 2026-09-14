// ============================================================
// WACRM Model Context Protocol (MCP) Route Handler — Vercel Native
//
// Deploys directly on Vercel as part of WACRM (/api/v1/mcp & /api/mcp).
// Exposes WACRM contacts, conversations, inbox messages, sending,
// and broadcasts as standard MCP JSON-RPC 2.0 tools.
//
// Authenticated via WACRM API Keys (`Authorization: Bearer wacrm_live_…`
// or `?api_key=wacrm_live_…`).
// ============================================================

import { NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/auth/api-context';
import { getAccountName } from '@/lib/api-keys/store';
import {
  CONTACT_SELECT,
  serializeContact,
  findOrCreateContact,
  getContactById,
  resolveAuditUserId,
} from '@/lib/api/v1/contacts';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

const SERVER_INFO = {
  name: 'wacrm-mcp',
  version: '0.8.0',
};

const TOOLS_SCHEMA = [
  {
    name: 'whoami',
    description: 'Verify WACRM API key and retrieve connected account details & granted scopes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_contacts',
    description: 'List contacts in the CRM with optional search filter over name or phone.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Free-text search query over name or phone number.' },
        limit: { type: 'number', description: 'Maximum items to return (1–100, default 50).' },
      },
    },
  },
  {
    name: 'get_contact',
    description: 'Retrieve a single contact by its unique contact ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact UUID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_contact',
    description: 'Create a new contact or find an existing contact by phone number.',
    inputSchema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'E.164 phone number (e.g. +14155550123).' },
        name: { type: 'string', description: 'Contact display name.' },
      },
      required: ['phone'],
    },
  },
  {
    name: 'list_conversations',
    description: 'List recent WhatsApp inbox conversations for the account.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter status (open, closed, snoozed).' },
        limit: { type: 'number', description: 'Page size (default 50).' },
      },
    },
  },
  {
    name: 'get_conversation',
    description: 'Get details and message history for a specific conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation UUID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_messages',
    description: 'List messages inside a conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Conversation UUID.' },
        limit: { type: 'number', description: 'Max messages to return (default 50).' },
      },
      required: ['conversation_id'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a WhatsApp text message to a contact.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'E.164 target phone number (e.g. +14155550123).' },
        message: { type: 'string', description: 'Text message content.' },
      },
      required: ['to', 'message'],
    },
  },
];

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    let authInfo: any = null;
    try {
      const ctx = await requireApiKey(request, 'contacts:read');
      const accountName = await getAccountName(ctx.accountId);
      authInfo = { accountId: ctx.accountId, accountName, keyId: ctx.keyId, scopes: ctx.scopes };
    } catch {
      // Unauthenticated discovery allowed
    }

    return NextResponse.json({
      status: 'online',
      server: SERVER_INFO,
      mcp_endpoint: `${url.origin}/api/v1/mcp`,
      authenticated: Boolean(authInfo),
      account: authInfo?.accountName || null,
      tools: TOOLS_SCHEMA,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'MCP GET failed' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request);
    const body = await request.json();

    const { id, method, params } = body || {};

    // 1. Initialize Handshake
    if (method === 'initialize') {
      return NextResponse.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
    }

    // 2. Ping
    if (method === 'ping') {
      return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, result: {} });
    }

    // 3. List Tools
    if (method === 'tools/list') {
      return NextResponse.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: { tools: TOOLS_SCHEMA },
      });
    }

    // 4. Call Tool
    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      let resultData: any = null;

      switch (toolName) {
        case 'whoami': {
          const name = await getAccountName(ctx.accountId);
          resultData = {
            account: { id: ctx.accountId, name },
            key: { id: ctx.keyId, scopes: ctx.scopes },
          };
          break;
        }

        case 'list_contacts': {
          let query = ctx.supabase
            .from('contacts')
            .select(CONTACT_SELECT)
            .eq('account_id', ctx.accountId)
            .order('created_at', { ascending: false })
            .limit(args.limit || 50);

          if (args.search) {
            const searchStr = String(args.search).trim();
            query = query.or(`name.ilike.%${searchStr}%,phone.ilike.%${searchStr}%`);
          }

          const { data, error } = await query;
          if (error) throw new Error(`Database error: ${error.message}`);
          resultData = { contacts: (data || []).map((row) => serializeContact(row as any)) };
          break;
        }

        case 'get_contact': {
          if (!args.id) throw new Error('Contact id is required');
          const contact = await getContactById(ctx.supabase, ctx.accountId, args.id);
          if (!contact) throw new Error('Contact not found');
          resultData = { contact: serializeContact(contact as any) };
          break;
        }

        case 'create_contact': {
          if (!args.phone) throw new Error('Phone number is required');
          const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
          const { id: contactId, created } = await findOrCreateContact(
            ctx.supabase,
            ctx.accountId,
            auditUserId,
            { phone: args.phone, name: args.name },
          );
          const contact = await getContactById(ctx.supabase, ctx.accountId, contactId);
          resultData = { created, contact: contact ? serializeContact(contact as any) : { id: contactId } };
          break;
        }

        case 'list_conversations': {
          let query = ctx.supabase
            .from('conversations')
            .select('*, contact:contacts(*)')
            .eq('account_id', ctx.accountId)
            .order('updated_at', { ascending: false })
            .limit(args.limit || 50);

          if (args.status) {
            query = query.eq('status', args.status);
          }

          const { data, error } = await query;
          if (error) throw new Error(`Database error: ${error.message}`);
          resultData = { conversations: data || [] };
          break;
        }

        case 'get_conversation': {
          if (!args.id) throw new Error('Conversation id is required');
          const { data: conv, error: convErr } = await ctx.supabase
            .from('conversations')
            .select('*, contact:contacts(*)')
            .eq('account_id', ctx.accountId)
            .eq('id', args.id)
            .maybeSingle();

          if (convErr || !conv) throw new Error('Conversation not found');

          const { data: msgs } = await ctx.supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', args.id)
            .order('created_at', { ascending: true })
            .limit(50);

          resultData = { conversation: conv, messages: msgs || [] };
          break;
        }

        case 'list_messages': {
          if (!args.conversation_id) throw new Error('conversation_id is required');
          const { data: msgs, error } = await ctx.supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', args.conversation_id)
            .order('created_at', { ascending: true })
            .limit(args.limit || 50);

          if (error) throw new Error(`Database error: ${error.message}`);
          resultData = { messages: msgs || [] };
          break;
        }

        case 'send_message': {
          if (!args.to || !args.message) throw new Error('both "to" and "message" are required');
          const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
          const resolved = await resolveConversationByPhone(
            ctx.supabase,
            ctx.accountId,
            auditUserId,
            args.to,
          );
          const sendRes = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
            conversationId: resolved.conversationId,
            messageType: 'text',
            contentText: args.message,
          });
          resultData = { success: true, sendResult: sendRes };
          break;
        }

        default:
          return NextResponse.json({
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code: -32601, message: `Tool not found: ${toolName}` },
          });
      }

      return NextResponse.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
        },
      });
    }

    return NextResponse.json({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32601, message: `Unsupported method: ${method}` },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: err.message || 'Internal MCP Error' },
      },
      { status: err.status || 400 },
    );
  }
}
