# Running wacrm as a multi-tenant SaaS

wacrm is account-scoped by design: every row carries an `account_id`
and RLS isolates tenants. Migration `037_saas_tenancy.sql` adds the
operator layer on top. **Billing is intentionally not included yet** —
plans are labels and limits the operator sets by hand.

## What a client experiences

1. Signs up at `/signup` → gets their own workspace automatically.
2. Lands on `/onboarding` (name the workspace, connect WhatsApp, invite
   the team). Every step is skippable.
3. Uses the product within their plan limits. If the trial ends or the
   workspace is suspended they see `/account-blocked` (data is kept).

## What you (the operator) get

Open `/admin` (404 for everyone else):

- All workspaces with owner email, status, members, contacts, trial end.
- Per workspace: plan label, max members, max contacts, **extend
  trial**, **activate**, **suspend**.
- **New-signup defaults**: trial days, member cap, contact cap that
  every future signup inherits.

### Setup

1. Apply `supabase/migrations/037_saas_tenancy.sql`.
2. Set `PLATFORM_ADMIN_EMAILS=you@yourdomain.com` (comma-separated) and
   redeploy. Sign in with that email to see `/admin`.
3. In `/admin` → *New-signup defaults*, set e.g. 14 trial days,
   3 members, 1000 contacts. Leave all empty to keep self-host
   behaviour (no trial, no limits).

Existing accounts are grandfathered: `active`, unlimited, onboarding
skipped.

## How enforcement works

| Rule | Where it is enforced |
|---|---|
| Suspended / expired trial blocks the dashboard | `(dashboard)/layout.tsx` redirect |
| …and blocks every cookie-auth API route | `getCurrentAccount()` |
| …and blocks public-API / MCP keys | `requireApiKey()` |
| Contact cap | Postgres trigger on `contacts` (covers UI, CSV import, API, MCP) |
| Member cap | Postgres trigger on `profiles` (covers invite acceptance) |
| Tenants can't edit their own plan/limits/status | Postgres trigger on `accounts` (the existing `accounts_update` RLS policy would otherwise allow it) |

Hitting a cap raises a Postgres error with the prefix `plan_limit:`.

## Not done yet (known gaps)

- **Payments / plan self-service** — by request, deferred.
- **Friendly "upgrade" UX when a cap is hit** — the DB blocks the write
  but most screens will show a generic failure toast.
- **Meta Embedded Signup token exchange** — the button opens Meta's
  dialog but the returned `code` is not yet exchanged for a token, so
  clients still connect WhatsApp via the manual credential form.
- **Localisation** of the new pages (`/onboarding`, `/admin`,
  `/account-blocked`) — English only.
- **Transactional email** (welcome, trial-ending reminders).
- **Per-tenant custom domains / white-label branding.**
