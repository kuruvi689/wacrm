# WACRM architecture audit

Date: 2026-11-21
Branch: `feat/production-release-candidate`
Scope: read-only review of the repo as it stands, plus the live-data risks for existing clients.
No code was changed for this document. Gaps and planned fixes are in `docs/PRODUCTION_GAPS.md`.

Paths are relative to the repo root. `file:line` refers to the code at the time of this audit.
Items marked **unverified** were not confirmed in code.

---

## Summary

- WACRM is a multi-user WhatsApp CRM on Next.js 16 (App Router), React 19, and Supabase (Postgres, Auth, RLS).
- It runs on Vercel serverless functions. There is no queue, no cache service, and no scheduled jobs.
- Tenancy is shared-database. Every tenant table has `account_id` and RLS.
- Inbound WhatsApp messages are processed inside `after()` after a fast 200 response. Processing is sequential and has no deduplication.
- The AI agent is one row per account. It replies automatically to inbound messages when several gates pass.
- Billing does not exist in committed code. Migration `040_billing_subscriptions_usage.sql` and `src/lib/billing/` are in the working tree, uncommitted.
- The most urgent findings are:
  1. Viewers can send WhatsApp messages (role check missing on send routes).
  2. Suspension and trial status are enforced only in the app. RLS and background engines ignore them.
  3. Meta retries cause duplicate messages, flows, automations, and AI replies.
  4. The in-memory rate limiter does nothing on Vercel.
  5. The cron routes are never scheduled, and their auth header does not match Vercel Cron.
  6. The Supabase free plan pauses after about 7 idle days. Live prod has real signups.
- The open architectural decision is shared-database versus database-per-tenant. This is a founder decision (see the last section).

---

## Stack and hosting

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16.2.12, App Router | `AGENTS.md` warns that APIs differ from older Next.js. Read `node_modules/next/dist/docs/` first. |
| UI | React 19.2.4, global styles in `src/app/globals.css` | |
| Auth and DB | Supabase: Postgres, RLS, Auth, Storage | `@supabase/ssr` 0.12 for cookie sessions. |
| Hosting | Vercel project `wacrm`, deployed from CLI | Prod alias `wacrm-wheat.vercel.app`. No `vercel.json` or `vercel.ts`. |
| Database | Supabase project `igqiwhfukbvoxduqycnf`, region ap-northeast-1, free plan | Live prod. Has real signups. |
| WhatsApp | Meta WhatsApp Cloud API, Graph v21.0 | Embedded Signup. Config ID 1331836852241410. |
| AI | OpenAI or Anthropic, called with raw `fetch` | No SDK. Providers in `src/lib/ai/providers/`. |
| Queue, cache, Redis | None | Not used. |
| Error monitoring | None | Not used. |
| CI | GitHub Actions, `.github/workflows/ci.yml` | Runs lint, typecheck, test, build on PRs to and pushes to `main`. |
| Tests | Vitest (`npm test`). No Playwright, no e2e directory | |

Npm scripts: `dev`, `build`, `start`, `lint`, `typecheck` (`tsc --noEmit`), `format`, `format:check`, `test` (`vitest run`), `test:watch`.

---

## Tenancy model

- The tenant key is `account_id`, which references `accounts.id`.
- A user belongs to one account. Membership is stored in `profiles.account_id` plus `profiles.account_role` (`owner` > `admin` > `agent` > `viewer`). Migration 017.
- Multi-membership is not supported.
- `is_account_member(account_id, min_role)` is a `SECURITY DEFINER` function used by RLS policies on tenant tables.
- RLS is enabled on all 41 tables. Tenant tables check `is_account_member`. Notifications check `auth.uid() = user_id`.
- Account lifecycle columns were added in migration 037: `plan` (free text label), `status` (`trialing`, `active`, `suspended`), `trial_ends_at`, `max_members`, `max_contacts`, `suspended_reason`, `onboarding_completed_at`.
- Triggers from 037:
  - `apply_platform_defaults`
  - `enforce_contact_limit`
  - `enforce_member_limit` (uses an advisory lock)
  - `protect_account_plan_columns`
- `complete_onboarding()` and `admin_account_overview()` (service-role only) also come from 037.
- RLS does not read `accounts.status`. Suspension is checked only in application code, through `src/lib/saas/access.ts` (`evaluateAccess`), and not on every path (see TEN-02).
- Gap: `protect_account_plan_columns` does not protect `owner_user_id`. Admins can change it (see TEN-01).

---

## Data model (key tables by area)

Source: `CREATE TABLE` statements in `supabase/migrations/001` to `039` (committed), and `040` (uncommitted).

| Area | Tables | Notes |
|---|---|---|
| Accounts and members | `accounts`, `profiles`, `account_invitations`, `platform_settings`, `member_presence` | 037 added lifecycle columns. Invitations are redeemed by RPC (019, 020). |
| Contacts and CRM | `contacts`, `contact_tags`, `tags`, `contact_notes`, `contact_custom_values`, `custom_fields`, `deals`, `pipelines`, `pipeline_stages` | Phone dedup in 022. Contact cap enforced by trigger (037). |
| Conversations and messages | `conversations`, `messages`, `message_reactions`, `message_templates`, `quick_replies` | `messages.message_id` (wamid) is indexed but not unique (001:178, 009). |
| Broadcasts | `broadcasts`, `broadcast_recipients` | Recipient status has a transition guard. Message status does not. |
| WhatsApp config | `whatsapp_config` | `phone_number_id` is unique (013). Tokens are encrypted. |
| Automations | `automations`, `automation_steps`, `automation_logs`, `automation_pending_executions` | Pending executions are drained by a cron that is not scheduled (006:111). |
| Flows | `flows`, `flow_nodes`, `flow_runs`, `flow_run_events` | Flow media in 016. |
| AI | `ai_configs`, `ai_usage_log`, `ai_knowledge_documents`, `ai_knowledge_chunks` | One config per account (029:45). Usage has tokens only, no cost (033:58). |
| Integrations | `api_keys`, `webhook_endpoints` | API keys stored as SHA-256 hash. Webhook secret stored (see Secrets). |
| Catalog and orders | `products`, `orders`, `order_items` | Migration 039. Not applied to prod. Modified and uncommitted in the working tree. |
| Notifications | `notifications` | |
| Billing (uncommitted) | `plans`, `subscriptions`, `subscription_events`, `invoices`, `payment_attempts`, `billing_ledger`, `payment_provider_events`, `billing_audit_log` | Migration 040 only. Untracked. Not applied. Not in committed code. |

Committed migrations are `001_initial_schema.sql` through `039_products_orders.sql`. Migration 040 is untracked.

---

## Request and auth model

### Dashboard session

- Users sign in with Supabase Auth (email, and Google on login and signup).
- The session is a Supabase cookie read by `@supabase/ssr`.
- Route handlers under `src/app/api/` check the session, then call `requireRole('agent' | 'admin')` (`src/lib/auth/account.ts`) before any privileged work.
- Gap: several `/api/whatsapp/*` routes check login and suspension but not role (see SEC-01).

### Service role

- `supabaseAdmin()` uses `SUPABASE_SERVICE_ROLE_KEY` and bypasses RLS.
- It is defined in `src/lib/flows/admin-client.ts` and copied into `src/lib/automations/`, `src/lib/ai/`, and inline in `src/app/api/whatsapp/config/route.ts:38`.
- Routes that use it must check the role first.

### Public API (`/api/v1`)

- Bearer tokens with prefix `wacrm_live_`. Only the SHA-256 hash is stored.
- Each key has scopes and a per-key rate limit (in-memory, see Rate limits).
- Suspended accounts are blocked by a gate.
- Webhook deliveries are signed with `X-Wacrm-Signature` (`src/lib/webhooks/sign.ts`).

### MCP

- An MCP server is exposed over SSE. Scopes are checked per tool.
- Gap: MCP session IDs come from `Math.random` and are stored in a global map. A caller can push messages into another session. This predates the current work.

### Platform admin

- Platform admins are set by `PLATFORM_ADMIN_USER_IDS` or `PLATFORM_ADMIN_EMAILS`.
- Admin pages are under `src/app/admin/`.
- Gap: email-based admin check is unsafe if email confirmation is off (SEC-12).

### Cron

- `/api/automations/cron` and `/api/flows/cron` check the `x-cron-secret` header against `AUTOMATION_CRON_SECRET` (`automations/cron/route.ts:19-23`).
- Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. The two do not match (see OPS-02).

### CSRF and headers

- No `Origin` check on state-changing routes. Cookies are `SameSite=Lax`.
- CSP is report-only.
- HSTS and `X-Frame-Options: DENY` are set.

### Input validation

- No schema library (no zod). Validation is written by hand per route.

---

## Inbound WhatsApp message to agent response (trace)

Entry point: `src/app/api/whatsapp/webhook/route.ts`.

1. Meta sends `POST /api/whatsapp/webhook`. The handler reads the raw body with `request.text()`.
2. Signature check. `verifyMetaWebhookSignature` (`src/lib/whatsapp/webhook-signature.ts:21`) computes HMAC-SHA256 with `META_APP_SECRET`, compares with `timingSafeEqual`, and returns 401 on failure. It fails closed.
3. The handler returns 200 at once. All work goes into `after(() => processWebhook(body))` (`route.ts:227`). `maxDuration = 60` (`route.ts:22`). There is no queue.
4. Tenant resolution (`route.ts:275-305`). The handler looks up `whatsapp_config` by `phone_number_id` (unique, migration 013) and takes `account_id` from that row.
5. `processMessage` (`route.ts:580`) runs steps 6 to 17 in order. Each step awaits the previous one.
6. `findOrCreateContact` (`route.ts:1012`).
7. `findOrCreateConversation` (`route.ts:1072`).
8. Emits the `conversation.created` webhook when a conversation is new.
9. Handles reactions (`message_reactions`).
10. `parseMessageContent` (`route.ts:857`). Media is fetched through the app's media proxy.
11. Inserts into `messages` (`route.ts:689`). No check for an existing `wamid`. A Meta retry inserts a second row.
12. Updates the conversation. `unread_count` is a read-modify-write.
13. `flagBroadcastReplyIfAny` marks a reply to a broadcast.
14. `dispatchInboundToFlows` (`src/lib/flows/engine.ts`). If a flow consumes the message, steps 15 and 16 still run, but AI does not (see step 16).
15. `runAutomationsForTrigger` (`src/lib/automations/engine.ts`).
16. `dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts:42`). Runs only if no flow consumed the message. Gates are listed in the AI section.
17. Emits the `message.received` webhook through `src/lib/webhooks/deliver.ts`. One attempt. No retry.

Status callbacks (`sent`, `delivered`, `read`, `failed`) follow a separate path: `handleStatusUpdate` (`route.ts:372`). It updates `messages.status` without a forward-only guard. Meta `errors[]` on failed statuses is not stored.

Failure handling for the whole path: errors are logged with `console.error` and the message is dropped. There is no dead-letter store.

---

## Outbound sending

Core client: `src/lib/whatsapp/meta-api.ts`.

| Function | Line | Purpose |
|---|---|---|
| `throwMetaError` | :30 | Keeps only the Meta error message. Error codes such as 131047 and 130429 are lost. |
| `sendTextMessage` | :268 | Text. |
| `sendMediaMessage` | :326 | Image, video, audio, document. |
| `sendTemplateMessage` | :412 | Template. |
| Interactive sends | :802, :910 | Buttons and lists. |

Behavior:

- Each send is a single `fetch`. No backoff. No handling of HTTP 429. No fetch timeout.
- The only retry is a phone-number format variant.
- Other send paths wrap this client:
  - `src/lib/flows/meta-send.ts:65` (`engineSendText`)
  - `src/lib/automations/meta-send.ts`
  - `src/lib/whatsapp/send-message.ts:398`
- In `send-message.ts`, the Meta call (about line 390) happens before the RLS-gated insert into `messages` (about line 452). If the insert fails, the message is already sent.
- The 24-hour customer service window is checked only in the UI (`message-composer.tsx:192`, `message-thread.tsx:229`). The server does not check it. `auto-reply.ts:38` assumes the window is open.
- No opt-out handling. No STOP keyword handling. No consent column.

Broadcasts:

- Dashboard route `src/app/api/whatsapp/broadcast/route.ts:186` runs an inline loop.
- v1 route `src/app/api/v1/broadcasts/route.ts:80` calls `after(deliverBroadcast)`, implemented in `src/lib/whatsapp/broadcast-core.ts:253`.
- Scheduled broadcasts have no dispatcher. Nothing picks them up at their scheduled time (see WA-08).

---

## AI agent module today

One agent per account. Table `ai_configs`, unique on `account_id` (029:45).

Fields: provider (`openai` or `anthropic`), model name, `api_key` (AES-GCM encrypted), `system_prompt`, `is_active`, `auto_reply_enabled`, `auto_reply_max_per_conversation` (1 to 20, default 3), `handoff_agent_id`, `embeddings_api_key`.

- No versioning. No multiple agents per account. No tool calling.
- Page: `src/app/(dashboard)/agents/page.tsx`. Tabs:
  - Playground: `components/agents/ai-playground`
  - Setup: `components/settings/ai-config`
  - Usage (admin): `components/agents/ai-usage`
- Providers: raw `fetch` in `src/lib/ai/providers/openai.ts` and `anthropic.ts`.
- Defaults in `src/lib/ai/defaults.ts`: `MAX_OUTPUT_TOKENS` 1024, 30 s timeout, 20-message context.
- No retries.

Auto-reply gates (`src/lib/ai/auto-reply.ts`, `dispatchInboundToAiReply`):

1. Silent if `is_active` is false.
2. Silent if any active `new_message_received` or `keyword_match` automation exists (`:61-68`). The agent yields to automations.
3. Silent if a human is assigned to the conversation.
4. Silent if `ai_autoreply_disabled` is set on the conversation.
5. Silent when the per-conversation cap is reached. The cap is claimed atomically by RPC `claim_ai_reply_slot` (029:118).
6. In-memory rate limit (`:90`). Ineffective on Vercel.
7. Sends through `engineSendText` with `aiGenerated: true`.
8. Usage is logged with `logAiUsage` (`src/lib/ai/usage.ts:29`). It is a fire-and-forget promise inside `after()` (`auto-reply.ts:126`).

Gates 1 to 5 do not check account `status` (trial or suspension). An auto-reply can run for a suspended account.

Handoff:

- The system prompt tells the model to reply with `[[HANDOFF]]` (`HANDOFF_SENTINEL`, `defaults.ts:23`) when it cannot help.
- `parseGeneration` (`src/lib/ai/generate.ts:61`) detects the sentinel. The handler sets `ai_autoreply_disabled`, writes `ai_handoff_summary` (`src/lib/ai/handoff.ts`), and assigns `handoff_agent_id`.
- Provider errors and timeouts are logged only (`auto-reply.ts`, around line 190). No reply is sent and no handoff happens. The customer gets silence.

Takeover and resume: `src/app/api/ai/autoreply/[conversationId]/route.ts`.

Playground: `src/app/api/ai/playground/route.ts`. Stateless. `requireActive: false`. Not metered.

---

## Knowledge base

Migration 030.

- Tables: `ai_knowledge_documents`, `ai_knowledge_chunks`.
- Chunks have a `tsvector` column (configuration `simple`, GIN index) and a `vector(1536)` column (HNSW index).
- Embedding model: `text-embedding-3-small` (OpenAI).
- Retrieval: `retrieveKnowledge` (`src/lib/ai/knowledge.ts:84`).
  - Semantic search first, through RPC `match_ai_knowledge_semantic`.
  - Full-text search fills the remaining slots.
  - `k = 5`.
- Ingest is synchronous inside the `api/ai/knowledge*` routes. Large documents depend on the function time limit (**unverified** for specific sizes).
- No reranker. No chunk-level permissions beyond account RLS.

---

## Background jobs

| Job | Trigger | Status |
|---|---|---|
| Webhook processing | `after()` in `api/whatsapp/webhook` | Runs. Bounded by `maxDuration` 60 s. No retry. |
| v1 broadcast delivery | `after(deliverBroadcast)` in `api/v1/broadcasts` | Runs. Same limit. |
| Dashboard broadcast | Inline loop in `api/whatsapp/broadcast` | Runs in the request. |
| Scheduled broadcast | None | No dispatcher. Not working. |
| Automations drain | `GET /api/automations/cron`, 50 per run | Claims `pending` rows and sets them to `running`. Not scheduled. No reaper for rows stuck in `running`. |
| Flow timeout | `/api/flows/cron` | Marks stale `flow_runs` as timed out. Not scheduled. |
| AI knowledge ingest | Synchronous in request | Runs. |

No `vercel.json` or `vercel.ts` exists, so no cron is configured on Vercel.

---

## Rate limiting and quotas today

Rate limiting:

- `src/lib/rate-limit.ts` uses an in-memory `Map`. On Vercel each function instance has its own memory, so limits do not hold across instances or cold starts.
- Used in: message send, reactions, broadcast, invitations, account and admin routes, `api-context.ts:100` (API keys), `api/ai/*`, and `auto-reply.ts:90`.
- The invitation peek route (`src/app/api/invitations/[token]/peek/route.ts`) keys its limit on the leftmost `x-forwarded-for` value, which the client can set.

Quotas:

- Only two limits exist: `accounts.max_members` and `accounts.max_contacts`, enforced by triggers (037).
- No message quota. No AI request quota. No spend cap.
- `plan_limit` (P0001) errors raised by the triggers are not mapped in the app. They surface as HTTP 500.
- Contact cap hit during inbound processing: the message is dropped silently.
- Webhook and automation engines never call `evaluateAccess`. Suspended or expired accounts keep auto-replying.

Usage metering:

- `ai_usage_log` stores tokens only, no cost (033:58).
- No message counts, no per-account monthly usage, no metering table for billing.

---

## Secrets and encryption

- Field encryption: AES-256-GCM with one key, `ENCRYPTION_KEY` (`src/lib/whatsapp/encryption.ts`).
- Legacy AES-CBC values still decrypt.
- No key version is stored with ciphertext. Rotating `ENCRYPTION_KEY` makes every stored token unreadable unless all rows are re-encrypted first.
- Encrypted or hashed fields:
  - `whatsapp_config.access_token`
  - `whatsapp_config.verify_token`
  - `ai_configs.api_key`
  - `webhook_endpoints.secret`
  - `api_keys.key_hash` (SHA-256, not reversible)
- Viewers can SELECT these columns under current RLS (see SEC-02).
- Webhook signing secret: each endpoint's secret signs outgoing deliveries.
- Prototype keys: a separate database-per-tenant prototype exists at `C:\Users\sindh\.gemini\antigravity\scratch\wacrm-multitenant` (local only). Its keys are in git history and must be rotated.

---

## Environment variables (names only)

Values are not recorded here. Do not paste values into docs, chats, or commits.

| Name | Used for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public). |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role client. Bypasses RLS. |
| `ENCRYPTION_KEY` | AES-256-GCM key for stored secrets. |
| `META_APP_SECRET` | Webhook HMAC verification. |
| `META_APP_ID` | Meta app ID (server). |
| `NEXT_PUBLIC_META_APP_ID` | Meta app ID (client, Embedded Signup). |
| `NEXT_PUBLIC_META_CONFIG_ID` | Embedded Signup config ID. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Platform-level webhook verify token. |
| `WHATSAPP_TEMPLATES_DRY_RUN` | Template submit dry-run switch. |
| `AUTOMATION_CRON_SECRET` | Cron routes auth (`x-cron-secret`). |
| `PLATFORM_ADMIN_USER_IDS` | Platform admin allow-list by user ID. |
| `PLATFORM_ADMIN_EMAILS` | Platform admin allow-list by email. |
| `NEXT_PUBLIC_SITE_URL` | Public site URL. |
| `NEXT_PUBLIC_APP_LOCALE` | UI locale. |
| `ALLOWED_INVITE_HOSTS` | Allowed hosts for invitation links. |
| `AI_REQUEST_TIMEOUT_MS` | AI provider timeout. |
| `AI_CONTEXT_MESSAGE_LIMIT` | Messages sent as AI context. |

Not present: any error-monitoring DSN, any billing provider key, any staging-environment variable set.

---

## Existing tests baseline

Source: the audit run on 2026-11-21. These checks were not re-run for this document.

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean |
| `vitest run` | 75 files, 727 tests, all pass |
| `eslint` on `src` | 0 errors, 41 warnings |
| `eslint` on untracked `brag-output/work/capture.js` | 2 errors (outside `src`, not committed) |
| Playwright or e2e tests | None. No dependency, no directory. |
| RLS policy tests | None found (unverified beyond a text search). |
| Coverage report | Not in the baseline (**unverified**). |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, and build on PRs to `main` and on pushes to `main`. It uses placeholder env values.

---

## Branches and deployment state

Branch history, oldest first:

1. `main`
2. `feat/saas-tenancy-and-security-fixes`. Live prod is at commit `9096d17` (`feat(brand): Teddy³ theme, logo and name`).
3. `feat/products-and-orders`. Commit `93457b2` (`feat(catalog): products, orders and server-side pricing`). Migration 039 not applied to prod.
4. `feat/production-release-candidate`. Current branch. This audit.

Recent commits on the current branch (newest first): `93457b2`, `9096d17`, `03f1a0e` (auth open-redirect fix), `a8731d7` (Google sign-in), `53e162d` (Embedded Signup).

Working tree at the time of audit (not committed):

- Modified: `supabase/migrations/039_products_orders.sql` (uncommitted hardening)
- Untracked: `supabase/migrations/040_billing_subscriptions_usage.sql`
- Untracked: `src/lib/billing/` (`billing.test.ts`, `invoice-amount.ts`, `subscription-state.ts`, `upi.ts`, `verification.ts`)
- Untracked: `.claude/`, `brag-output/`, `sendiee-teardown.md` (not product code)

Deployment: Vercel project `wacrm`, deployed from the CLI. No deploy pipeline from git is configured in the repo.

---

## Data-migration risks for existing clients

Live prod (`igqiwhfukbvoxduqycnf`) has real signups. Treat every migration as a change to live data.

1. **Migration 039 is not on prod.** It is modified and uncommitted. Commit and review it before applying. Check the prod migration list first.
2. **Migration 040 is untracked and not on prod.** Review it for any change to existing tables (for example `accounts`) before applying. Check that the `billing_*` tables do not write to tenant data.
3. **Prod schema state is assumed, not confirmed.** The branch history says prod is at `9096d17`. Confirm the applied migration list (through 038) on prod before any change. **Unverified.**
4. **No backup or restore test is documented.** Take an export before any migration. Confirm what the current Supabase plan includes for backups (**unverified**).
5. **The free plan pauses after about 7 days without activity.** A paused project is an outage. Restoring it is manual. Move prod to a plan that does not pause before more clients rely on it, or keep it active on a schedule.
6. **Redeem-invitation cascade risk.** The "empty account" check in `redeem_invitation` (migration 019) does not look at `products`, `orders`, `api_keys`, `webhook_endpoints`, `ai_configs`, `quick_replies`, or `ai_knowledge`. An account that holds only those rows can be treated as empty and deleted. Fix before new members are invited to existing accounts.
7. **Owner can be reassigned by an admin.** `accounts.owner_user_id` is not protected by `protect_account_plan_columns`. Migration fix is needed before more clients are onboarded.
8. **Meta retries will duplicate messages on live accounts.** Without wamid dedup, a delivery retry runs flows, automations, and AI replies again. Fix before enabling any new automation for existing clients.
9. **Stuck automation rows.** Rows in `automation_pending_executions` may be waiting in `pending` because the cron is not scheduled. Count them before enabling the cron. Check for rows left in `running` (no reaper).
10. **Encryption key changes.** Do not rotate `ENCRYPTION_KEY` until all rows are re-encrypted. Legacy CBC rows exist; their count is **unverified**.
11. **Account recovery is broken.** `forgot-password` exists. There is no `/reset-password` page. Supabase default SMTP only delivers to team members. An existing client who forgets a password cannot recover the account.
12. **Suspended accounts keep running automation.** Suspension is not enforced in RLS or in webhook and AI paths. A client suspended for non-payment still receives auto-replies.
13. **Prototype keys in git history.** The local database-per-tenant prototype has keys in its git history. Rotate them, even though the repo is local.

Founder decision required (blocks the migration path):

- Shared database (current app) versus database per tenant (the long-term plan in the prototype).
- Waiting clients are on the shared-database app.
- If shared database stays: RLS must enforce suspension, role checks must be added to send routes, and the owner-change path must be closed before more clients join.
- If database per tenant: existing shared-database clients need a data-move plan, with rehearsal on a copy first.
- The decision should be recorded as an ADR in `docs/` before further tenancy work.

---

## Unverified items and open questions

- Exact Supabase backup coverage on the current plan.
- Whether prod has migrations 001 to 038 applied exactly as committed.
- Count of legacy CBC-encrypted rows.
- Count of rows in `automation_pending_executions` by status.
- Whether any code moves `accounts.status` from `trialing` to `suspended` at `trial_ends_at`. A search found `trial_ends_at` used in `src/lib/saas/access.ts` and `src/lib/billing/subscription-state.ts` (untracked), but no transition job was confirmed.
- Whether `src/lib/billing/upi.ts` (untracked) contains logic derived from the YouPI-PG project. Review it against the licensing finding before committing (see PRODUCTION_GAPS.md, BIL-04).
- Vercel function duration limits on the Pro or Hobby plan in use.
