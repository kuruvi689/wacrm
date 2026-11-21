# WACRM production gaps

Date: 2026-11-21
Branch: `feat/production-release-candidate`
Companion to `docs/ARCHITECTURE_AUDIT.md`, which holds the trace, the data model, and the live-data risks.

Originally a read-only audit; the Status column was added when the release candidate was assembled.

## How to read this

- **ID**: area prefix and number. Used in commit messages and issues.
- **Evidence**: `file:line` where known. Where the exact line was not pinned, the file or migration is named and the cell says so.
- **Severity**:
  - Items 1 to 15 in the audit's ranked risk list carry the audit's rank. Their severity is the audit's.
  - All other severities are proposed by this document.
  - No item is rated Critical. None of the findings is a confirmed cross-tenant data exposure.
  - Severity meanings: High = fix before more paying clients rely on the feature. Medium = fix before launch. Low = fix when touched.
- **Planned fix**: one line.
- **Status** (updated for the release candidate): `Fixed in RC (verify on staging)` = implemented and covered by local tests on this branch, not yet proven on an isolated staging app. `Partial` = some of the fix exists. `Open` = not addressed. `Decided` = founder decision recorded. Local test evidence is in `docs/PRODUCTION_READINESS.md`.

Coverage check against the audit's 15 ranked risks and the listed extra gaps is at the end.

---

## Security

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| SEC-01 | Viewers can send WhatsApp messages. Send, broadcast, react, and template routes check login and suspension, not role. Meta send runs before the RLS-gated insert. | `src/app/api/whatsapp/*` (send, broadcast, react, templates); `src/lib/whatsapp/send-message.ts` (Meta send about line 390, insert about line 452) | High | Require `agent` role on every send-type route and check the role inside `send-message.ts`. | Fixed in RC (verify on staging) |
| SEC-02 | Viewers can SELECT encrypted secrets and hashes: `whatsapp_config.access_token`, `ai_configs.api_key`, `webhook_endpoints.secret`, `api_keys.key_hash`. | RLS on those tables (table definitions in migrations 014, 026, 028, 029; policy file not pinned) | Medium | Revoke column SELECT on secret columns from `authenticated`, or move secrets to a table with no client read path. | Open |
| SEC-03 | One `ENCRYPTION_KEY` with no key version. Legacy AES-CBC still decrypts. Rotating the key breaks every stored token. | `src/lib/whatsapp/encryption.ts` | Medium | Prefix ciphertext with a key version, add a re-encrypt script, keep the old key readable until done. | Open |
| SEC-04 | Chat-media and flow-media buckets are public. Upload content type is set by the client. | `src/lib/storage/upload-media.ts`; migrations 016, 023 | Medium | Make buckets private with signed URLs and check file type from its bytes. | Open |
| SEC-05 | SSRF guard gaps: DNS rebinding (resolved twice), and unblocked ranges 198.18/15, 224/4, 240/4, 255.255.255.255, 64:ff9b::/96, 2002::/16, hex IPv4-mapped forms. | `src/lib/webhooks/ssrf.ts` | Medium | Resolve once and connect to that IP, add the missing ranges, and test each range. | Fixed in RC (verify on staging) |
| SEC-06 | No schema validation. No zod. The WhatsApp config POST passes the raw body on. | `src/app/api/whatsapp/config/route.ts` (POST) | Medium | Add a schema per route boundary, starting with config and send routes. | Open |
| SEC-07 | No `Origin` check on state-changing routes. Relies on `SameSite=Lax`. | Route handlers under `src/app/api/` | Low | Reject cross-origin `Origin` on POST, PATCH, and DELETE. | Open |
| SEC-08 | CSP is report-only. | CSP header config (file not pinned in audit) | Low | Enforce CSP with nonces after one review cycle of reports. | Open |
| SEC-09 | `SECURITY DEFINER` functions may still be callable by `anon`. The 038 revoke was from `PUBLIC` only. | Migration 038; other `SECURITY DEFINER` functions (list not pinned) | Low | Revoke EXECUTE from `anon` and `authenticated` where not needed, and add a grants test. | Open |
| SEC-10 | WhatsApp verify GET decrypts every stored verify token and compares with `===`. Not constant time. Cost grows with the number of accounts. | `src/app/api/whatsapp/webhook/route.ts:145` | Low | Store a keyed hash of each verify token and compare with `timingSafeEqual`. | Open |
| SEC-11 | MCP session IDs come from `Math.random`. A global session map lets any caller push messages into another session. Predates this work. | MCP route under `src/app/api/mcp/` (file not pinned) | Medium | Use `crypto.randomUUID()` and bind each session to the auth context that created it. | Open |
| SEC-12 | Platform admin by email is unsafe if email confirmation is off. | Platform admin check, using `PLATFORM_ADMIN_EMAILS` (file not pinned) | Low | Allow admin by user ID only, or require a confirmed email before the check. | Open |
| SEC-13 | Keys for the database-per-tenant prototype are in its git history. | `C:\Users\sindh\.gemini\antigravity\scratch\wacrm-multitenant` (local git history) | High | Rotate every key found in history, then rewrite or recreate that repo without them. | Open |

---

## Tenancy

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| TEN-01 | An admin can change `accounts.owner_user_id`. The column is not in the protected-columns trigger. The value is trusted by `redeem_invitation` and by the v1 contacts code. | Migration 037 (`protect_account_plan_columns`); migration 019 (`redeem_invitation`); `src/lib/api/v1/contacts.ts:87` | High | Add `owner_user_id` to the protected-column trigger; only the current owner or platform admin may change it. | Fixed in RC (verify on staging) |
| TEN-02 | Suspension and trial status are enforced only in app code. RLS ignores `accounts.status`. The webhook, AI, automation, flow, and webhook-delivery paths never call `evaluateAccess`. | Migration 037; `src/lib/saas/access.ts`; `src/app/api/whatsapp/webhook/route.ts`; `src/lib/ai/auto-reply.ts` | High | Add a status check to the tenant RLS helper and call `evaluateAccess` at webhook entry and in each engine. | Open |
| TEN-03 | The "empty account" check in `redeem_invitation` does not look at `products`, `orders`, `api_keys`, `webhook_endpoints`, `ai_configs`, `quick_replies`, or `ai_knowledge`. A join can cascade-delete those rows. (Audit rank: LOW-MED.) | Migration 019 (`redeem_invitation`) | Medium | Check every tenant table in the emptiness test, or refuse to join a non-empty account. | Fixed in RC (verify on staging) |
| TEN-04 | Automations are scoped by `user_id`, not `account_id`. The automations GET skips the suspension gate. | `src/lib/automations/`; `src/app/api/automations/route.ts` (GET) | Low | Scope by `account_id`, and add the role and suspension checks to GET. | Partial (see runbook/readiness) |
| TEN-05 | Shared database today. Database per tenant is the stated long-term plan. No decision is recorded. Founder decision. | Architecture audit, "Data-migration risks" | High | Founder decides; record an ADR in `docs/`; then pick the hardening path or the migration path. | Open |
| TEN-06 | Platform admin reads all accounts through `admin_account_overview()`. No audit log of those reads. | Migration 037 (`admin_account_overview`) | Low | Write each admin read to an `admin_access_log` table. | Open |
| TEN-07 | Any account member can read every conversation and message in the account. No assignment-based rule. Product rule not decided. | RLS on `conversations` and `messages` (policy file not pinned) | Low | Decide the visibility rule with the founder, then add assignment-based RLS if needed. | Open |

---

## WhatsApp reliability

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| WA-01 | No dedup on WhatsApp message ID (`wamid`). A Meta retry inserts a second row and runs flows, automations, and AI replies again. | `messages.message_id` indexed but not unique (001:178, 009); insert in `src/app/api/whatsapp/webhook/route.ts:689`; `processMessage` at `route.ts:580` | High | Add a unique key on (`account_id`, `message_id`) and skip all processing on conflict. | Fixed in RC (verify on staging) |
| WA-02 | `messages.status` can move backward. The broadcast recipient status has a transition guard; the message status does not. | `handleStatusUpdate` at `route.ts:372`; `isValidStatusTransition` at `route.ts:358` (broadcast path) | Medium | Apply the same forward-only guard to `messages.status`. | Fixed in RC (verify on staging) |
| WA-03 | Meta `errors[]` on failed status callbacks is not stored. | `route.ts:372` | Medium | Store error code and title on the message row and show them in the thread. | Fixed in RC (verify on staging) |
| WA-04 | Outbound: one fetch per send, no backoff, no HTTP 429 handling, no timeout. `throwMetaError` keeps only the message, so codes 131047 and 130429 are lost. | `src/lib/whatsapp/meta-api.ts:30` (`throwMetaError`), `:268`, `:326`, `:412`, `:802`, `:910` | High | Keep the Meta code in the thrown error, add a timeout, and retry 429 and 5xx with backoff. | Fixed in RC (verify on staging) |
| WA-05 | Failed inbound processing is logged and dropped. No dead-letter store. | `processWebhook` via `after()` at `route.ts:227` | High | Write the raw payload to a `webhook_inbox` table before processing and retry from that table. | Partial (see runbook/readiness) |
| WA-06 | Send happens before the message row is saved. If the insert fails after send, the message reached the customer but is not recorded. | `src/lib/whatsapp/send-message.ts` (send about line 390, insert about line 452) | High | Insert as `pending`, send, then update with the `wamid`; reconcile on mismatch. | Open |
| WA-07 | The 24-hour customer service window is checked only in the UI. The server does not check it. Auto-reply assumes the window is open. | `message-composer.tsx:192`; `message-thread.tsx:229`; `src/lib/ai/auto-reply.ts:38` | High | Check the window in the server send path and return a typed error when closed. | Fixed in RC (verify on staging) |
| WA-08 | No opt-out handling. No STOP keyword handling. No consent field on contacts. | No code; `contacts` table has no consent column | High | Add consent fields, handle STOP and unsubscribe keywords, and block sends to opted-out contacts. | Fixed in RC (verify on staging) |
| WA-09 | Scheduled broadcasts have no dispatcher. Nothing sends a broadcast at its scheduled time. | `src/app/api/whatsapp/broadcast/route.ts`; `src/lib/whatsapp/broadcast-core.ts:253` | High | Add a scheduled dispatcher (cron or queue) that picks up due broadcasts. | Open |
| WA-10 | Dashboard broadcast runs an inline loop inside the request. Large recipient lists can exceed the function duration. | `src/app/api/whatsapp/broadcast/route.ts:186` | Medium | Move the loop to a batch worker that resumes from recipient state. | Open |
| WA-11 | Webhook work runs one step after another inside `after()`, limited by `maxDuration` 60 s. A slow chain (flows, automations, AI) can time out with no retry. | `route.ts:22`, `route.ts:226-227` | Medium | Split processing into stages with persisted state (same work as WA-05). | Open |
| WA-12 | Outgoing message webhooks to customer endpoints: one attempt, no retry. | `src/lib/webhooks/deliver.ts` | Medium | Add retry with backoff and a delivery log per attempt. | Open |
| WA-13 | `unread_count` is read-modify-write. Concurrent messages can lose increments. (Proposed.) | Conversation update in `route.ts` (step 12 of the trace) | Low | Use an atomic increment RPC, as the existing `increment_*` RPCs do (migrations 005, 007, 012). | Open |

---

## AI agents

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| AI-01 | Provider error or timeout: no reply and no handoff. The customer gets silence. | `src/lib/ai/auto-reply.ts` (catch block about line 190) | Medium | On failure, send a fixed fallback message or trigger handoff, and record which one happened. | Fixed in RC (verify on staging) |
| AI-02 | One agent per account. No prompt or model version history. No rollback. | `ai_configs` unique on `account_id` (029:45) | Medium | Add a version table for prompt and model changes; defer multiple agents. | Fixed in RC (verify on staging) |
| AI-03 | Playground is stateless, unmetered, and works for inactive agents (`requireActive: false`). | `src/app/api/ai/playground/route.ts` | High | Require `agent` role and count playground calls against the AI quota (see RL-03). | Fixed in RC (verify on staging) |
| AI-04 | Usage log stores tokens only, no cost. The log write is fire-and-forget inside `after()`. | `src/lib/ai/usage.ts:29`; `src/lib/ai/auto-reply.ts:126`; migration 033 (`ai_usage_log`) | Medium | Store an estimated cost per model and await the write inside the handler. | Fixed in RC (verify on staging) |
| AI-05 | Auto-reply goes silent whenever any active `new_message_received` or `keyword_match` automation exists. The precedence is implicit. | `src/lib/ai/auto-reply.ts:61-68` | Low | Make the precedence an explicit setting and show it in the UI. | Open |
| AI-06 | Auto-reply and automations do not check account status. A suspended account keeps getting replies. | `src/lib/ai/auto-reply.ts` (gates 1 to 5) | High | Add an `evaluateAccess` gate to auto-reply (part of TEN-02). | Open |
| AI-07 | The model's output controls conversation state. The `[[HANDOFF]]` sentinel changes assignment and disables AI. Inbound customer text can try to make the model emit it. (Proposed.) | `src/lib/ai/generate.ts:61`; `src/lib/ai/defaults.ts:23` | Low | Act on the sentinel only when it is the whole output, and log every handoff. | Open |
| AI-08 | Knowledge ingest runs synchronously in the request. Large documents can exceed the function duration. | `api/ai/knowledge*` routes | Medium | Move ingest to a background job with a status field on the document. | Open |
| AI-09 | Provider calls have no retry. Timeout is 30 s and output is capped at 1024 tokens. | `src/lib/ai/defaults.ts`; `src/lib/ai/providers/openai.ts`, `anthropic.ts` | Low | Retry once on 429 and 5xx with backoff. Keep the limits configurable (`AI_REQUEST_TIMEOUT_MS` already exists). | Partial (see runbook/readiness) |
| AI-10 | No tool calling. The agent can only reply with text and cannot act on CRM data. Product gap. | `src/lib/ai/` | Low | Defer until billing and reliability work is done; then define a small tool set. | Fixed in RC (verify on staging) |
| AI-11 | Retrieval uses the `simple` text configuration, no reranker, and a fixed k of 5. No retrieval quality test. | `src/lib/ai/knowledge.ts:84` | Low | Build a fixed question set, measure retrieval, then tune k and add reranking if needed. | Open |

---

## Billing and payments

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| BIL-01 | No billing, subscription, or payment tables in committed migrations 001 to 039. No payment code in committed `src/`. | Migrations 001 to 039 | High | Commit migration 040 after review, then apply to staging and to prod (see BIL-02, OPS-12). | Fixed in RC (verify on staging) |
| BIL-02 | Migration 040 defines the billing tables (`plans`, `subscriptions`, `subscription_events`, `invoices`, `payment_attempts`, `billing_ledger`, `payment_provider_events`, `billing_audit_log`). It is untracked and not applied. | `supabase/migrations/040_billing_subscriptions_usage.sql` (untracked) | High | Review RLS on each table, confirm it writes nothing to tenant tables, then commit. | Fixed in RC (verify on staging) |
| BIL-03 | No payment provider. No payment SDK in `package.json`. The provider choice is not recorded. | `package.json` | High | Founder chooses a licensed payment provider, recorded as an ADR; then implement signed webhooks with idempotency. | Decided: manual UPI with operator bank verification |
| BIL-04 | The YouPI-PG project cannot be used. It has no license (all rights reserved). Issue #141 reports forged SMS and notifications marking orders paid. Its own docs say it is not settlement-authoritative. | YouPI-PG repo at `405327c`; `apps/payment-api/src/auth-guard.js` (any POST with `X-Device-Id` passes); `apps/sms-observer/src/browser-automator.js:360`; issue #141 | High | Do not copy code. Re-implement only the concepts (UPI intent, idempotent sessions, integer paise, signed outbox). Check `src/lib/billing/upi.ts` (untracked) for copied logic before commit. | Decided: YouPI-PG rejected |
| BIL-05 | No settlement rule for UPI payments. The operator must match UTR, amount, and date against the bank, or use a licensed provider. Not implemented. | No code; `billing_audit_log` in migration 040 is the only related table | High | Write the settlement rule; build a manual verification screen that writes to `billing_audit_log`. | Fixed in RC (verify on staging) |
| BIL-06 | No refund, dispute, or tax handling designed. (Proposed.) | No code | Medium | Define refund and tax rules with the founder and an accountant before paid launch. | Open |
| BIL-07 | Provider events table exists (migration 040) but no code enforces idempotency on provider event IDs. (Proposed.) | Migration 040 (`payment_provider_events`) | Medium | Add a unique constraint on the provider event ID and make each handler idempotent. | Fixed in RC (verify on staging) |

---

## Subscriptions

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| SUB-01 | Plan is a free-text label on `accounts.plan`. Nothing reads it to set limits. | Migration 037 (`accounts.plan TEXT`) | High | Replace with a foreign key to `plans` (migration 040) and read limits through it. | Fixed in RC (verify on staging) |
| SUB-02 | No plan entitlements. Only `max_members` and `max_contacts` exist, set per account. | Migration 037 (`apply_platform_defaults`, `enforce_contact_limit`, `enforce_member_limit`) | High | Define an entitlement table per plan and read limits from the plan, not from per-account columns. | Fixed in RC (verify on staging) |
| SUB-03 | Trial expiry has no transition job found. `trial_ends_at` is read but nothing sets the account to `suspended`. (Unverified: a full search was not run.) | `src/lib/saas/access.ts`; `src/lib/billing/subscription-state.ts` (untracked) | High | Compute status from dates inside `evaluateAccess` and enforce it in RLS (TEN-02). | Partial (see runbook/readiness) |
| SUB-04 | Upgrade, downgrade, cancel, and grace-period behavior is not defined. | No committed code. `src/lib/billing/subscription-state.ts` exists in the working tree (untracked); its contents were not reviewed for this document | High | Write the state machine in `subscription-state.ts` and test every transition. | Partial (see runbook/readiness) |
| SUB-05 | Platform admin cannot change a plan or extend a trial from the UI with an audit entry. (Proposed.) | `src/app/admin/`; migration 037 | Medium | Add an admin action that writes an audit row. | Fixed in RC (verify on staging) |

---

## Rate limits and metering

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| RL-01 | Rate limiter uses an in-memory `Map`. Each Vercel instance has its own memory, so limits do not hold. | `src/lib/rate-limit.ts`; used by send, reactions, broadcast, invitations, admin, `src/lib/auth/api-context.ts:100`, `src/app/api/ai/*`, `src/lib/ai/auto-reply.ts:90` | High | Move to a shared store (for example a Postgres table with an atomic upsert RPC) and keep the same function interface. | Fixed in RC (verify on staging) |
| RL-02 | The invitation peek route keys its limit on the leftmost `x-forwarded-for`, which the client can set. | `src/app/api/invitations/[token]/peek/route.ts` | Medium | Key on the platform-set client IP and on the token, and apply both limits. | Fixed in RC (verify on staging) |
| RL-03 | No message, AI request, or AI spend quota. | No code | High | Add per-account monthly counters for messages and AI calls and enforce them in the send and auto-reply paths. | Fixed in RC (verify on staging) |
| RL-04 | No usage metering. `ai_usage_log` holds tokens only. No message counts. No cost. | Migration 033 (`ai_usage_log`) | High | Add a `usage_events` table (account, kind, quantity, cost) and write to it from send and AI paths. | Fixed in RC (verify on staging) |
| RL-05 | `plan_limit` (P0001) errors from triggers are not mapped. Users see HTTP 500. (Audit rank 9: MEDIUM.) | Triggers from migration 037; no mapping found in `src/lib/` (exact file not pinned) | Medium | Map P0001 to HTTP 402 or 409 with a typed message the UI can show. | Fixed in RC (verify on staging) |
| RL-06 | When the contact cap is hit during inbound processing, the message is dropped silently. | `enforce_contact_limit` (migration 037); `processMessage` at `route.ts:580` | High | Keep the message on a capped account with a flag, notify the owner, and show an upgrade prompt. | Open |

---

## Infrastructure and operations

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| OPS-01 | Cron routes exist but nothing schedules them. No `vercel.json` or `vercel.ts`. | `src/app/api/automations/cron/route.ts`; `src/app/api/flows/cron/route.ts`; repo root (no Vercel config) | High | Add cron entries to `vercel.json` after OPS-02 is fixed. | Fixed in RC (verify on staging) |
| OPS-02 | Cron auth mismatch. Routes require `x-cron-secret`. Vercel Cron sends `Authorization: Bearer`. Scheduled calls would get 401. | `src/app/api/automations/cron/route.ts:19-23`; `src/app/api/flows/cron/route.ts` | High | Accept the Vercel Cron Bearer header in both routes, using `CRON_SECRET`, and keep the header check. | Fixed in RC (verify on staging) |
| OPS-03 | Automation rows left in `running` have no reaper. | `automation_pending_executions` (migration 006:111); `src/app/api/automations/cron/route.ts` | Medium | Return rows in `running` past a timeout to `pending` and count attempts. | Fixed in RC (verify on staging) |
| OPS-04 | No staging environment. One Supabase project serves production. Deploys go to the prod alias. | Supabase project `igqiwhfukbvoxduqycnf`; Vercel project `wacrm` | High | Create a staging Supabase project and a Vercel preview environment; apply migrations there first. | Open |
| OPS-05 | Deploys run from the CLI. No git-driven production deploy. | Vercel project `wacrm` | Low | Connect the repo to Vercel and deploy `main` only after CI passes. | Open |
| OPS-06 | No backup or restore test documented. | None | High | Schedule a schema and data export, test a restore into staging, and record RPO and RTO. | Open |
| OPS-07 | Free plan pauses after about 7 idle days. Live prod has real signups. | Supabase project plan | High | Move prod to a plan that does not pause. Use a keep-alive only as a stopgap. | Open |
| OPS-08 | No error monitoring. Errors go to `console.error` only. | Repo-wide; for example the webhook and AI catch blocks | High | Add an error tracker with source maps. Tag each event with route and account ID, never with message content. | Open |
| OPS-09 | No health check endpoint. | None under `src/app/api/` | Medium | Add `GET /api/health` that checks database reachability and returns no secrets. | Fixed in RC (verify on staging) |
| OPS-10 | Supabase default SMTP delivers only to team members and has low limits. Signup and reset emails fail for other users. | Supabase Auth settings (not in repo) | High | Configure a custom SMTP provider in Supabase Auth and set its rate limits. | Open |
| OPS-11 | No `/reset-password` page. `forgot-password` sends a link with no page to land on. | `src/app/(auth)/forgot-password/page.tsx`; no `src/app/(auth)/reset-password/` | High | Add a reset page that takes the recovery session and calls `updateUser` with the new password. | Fixed in RC (verify on staging) |
| OPS-12 | Migration 039 (modified, uncommitted) and 040 (untracked) are not on prod. No written apply process. | `supabase/migrations/039_products_orders.sql`, `040_billing_subscriptions_usage.sql` | High | Write the apply order and checks, apply to staging first, and log each prod apply in `docs/`. | Open |
| OPS-13 | Parallel uncommitted work in the working tree: 039, 040, `src/lib/billing/`, `.claude/`, `brag-output/`, `sendiee-teardown.md`. | `git status` at audit time | Medium | Owners commit their own files. Keep non-product folders out of the product commit. | Open |
| OPS-14 | No check that prod migrations match the repo. | Supabase migration list vs `supabase/migrations/` | Medium | Compare the two in a script before each deploy. | Open |

---

## Testing

| ID | Gap | Evidence | Severity | Planned fix | Status |
|---|---|---|---|---|---|
| TST-01 | No end-to-end tests. No Playwright or equivalent. | `package.json`; no e2e directory | High | Add a Playwright smoke suite: sign in, connect a test number, send, replay an inbound webhook. | Open |
| TST-02 | No RLS policy tests. Cross-account and role denials are not tested. | `src/**/*.test.ts` (none for RLS) | High | Add SQL-level tests with two accounts and each role, asserting read and write denials. | Fixed in RC (verify on staging) |
| TST-03 | No test replays a duplicate Meta webhook. | `src/app/api/whatsapp/webhook/` (no dedup test) | High | Post the same payload twice and assert one message row and one flow run. | Partial (see runbook/readiness) |
| TST-04 | Webhook processing duration is not tested against `maxDuration`. | `route.ts:22` | Medium | Add a timing test with slow mocked steps and document the time budget. | Open |
| TST-05 | Lint: 41 warnings in `src`. Two errors in untracked `brag-output/work/capture.js`, outside `src`. | `eslint` output at audit time | Low | Clear warnings in files you touch. Exclude `brag-output/` from lint. | Open |
| TST-06 | No coverage report in the baseline. | Vitest config (not checked for coverage settings) | Medium | Add a coverage report to CI and enforce 80% on new code. | Open |
| TST-07 | No test that a suspended account gets no auto-reply or webhook processing. `src/lib/saas/access.test.ts` covers the access function only. | `src/lib/saas/access.test.ts` | High | Add webhook and auto-reply tests for a suspended account. | Open |

---

## Coverage check

### The audit's 15 ranked risks

| Rank | Risk | Gap ID |
|---|---|---|
| 1 | Viewers can send WhatsApp | SEC-01 |
| 2 | Suspension and trial enforced only in app | TEN-02 (also AI-06, TST-07) |
| 3 | Admins can rewrite `owner_user_id` | TEN-01 |
| 4 | In-memory rate limit useless on Vercel | RL-01 |
| 5 | Viewers can SELECT encrypted secrets | SEC-02 |
| 6 | Public chat-media and flow-media buckets | SEC-04 |
| 7 | SSRF gaps | SEC-05 |
| 8 | No schema validation | SEC-06 |
| 9 | `plan_limit` errors become HTTP 500 | RL-05 |
| 10 | `redeem_invitation` cascade delete | TEN-03 |
| 11 | No CSRF Origin check; CSP report-only | SEC-07, SEC-08 |
| 12 | Anon may call `SECURITY DEFINER` functions | SEC-09 |
| 13 | Verify GET decrypts every token | SEC-10 |
| 14 | Automations scoped by `user_id` | TEN-04 |
| 15 | Platform admin by email | SEC-12 |

### Other known gaps from the audit

| Item | Gap ID |
|---|---|
| Single encryption key, no versioning (rotation breaks tokens) | SEC-03 |
| MCP session IDs predictable and shared | SEC-11 |
| Prototype keys in git history | SEC-13 |
| Shared database versus database per tenant (founder decision) | TEN-05 |
| Webhook failures are logged and dropped, no dead-letter store | WA-05 |
| Scheduled broadcasts have no dispatcher | WA-09 |
| No `/reset-password` page | OPS-11 |
| Supabase default SMTP limits | OPS-10 |
| Free plan pauses after 7 idle days | OPS-07 |

### Extra gaps requested for this document

| Item | Gap ID |
|---|---|
| No subscription, billing, or payment tables (committed code) | BIL-01 |
| No usage metering | RL-04 |
| No plan entitlements | SUB-02 |
| YouPI-PG not usable (license, issue #141, not settlement-authoritative) | BIL-04 |
| No staging environment | OPS-04 |
| No backup or restore test documented | OPS-06 |
| No error monitoring | OPS-08 |
| No health check endpoint | OPS-09 |
| Crons never scheduled | OPS-01, OPS-02 |
| No `/reset-password` page | OPS-11 |
| Supabase default SMTP limits | OPS-10 |

Every audit finding maps to at least one row above.

---

## Order of work (proposed)

This order is a proposal for the founder to confirm. It is not a plan of record.

1. Stop the bleeding on live prod: SEC-01, TEN-02 (suspension gate), WA-01 (dedup), RL-01 (rate limit store), OPS-07 (pause).
2. Make the platform recoverable: OPS-06 (backup and restore test), OPS-08 (error monitoring), OPS-09 (health), OPS-11 and OPS-10 (password recovery and SMTP).
3. Fix tenancy holes before more clients join: TEN-01, TEN-03, SEC-02.
4. Make the message path reliable: WA-04, WA-05, WA-06, WA-07, WA-08, OPS-01, OPS-02, OPS-03.
5. Decide the tenancy model (TEN-05) and record it. This decision changes items 3 and 6.
6. Billing: BIL-03, BIL-02 (review then commit 040), BIL-05, SUB-01 to SUB-04, RL-03, RL-04.
