# WACRM rollback plan

Date: 2026-11-21
Branch: `feat/production-release-candidate`
Read with `docs/DEPLOYMENT_RUNBOOK.md` (how releases go out) and `docs/OPERATIONS_RUNBOOK.md` (incidents and daily work).

Items marked **unverified** could not be confirmed from the repo or audit documents.

---

## 1. Principles

1. **Roll back the app first.** Most problems are in the app code. Rolling back the Vercel deployment is fast and does not touch data.
2. **Migrations are additive, so do not drop them.** The tables and columns added by 039 to 044 hold live customer data once clients use them. Neutralise a feature instead of dropping its tables.
3. **Never drop `billing_ledger`.** It is append-only financial history. Corrections are new rows, never deletes. Refunds and adjustments too.
4. **Back up before every migration.** There is no point-in-time recovery on the free Supabase plan, so the `pg_dump` file is the restore path (section 5).
5. **Stop the damage first, then fix.** Pausing a feature is faster than a redeploy. Record every rollback decision in the incident note (`docs/OPERATIONS_RUNBOOK.md`, section 9).

---

## 2. Rolling back the app (Vercel)

Use this when a new production deployment breaks the app and the previous one worked.

| Step | Action | Check |
|---|---|---|
| 2.1 | Open the Vercel project `wacrm` and list the recent production deployments. Note the ID of the last good one (the one before this release). | ID written in the incident note. |
| 2.2 | Roll back to that deployment. Preferred: the Vercel dashboard "Promote to Production" (or "Rollback") on the good deployment. CLI option: `npx vercel@latest rollback <deployment-url>`. The exact CLI syntax is **unverified** for the installed CLI version; run `npx vercel@latest rollback --help` first. | Prod alias points at the good deployment. |
| 2.3 | Run `GET https://wacrm-wheat.vercel.app/api/health`. Expect HTTP 200 and `"status":"ok"`. | Health is ok. |
| 2.4 | Run one inbound and one outbound test message on a test number. | Both work. |
| 2.5 | Check the Vercel function logs for 10 minutes. | No new errors from the rolled-back code. |
| 2.6 | Tell the founder in chat with the time, the old and new deployment IDs, and what was seen. | Founder acknowledges. |

Important: a rollback of the app does **not** undo migrations. If the old code cannot run against the new schema, the additive design means it usually still runs (new columns and tables are ignored). If it does not, use section 3 to neutralise the new feature, then keep the app rolled back.

Important: rolling back the app does not stop cron jobs that are already scheduled in `vercel.json`. The cron routes call the same database functions. If the bug is in a cron route, also use section 4 to pause it.

---

## 3. Migration rollback: neutralise, do not drop

Use this only when a migration itself is wrong and the app cannot be made safe by a rollback (section 2) alone.

### 3.1 Rules

| Rule | Why |
|---|---|
| Do not `DROP TABLE` on any table from 039 to 044. | Live customer data, and the RLS and grants depend on it. |
| Do not drop `billing_ledger`, `billing_audit_log` or `subscription_events` at all. | Append-only financial and audit history. |
| Neutralise by dropping a trigger, a function or a grant, then keep the table. | Reversible, and leaves data in place. |
| Every neutralising SQL runs inside a transaction, with a before and after check. | Lets you roll the transaction back if a check fails. |
| Run on staging first, with the same SQL. | Proves the change before production. |
| Get founder approval in chat before running it on production. | Schema changes need a named approver. |

### 3.2 Per-migration neutralising options

| Migration | Safe neutralising step | Do NOT do |
|---|---|---|
| 039 `products_orders` | Revoke API access to `products`, `orders`, `order_items` from `anon` and `authenticated`. Drop only the trigger that calls `public.order_items_same_account()` (trigger name to confirm on staging) if it blocks a valid write. The AI quoting path reads products; disable that feature first (set the agent to paused, section 4.3). | Drop `orders` or `order_items` (they hold priced baskets that customers may already see). |
| 040 billing core | Unset the `BILLING_*` variables so checkout is hidden (section 4.1). To stop a plan being sold, set its `price_minor` to NULL (the schema treats NULL as "not for sale"); confirm with the billing owner first, because it changes what customers see. Revoking `EXECUTE` on billing functions from `service_role` is possible but blocks operators too; use it only with founder approval. | Drop any billing table. Delete any row from `billing_ledger`, `billing_audit_log` or `subscription_events`. Edit `invoices` or `payment_attempts` by hand. |
| 041 security hardening | Do not undo. It closes holes. If a legitimate flow breaks, grant back the one specific function to `authenticated` and record why. | Restore the old `owner_user_id` update path. |
| 042 WhatsApp reliability | Columns are harmless. Drop the opt-out check only if it wrongly blocks sends: this is code, so prefer a code rollback (section 2). | Drop `contacts.opted_out_at` (it is the record of an opt-out, which may be a legal requirement). |
| 043 job reaper | The new columns are harmless. If the reaper is wrong, pause the cron (section 4.4) and reset `running` rows to `pending` with a reviewed query. | Drop `attempts` or `claimed_at` while rows still rely on them. |
| 044 AI agents | Pause agents in the app (immediate stop of auto-replies, section 4.3). Neutralise only what exists: the `ai_agent_versions_immutable` trigger and function, and only if it blocks a valid fix (trigger name to confirm on staging). Writes go through server routes with the service role, so there is no agent write function to revoke. Drop the `uq_ai_agents_one_active` index only if it blocks a valid change. With agents paused, auto-reply uses the legacy `ai_configs` settings (confirm on staging). | Drop `ai_agent_versions` or `ai_agent_events` (version history and rollback audit). |

### 3.3 Neutralising SQL template

Use as a starting point. Replace the placeholders with exact names reviewed on staging. Do not run it unreviewed.

```sql
begin;
-- 1. Before check (record the output in the incident note)
select count(*) from <table>;

-- 2. Neutralise (example: revoke a grant, or drop a trigger, never a table)
-- revoke execute on function public.<function_name>(<args>) from authenticated;
-- drop trigger if exists <trigger_name> on public.<table>;

-- 3. After check
select count(*) from <table>;   -- must equal the before count
commit;
-- If a check is wrong, run: rollback;
```

---

## 4. Feature switches (fastest stop, no redeploy)

These stop a feature in seconds. Use them before any deploy-level rollback when the problem is one feature.

### 4.1 Billing checkout

| Step | Action | Effect |
|---|---|---|
| 4.1.1 | In Vercel Production, unset `BILLING_UPI_VPA` (and, if needed, `BILLING_UPI_PAYEE_NAME` and `BILLING_RECEIVING_ACCOUNT`). Redeploy or trigger a redeploy so the change applies. | Checkout cannot build a payment link, so customers cannot pay. |
| 4.1.2 | Confirm the checkout route returns a clear error rather than a broken link. | Checked on staging first if time allows. |

Note: setting a variable needs a redeploy because variables are read at build or start time (**unverified** which applies to each route; confirm in the Vercel docs for the current runtime). Unsetting does not change money already paid.

### 4.3 AI agents and auto-replies

| Step | Action | Effect |
|---|---|---|
| 4.3.1 | In the app, set the affected account's agent status to `paused` (the `ai_agents` status; takes effect at once, per migration 044 header). | Auto-replies stop for that account. |
| 4.3.2 | For all accounts at once, use the operator query in section 4.3.3 with founder approval. | Stops replies everywhere. |
| 4.3.3 | Operator query (review before running; the `status` column and value must match the migration 044 definition, **unverified** in detail): `update ai_agents set status = 'paused' where status = 'active';` | All active agents paused. Record the row count. |

Do not delete agents or versions. Pausing is reversible.

### 4.4 Cron jobs

| Step | Action | Effect |
|---|---|---|
| 4.4.1 | Remove the cron entry for the failing route from `vercel.json` and deploy (the schedule is in the deployed file, so this needs a deploy). | Route is no longer called by Vercel Cron. |
| 4.4.2 | Stop any external pinger (DEPLOYMENT_RUNBOOK section 8) in its own dashboard. | Pinger stops calling the route. |
| 4.4.3 | Rotate `CRON_SECRET` only if the secret was exposed (OPERATIONS_RUNBOOK section 7). Rotation is not needed to stop a runaway job. | Calls with the old secret get 401. |

## 5. Backup and restore drill

### 5.1 Backup (before every migration)

| Step | Action |
|---|---|
| 5.1.1 | Run `pg_dump --format=custom --no-owner --file "<outside-repo-dir>/wacrm-<commit>-<date>.dump" "$SUPABASE_DB_URL"` with `SUPABASE_DB_URL` set from the password manager for this shell only (DEPLOYMENT_RUNBOOK 5.3). Auth and storage schema coverage is **unverified**. |
| 5.1.2 | Record the file name, size, timestamp and the commit hash in the release note. Do not record the connection string. |
| 5.1.3 | Keep at least the last three dumps. Store them in an encrypted location the founder controls. |

Backup coverage on the free Supabase plan is **unverified**. Check the Supabase dashboard for backups before relying on the platform. Do not assume daily backups exist.

### 5.2 Restore drill (before the first paid client relies on the system, and then quarterly)

| Step | Action | Pass condition |
|---|---|---|
| 5.2.1 | Restore the latest dump into the staging Supabase project (never into production). | Restore completes with no error. |
| 5.2.2 | Run the DEPLOYMENT_RUNBOOK 5.5 queries, then sign in and open one account and conversation. | Counts match; data is present. |
| 5.2.4 | Measure and record the time taken: this is your restore time (RTO). Record the age of the dump: this is your data loss window (RPO). | Both written in the operations runbook. |

### 5.3 Full restore to production (only with founder approval)

| Step | Action |
|---|---|
| 5.3.1 | Freeze writes: put the app in maintenance (remove the public route or pause the Vercel alias, founder decision). |
| 5.3.2 | Take a fresh dump of the broken state first, so nothing is lost. |
| 5.3.3 | Restore to a new Supabase project, check it, then point the app at it by changing `NEXT_PUBLIC_SUPABASE_URL` and the keys in Vercel, after founder approval. |
| 5.3.4 | Run the smoke tests (DEPLOYMENT_RUNBOOK section 6), then tell affected clients what was lost (writes between the dump and the failure). |

A full restore replaces the live database. Treat it as a last resort.

---

## 6. Decision trees

Each tree starts from a symptom. Follow the arrows. "Founder" means ask in chat before the step.

### 6.1 Webhook broken (inbound messages not appearing, or Meta shows failures)

```
Inbound messages missing?
├── Check GET /api/health
│   ├── 503 or "degraded"  -> database problem -> OPERATIONS_RUNBOOK section 6.1 (Supabase paused?)
│   └── 200 "ok"           -> continue
├── Check Meta webhook status in the Meta app dashboard
│   ├── Verification failing -> check WHATSAPP_WEBHOOK_VERIFY_TOKEN and the Meta callback URL
│   │                           (no code rollback needed; fix config)
│   └── Deliveries failing with 5xx -> continue
├── Check Vercel logs for /api/whatsapp/webhook (last 30 min)
│   ├── Signature errors (401) -> check META_APP_SECRET matches the Meta app; do not rotate
│   │                              until founder approves (OPERATIONS_RUNBOOK section 7)
│   ├── New stack trace since last deploy -> roll back the app (section 2), then tell founder
│   └── No new errors but still missing -> the message may be dropped after processing
│                                           (known gap WA-05, no dead-letter store): tell founder,
│                                           ask Meta to resend if within its retry window
└── Still broken after 2 steps -> founder decides: roll back app (section 2) and keep the
                                 webhook up; never leave Meta receiving 5xx for long
```

Never delete or re-order Meta webhook subscriptions while debugging without founder approval.

### 6.2 AI replies looping (the agent keeps answering itself or a customer repeatedly)

```
Customers or staff report repeated AI replies?
├── Pause the account's agent now (section 4.3.1). Reversible.
├── Is it one account or many?
│   ├── One account -> check its ai_configs and ai_agents rows; check conversation
│   │                  per-conversation cap (default 3, from ai_configs settings)
│   │                  -> fix settings with founder approval
│   └── Many accounts -> run section 4.3.3 (founder approval) and roll back the app
├── Is the loop caused by an automation that replies to AI replies?
│   ├── Yes -> disable that automation in the app; tell the client
│   └── No  -> continue
├── Is a new release the trigger?
│   ├── Yes -> roll back the app (section 2); leave agents paused until the fix is verified
│   └── No  -> check for a duplicate-delivery fault: inbound dedup runs in `claim_inbound_message` (migration 040). Verify the claim is recorded in `inbound_message_claims` before assuming a duplicate
│              -> tell founder; do not resume agents until verified
└── Before resuming: run one test conversation in the playground (it is not metered and
    works for paused agents, gap AI-03), then resume the agent (set status back to active)
```

Note: gap AI-07 means the model can emit the handoff sentinel. Log every handoff when investigating.

### 6.3 Billing wrong (a customer shows the wrong plan, the wrong amount, or a paid invoice that is not paid)

Billing money is only changed through operator functions. Never edit rows by hand.

```
Billing looks wrong?
├── Stop new checkouts first: unset BILLING_UPI_VPA (section 4.1) - founder approves
├── Identify the type of wrong:
│   ├── Plan or limits wrong      -> check subscriptions and plans rows (read-only query first)
│   │                                 -> fix with billing_admin_set_subscription (audited, needs reason)
│   ├── Invoice shows wrong amount -> do NOT edit. Check invoices and payment_attempts amounts
│   │                                 (computed server-side). If the price was wrong, tell founder;
│   │                                 correct the plan price, then cancel the open invoice via the
│   │                                 operator console invoice routes under `src/app/api/admin/billing/invoices`, and
│   │                                 issue a new one.
│   ├── Customer paid, not marked paid -> operator verifies the bank entry (exact amount, UTR, date,
│   │                                     receiving account) and settles with billing_settle_payment.
│   │                                     Never settle from a screenshot or a customer UTR alone.
│   ├── Marked paid, money not received -> do NOT reverse by editing. Record a refund or adjustment
│   │                                      through the operator console (billing_record_refund or
│   │                                      adjustment). Ledger rows are append-only.
│   └── Duplicate settlement attempt -> the UTR uniqueness on settlements blocks it; check
│                                        billing_audit_log for who tried
├── Any case involving money -> founder approval before any operator action
└── After the fix: confirm the customer's plan, invoice status and ledger on staging, then prod
```

Refunds never change the plan by themselves. The operator acts separately if the plan must change.

---

## 7. Rollback decision note

Before a rollback, write down: the symptom and first time seen, the live and last-good deployment IDs, any migrations applied in this release, whether a feature switch (section 4) is enough, who is affected, whether money moved or wrong messages were sent, the backup available, and whether founder approval is needed (yes for any schema or money action).

## 8. After a rollback

| Step | Action | Owner |
|---|---|---|
| 8.1 | Write the incident note (OPERATIONS_RUNBOOK section 9). | Engineer |
| 8.3 | Open a fix branch. Do not re-deploy the failed release until gate 1 to gate 4 pass again (DEPLOYMENT_RUNBOOK section 2). | Engineer |
| 8.4 | Tell affected clients in plain English what happened and what changed. Sending the message is a founder decision. | Founder |
| 8.5 | Check whether any gap in `docs/PRODUCTION_GAPS.md` caused or hid the problem; update its row. | Engineer |
