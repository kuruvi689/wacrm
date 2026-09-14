# Connecting Hermes Agent to WACRM via OAuth Redirect MCP Server

This guide explains how to connect **Hermes Agent** (or any AI agent supporting HTTP/SSE MCP servers with OAuth) to your WACRM instance (`https://wacrm-wheat.vercel.app`).

---

## 🚀 Overview

The **WACRM OAuth Redirect MCP Server** provides:
- **OAuth 2.0 PKCE / Authorization Code flow**: Handles authorization requests, redirect callbacks, and token exchange.
- **HTTP / SSE Transport**: Exposes MCP tools over Server-Sent Events (`/sse` & `/messages`) for remote agent connection.
- **WACRM Tool Suite**: Full control over contacts, conversations, messages, and broadcasts.

---

## ⚡ Quick Start

### 1. Start the OAuth MCP Server

In the `mcp-server/` directory:

```bash
npm run build
npm run start:oauth
```

By default, the server runs on `http://localhost:3001` (or custom port via `MCP_OAUTH_PORT` environment variable).

### 2. Configure Environment Variables (Optional)

| Variable | Description | Default |
|---|---|---|
| `WACRM_BASE_URL` | Your live WACRM instance URL | `https://wacrm-wheat.vercel.app` |
| `WACRM_API_KEY` | Default WACRM API key fallback (from **Settings → API keys**) | *(Optional)* |
| `WACRM_ENABLE_WRITES` | Enable write operations (`create_contact`, `send_message`, etc.) | `true` |
| `WACRM_ENABLE_BROADCASTS` | Enable mass template broadcasts | `true` |
| `MCP_OAUTH_PORT` | Port for the OAuth MCP HTTP server | `3001` |
| `MCP_SERVER_URL` | Public base URL of the MCP server | `http://localhost:3001` |

---

## 🤖 Hermes Agent Configuration

In your Hermes agent configuration (e.g. `hermes.json` or `config.json`):

```json
{
  "mcpServers": {
    "wacrm": {
      "url": "http://localhost:3001/sse",
      "transport": "sse",
      "oauth": {
        "authorizeUrl": "http://localhost:3001/oauth/authorize",
        "tokenUrl": "http://localhost:3001/oauth/token"
      }
    }
  }
}
```

---

## 🔑 Available MCP Tools

Once connected, Hermes can call the following tools:

### 📖 Read Tools
- `whoami`: Verify WACRM instance status & permissions.
- `list_contacts`: List contacts with search/filter options.
- `get_contact`: Retrieve contact details by ID.
- `list_conversations`: List inbox conversations.
- `get_conversation`: Retrieve conversation details & messages.
- `list_messages`: Search messages in a conversation.
- `get_broadcast_status`: Check status of broadcast campaigns.

### ✍️ Write Tools (Opt-in via `WACRM_ENABLE_WRITES=true`)
- `send_message`: Send a WhatsApp text message to a contact.
- `create_contact`: Create a new contact.
- `update_contact`: Modify contact details/tags.

### 📢 Broadcast Tools (Opt-in via `WACRM_ENABLE_BROADCASTS=true`)
- `send_template_broadcast`: Launch a mass WhatsApp template broadcast.

---

## 🛡️ OAuth Endpoints

- **Server Info & Landing Page:** `http://localhost:3001/`
- **OAuth Discovery Metadata:** `http://localhost:3001/.well-known/oauth-authorization-server`
- **Authorize Endpoint:** `http://localhost:3001/oauth/authorize`
- **Token Endpoint:** `http://localhost:3001/oauth/token`
- **MCP SSE Endpoint:** `http://localhost:3001/sse`
