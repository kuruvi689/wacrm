# Implementation Plan — WACRM production release candidate

Branch: `feat/production-release-candidate` (from `feat/products-and-orders`, which builds on the live `feat/saas-tenancy-and-security-fixes`). Nothing in this plan deploys to production or touches the production database. That needs founder approval (see `DEPLOYMENT_RUNBOOK.md`).

Principles:
- Preserve working features. Every migration is additive and idempotent.
- Accounts without a subscription keep today's behaviour.
- The server decides money, limits and permissions; the browser never does.
- Where an external dependency is unsafe (YouPI-PG), keep the abstraction and leave the slot empty rather than ship it.

## Work order (dependency order) and status

| # | Work | Main files | Status |
|---|---|---|---|
| 0 | Audit and baseline (tsc clean, 727 tests) | `docs/ARCHITECTURE_AUDIT.md`, `docs/PRODUCTION_GAPS.md` | Done |
| 1 | Billing, subscription, usage and rate-limit core (DB) | `supabase/migrations/040_billing_subscriptions_usage.sql`, `supabase/tests/billing-migration.test.ts` | Done (54 Postgres checks) |
| 2 | Billing domain logic (pure) | `src/lib/billing/{subscription-state,invoice-amount,upi,verification,providers,metering}.ts` | Done (unit tested) |
| 3 | Tenant security hardening | `041_account_security_hardening.sql`, `src/lib/saas/plan-limit-error.ts`, `src/lib/webhooks/ssrf.ts`, WhatsApp route role gates | Done |
| 4 | WhatsApp reliability: wamid dedup, forward-only status, Meta errors, retry/backoff, timeout, 24h window, opt-out, automation gate on entitlements | `042_whatsapp_reliability.sql`, `src/lib/whatsapp/*`, webhook route | Done |
| 5 | Shared rate limiter rollout | `src/lib/rate-limit.ts` (`checkRateLimitShared`), all API routes, `src/lib/request-ip.ts` | Done |
| 6 | Background jobs: cron auth (Vercel Bearer), stuck-job reaper, health check, `vercel.json` | `043_job_reaper.sql`, `src/lib/cron/auth.ts`, `/api/health` | Done |
| 7 | Billing API + customer Billing page + operator billing console | `src/app/api/billing/**`, `src/app/api/admin/billing/**`, settings/admin UI | See PR |
| 8 | AI agent management: agents, immutable versions, rollback, states, tool registry, metering, failure handoff, simulation, per-agent stats | `044_ai_agents.sql`, `src/lib/ai/**`, Agents page | See PR |
| 9 | Release docs and acceptance matrix | `docs/*` | See PR |

## Key design decisions (reversible unless noted)

1. **Postgres for shared rate limits and quotas** rather than Redis: no new vendor or cost, and it is transactional with the data. Swap path: Upstash behind the same `rate_limit_hit` signature.
2. **One current subscription row per account**, with history in `subscription_events`. The same explicit state machine lives in TypeScript and SQL.
3. **Manual UPI with operator verification** as the only v1 settlement path. A regulated PSP adapter comes later, through the same `billing_settle_payment`.
4. **The ledger is append-only.** Corrections are new rows. Not reversible by design.
5. **Legacy accounts are never quota-blocked.** Moving a client onto a plan is an explicit, audited operator action.
6. **Fail-open choices**, each logged:
   - inbound dedup RPC errors (process the message rather than drop it);
   - metering RPC errors for AI replies (reply rather than silence the customer);
   - shared rate-limit outage (fall back to the per-process limiter).
   Settlement and money paths fail closed.

## Founder decisions required (blocking real billing)

| Decision | Default until decided |
|---|---|
| Plan names, prices, limits, grace days | No prices: nothing is for sale. Create plans in Admin → Billing. |
| Proration on upgrade | `none`: full price, starts at settlement |
| Receiving business bank account, UPI VPA, payee name | Checkout shows "billing not configured" |
| GST treatment and invoice format | Not built |
| Shared-DB SaaS vs database-per-tenant long term | This release is shared-DB with RLS. The DB-per-tenant prototype is out of scope. |
| Staging Supabase project (free org allows 2 active) and Vercel Pro or an external pinger for per-minute crons | Daily crons only |
| Production deploy and migration window | Not scheduled |

## Out of scope / follow-ups

Listed with IDs in `docs/PRODUCTION_GAPS.md`. The main ones:
- regulated PSP adapter and UPI AutoPay;
- `ENCRYPTION_KEY` versioning and a re-encryption job;
- private storage buckets with signed URLs;
- DNS-rebinding-proof SSRF (pin the resolved IP);
- metering `workflow_runs` in the automation and flow engines;
- error monitoring (Sentry);
- a staging load test for concurrent settlements and quotas;
- `/reset-password` page; custom SMTP;
- MCP SSE session ids (`Math.random`).
