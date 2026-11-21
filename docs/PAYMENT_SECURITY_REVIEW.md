# Payment Security Review

Date: 2026-11-21. Branch: `feat/production-release-candidate`. Author: Claude (engineering), for founder review.

## Decision

WACRM v1 collects subscription payments by **UPI to the business's own account, confirmed by a billing operator who checks the receiving bank statement**. No customer action, screenshot, UTR, SMS, phone notification, browser redirect or gateway callback can mark an invoice paid.

The founder's preferred gateway, [YouPI-PG](https://github.com/youpi-pg/YouPI-PG), was reviewed and is **not used, copied or deployed**. The billing code sits behind a payment-adapter interface (`src/lib/billing/providers.ts`), so a regulated provider can be added later without changing the ledger or the subscription logic.

## YouPI-PG review (HEAD `405327c`, read 2026-11-21)

| Area | Finding | Impact |
|---|---|---|
| License | No `LICENSE` file. GitHub detects no license and `package.json` says `"Commercial"`. Issues #15, #56, #58 and #126 ask for a license; the maintainer's only reply is "contact me on instagram". About 90 outside contributors, no CLA. | **Blocking.** Public source is not a license. With none, all rights are reserved, so we may not copy, modify or deploy it commercially. |
| How "paid" is decided | It reads bank credit alerts: Android SMS and notification listener, Gmail, and a Google Messages Web scraper. It matches on **amount only**, one payer per VPA at a time. It then reports `OBSERVED_SUCCESS` with `NOT_RECONCILED`; reconciliation is an operator-uploaded bank CSV. | **Blocking.** An alert proves nothing about settlement. |
| Issue #141 (open, no maintainer reply) | Forged SMS or notifications mark orders paid. Confirmed in code: `POST /api/v1/pollers/events` accepts any request carrying an `X-Device-Id` header (no HMAC, `apps/payment-api/src/auth-guard.js`), and the Messages Web observer hardcodes `sender: 'Google-Messages-Web'`. Related fixes in PRs #143, #144, #145 and #124 are unmerged. | **Critical.** Anyone who can send an SMS can "pay". |
| Its own docs | `SECURITY_AUDIT.md`: "EXPERIMENTAL; NOT APPROVED FOR REAL-MONEY PRODUCTION". `SECURITY_REMEDIATION_REPORT.md`: "Do not use the current gateway as a source of payment settlement truth". | Agrees with this review. |
| Webhooks | `X-Gateway-Signature` is an HMAC over the body with no timestamp, so it can be replayed. V2 adds a timestamp. It has delivery IDs and an outbox. | A valid signature only proves the gateway sent the message, not that money arrived. |
| Operations | Users report frozen bank accounts (#32, #70). Free hosting tier with SQLite. The admin "simulator" endpoint is disabled only when `NODE_ENV=production`. | Collecting business revenue into a personal account risks a frozen account. |

Ideas we re-implemented ourselves (no code copied): an NPCI `upi://pay` request link, server-generated references, integer paise, idempotent sessions, and timestamped HMAC webhooks.

## Threat model and controls

| Threat | Control | Where |
|---|---|---|
| Client changes the price | Amount computed server-side (`computeInvoice`), then **re-derived inside SQL** from `plans.price_minor` (`billing_open_checkout` takes only a credit, capped at the price). The attempt copies its amount from the invoice. | `invoice-amount.ts`, migration 040 |
| Fake "I paid" (screenshot, UTR, SMS, redirect) | The customer UTR is stored as `customer_utr`, a claim. Only `billing_settle_payment`, called by a platform operator, writes a settlement. | `billing_submit_customer_utr`, `billing_settle_payment` |
| Wrong or short amount | Exact match on invoice, attempt and received amount, in TypeScript (`checkSettlement`) and again in SQL. Under- and over-payments go to manual investigation. | `verification.ts`, 040 |
| Same bank transaction reused | `UNIQUE (bank_utr) WHERE entry_type='settlement'` on the ledger. The API also pre-checks and the queue shows duplicate-UTR warnings. | 040 |
| Money sent to the wrong account | The operator enters the receiving account, which must equal `BILLING_RECEIVING_ACCOUNT`. | `checkSettlement` |
| Payment applied to another tenant | The attempt's account must match the operator's chosen account. Tenant routes take `account_id` from the session, never from the body. | `checkSettlement`, routes |
| Replay or double-click | Idempotency key on attempts; settlement only from open states; one open invoice per account (partial unique index); row locks (`FOR UPDATE`) in every function. | 040 |
| Concurrent checkouts or settlements | The account row is locked during checkout; invoice and attempt rows are locked during settlement; the unique open-invoice index is a backstop. | 040 |
| Tampering with history | `billing_ledger`, `billing_audit_log` and `subscription_events` are append-only: a trigger blocks UPDATE and DELETE even for the service role. Corrections are new entries (refunds, adjustments). | 040 |
| Insider misuse | Every operator action (settle, reject, refund, override, suspend) needs a reason and is written to `billing_audit_log` with actor id and email. | 040 |
| Tenants editing their own plan | All billing tables are read-only to users (RLS SELECT only, writes revoked). Every function is `service_role` only. The 037 trigger still blocks plan, status and limit edits from user sessions. | 040, 037 |
| Webhook forgery (future PSP) | `payment_provider_events` with `UNIQUE (provider, event_id)` for dedup. A future adapter must verify an HMAC over the raw body with a timestamp, compare in constant time, then call the same `billing_settle_payment`, so amount and state checks still apply. No such adapter ships in v1. | 040, `providers.ts` |
| Bank credentials | None are stored. The operator works from the bank's own portal. `received_into` is a masked label, e.g. `HDFC-XX1234`. | — |

## What v1 does not do (and must not be advertised)

- **No automatic recurring UPI.** UPI AutoPay needs an NPCI mandate through a licensed PSP. v1 is manual renewal each period, and the UI says so.
- **No instant activation.** A plan activates when an operator verifies the money, usually within working hours. Tell clients this.
- **No refunds through the app.** Money goes back through the bank; the operator then records it (`billing_record_refund`). A refund never changes the plan by itself.

## Before taking real money (founder decisions)

1. **Receiving account.** It should be a current account in the business's name, not a personal savings account (freeze risk; personal-account UPI is not meant for business collection). Set `BILLING_UPI_VPA`, `BILLING_UPI_PAYEE_NAME` and `BILLING_RECEIVING_ACCOUNT`.
2. **GST and invoicing.** Confirm whether GST must be charged and shown. If so, plan prices must be entered tax-inclusive, or the invoice must gain tax lines. Not built.
3. **Legal pages.** Terms, refund policy and privacy policy for paid plans.
4. **Who operates billing.** List the platform-admin user ids (`PLATFORM_ADMIN_USER_IDS`) who may verify payments.
5. **Longer term.** For automatic collection, use a regulated PSP (Razorpay, Cashfree, PhonePe PG and similar) through a new adapter. Settlement then comes from its verified server-to-server event plus a status re-fetch from its API. It still goes through `billing_settle_payment`.

## Test evidence

- `src/lib/billing/billing.test.ts`: 33 unit tests for the state machine, amounts, UPI link and settlement rules.
- PGlite integration suite (`supabase/tests/billing-migration.test.ts`) runs migration 040 on real Postgres and covers:
  - correct payment, wrong amount, wrong currency, duplicate UTR, replayed settlement;
  - wrong tenant, verification after expiry, refund over net paid, partial and full refunds;
  - append-only ledger and audit log, suspension blocking settlement;
  - reconciliation, and the grants (service-role only).
- Not covered yet: true multi-connection concurrency, because PGlite is single-connection. The row-lock and unique-index design is described above; a staging load test is listed in `docs/PRODUCTION_READINESS.md`.
