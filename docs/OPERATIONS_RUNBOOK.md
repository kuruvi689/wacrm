# WACRM operations runbook

Date: 2026-11-21
Branch: `feat/production-release-candidate`
Audience: the billing operator (platform admin) and the on-call engineer.
Read with `docs/DEPLOYMENT_RUNBOOK.md` and `docs/ROLLBACK_PLAN.md`.

Known gaps are cited by ID (for example SEC-01); details are in `docs/PRODUCTION_GAPS.md`. Items marked **unverified** could not be confirmed from the repo.

Client support contact: **[SUPPORT_CONTACT, to be filled in by the founder]**

---

## 1. Roles

Platform operators (users in `PLATFORM_ADMIN_USER_IDS`) verify payments, record refunds, set overrides, suspend accounts and read the audit log. The founder approves releases, schema changes, money actions and client messages. The on-call engineer watches monitoring and runs incident steps. Client owners connect WhatsApp, manage members and pay subscriptions.

Operator rules: use your own login; give a specific reason for every action; never type or paste bank logins, OTPs, card details or secret values into any tool.

---

## 2. Daily routine

Each day: check `GET /api/health` (4.1); clear the payment queue (3.1), each item decided with a reason; scan Vercel logs for 24 h (4.2); confirm all three crons ran (4.4); check the `deferred_work` count (4.3); add one line to the operations log (9).

---

## 3. Money and account status

### 3.1 Daily payment verification

Money is confirmed only by checking the bank yourself. These do **not** count as proof: a customer screenshot, a UTR the customer typed, an SMS or app notification, a redirect back from a payment page, or a forwarded email. The app stores the customer UTR only as a claim (`customer_utr`).

| Step | Action | Check |
|---|---|---|
| 1 | Open the pending item in the operator console (`src/app/admin`, billing). Note the invoice, attempt, amount (in currency, shown from minor units), UTR and date submitted. | Details noted. |
| 2 | Log in to the business bank portal yourself. Do not use a script, screenshot or forwarded image. | Logged in as you. |
| 3 | Find one credit that matches all four: **exact amount**, **UTR**, **date**, and **receiving account** (must equal `BILLING_RECEIVING_ACCOUNT`). | All four match. |
| 4 | If all four match, settle the attempt in the console (`billing_settle_payment`). Reason example: "UTR, amount and account verified in bank portal on [date]". | Invoice paid; ledger row written. |
| 5 | Short or over amount: do not settle. Flag for manual investigation and tell the founder. | Flagged. |
| 6 | UTR already used: the system blocks a second settlement. Find out who submitted it. Do not settle. | Flagged. |
| 7 | No matching credit after the expected time: reject with a reason, or leave pending and check next day. Any customer message uses founder-approved wording. | Decided. |
| 8 | Log the outcome: attempt ID, result, time. | Logged. |

Rules:
- Activation is not instant. Tell customers it happens after verification, usually within working hours.
- Never change an amount, plan or status by editing a database row.
- A payment to a personal account is a freeze risk. Check the receiving account every time.

### 3.2 Refunds

1. Get founder approval in chat, then send the money back from the business bank portal yourself. Keep the bank reference.
2. Record the refund (`billing_record_refund`) with the reference and reason. Never more than the net amount paid. A refund does not change the plan.

Refunds are new ledger rows; originals are never edited. Tax and refund rules are not built (BIL-06); confirm with the founder and accountant before paid launch.

### 3.3 Overrides

Get founder approval, then use `billing_admin_set_subscription` with a specific reason (for example "founder approved 14-day trial extension for launch partner"). Check the plan and limits, and log it.

### 3.4 Suspensions

Get founder approval before suspending a paying client.

| Step | Action | Why |
|---|---|---|
| 1 | Suspend in the console with a reason (stored as `suspended_reason` and subscription state `suspended`). | Records the decision. |
| 2 | Pause the account's AI agent (ROLLBACK_PLAN 4.3). | Suspension is enforced only in app code (TEN-02); auto-replies ignore it (AI-06). |
| 3 | Disable the account's active automations and broadcasts. | Automations are not gated by suspension (TEN-04). |
| 4 | Tell the owner what happened and how to resolve it, in founder-approved wording. | Client knows the next step. |
| 5 | To reinstate: reverse the console action with a reason, then re-enable steps 2 and 3 by hand. | Reversible. |

Do not delete an account to suspend it (section 5.4).

---

## 4. Monitoring

### 4.1 Health

`GET https://wacrm-wheat.vercel.app/api/health` returns HTTP 200 with `"status":"ok"` when the database answers within 3 seconds. HTTP 503 with `"status":"degraded"` means the database probe failed. The body carries no secrets and no error text.

Nothing polls this automatically today. Set up an external check every 5 minutes that alerts a named person on any non-200. The owner is **unverified** until named in the release note.

### 4.2 Logs

- **Vercel function logs** (project `wacrm`): new stack traces and `console.error` entries. These are the only error logs (OPS-08).
- **Supabase logs** (project `igqiwhfukbvoxduqycnf`): failed queries, auth errors, timeouts. Confirm the project ID first.
- **Meta app dashboard**: webhook delivery failures and message error codes.

Never copy customer message text, tokens or keys into a ticket. Use IDs only.

### 4.3 Message failures, quotas and deferred work

- `messages.error_code` (migration 042): 131047 needs an approved template (24-hour window closed); 131026 is undeliverable; 190 is an expired token (6.3); 130429 is a Meta rate limit (6.4). The UI does not show codes yet (WA-03).
- `deferred_work` (migration 040): chargeable work refused by quota or billing. A rising count means a quota is too low or billing has lapsed.

Quota enforcement is partly built; treat numbers as indicators until the staging checks pass.

### 4.4 Cron jobs

| Route | Schedule (UTC, from `vercel.json`) | Job |
|---|---|---|
| `/api/automations/cron` | 03:00 daily | Drains pending automation actions; reaps rows stuck in `running` (migration 043). |
| `/api/flows/cron` | 03:15 daily | Marks stale flow runs as timed out. |
| `/api/billing/cron` | 03:30 daily | Runs `billing_reconcile`: expires stale attempts and invoices, applies due transitions, releases stale reservations, prunes rate-limit and dedup rows. |

Daily check: Vercel cron logs show each job ran in the last 24 h. Also count `automation_pending_executions` rows with `status = 'running'` and `claimed_at` older than 10 minutes (read-only). If a job did not run, go to section 6.5.

---

## 5. Customers, roles and retention

### 5.1 Account administration

- Only platform operators change plans, limits and statuses. The protected-column trigger (037) blocks tenant owners from editing them.
- An admin can change `accounts.owner_user_id` today (TEN-01). Migration 041 closes that path; it is on this branch and not on prod until deployed. Owner changes need founder approval.
- Platform admin by email is unsafe while email confirmation is off (SEC-12). Prefer user IDs.

### 5.2 Account recovery

- **Forgotten password:** use the reset link from the login page and open the email in the browser that requested it. Verify link delivery, an expired link, and sign-in with the new password in staging. The recovery callback URL and SMTP setup must be configured in Supabase.
- **Emails not arriving:** default Supabase SMTP only reaches team members and has low limits (OPS-10). Check the Auth email settings.

### 5.3 Roles today

| Role | Intended | Current state |
|---|---|---|
| Owner, admin | Full access; billing view and members | Works. |
| Agent | Read and send in the inbox | Works. |
| Viewer | Read only | Cannot send. Send and react need agent; broadcast and templates need admin (`role-gate.ts`, SEC-01 fixed on this branch; on prod once deployed). |

### 5.4 Retention and tenant deletion

| Data | Kept for | Notes |
|---|---|---|
| Inbound dedup claims (`inbound_message_claims`) | 7 days | Pruned by the daily billing reconcile. |
| Rate-limit buckets (`rate_limit_buckets`) | 1 day | Pruned by the daily billing reconcile. |
| Billing rows | Keep. Foreign keys are RESTRICT. | Tenant deletion is blocked while they exist. Do not work around it. |
| Messages, contacts, conversations | **No retention policy found (unverified).** | Founder to decide. |

Deleting a tenant: founder approval with account ID and reason; export the account data and billing history (encrypted); cancel open invoices and stop the subscription in the console; delete only after the founder checks the export. Deletion is permanent. Data subject requests follow the export step; their full process is **unverified**.

---

## 6. Incidents

Open an incident note for each one (template in section 9). Record time, symptom, impact, who was told, actions, and resolution time.

### 6.1 Supabase project paused

- **Symptom:** health returns 503 or times out; every user sees database errors.
- **Cause:** the free plan pauses after about 7 idle days (OPS-07). Prod has real signups.
- **Action:** confirm the pause in the Supabase dashboard for project `igqiwhfukbvoxduqycnf`; restore it (exact steps **unverified**; follow the current screen); wait until active; run the health check and DEPLOYMENT_RUNBOOK section 6 smoke tests; tell the founder.
- **Prevention:** move prod to a plan that does not pause (OPS-07). A keep-alive is a stopgap only.
- **Note:** a pause does not change stored payment records, but nothing can be verified, settled or sent until the database is back.

### 6.2 Meta webhook signature failures

- **Symptom:** webhook returns 401; Meta shows failed deliveries; inbound messages stop.
- **Cause:** `META_APP_SECRET` in Vercel does not match the secret of the Meta app, or it was rotated on one side only. A proxy that alters the raw body also breaks the signature.
- **Action:** compare the Meta app secret and `META_APP_SECRET` by a hash you compute yourself (never by pasting values); if rotated, follow 7.1; check for a new proxy or middleware; send a Meta test delivery.
- **Do not** disable signature checks. They fail closed by design.

### 6.3 Meta error 190 (token expired or revoked)

- **Symptom:** sends fail with code 190 for one account (stored in `messages.error_code`).
- **Cause:** the client's WhatsApp access token expired or was revoked. The app does not retry 190 by design.
- **Action:** the client owner reconnects WhatsApp through Embedded Signup (the Connect WhatsApp button), in their own browser and Meta login. Operators never ask for, paste or type the token. Then send one test message.

### 6.4 Rate-limit storms

- **Symptom:** many 429 responses or Meta rate-limit codes (130429); one account or IP sends bursts.
- **Cause candidates:** a runaway broadcast or automation, a client script, or hostile traffic. The shared limiter (`checkRateLimitShared`, backed by `rate_limit_hit` and `rate_limit_buckets`, migration 040) replaces the old per-instance limiter (RL-01 fixed on this branch; on prod once deployed).
- **Action:** find the account or API key by ID in logs; pause that account's broadcasts and automations; revoke an abused API key (the client can also do this); use Vercel firewall controls if traffic is hostile (exact steps **unverified**); watch `rate_limit_buckets` growth; tell the founder.
- **Do not** lift a limit in code during an incident without a reviewed change.

### 6.5 Cron not running

- **Symptom:** automations pending for hours; billing reconcile missing; `automation_pending_executions` rows stuck.
- **Causes:** (a) `vercel.json` not deployed; (b) `CRON_SECRET` missing or under 16 characters (503); (c) wrong secret (401); (d) code error (500).
- **Action:** confirm the three cron entries are deployed; run the curl check in DEPLOYMENT_RUNBOOK 6.6; act on the code: 401 means secret mismatch (7.1), 503 means variable missing, 500 means check logs and roll back if the release is new. Stuck `running` rows older than 10 minutes get one retry from the reaper (migration 043), then are marked failed. Record the count.

### 6.6 AI replies looping or wrong

Follow ROLLBACK_PLAN 6.2 and pause the agent (ROLLBACK_PLAN 4.3). Before blaming the AI, check whether Meta re-delivered the inbound message; dedup runs in `claim_inbound_message` (WA-01 fixed on this branch).

### 6.7 Billing wrong

Follow ROLLBACK_PLAN 6.3. Stop checkout first if money may be collected wrongly.

---

## 7. Secret rotation

Rules for every row:
1. Rotate in the provider's dashboard, then in Vercel Production, then redeploy, then test. Remove the old value only after the test passes.
2. Never paste values into chat, tickets, commits or docs. Name the variable only.
3. Log each rotation: name, date, who, test result.
4. Rotate at least yearly, and at once if exposed.

### 7.1 Rotation table

| Name | Rotate? | Effect if done wrong |
|---|---|---|
| `ENCRYPTION_KEY` | **Do not rotate.** One key, no key version (SEC-03); the re-encryption job is not built. | Every stored WhatsApp token, AI key and webhook secret becomes unreadable. Clients must reconnect and re-enter keys. |
| `SUPABASE_SERVICE_ROLE_KEY` | If exposed. Rotate in Supabase (steps **unverified**). | Server cannot reach the database until updated. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | If exposed (public by design). | Sign-in breaks until redeploy. |
| `META_APP_SECRET` | If exposed. Change in Meta and Vercel in one window. | Signatures fail between the two steps; inbound messages are lost (Meta retries only for a limited time). |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | If exposed. Change in Vercel and in Meta, then re-verify. | Webhook verification fails until both match. |
| `CRON_SECRET` | If exposed. Update Vercel and the external pinger, redeploy, run the curl check. | Cron routes return 401. |
| `AUTOMATION_CRON_SECRET` | If exposed. Same as above for the legacy `x-cron-secret` header. | External pinger gets 401. |
| `PLATFORM_ADMIN_USER_IDS` | As needed, founder approves. | An operator loses or gains billing access. |
| `PLATFORM_ADMIN_EMAILS` | Remove when possible (SEC-12). | Email-based admin is unsafe while confirmation is off. |
| `BILLING_UPI_VPA`, `BILLING_UPI_PAYEE_NAME`, `BILLING_RECEIVING_ACCOUNT` | Founder approval only. Confirm the new receiving account is a business current account. | Customers pay the wrong place; correct payments get rejected. |
| Per-account WhatsApp tokens | Client-driven (Embedded Signup). | Sends fail with 190 until reconnected. |
| Per-account AI provider keys | Client-driven, in AI settings. | AI replies fail for that account. |
| Customer webhook secrets | Client-driven. Rotation tool **unverified** in this repo. | Customer endpoint rejects signatures. |
| Public API keys (`wacrm_live_...`) | Client-driven: revoke and create in the app. | Integrations on the old key stop. |

### 7.2 Check after any rotation (within 15 minutes)

1. `GET /api/health` returns 200.
2. The curl check (DEPLOYMENT_RUNBOOK 6.6), if a cron secret changed.
3. One test message, if a WhatsApp or Meta value changed.
4. Log the result.

---

## 8. Known operational risks

| Risk | Gap ID | Operator action |
|---|---|---|
| Suspension not enforced in the database or webhook | TEN-02, AI-06 | Suspend and pause agents and automations (3.4). |
| Deduplication and shared rate limit | WA-01, RL-01 | Fixed on this branch; confirm they are deployed before relying on them. |
| No error tracker | OPS-08 | Vercel logs are the only error view. |
| Free Supabase pauses | OPS-07 | Section 6.1. |
| No staging yet | OPS-04 | Test carefully; use staging once it exists. |
| No restore drill on record | OPS-06 | ROLLBACK_PLAN section 5. |

---

## 9. Log templates

Incident note: incident ID and date; symptom and first seen (time, timezone); impact (accounts, roles, whether money or messages were affected); who was told and when; actions in order; rollback or switch used; resolved at; gap IDs; follow-up owner and due date.

Operations log line: date and time; operator; action; reference (IDs only); reason.
