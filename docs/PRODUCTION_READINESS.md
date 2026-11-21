# WACRM production readiness

**Verdict: NOT production-ready — BLOCKED for paid production onboarding.** The release candidate uses a shared Supabase database with workspace isolation. Manual UPI is the implemented payment path. The review below covers the local release candidate and records the remaining evidence needed from staging.

| Requirement | Status | Evidence or release gate |
| --- | --- | --- |
| Agent management | PASS locally | Admins can configure, version, simulate, activate, pause and roll back agents. Tests cover form logic, version rules, tool permissions and automatic replies. Verify the signed-in Agents page and human takeover on staging. |
| Payment confirmation | PASS on staging for synthetic manual UPI | A rollback-only SQL smoke exercised checkout, invoice creation, UTR submission, an unverified provider event, reconciliation and audited operator settlement. Browser checkout is still pending. [Payment security review](PAYMENT_SECURITY_REVIEW.md) |
| Subscription lifecycle | PASS locally for manual renewal | Billing routes and Postgres tests cover checkout, settlement, renewal, expiry, cancellation and operator changes. Complete a browser checkout and a bank-statement reconciliation drill using test records in staging. |
| Real billing configuration | BLOCKED | Approve manual UPI, prices and limits, proration, receiving account and payee, billing operators, GST and invoice requirements, and the refund policy. Gateway settlement or AutoPay requires a separate provider integration. |
| Plan enforcement and concurrency | FAIL for the full brief | AI auto-replies reserve replies and tokens. Draft, Playground and Simulation use provider tokens outside the plan quota. Inbound message counts are informational and workflow runs are unmetered. Publish only the limits enforced by the chosen pilot plan. Run concurrent settlement and quota checks on staging. |
| Tenant isolation and security | BLOCKED | Migrations 040–044 include tenant, role and service-role protections. A local role-policy test checks workspace isolation. Repeat through the staging Supabase API and verify storage and integration access before introducing client data. |
| WhatsApp reliability | BLOCKED | Deduplication, delivery status, retry handling and handoff have local coverage. Use a test number to check signed inbound delivery, replay, outgoing delivery, opt-out, and human takeover. |
| Automated checks | PASS locally for tests | Full local run passed 1,132 tests. The production-mode build and its typecheck passed with test configuration. PGlite covered fresh and repeated migrations, demo seeding and workspace isolation. Require green PR CI. |
| Monitoring and scheduled work | BLOCKED | Health checks and scheduled routes exist. Confirm alert delivery and monitor failed sends, job backlog and billing reconciliation. Approve a commercial hosting plan and a scheduler that meets workflow latency requirements. |
| Backups and rollback | BLOCKED | [Rollback plan](ROLLBACK_PLAN.md) and [deployment runbook](DEPLOYMENT_RUNBOOK.md) define recovery. Record a successful restore in isolation and agree on recovery time and data loss targets. |
| Client authentication | BLOCKED | The recovery form and callback are implemented and callback tests pass locally. Verify live email delivery, sign-in, invitation and password recovery on staging. Confirm a client-capable SMTP provider before offering email sign-up. |
| Staging acceptance and founder approval | BLOCKED | The isolated Supabase staging database has migrations 001–044. Connect a staging app and run the acceptance checks in the deployment runbook. Record the approved commit, backup/restore evidence and production migration window before deployment. |

## Synthetic demo

Create the Auth user `wacrm-demo@example.invalid` in a disposable local or isolated staging database after applying the migrations. In the same SQL session, run `SET wacrm.demo_seed = 'isolated-staging';` followed by [demo.sql](../supabase/seed/demo.sql). The seed uses the existing demo workspace and inserts one fictional contact and conversation, one message, an inactive agent draft and a private unpriced plan. The demo seed refuses a workspace with a WhatsApp connection. Use the normal onboarding checks with a separate approved test workspace and number. Never run the seed in production.

## Monthly cost estimate

Vercel Pro and Supabase Pro start at approximately **US$45/month combined**, before tax, overages, extra seats, an additional staging database, SMTP or monitoring. Free tiers start at US$0 and suit eligible experiments. Confirm usage terms and current pricing before purchase. Client-connected AI-provider and Meta usage are billed separately from WACRM subscriptions. [Vercel pricing](https://vercel.com/pricing) · [Supabase pricing](https://supabase.com/pricing)

## Decisions needing founder approval

Nothing below has a default that the code will assume in production. Plans stay unpriced until the founder sets them.

- [ ] Plan names, prices and limits (members, contacts, AI replies, AI tokens, agents). Publish only limits the code enforces.
- [ ] Proration rules for upgrades, downgrades and cancellation at period end.
- [ ] Receiving bank account, UPI VPA and payee name shown at checkout, and the operators allowed to verify payments.
- [ ] GST and invoice requirements, and the refund policy.
- [ ] Payment path: manual UPI with operator bank verification (implemented) versus a licensed gateway later. YouPI-PG is rejected: it has no licence and issue #141 reports forged payment SMS.
- [ ] Isolated staging Supabase project and staging deployment for acceptance.
- [ ] Hosting plan: Vercel Pro, or Hobby with an external scheduler that calls the cron routes with `CRON_SECRET`.
- [ ] Backup and restore targets (RPO and RTO), and one recorded restore into isolation.
- [ ] Approval of the commit, migration window (040–044) and production rollout.

## Cost ranges (verify current pricing)

| Item | Range | Note |
| --- | --- | --- |
| Vercel | US$0 (Hobby, non-commercial) to about US$20/seat/month (Pro) | Hobby limits cron frequency and prohibits commercial use. Verify pricing. |
| Supabase | US$0 (Free, pauses when idle) to about US$25/month (Pro) per project | A separate staging project adds a second bill. Verify pricing. |
| AI provider | Billed to each client's own key | Not a WACRM cost; each simulation also spends the client's tokens. |
| Meta WhatsApp | Billed to each client by Meta | Conversation pricing changes; verify. |
| Email (SMTP) | US$0 to low tens of dollars | Needed for client sign-up and recovery email. |

## Overall verdict

**NOT production-ready.** The release candidate is code-complete and locally tested, but it must not be deployed until payment configuration is approved, a backup restore is proven, staging acceptance passes, and the founder approves the release.
