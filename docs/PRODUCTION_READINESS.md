# WACRM production readiness

**Verdict: BLOCKED for paid production onboarding.** The release candidate uses a shared Supabase database with workspace isolation. Manual UPI is the implemented payment path. The review below covers the local release candidate and records the remaining evidence needed from staging.

| Requirement | Status | Evidence or release gate |
| --- | --- | --- |
| Agent management | PASS locally | Admins can configure, version, simulate, activate, pause and roll back agents. Tests cover form logic, version rules, tool permissions and automatic replies. Verify the signed-in Agents page and human takeover on staging. |
| Payment confirmation | PASS locally for manual UPI | Operator settlement checks the receiving account, amount and unique bank UTR. Customer UTR submission cannot settle an invoice. [Payment security review](PAYMENT_SECURITY_REVIEW.md) |
| Subscription lifecycle | PASS locally for manual renewal | Billing routes and Postgres tests cover checkout, settlement, renewal, expiry, cancellation and operator changes. Complete a browser checkout and a reconciliation drill in staging. |
| Real billing configuration | BLOCKED | Approve manual UPI, prices and limits, proration, receiving account and payee, billing operators, GST and invoice requirements, and the refund policy. Gateway settlement or AutoPay requires a separate provider integration. |
| Plan enforcement and concurrency | FAIL for the full brief | AI auto-replies reserve replies and tokens. Draft, Playground and Simulation use provider tokens outside the plan quota. Inbound message counts are informational and workflow runs are unmetered. Publish only the limits enforced by the chosen pilot plan. Run concurrent settlement and quota checks on staging. |
| Tenant isolation and security | BLOCKED | Migrations 040–044 include tenant, role and service-role protections. A local role-policy test checks workspace isolation. Repeat through the staging Supabase API and verify storage and integration access before introducing client data. |
| WhatsApp reliability | BLOCKED | Deduplication, delivery status, retry handling and handoff have local coverage. Use a test number to check signed inbound delivery, replay, outgoing delivery, opt-out, and human takeover. |
| Automated checks | PASS locally for tests | Full local run passed 1,132 tests. The production-mode build and its typecheck passed with test configuration. PGlite covered fresh and repeated migrations, demo seeding and workspace isolation. Require green PR CI. |
| Monitoring and scheduled work | BLOCKED | Health checks and scheduled routes exist. Confirm alert delivery and monitor failed sends, job backlog and billing reconciliation. Approve a commercial hosting plan and a scheduler that meets workflow latency requirements. |
| Backups and rollback | BLOCKED | [Rollback plan](ROLLBACK_PLAN.md) and [deployment runbook](DEPLOYMENT_RUNBOOK.md) define recovery. Record a successful restore in isolation and agree on recovery time and data loss targets. |
| Client authentication | BLOCKED | The recovery form and callback are implemented and callback tests pass locally. Verify live email delivery, sign-in, invitation and password recovery on staging. Confirm a client-capable SMTP provider before offering email sign-up. |
| Staging acceptance and founder approval | BLOCKED | Run the staging acceptance checks in the deployment runbook. Record the approved commit, backup/restore evidence and production migration window before deployment. |

## Synthetic demo

Create the Auth user `wacrm-demo@example.invalid` in a disposable local or isolated staging database after applying the migrations. In the same SQL session, run `SET wacrm.demo_seed = 'isolated-staging';` followed by [demo.sql](../supabase/seed/demo.sql). The seed uses the existing demo workspace and inserts one fictional contact and conversation, one message, an inactive agent draft and a private unpriced plan. The demo seed refuses a workspace with a WhatsApp connection. Use the normal onboarding checks with a separate approved test workspace and number. Never run the seed in production.

## Monthly cost estimate

Vercel Pro and Supabase Pro start at approximately **US$45/month combined**, before tax, overages, extra seats, an additional staging database, SMTP or monitoring. Free tiers start at US$0 and suit eligible experiments. Confirm usage terms and current pricing before purchase. Client-connected AI-provider and Meta usage are billed separately from WACRM subscriptions. [Vercel pricing](https://vercel.com/pricing) · [Supabase pricing](https://supabase.com/pricing)
