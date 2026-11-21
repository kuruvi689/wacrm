# AI agent configuration

How AI agents work in the CRM and how an admin sets one up. Everything here is on the **AI Agents** page (sidebar), tabs Agents, Playground, Setup, Usage.

## Who can do what

Admins and owners manage agents. Agents (staff) and viewers do not see the Agents tab, and the agent APIs return 403 for them.

## Setup tab: provider, key, kill switch

- Pick OpenAI or Anthropic and save your own API key. The key is encrypted at rest and never shown again.
- **Enable AI assistant** turns on "Draft with AI" in the inbox.
- **Auto-reply** is the account-wide kill switch. When it is off, nobody replies automatically, whichever agent is active. Activating an agent turns it on; pausing an agent leaves it as it was.
- An agent's provider must match the saved key's provider. Otherwise save/activate returns "different provider" (422 `provider_key_mismatch`) and live auto-replies are blocked and logged.

## Agents and versions

An **agent** is a named configuration (name, role, description). Its behaviour lives in immutable **versions**:

- provider and model, creativity (temperature 0-2), max reply tokens (64-4096), messages of context (1-50)
- instructions, business facts, hard rules
- allowed tools, optional n8n webhook address
- "hand off when the AI is unavailable" (default on)
- an optional change note

Editing an agent that changes any of these saves a **new version** and makes it current. Old versions are never changed. Name, role and description edits do not create a version.

**Make current** on an older version moves the agent back to it (rollback). It does not delete the newer versions, and it is recorded in the History list.

The number of agents is limited by the plan (`max_ai_agents`). The New agent button is disabled at the limit.

## Statuses

| Status | Meaning |
| --- | --- |
| Draft | Created, never activated. Does not reply to customers. |
| Testing | Reserved; the UI shows it but nothing sets it today. |
| Active | The one agent answering inbound customers. Only one agent per account can be active. |
| Paused | Not answering. Activating another agent pauses the previous one automatically. |

Activate needs a saved AI key (otherwise 409 `ai_not_configured`).

## Tools and permissions

The agent can only use tools ticked in its current version. Anything else is refused even if the model asks.

| Tool | What it does |
| --- | --- |
| Search knowledge base | Reads your uploaded knowledge. |
| Look up the contact | Reads the current contact's name, tags and fields. |
| Update the contact | Adds existing tags or fills existing custom fields. Never creates new tags or fields. |
| Hand off to a human | Passes the chat to your team with a short summary. |
| Call your n8n webhook | POSTs to an https address you control, signed with `X-Wacrm-Signature` (HMAC). All agents in the workspace share one signing secret. The page shows the secret once when it is created or replaced. Update the affected n8n workflows after replacing it. |

Tools never take a contact, conversation or account id from the model; the server binds them. A model gets at most 3 tool rounds per reply, then must answer in text. Every call is logged without argument values.

## Handoff

The agent hands a chat to a human when it says it cannot help, when it uses the hand-off tool, and (if enabled) when the AI provider fails or times out. Handoffs go to the team member chosen in Setup. They appear as "Handed to a human" in the stats.

## Metering and plan limits

Each automatic reply reserves 1 AI response and an estimate of tokens against the plan before the provider is called.

- Quota exhausted: no provider call, the chat is deferred, the account is notified, and the log row is **Blocked**.
- Duplicate inbound message: skipped, never charged twice.
- Provider error/timeout: the reservation is released and the failure is logged.
- Success: the real usage is committed once the WhatsApp send is accepted.

Drafts, Playground and Simulation are not metered against the plan quota.

## Last 30 days stats (per agent)

From the usage log for that agent: replies accepted for sending, tokens, **estimated** cost, failures (errors and timeouts), handoffs, blocked. Check the inbox for delivery status. Cost uses a built-in per-model price table; unknown models show as unpriced (the total then ends with "+" or reads Unknown). It is an estimate, not a bill. Simulations are excluded. Only the latest 5000 calls are read.

## Simulation

The Simulate tab runs the agent's current version on a fake conversation. The simulation runs contact lookups and knowledge searches. It previews contact updates and webhook calls. It sends no WhatsApp messages. Each run uses tokens from the workspace AI provider key and is exempt from the plan quota. Use it after every new version before activating.

## What is not done

- Draft, Playground and Simulation do not count against plan quota.
- No tool-call history screen (tool calls are logged in the database, admin-readable, but not shown in the UI).
- No side-by-side version diff; versions list their model, tools and change note only.
- Staff roles below admin get no read-only view of agents (the API is admin-only).
- "Testing" status is not set by any flow yet.
- Deferred replies after a quota block are recorded but nothing replays them yet.
- Agent stats are read in the browser (up to 5000 rows) rather than aggregated on the server.
- The n8n DNS check can in theory be raced between validation and the call.
