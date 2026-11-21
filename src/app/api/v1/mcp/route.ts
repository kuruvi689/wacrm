// ============================================================
// WACRM MCP server — stateless JSON-RPC 2.0 over HTTP
// (MCP "Streamable HTTP" transport, request/response mode).
//
// Why stateless: this runs on serverless, where a POST rarely lands
// on the instance that holds an in-memory SSE stream. Every response
// is therefore returned in the POST body, and nothing is kept between
// requests.
//
// Auth: every tools/call needs a WACRM API key (`Authorization:
// Bearer wacrm_live_…`), and each tool enforces the matching scope.
// The Supabase client behind an API key is service-role (bypasses
// RLS), so EVERY query below must be filtered by `ctx.accountId`.
// ============================================================

import { NextResponse } from 'next/server';
import { requireApiKey, type ApiKeyContext } from '@/lib/auth/api-context';
import { getAccountName } from '@/lib/api-keys/store';
import { hasScope, type ApiScope } from '@/lib/api-keys/scopes';
import {
  CONTACT_SELECT,
  serializeContact,
  findOrCreateContact,
  getContactById,
  resolveAuditUserId,
} from '@/lib/api/v1/contacts';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

const SERVER_INFO = { name: 'wacrm-mcp', version: '0.8.0' };
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 4096;

type ToolArgs = Record<string, unknown>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Scopes the API key must hold. Empty = any valid key. */
  scopes: ApiScope[];
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'whoami',
    description: 'Verify WACRM API key and retrieve connected account details & granted scopes.',
    inputSchema: { type: 'object', properties: {} },
    scopes: [],
  },
  {
    name: 'list_contacts',
    description: 'List contacts in the CRM with optional search filter over name or phone.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Free-text search over name or phone number.' },
        limit: { type: 'number', description: `Maximum items to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).` },
      },
    },
    scopes: ['contacts:read'],
  },
  {
    name: 'get_contact',
    description: 'Retrieve a single contact by its unique contact ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact UUID.' } },
      required: ['id'],
    },
    scopes: ['contacts:read'],
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
    scopes: ['contacts:write'],
  },
  {
    name: 'list_conversations',
    description: 'List recent WhatsApp inbox conversations for the account.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter status (open, closed, snoozed).' },
        limit: { type: 'number', description: `Page size (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).` },
      },
    },
    scopes: ['conversations:read'],
  },
  {
    name: 'get_conversation',
    description: 'Get details and message history for a specific conversation.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Conversation UUID.' } },
      required: ['id'],
    },
    scopes: ['conversations:read', 'messages:read'],
  },
  {
    name: 'list_messages',
    description: 'List messages inside a conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Conversation UUID.' },
        limit: { type: 'number', description: `Max messages to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).` },
      },
      required: ['conversation_id'],
    },
    scopes: ['messages:read'],
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
    scopes: ['messages:send'],
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Error carrying the HTTP status to return to the MCP client. */
class McpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

// ------------------------------------------------------------
// Argument helpers (the wire is untrusted — validate on entry)
// ------------------------------------------------------------

function requireString(args: ToolArgs, key: string, maxLength = 512): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpError(`"${key}" is required and must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new McpError(`"${key}" must be at most ${maxLength} characters`);
  }
  return value.trim();
}

function optionalString(args: ToolArgs, key: string, maxLength = 512): string | undefined {
  return args[key] === undefined || args[key] === null || args[key] === ''
    ? undefined
    : requireString(args, key, maxLength);
}

function parseLimit(args: ToolArgs): number {
  const raw = args.limit;
  if (raw === undefined || raw === null) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new McpError('"limit" must be a number');
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

/**
 * Strip characters that have meaning inside a PostgREST `.or()` filter
 * (commas and parentheses split/nest conditions) and the LIKE wildcards,
 * so a search term can't rewrite the filter it is embedded in.
 */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()%_\\*]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function assertScopes(ctx: ApiKeyContext, tool: ToolDefinition): void {
  const missing = tool.scopes.find((scope) => !hasScope(ctx.scopes, scope));
  if (missing) {
    throw new McpError(`This API key is missing the '${missing}' scope`, 403);
  }
}

// ------------------------------------------------------------
// Tool handlers — every query is scoped by ctx.accountId
// ------------------------------------------------------------

type ToolHandler = (ctx: ApiKeyContext, args: ToolArgs) => Promise<unknown>;

/** Throws unless the conversation exists inside the caller's account. */
async function assertConversationInAccount(
  ctx: ApiKeyContext,
  conversationId: string,
): Promise<void> {
  const { data, error } = await ctx.supabase
    .from('conversations')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('id', conversationId)
    .maybeSingle();
  if (error || !data) throw new McpError('Conversation not found', 404);
}

const HANDLERS: Record<string, ToolHandler> = {
  async whoami(ctx) {
    const name = await getAccountName(ctx.accountId);
    return {
      account: { id: ctx.accountId, name },
      key: { id: ctx.keyId, scopes: ctx.scopes },
    };
  },

  async list_contacts(ctx, args) {
    let query = ctx.supabase
      .from('contacts')
      .select(CONTACT_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(parseLimit(args));

    const search = optionalString(args, 'search', MAX_SEARCH_LENGTH);
    const term = search ? sanitizeSearchTerm(search) : '';
    if (term) {
      query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw new McpError('Could not load contacts', 500);
    return {
      contacts: (data ?? []).map((row) => serializeContact(row as Record<string, unknown>)),
    };
  },

  async get_contact(ctx, args) {
    const contact = await getContactById(ctx.supabase, ctx.accountId, requireString(args, 'id', 64));
    if (!contact) throw new McpError('Contact not found', 404);
    // getContactById already returns the serialized public shape.
    return { contact };
  },

  async create_contact(ctx, args) {
    const phone = requireString(args, 'phone', 32);
    const name = optionalString(args, 'name', 200);
    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    const { id: contactId, created } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      { phone, name },
    );
    const contact = await getContactById(ctx.supabase, ctx.accountId, contactId);
    return { created, contact: contact ?? { id: contactId } };
  },

  async list_conversations(ctx, args) {
    let query = ctx.supabase
      .from('conversations')
      .select('*, contact:contacts(*)')
      .eq('account_id', ctx.accountId)
      .order('updated_at', { ascending: false })
      .limit(parseLimit(args));

    const status = optionalString(args, 'status', 32);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new McpError('Could not load conversations', 500);
    return { conversations: data ?? [] };
  },

  async get_conversation(ctx, args) {
    const id = requireString(args, 'id', 64);
    const { data: conversation, error } = await ctx.supabase
      .from('conversations')
      .select('*, contact:contacts(*)')
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .maybeSingle();
    if (error || !conversation) throw new McpError('Conversation not found', 404);

    const { data: messages } = await ctx.supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(DEFAULT_LIMIT);

    return { conversation, messages: messages ?? [] };
  },

  async list_messages(ctx, args) {
    const conversationId = requireString(args, 'conversation_id', 64);
    // Ownership check first: the service-role client bypasses RLS, so
    // without it any key could read another tenant's messages by UUID.
    await assertConversationInAccount(ctx, conversationId);

    const { data, error } = await ctx.supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(parseLimit(args));
    if (error) throw new McpError('Could not load messages', 500);
    return { messages: data ?? [] };
  },

  async send_message(ctx, args) {
    const to = requireString(args, 'to', 32);
    const message = requireString(args, 'message', MAX_MESSAGE_LENGTH);
    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    const resolved = await resolveConversationByPhone(ctx.supabase, ctx.accountId, auditUserId, to);
    const sendResult = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
      conversationId: resolved.conversationId,
      messageType: 'text',
      contentText: message,
    });
    return { success: true, sendResult };
  },
};

// ------------------------------------------------------------
// HTTP handlers
// ------------------------------------------------------------

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
    { status },
  );
}

function statusOf(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 500;
}

/** Browser-friendly landing page; the server itself needs no browser. */
function dashboardHtml(origin: string): string {
  const endpoint = escapeHtml(`${origin}/api/mcp`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>WACRM MCP Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #0f172a; background: #f8fafc; }
    pre { background: #0f172a; color: #f8fafc; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
    code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>WACRM MCP Server</h1>
  <p>Endpoint: <code>${endpoint}</code> (MCP Streamable HTTP, JSON responses).</p>
  <pre>{
  "mcpServers": {
    "wacrm": {
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer wacrm_live_YOUR_API_KEY" }
    }
  }
}</pre>
</body>
</html>`;
}

export async function GET(request: Request) {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) {
    return new Response(dashboardHtml(new URL(request.url).origin), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  // No server-initiated stream: serverless instances can't hold one
  // between requests. The spec allows 405 for this.
  return new Response('This MCP server answers over POST only.', {
    status: 405,
    headers: { Allow: 'GET, POST' },
  });
}

export async function POST(request: Request) {
  let body: { id?: unknown; method?: unknown; params?: Record<string, unknown> } | null;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const { id, method, params } = body ?? {};

  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case 'ping':
        return rpcResult(id, {});

      case 'notifications/initialized':
        return new Response(null, { status: 202 });

      case 'tools/list': {
        // Authenticated so an anonymous caller learns nothing about
        // the account, and the list can be limited to what the key can do.
        const ctx = await requireApiKey(request);
        const visible = TOOLS.filter((tool) => tool.scopes.every((s) => hasScope(ctx.scopes, s)));
        return rpcResult(id, {
          tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      }

      case 'tools/call': {
        const ctx = await requireApiKey(request);
        const toolName = typeof params?.name === 'string' ? params.name : '';
        const tool = TOOLS_BY_NAME.get(toolName);
        if (!tool) return rpcError(id, -32601, `Tool not found: ${toolName}`);
        assertScopes(ctx, tool);

        const rawArgs = params?.arguments;
        const args: ToolArgs =
          rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as ToolArgs) : {};

        const data = await HANDLERS[tool.name](ctx, args);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      }

      default:
        return rpcError(id, -32601, `Unsupported method: ${String(method)}`);
    }
  } catch (err) {
    const status = statusOf(err);
    // Only our own typed errors and API-key auth errors carry messages
    // safe to show; anything else is logged and masked.
    const safe = err instanceof McpError || (status >= 400 && status < 500);
    if (!safe) console.error('[mcp] unexpected error:', err);
    const message = safe && err instanceof Error ? err.message : 'Internal MCP error';
    return rpcError(id, -32603, message, safe ? status : 500);
  }
}
