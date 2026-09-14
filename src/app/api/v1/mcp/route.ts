// ============================================================
// WACRM Official MCP Server (Server-Sent Events & JSON-RPC 2.0)
//
// Deploys natively on Vercel App Router (/api/mcp & /api/v1/mcp).
// Fully compatible with Cursor, Claude Desktop, Open-WebUI, Hermes,
// and all official MCP (Model Context Protocol) clients.
//
// Transports:
//   1. SSE Transport: GET /api/mcp (Content-Type: text/event-stream)
//   2. Message Endpoint: POST /api/mcp?sessionId=...
//   3. Web Dashboard: GET /api/mcp (Accept: text/html)
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

// In-memory active SSE session response controllers
const activeSseControllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const acceptHeader = request.headers.get('accept') || '';

  // 1. Return HTML Dashboard for Web Browsers
  if (acceptHeader.includes('text/html') && !url.searchParams.get('transport')) {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>WACRM Model Context Protocol (MCP) Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #0f172a; background: #f8fafc; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px; margin: 20px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    code { background: #f1f5f9; color: #2563eb; padding: 3px 7px; border-radius: 4px; font-size: 0.9em; font-family: monospace; }
    pre { background: #0f172a; color: #f8fafc; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
    .badge { display: inline-block; background: #dcfce7; color: #166534; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
  </style>
</head>
<body>
  <div style="display:flex; justify-content:space-between; align-items:center;">
    <h1>⚡ WACRM MCP Server</h1>
    <span class="badge">ONLINE v0.8.0</span>
  </div>
  <p>Self-hosted WhatsApp CRM Model Context Protocol server running natively on Vercel App Router.</p>

  <div class="card">
    <h3>📡 Official MCP SSE Connection URL</h3>
    <p>Use this URL in your MCP client (Cursor, Claude Desktop, Hermes, etc.):</p>
    <code>${url.origin}/api/mcp</code>
  </div>

  <div class="card">
    <h3>⚙️ Client Configuration Example</h3>
    <pre>{
  "mcpServers": {
    "wacrm": {
      "url": "${url.origin}/api/mcp",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer wacrm_live_YOUR_API_KEY_HERE"
      }
    }
  }
}</pre>
  </div>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // 2. Official SSE Stream Handler (Content-Type: text/event-stream)
  const sessionId = 'sse_' + Math.random().toString(36).substring(2, 15);
  const mcpPostUrl = `${url.origin}${url.pathname}?sessionId=${sessionId}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      activeSseControllers.set(sessionId, controller);
      // Emit initial MCP SSE endpoint event
      controller.enqueue(encoder.encode(`event: endpoint\ndata: ${mcpPostUrl}\n\n`));

      // Keep-alive heartbeat ping every 15 seconds
      const interval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(interval);
          activeSseControllers.delete(sessionId);
        }
      }, 15000);
    },
    cancel() {
      activeSseControllers.delete(sessionId);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    const body = await request.json();

    const { id, method, params } = body || {};

    // 1. Initialize Handshake
    if (method === 'initialize') {
      const responsePayload = {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
      sendSseEvent(sessionId, responsePayload);
      return NextResponse.json(responsePayload);
    }

    // 2. Ping
    if (method === 'ping') {
      const responsePayload = { jsonrpc: '2.0', id: id ?? null, result: {} };
      sendSseEvent(sessionId, responsePayload);
      return NextResponse.json(responsePayload);
    }

    // 3. List Tools
    if (method === 'tools/list') {
      const responsePayload = {
        jsonrpc: '2.0',
        id: id ?? null,
        result: { tools: TOOLS_SCHEMA },
      };
      sendSseEvent(sessionId, responsePayload);
      return NextResponse.json(responsePayload);
    }

    // 4. Call Tool
    if (method === 'tools/call') {
      const ctx = await requireApiKey(request);
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

      const responsePayload = {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
        },
      };

      sendSseEvent(sessionId, responsePayload);
      return NextResponse.json(responsePayload);
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

function sendSseEvent(sessionId: string | null, payload: any) {
  if (!sessionId) return;
  const controller = activeSseControllers.get(sessionId);
  if (controller) {
    try {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
    } catch {
      activeSseControllers.delete(sessionId);
    }
  }
}
