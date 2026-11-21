# WACRM deployment runbook

Date: 2026-11-21
Branch: `feat/production-release-candidate` (HEAD `dfe161d` at time of writing)
Owner: founder (approves every production deploy and every production migration)

Read this with `docs/ROLLBACK_PLAN.md` (what to do when a deploy goes wrong) and `docs/OPERATIONS_RUNBOOK.md` (day-to-day work after a deploy).

Items marked **unverified** could not be confirmed from the repo or the audit documents. Confirm them before relying on them.

---

## 1. Environments and identifiers

| Item | Value | Notes |
|---|---|---|
| Vercel project | `wacrm` (team `kuruvi689s-projects`) | Deployed from the CLI. No Git integration. |
| Production URL | https://wacrm-wheat.vercel.app | Prod alias. |
| Production Supabase | project `igqiwhfukbvoxduqycnf`, region ap-northeast-1 | Free plan. Pauses after about 7 idle days. No point-in-time recovery on the free plan. Backup coverage **unverified**. |
| Staging Supabase | **Does not exist yet** | Gap OPS-04. Create it before the first release that follows this runbook. |
| Production code on prod | Commit `9096d17` | The branch is ahead of prod. Migrations 039 to 044 are not applied to prod. |
| Production migrations applied | Up to `038` | Per the release brief. Confirm with step 5.2 before any change. |

---

## 2. Release path (every release)

Order: feature branch, then gates 1 to 6 below. Each gate must pass before the next starts. A failed gate means stop and fix on the feature branch.

| Gate | Who | Pass condition |
|---|---|---|
| 1. Tests | Engineer | All four commands below exit 0. |
| 2. Security checks | Engineer | Items in section 3.2 reviewed; no open CRITICAL item for the release. |
| 3. Staging | Engineer | Migrations applied to staging; app deployed to staging preview. |
| 4. Acceptance | Engineer + founder | Checks in section 7 pass on staging. |
| 5. Founder approval | Founder | Written go-ahead in chat or in the release note. |
| 6. Production | Engineer | Section 5 completed in order; smoke tests in section 6 pass. |

---

## 3. Gate 1 and Gate 2: tests and security checks

### 3.1 Tests (run from the repo root)

| Step | Command | Pass condition |
|---|---|---|
| 1.1 | `npm run typecheck` | No errors (runs `tsc --noEmit`). |
| 1.2 | `npm test` | All Vitest files pass (`vitest run`). |
| 1.3 | `npm run lint` | 0 errors. Warnings in touched files should be cleared. |
| 1.4 | `npm run build` | Build completes (`next build`). |

Also run the migration test suite. It applies every migration in order to an in-memory Postgres and re-applies 039 and later:

| Step | Command | Pass condition |
|---|---|---|
| 1.5 | `npx vitest run supabase/tests` | All pass. |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test and build on pull requests to `main` and on pushes to `main`. A release must not merge with a red CI run.

### 3.2 Security checks before release

1. Confirm no secret values are in the diff: search the changed files for key-like strings. Never paste a value into a commit, PR or doc.
2. Confirm new routes take `account_id` from the session, call `isAuthorizedCronRequest` for cron, and check role before any service-role call.
5. Check known open security gaps against the release scope (see `docs/PRODUCTION_GAPS.md`). In particular:
   - SEC-01 is fixed on this branch: `src/lib/whatsapp/role-gate.ts` requires agent for send and react, and admin for broadcast and templates. It is not on prod commit `9096d17` until deployed.
   - TEN-02: suspension is enforced in app code only, not in RLS.
   - WA-01 is fixed on this branch: the webhook claims each inbound wamid with `claim_inbound_message` (table `inbound_message_claims`, migration 040). Not on prod until deployed.
6. Dependency check: run `npm audit --omit=dev` and record the result in the release note. Whether CI runs this is **unverified**.

---

## 4. Gate 3: staging

### 4.1 Staging setup (one time, before the first release)

| Step | Action | Done when |
|---|---|---|
| 4.1.1 | Create a new Supabase project for staging (separate from `igqiwhfukbvoxduqycnf`). | Project exists and is not the prod project. |
| 4.1.2 | Apply migrations 001 to 044 in order to the empty staging project (section 5.3 method). | All migrations applied with no error. |
| 4.1.3 | Set staging env vars in the Vercel preview scope (names in section 4.3). Use test values, never prod values. | Preview deploy starts. |

### 4.2 Staging deploy

1. Create a Vercel preview from a clean checkout of the feature commit (the CLI deploys local files). Record the preview URL and commit hash.
2. Run the section 6 smoke tests against the preview URL.

### 4.3 Environment variables (names only)

Set these in the Vercel project for each scope (Production, Preview). Never write values into the repo, docs, chat or commit messages.

| Name | Scope | Purpose | Source |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All | Supabase project URL (public). | Existing |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | All | Supabase anon key (public). | Existing |
| `SUPABASE_SERVICE_ROLE_KEY` | All, secret | Service-role client; bypasses RLS. | Existing |
| `ENCRYPTION_KEY` | All, secret | AES-256-GCM key for stored secrets. Do not rotate (see OPERATIONS_RUNBOOK section 7). | Existing |
| `META_APP_SECRET` | All, secret | Verifies Meta webhook signatures. | Existing |
| `META_APP_ID` | All | Meta app ID (server). | Existing |
| `NEXT_PUBLIC_META_APP_ID` | All | Meta app ID (client, Embedded Signup). | Existing |
| `NEXT_PUBLIC_META_CONFIG_ID` | All | Embedded Signup config ID. | Existing |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | All, secret | Platform-level webhook verify token. | Existing |
| `WHATSAPP_TEMPLATES_DRY_RUN` | Preview | Template submit dry-run switch. Keep on for staging. | Existing |
| `AUTOMATION_CRON_SECRET` | All, secret | Legacy `x-cron-secret` header for external pingers. | Existing |
| `PLATFORM_ADMIN_USER_IDS` | All | Platform admin allow-list by user ID. Preferred. | Existing |
| `PLATFORM_ADMIN_EMAILS` | All | Platform admin allow-list by email. Unsafe if email confirmation is off (SEC-12). | Existing |
| `NEXT_PUBLIC_SITE_URL` | All | Public site URL. | Existing |
| `NEXT_PUBLIC_APP_LOCALE` | All | UI locale. | Existing |
| `ALLOWED_INVITE_HOSTS` | All | Allowed hosts for invitation links. | Existing |
| `AI_REQUEST_TIMEOUT_MS` | All | AI provider timeout. | Existing |
| `AI_CONTEXT_MESSAGE_LIMIT` | All | Messages sent as AI context. | Existing |
| `CRON_SECRET` | All, secret | Bearer secret for Vercel Cron and billing reconcile. At least 16 characters. Shorter values are ignored. | New |
| `BILLING_UPI_VPA` | Production | UPI ID that customers pay to. | New |
| `BILLING_UPI_PAYEE_NAME` | Production | Name shown in the payer's UPI app. | New |
| `BILLING_RECEIVING_ACCOUNT` | Production | Masked label the operator must match, for example a bank and last digits. | New |
| `BILLING_PRORATION_POLICY` | All | `none` (default) or `daily`. Founder decision. | New |
| `META_API_TIMEOUT_MS` | All | Per-attempt timeout for Meta calls. Default 15 s in code. | New |
| `META_API_RETRY_BASE_MS` | All | Base delay for Meta retry backoff. | New |

Notes:
- `CRON_SECRET` is required before any cron can run. Without it, cron routes return 503 ("not configured").
- Set billing variables on production only when billing is ready to go live (unsetting hides checkout: ROLLBACK_PLAN 4.1).
- Check names in the Vercel dashboard; never print values.

---

## 5. Gate 6: production deploy (only after founder approval)

### 5.1 Before you start

| Step | Action | Check |
|---|---|---|
| 5.1.1 | Confirm the approved commit hash and the staging result. | Written in the release note. |
| 5.1.2 | If the migration takes a table lock, agree a client notice with the founder. | Notice approved or not needed. |
| 5.1.3 | Confirm Supabase project `igqiwhfukbvoxduqycnf` is active (not paused). | Dashboard shows active. |

### 5.2 Confirm the current production migration state

Run this read-only query in the production SQL editor. The Supabase CLI history table is assumed (**unverified**); if it fails, use the object checks in 5.5.

```sql
select version, name
from supabase_migrations.schema_migrations
order by version;
```

Expected: versions up to `038`. If `039` or later already appear, stop. Work out what was applied before you go on.

### 5.3 Backup first (required before any migration)

| Step | Action | Done when |
|---|---|---|
| 5.3.1 | Take a full logical export of production with `pg_dump` (command below); keep the connection string in your password manager. Record file name, size and commit in the release note. | Dump file written outside the repo. |
| 5.3.3 | Confirm the dump restores into the staging project (drill). | Restore finishes with no error. |

```bash
# Non-secret example. SUPABASE_DB_URL is set from your password manager for this shell only.
pg_dump --format=custom --no-owner --file "<outside-repo-dir>/wacrm-<commit>-<YYYY-MM-DD>.dump" "$SUPABASE_DB_URL"
```

The `auth` and `storage` schemas may need extra `--schema` flags or the Supabase CLI dump command; **unverified**. Check the restore includes them before relying on it.

Backup availability on the free plan is **unverified**. Treat the `pg_dump` file as the only restore path until that is confirmed (see ROLLBACK_PLAN section 5).

### 5.4 Apply migrations in order

Apply in this order. Each file is additive and idempotent, so a re-run is safe. Apply one file at a time and run its checks (5.5) before the next.

| Order | File | What it adds (from file header) | Status on prod before this release |
|---|---|---|---|
| 1 | `039_products_orders.sql` | `products`, `orders`, `order_items`. Money in integer minor units. | Not applied |
| 2 | `040_billing_subscriptions_usage.sql` | Billing core: `plans`, `subscriptions`, `subscription_events`, `invoices`, `payment_attempts`, `billing_ledger`, `payment_provider_events`, `billing_audit_log`; usage counters and reservations; `rate_limit_buckets`; `inbound_message_claims`; `deferred_work`. No prices seeded. | Not applied |
| 3 | `041_account_security_hardening.sql` | Protects `accounts.owner_user_id` from admin edits; redeem-invitation emptiness check covers all tenant tables; revokes `anon` execute on remaining signed-in-only functions. | Not applied |
| 4 | `042_whatsapp_reliability.sql` | `messages.error_code`, `messages.error_message`; `contacts.opted_out_at`, `contacts.opt_out_source`; partial index on opted-out contacts. | Not applied |
| 5 | `043_job_reaper.sql` | `automation_pending_executions.attempts` and `claimed_at`; partial index for rows in `running`. | Not applied |
| 6 | `044_ai_agents.sql` | `ai_agents`, `ai_agent_versions`, `ai_agent_events`, `ai_tool_calls`; one active agent per account; extra columns on `ai_usage_log` and `ai_configs`. **Not committed at the time of writing and may still change.** | Not applied |

Before applying 044, confirm it is committed and reviewed; if it changed after staging, re-run staging first. Use the same method (SQL editor or Supabase CLI; **unverified** which is used) on both environments.

### 5.5 Per-migration verification queries (read-only)

Run after each file. Each query should return the row count shown.

| After | Query (read-only) | Expected |
|---|---|---|
| 039 | `select table_name from information_schema.tables where table_schema='public' and table_name in ('products','orders','order_items');` | 3 rows |
| 040 | `select table_name from information_schema.tables where table_schema='public' and table_name in ('plans','subscriptions','subscription_events','invoices','payment_attempts','billing_ledger','payment_provider_events','billing_audit_log','usage_counters','usage_reservations','rate_limit_buckets','inbound_message_claims','deferred_work');` | 13 rows |
| 040 | `select count(*) from plans where price_minor is not null;` | 0 on a fresh apply (no prices are seeded). Any non-zero value must be explained by the founder. |
| 041 | `select grantee, privilege_type from information_schema.routine_privileges where routine_schema='public' and grantee='anon';` | Only functions the team has listed as public should appear. Review the list. |
| 042 | `select column_name from information_schema.columns where table_schema='public' and ((table_name='messages' and column_name in ('error_code','error_message')) or (table_name='contacts' and column_name in ('opted_out_at','opt_out_source')));` | 4 rows |
| 043 | `select column_name from information_schema.columns where table_schema='public' and table_name='automation_pending_executions' and column_name in ('attempts','claimed_at');` | 2 rows |
| 044 | `select table_name from information_schema.tables where table_schema='public' and table_name in ('ai_agents','ai_agent_versions','ai_agent_events','ai_tool_calls');` | 4 rows |
| 044 | `select indexname from pg_indexes where schemaname='public' and indexname='uq_ai_agents_one_active';` | 1 row |

If a count is short, stop. Do not continue to the next file. Compare the migration file with what was applied, then decide with the founder.

### 5.6 Deploy the app

| Step | Action | Check |
|---|---|---|
| 5.6.1 | Check out the approved commit cleanly (no uncommitted changes in the working tree). | `git status` is clean for product files. |
| 5.6.2 | Confirm the production env vars in section 4.3 are set in the Production scope. | Names present; values not printed. |
| 5.6.3 | Deploy: `npx vercel@latest deploy --prod`. | Command prints a deployment URL and status. |
| 5.6.4 | Record the Vercel deployment ID and the commit hash in the release note. | Note updated. |
| 5.6.5 | Confirm the prod alias points at the new deployment. | https://wacrm-wheat.vercel.app serves the new version (see section 6.1). |

Run section 6 within 15 minutes; on failure, go to ROLLBACK_PLAN section 2. Cron schedules live in `vercel.json`. The current file schedules three daily jobs (03:00, 03:15 and 03:30 UTC). Vercel Hobby plans run crons at most once a day, so a per-minute schedule needs an external pinger (section 8).

---

## 6. Smoke tests

Run these on production after each deploy, and on staging before gate 5. Use a test account and a test WhatsApp number. Do not message real customers.

| # | Test | How | Pass condition |
|---|---|---|---|
| 6.1 | Health | `GET https://wacrm-wheat.vercel.app/api/health` | HTTP 200, body has `"status":"ok"`, `checks.database.ok` is true, `version` matches `package.json` (currently `0.8.0`). HTTP 503 with `"status":"degraded"` means the database probe failed. |
| 6.2 | Login | Sign in with the test account (email or Google). | Dashboard loads. Account name is correct. |
| 6.3 | Meta webhook verify (GET) | Meta app dashboard "Verify and save" for the callback `https://wacrm-wheat.vercel.app/api/whatsapp/webhook`. The verify token value comes from the Meta dashboard and your password manager. | Meta shows the webhook as verified. A wrong token must be rejected. |
| 6.4 | Test message | From the dashboard, send one text message from the test number to a test recipient. Then reply from that recipient's phone. | Outbound shows as sent; inbound appears in the thread once. |
| 6.5 | Billing page | Billing UI is in progress in this release candidate. Before the test, check that the billing settings section exists. The billing API (`/api/billing`, `/api/billing/checkout`) can be smoke-tested without the UI. | Page loads without error, or record that the UI is not yet built and test the API instead. |
| 6.6 | Cron with Bearer | See section 6.6 command below. | HTTP 200 with a JSON body. HTTP 401 means the secret is wrong. HTTP 503 means `CRON_SECRET` is missing or shorter than 16 characters. |

### 6.6 Cron check command

Run where `CRON_SECRET` is already set in the shell (never typed on the command line). Repeat for `/api/automations/cron` and `/api/flows/cron`; expect `200` each.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $CRON_SECRET" https://wacrm-wheat.vercel.app/api/billing/cron
```

---

## 7. Staging acceptance (gate 4)

Before the founder approves production, all section 6 checks pass on the staging preview URL, plus:

| Check | Pass condition |
|---|---|
| The release's own feature | Demonstrated end to end with test data. |
| Role gate | A viewer account gets HTTP 403 on send and react. An agent account gets HTTP 403 on broadcast and templates. |
| A suspended test account gets no auto-reply | Known gap TEN-02 and AI-06 may fail this. Record the result. |
| Duplicate Meta delivery (regression check) | Post the same inbound payload twice. Only one message row and one flow run should result. |
| Migration checks in 5.5 | All pass on staging. |
Record each failure with its gap ID; a failure stops the release.

---

## 8. External pinger (optional)

Vercel Hobby crons run at most daily. For shorter intervals, use an external HTTP scheduler that calls `GET https://wacrm-wheat.vercel.app/api/automations/cron` (and the flows or billing route if needed) with `Authorization: Bearer <CRON_SECRET>` in a header, never in the URL. Start at 5 minutes, alert on any non-200, and name the owner in the release note. Do not go below the route's 60-second `maxDuration` budget.
