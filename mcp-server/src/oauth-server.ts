#!/usr/bin/env node
// ============================================================
// WACRM OAuth Redirect MCP Server
//
// A Model Context Protocol (MCP) server running over HTTP/SSE with an
// integrated OAuth 2.0 authorization & redirect flow.
// Designed for Hermes Agent and external MCP clients requiring OAuth
// authentication to drive self-hosted WACRM instances.
// ============================================================

import http from 'node:http';
import url from 'node:url';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { WacrmClient } from './client.js';
import { registerTools } from './tools/index.js';
import type { Config } from './config.js';

const VERSION = '0.1.1';
const PORT = Number(process.env.MCP_OAUTH_PORT || process.env.PORT || 3001);
const HOST = process.env.MCP_OAUTH_HOST || '0.0.0.0';
const BASE_URL = process.env.WACRM_BASE_URL?.replace(/\/+$/, '') || 'https://wacrm-wheat.vercel.app';
const SERVER_PUBLIC_URL = process.env.MCP_SERVER_URL?.replace(/\/+$/, '') || `http://localhost:${PORT}`;

// In-memory OAuth Code & Token Stores
interface OAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  apiKey?: string;
  expiresAt: number;
}

interface OAuthToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  apiKey: string;
  scope: string;
}

const authCodes = new Map<string, OAuthCode>();
const accessTokens = new Map<string, OAuthToken>();
const sseTransports = new Map<string, SSEServerTransport>();

function getEnvConfig(apiKeyOverride?: string): Config {
  const apiKey = apiKeyOverride || process.env.WACRM_API_KEY || '';
  const enableWrites = ['1', 'true', 'yes', 'on'].includes((process.env.WACRM_ENABLE_WRITES || '').toLowerCase());
  const enableBroadcasts = ['1', 'true', 'yes', 'on'].includes((process.env.WACRM_ENABLE_BROADCASTS || '').toLowerCase());
  return {
    baseUrl: BASE_URL,
    apiKey,
    enableWrites,
    enableBroadcasts,
  };
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        // Try parsing URL-encoded form data fallback
        const params = new URLSearchParams(body);
        const result: Record<string, string> = {};
        for (const [key, val] of params.entries()) {
          result[key] = val;
        }
        resolve(result);
      }
    });
    req.on('error', reject);
  });
}

function createMcpInstance(apiKey: string): McpServer {
  const config = getEnvConfig(apiKey);
  const client = new WacrmClient(config);
  const server = new McpServer({
    name: 'wacrm-oauth-mcp',
    version: VERSION,
  });
  registerTools(server, client, config);
  return server;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url || '', true);
  const pathname = parsedUrl.pathname || '/';
  const query = parsedUrl.query;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ------------------------------------------------------------
    // 1. Root Info & Status Page
    // ------------------------------------------------------------
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>WACRM OAuth Redirect MCP Server</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1e293b; background: #f8fafc; }
            h1 { color: #0f172a; }
            .card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 20px 0; shadow: 0 1px 3px rgba(0,0,0,0.1); }
            code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
            pre { background: #0f172a; color: #f8fafc; padding: 15px; border-radius: 6px; overflow-x: auto; }
            .btn { display: inline-block; background: #2563eb; color: white; padding: 10px 18px; text-decoration: none; border-radius: 6px; font-weight: 500; }
          </style>
        </head>
        <body>
          <h1>⚡ WACRM OAuth Redirect MCP Server</h1>
          <p>This server enables <strong>Hermes Agent</strong> and AI assistants to securely connect to WACRM via OAuth 2.0 and MCP over HTTP/SSE.</p>

          <div class="card">
            <h3>Server Metadata</h3>
            <ul>
              <li><strong>Instance URL:</strong> <code>${BASE_URL}</code></li>
              <li><strong>MCP SSE Endpoint:</strong> <code>${SERVER_PUBLIC_URL}/sse</code></li>
              <li><strong>OAuth Authorize Endpoint:</strong> <code>${SERVER_PUBLIC_URL}/oauth/authorize</code></li>
              <li><strong>OAuth Token Endpoint:</strong> <code>${SERVER_PUBLIC_URL}/oauth/token</code></li>
            </ul>
          </div>

          <div class="card">
            <h3>Hermes MCP Configuration</h3>
            <p>Add this to your Hermes MCP client configuration:</p>
            <pre>
{
  "mcpServers": {
    "wacrm": {
      "url": "${SERVER_PUBLIC_URL}/sse",
      "transport": "sse",
      "oauth": {
        "authorizeUrl": "${SERVER_PUBLIC_URL}/oauth/authorize",
        "tokenUrl": "${SERVER_PUBLIC_URL}/oauth/token"
      }
    }
  }
}
            </pre>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // ------------------------------------------------------------
    // 2. OAuth Discovery Metadata
    // ------------------------------------------------------------
    if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/mcp-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: SERVER_PUBLIC_URL,
        authorization_endpoint: `${SERVER_PUBLIC_URL}/oauth/authorize`,
        token_endpoint: `${SERVER_PUBLIC_URL}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256', 'plain'],
        scopes_supported: ['read', 'write', 'broadcast'],
        mcp_sse_endpoint: `${SERVER_PUBLIC_URL}/sse`,
      }));
      return;
    }

    // ------------------------------------------------------------
    // 3. OAuth Authorize Endpoint (GET /oauth/authorize)
    // ------------------------------------------------------------
    if (pathname === '/oauth/authorize' && req.method === 'GET') {
      const clientId = (query.client_id as string) || 'hermes-agent';
      const redirectUri = (query.redirect_uri as string) || '';
      const state = (query.state as string) || '';
      const codeChallenge = (query.code_challenge as string) || '';
      const codeChallengeMethod = (query.code_challenge_method as string) || '';

      // If key is supplied in query or env, allow instant confirmation
      const apiKeyParam = (query.api_key as string) || process.env.WACRM_API_KEY || '';

      if (req.headers.accept?.includes('text/html') && !query.confirm) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Authorize Hermes for WACRM</title>
            <style>
              body { font-family: system-ui, -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; background: #f8fafc; }
              .card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
              .btn { width: 100%; background: #16a34a; color: white; padding: 12px; border: none; border-radius: 8px; font-weight: 600; font-size: 16px; cursor: pointer; margin-top: 15px; }
              input { width: 100%; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 6px; box-sizing: border-box; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>Authorize Hermes Agent</h2>
              <p>Hermes is requesting permission to access your WACRM instance at <strong>${BASE_URL}</strong>.</p>
              <form method="GET" action="/oauth/authorize">
                <input type="hidden" name="client_id" value="${clientId}" />
                <input type="hidden" name="redirect_uri" value="${redirectUri}" />
                <input type="hidden" name="state" value="${state}" />
                <input type="hidden" name="code_challenge" value="${codeChallenge}" />
                <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}" />
                <input type="hidden" name="confirm" value="true" />
                
                <label style="font-size:14px; font-weight:500;">WACRM API Key (Leave blank to use server default):</label>
                <input type="password" name="api_key" placeholder="wacrm_live_..." value="${apiKeyParam}" />
                
                <button type="submit" class="btn">Authorize Connection</button>
              </form>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Generate OAuth code
      const code = 'code_' + crypto.randomBytes(16).toString('hex');
      authCodes.set(code, {
        code,
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        apiKey: apiKeyParam,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      if (redirectUri) {
        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set('code', code);
        if (state) redirectUrl.searchParams.set('state', state);
        res.writeHead(302, { Location: redirectUrl.toString() });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code, state }));
      }
      return;
    }

    // ------------------------------------------------------------
    // 4. OAuth Token Endpoint (POST /oauth/token)
    // ------------------------------------------------------------
    if (pathname === '/oauth/token' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const code = body.code || query.code;
      const authRecord = code ? authCodes.get(code) : undefined;

      const apiKey = authRecord?.apiKey || process.env.WACRM_API_KEY || body.api_key || 'wacrm_default_key';
      const token = 'at_wacrm_' + crypto.randomBytes(24).toString('hex');

      accessTokens.set(token, {
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: 3600 * 24 * 30, // 30 days
        apiKey,
        scope: 'read write broadcast',
      });

      if (code) authCodes.delete(code);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600 * 24 * 30,
        scope: 'read write broadcast',
      }));
      return;
    }

    // ------------------------------------------------------------
    // 5. MCP SSE Transport (GET /sse)
    // ------------------------------------------------------------
    if (pathname === '/sse' && req.method === 'GET') {
      // Authenticate Bearer token if provided
      const authHeader = req.headers.authorization || '';
      let apiKey = process.env.WACRM_API_KEY || '';
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const tokenRecord = accessTokens.get(token);
        if (tokenRecord) {
          apiKey = tokenRecord.apiKey;
        }
      }

      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;
      sseTransports.set(sessionId, transport);

      const mcpServer = createMcpInstance(apiKey);
      await mcpServer.connect(transport);

      req.on('close', () => {
        sseTransports.delete(sessionId);
      });
      return;
    }

    // ------------------------------------------------------------
    // 6. MCP Messages Endpoint (POST /messages)
    // ------------------------------------------------------------
    if (pathname === '/messages' && req.method === 'POST') {
      const sessionId = (query.sessionId as string) || '';
      const transport = sseTransports.get(sessionId);

      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    }

    // Fallthrough 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error('[OAuth MCP Error]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n============================================================`);
  console.log(`🚀 WACRM OAuth Redirect MCP Server v${VERSION} Ready!`);
  console.log(`============================================================`);
  console.log(`🌐 Server Base URL: ${SERVER_PUBLIC_URL}`);
  console.log(`🔗 WACRM Instance:  ${BASE_URL}`);
  console.log(`📡 MCP SSE URL:     ${SERVER_PUBLIC_URL}/sse`);
  console.log(`🔐 OAuth Authorize: ${SERVER_PUBLIC_URL}/oauth/authorize`);
  console.log(`🔑 OAuth Token:     ${SERVER_PUBLIC_URL}/oauth/token`);
  console.log(`============================================================\n`);
});
