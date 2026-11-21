# Subscription Architecture

Server-authoritative SaaS subscriptions, billing ledger, quotas and rate limits. The source of truth is `supabase/migrations/040_billing_subscriptions_usage.sql`, with TypeScript mirrors in `src/lib/billing/`.

```
Customer picks plan ─► POST /api/billing/checkout
                         │  computeInvoice()  (server, proration policy)
                         ▼
                  billing_open_checkout()  ── re-derives amount from plans.price_minor
                         ▼
                  invoices (one open per account)
                         ▼
                  billing_create_payment_attempt()  ── amount copied from invoice
                         │  PaymentAdapter.createRequest() → upi://pay link
                         ▼
   customer pays ──► submits UTR (claim) ─► payment_attempts.status = pending_verification
                         ▼
   operator checks bank ─► billing_settle_payment()  ── exact amount, unique UTR
                         ▼
        billing_ledger (append-only) + invoice paid + subscription extended
                         ▼
        billing_entitlements()  ─► quotas, automation gate, UI
```

## Tables

| Table | Purpose | User access |
|---|---|---|
| `plans` | Limits per plan; `price_minor` NULL means not for sale. No prices are seeded; only an internal `unlimited` plan exists. | Signed-in users read active, public plans |
| `subscriptions` | One current row per account | Members read |
| `subscription_events` | Every status change, with actor (append-only) | Admins read |
| `invoices` | What is owed. At most one `open` per account. | Admins read |
| `payment_attempts` | A request for money; `customer_utr` is a claim | Admins read |
| `billing_ledger` | Settlements, refunds and adjustments. Append-only; UTR unique for settlements. | Admins read |
| `payment_provider_events` | Webhook dedup and replay store for future PSP adapters | None |
| `billing_audit_log` | Every operator action (append-only) | None (operator console via service role) |
| `usage_counters` | Per account, metric and month: `used`, `reserved`, `blocked` | Members read |
| `usage_reservations` | Reserve, then commit or release, with an idempotency key | None |
| `rate_limit_buckets` | Shared fixed-window limiter | None |
| `inbound_message_claims` | WhatsApp wamid dedup (7-day retention) | None |
| `deferred_work` | Chargeable work refused by quota or billing (AI replies) | Admins read |

All writes go through `SECURITY DEFINER` functions granted to `service_role` only, called by API routes after an auth and role check.

## Subscription states

| State | Meaning | Chargeable work (AI, automations) | Workspace access |
|---|---|---|---|
| `trialing` | Operator-granted trial until `trial_ends_at` | Yes, until the trial ends | Yes |
| `pending_payment` | First checkout started, not paid | No | Yes |
| `active` | Paid through `current_period_end` | Yes | Yes |
| `past_due` | Period ended without renewal (transient) | Yes | Yes |
| `grace` | Renewal window, `plans.grace_days` long | Yes | Yes |
| `suspended` | Operator action (abuse, chargeback) | No | **No** (only state that locks the workspace) |
| `cancelled` | Cancelled by the customer (at period end) or by an operator | No | Yes (read and export, can buy again) |
| `expired` | Grace ended without payment, or trial ended | No | Yes (read and export, can renew) |

Allowed transitions are defined twice, in `TRANSITIONS` (`subscription-state.ts`) and in `billing_next_status()` (SQL), and tested against each other. Anything else raises `illegal_transition`.

```
trialing ──checkout──► pending_payment ──paid──► active ◄──paid── past_due / grace / expired / cancelled
active ──period end──► past_due ──► grace ──grace end──► expired
any paid state ──suspend──► suspended ──reinstate──► active
active (cancel_at_period_end) ──period end──► cancelled
```

Timestamps: `current_period_start/end`, `trial_ends_at`, `grace_ends_at`, `cancelled_at`, plus a `version` counter bumped on every change.

## Billing behaviour

| Case | Behaviour |
|---|---|
| First purchase | `new` invoice at full price; starts at settlement |
| Renewal (manual) | `renewal` invoice. Paid early, it extends from the current period end, so no paid days are lost. Paid late, it starts at settlement. |
| Upgrade | `upgrade` invoice; takes effect at settlement. With `BILLING_PRORATION_POLICY=daily`, unused days of the current plan are credited (rounded down). The default `none` charges full price. **Founder decision.** |
| Downgrade | No charge now. `pending_plan_id` is set and the next renewal is billed at the cheaper plan. |
| Cancel | `cancel_at_period_end`; service continues to the period end, then `cancelled`. Can be undone before then. |
| Expiry | `period_end` → `past_due` → `grace` (N days) → `expired`. Owners are notified (6-hour dedupe). |
| Refund | Operator records money returned. Partial or full; never more than net paid. Plan unchanged unless the operator acts separately. |
| Duplicate event | Idempotency keys on attempts and usage, a unique UTR on settlements, settlement only from open states. |
| Failed payment | The attempt expires (`billing_reconcile`). The invoice stays open until its deadline, and a late payment can still be verified against it. |
| Entitlement correction | `billing_admin_set_subscription` (trial, complimentary period, plan change). It needs a reason and is audited. |
| Missed or delayed events | `GET /api/billing/cron` → `billing_reconcile()` expires attempts and invoices, applies due transitions, releases stale reservations and prunes rate-limit and dedup rows. It is idempotent. |

## Backward compatibility

Accounts that existed before this release have **no subscription row**. `billing_entitlements()` returns `source: 'legacy'` for them. Their access follows the existing `accounts.status` / `trial_ends_at` rules, usage is metered, and **no quota ever blocks them**. An operator moves each client onto a plan explicitly (operator override, or the client pays). Nothing is migrated automatically.

`accounts.plan`, `max_members` and `max_contacts` are kept in step with the subscription's plan, so the existing database triggers (037) keep enforcing seat and contact caps.

## Quotas and metering

| Metric | Plan column | Metered where |
|---|---|---|
| `messages` | `monthly_messages` | Inbound WhatsApp (`usage_record`, never blocks) |
| `ai_responses` | `monthly_ai_responses` | AI auto-reply (reserve, then commit) |
| `ai_tokens` | `monthly_ai_tokens` | AI auto-reply (reserve an estimate, commit the actual) |
| `workflow_runs` | `monthly_workflow_runs` | Not wired yet (see production gaps) |

Count limits (`max_ai_agents`, `max_whatsapp_numbers`, `max_members`, `max_contacts`, `max_active_automations`, `max_integrations`, `knowledge_storage_mb`) are checked at create time. Members and contacts are enforced by the 037 triggers; agents by the agents API.

Reservation pattern:

1. `usage_reserve(account, metric, amount, key)` locks the counter row for the account, metric and month, so concurrent workers serialise and cannot overshoot. If the key exists, it returns `duplicate`: the WhatsApp retry is not charged twice.
2. The work runs.
3. `usage_commit(id, actual)` on success, or `usage_release(id)` on failure. Reservations left by a crashed worker expire and are released by reconcile.

When quota or billing blocks AI work, the customer message is still stored. A `deferred_work` row is written, owners and admins get a notification, and the usage page offers upgrade or renewal.

## Rate limiting

- **Burst limits** use `checkRateLimitShared()`, backed by `rate_limit_hit()` (an atomic upsert in Postgres), shared by every Vercel instance. If the database is unreachable it falls back to the per-process limiter, logged.
- **Durable quotas** use usage counters (above).
- Postgres is the shared store instead of Redis: no new vendor or cost, and the same transactional database. If traffic outgrows it, swap `rate_limit_hit` for Upstash Redis behind the same function signature.

## Environment variables (new)

| Variable | Purpose |
|---|---|
| `BILLING_UPI_VPA` | UPI ID payments go to (business current account) |
| `BILLING_UPI_PAYEE_NAME` | Name shown in the payer's UPI app |
| `BILLING_RECEIVING_ACCOUNT` | Masked label the operator must match, e.g. `HDFC-XX1234` |
| `BILLING_PRORATION_POLICY` | `none` (default) or `daily` (founder decision) |
| `CRON_SECRET` | Bearer secret for Vercel Cron or an external pinger (16+ characters) |
