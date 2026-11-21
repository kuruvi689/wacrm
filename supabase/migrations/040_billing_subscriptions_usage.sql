-- ============================================================
-- 040_billing_subscriptions_usage.sql — paid SaaS core
--
-- Adds, without changing any existing behaviour:
--   * plans                — configurable limits; price NULL = not for sale
--   * subscriptions        — one current row per account, explicit states
--   * invoices / payment_attempts / billing_ledger (append-only)
--   * payment_provider_events — webhook dedup + replay protection
--   * billing_audit_log    — every operator action (append-only)
--   * usage_counters / usage_reservations — reserve → commit/release quotas
--   * rate_limit_buckets   — shared, atomic fixed-window limiter
--   * inbound_message_claims — WhatsApp wamid idempotency
--   * deferred_work        — quota-blocked work kept for later resume
--
-- Backward compatibility: an account with NO subscription row keeps
-- today's behaviour (accounts.status / trial_ends_at gate access,
-- usage is metered but never blocked). Operators move accounts onto a
-- plan explicitly; nothing is migrated automatically.
--
-- Money is integer minor units. No prices are seeded: the founder sets
-- them. Every write function is service-role only; tenants can READ
-- their own billing rows and nothing else.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status_enum') THEN
    CREATE TYPE subscription_status_enum AS ENUM (
      'trialing', 'pending_payment', 'active', 'past_due', 'grace',
      'suspended', 'cancelled', 'expired'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status_enum') THEN
    CREATE TYPE invoice_status_enum AS ENUM ('open', 'paid', 'void', 'expired', 'refunded');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_kind_enum') THEN
    CREATE TYPE invoice_kind_enum AS ENUM ('new', 'renewal', 'upgrade', 'downgrade');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_attempt_status_enum') THEN
    CREATE TYPE payment_attempt_status_enum AS ENUM (
      'awaiting_customer', 'pending_verification', 'verified',
      'rejected', 'expired', 'cancelled'
    );
  END IF;
END $$;

-- ============================================================
-- PLANS
-- NULL limit = unlimited. Limits are per account; monthly_* reset on
-- the 1st of each calendar month (UTC).
-- ============================================================
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  price_minor BIGINT CHECK (price_minor IS NULL OR price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  period_days INTEGER NOT NULL DEFAULT 30 CHECK (period_days BETWEEN 1 AND 366),
  grace_days INTEGER NOT NULL DEFAULT 3 CHECK (grace_days BETWEEN 0 AND 60),
  max_ai_agents INTEGER CHECK (max_ai_agents IS NULL OR max_ai_agents >= 0),
  max_whatsapp_numbers INTEGER CHECK (max_whatsapp_numbers IS NULL OR max_whatsapp_numbers >= 0),
  max_members INTEGER CHECK (max_members IS NULL OR max_members >= 1),
  max_contacts INTEGER CHECK (max_contacts IS NULL OR max_contacts >= 0),
  max_active_automations INTEGER CHECK (max_active_automations IS NULL OR max_active_automations >= 0),
  max_integrations INTEGER CHECK (max_integrations IS NULL OR max_integrations >= 0),
  knowledge_storage_mb INTEGER CHECK (knowledge_storage_mb IS NULL OR knowledge_storage_mb >= 0),
  monthly_messages BIGINT CHECK (monthly_messages IS NULL OR monthly_messages >= 0),
  monthly_ai_responses BIGINT CHECK (monthly_ai_responses IS NULL OR monthly_ai_responses >= 0),
  monthly_ai_tokens BIGINT CHECK (monthly_ai_tokens IS NULL OR monthly_ai_tokens >= 0),
  monthly_workflow_runs BIGINT CHECK (monthly_workflow_runs IS NULL OR monthly_workflow_runs >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Internal plan for operator-granted unlimited access. Never sold.
INSERT INTO plans (id, name, description, is_active, is_public)
VALUES ('unlimited', 'Unlimited (operator grant)', 'Internal: no limits, not for sale.', TRUE, FALSE)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_select ON plans;
-- Signed-in users can see what is for sale (the plan picker).
CREATE POLICY plans_select ON plans FOR SELECT TO authenticated
  USING (is_active AND is_public);
REVOKE INSERT, UPDATE, DELETE ON plans FROM anon, authenticated;

-- ============================================================
-- SUBSCRIPTIONS — one current row per account
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  -- Downgrade chosen by the customer; billed at the next renewal.
  pending_plan_id TEXT REFERENCES plans(id),
  status subscription_status_enum NOT NULL,
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  grace_ends_at TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at TIMESTAMPTZ,
  suspended_reason TEXT,
  -- Bumped on every change; lets callers detect concurrent edits.
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (current_period_end IS NULL OR current_period_start IS NULL OR current_period_end > current_period_start)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status_period ON subscriptions(status, current_period_end);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_select ON subscriptions;
CREATE POLICY subscriptions_select ON subscriptions FOR SELECT
  USING (is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON subscriptions FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS subscription_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  from_status subscription_status_enum,
  to_status subscription_status_enum NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'operator', 'customer')),
  actor_user_id UUID,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_account ON subscription_events(account_id, created_at DESC);

ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_events_select ON subscription_events;
CREATE POLICY subscription_events_select ON subscription_events FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE INSERT, UPDATE, DELETE ON subscription_events FROM anon, authenticated;

-- ============================================================
-- INVOICES
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT NOT NULL UNIQUE DEFAULT ('INV-' || to_char(NOW(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0')),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  kind invoice_kind_enum NOT NULL,
  status invoice_status_enum NOT NULL DEFAULT 'open',
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  credit_minor BIGINT NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_days INTEGER NOT NULL CHECK (period_days BETWEEN 1 AND 366),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

-- At most one open invoice per account: concurrent checkouts collapse
-- onto the same invoice instead of creating two bills.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_one_open_per_account
  ON invoices(account_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_invoices_account_created ON invoices(account_id, created_at DESC);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoices_select ON invoices;
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE INSERT, UPDATE, DELETE ON invoices FROM anon, authenticated;

-- ============================================================
-- PAYMENT ATTEMPTS — a request for money, never proof of money
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  -- Payment adapter that created the request (src/lib/billing/providers).
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^[A-Z0-9]{6,35}$'),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status payment_attempt_status_enum NOT NULL DEFAULT 'awaiting_customer',
  provider_session_id TEXT,
  checkout_url TEXT,
  upi_uri TEXT,
  -- What the customer SAYS they paid with. A hint for the operator only.
  customer_utr TEXT,
  customer_submitted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  verified_by UUID,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_invoice ON payment_attempts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_customer_utr ON payment_attempts(customer_utr) WHERE customer_utr IS NOT NULL;

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_attempts_select ON payment_attempts;
CREATE POLICY payment_attempts_select ON payment_attempts FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE INSERT, UPDATE, DELETE ON payment_attempts FROM anon, authenticated;

-- ============================================================
-- BILLING LEDGER — append-only financial truth
-- settlement > 0, refund < 0, adjustment either sign.
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  invoice_id UUID REFERENCES invoices(id) ON DELETE RESTRICT,
  payment_attempt_id UUID REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('settlement', 'refund', 'adjustment')),
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  bank_utr TEXT,
  received_into TEXT,
  received_at TIMESTAMPTZ,
  recorded_by UUID,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (entry_type <> 'settlement' OR (amount_minor > 0 AND bank_utr IS NOT NULL)),
  CHECK (entry_type <> 'refund' OR amount_minor < 0)
);
-- A bank transaction can settle exactly one payment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_ledger_settlement_utr
  ON billing_ledger(bank_utr) WHERE entry_type = 'settlement';
CREATE INDEX IF NOT EXISTS idx_billing_ledger_account ON billing_ledger(account_id, created_at DESC);

ALTER TABLE billing_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_ledger_select ON billing_ledger;
CREATE POLICY billing_ledger_select ON billing_ledger FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE INSERT, UPDATE, DELETE ON billing_ledger FROM anon, authenticated;

-- ============================================================
-- PROVIDER WEBHOOK EVENTS — dedup + replay protection
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_provider_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payment_attempt_id UUID REFERENCES payment_attempts(id) ON DELETE SET NULL,
  payload_sha256 TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, event_id)
);
ALTER TABLE payment_provider_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_provider_events FROM anon, authenticated;

-- ============================================================
-- BILLING AUDIT LOG — every operator decision
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id UUID,
  actor_email TEXT,
  action TEXT NOT NULL,
  account_id UUID,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_audit_account ON billing_audit_log(account_id, created_at DESC);
ALTER TABLE billing_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing_audit_log FROM anon, authenticated;

-- Append-only guard for financial history. Even the service role
-- cannot rewrite it; corrections are new entries.
CREATE OR REPLACE FUNCTION public.billing_forbid_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS billing_ledger_append_only ON billing_ledger;
CREATE TRIGGER billing_ledger_append_only
  BEFORE UPDATE OR DELETE ON billing_ledger
  FOR EACH ROW EXECUTE FUNCTION public.billing_forbid_mutation();

DROP TRIGGER IF EXISTS billing_audit_append_only ON billing_audit_log;
CREATE TRIGGER billing_audit_append_only
  BEFORE UPDATE OR DELETE ON billing_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.billing_forbid_mutation();

DROP TRIGGER IF EXISTS subscription_events_append_only ON subscription_events;
CREATE TRIGGER subscription_events_append_only
  BEFORE UPDATE OR DELETE ON subscription_events
  FOR EACH ROW EXECUTE FUNCTION public.billing_forbid_mutation();

-- ============================================================
-- STATE MACHINE — mirror of src/lib/billing/subscription-state.ts
-- ============================================================
CREATE OR REPLACE FUNCTION public.billing_next_status(
  p_from subscription_status_enum,
  p_event TEXT
) RETURNS subscription_status_enum
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_from = 'trialing' AND p_event = 'checkout_started' THEN 'pending_payment'
    WHEN p_from = 'trialing' AND p_event = 'payment_settled' THEN 'active'
    WHEN p_from = 'trialing' AND p_event = 'period_ended' THEN 'expired'
    WHEN p_from = 'pending_payment' AND p_event = 'payment_settled' THEN 'active'
    WHEN p_from = 'pending_payment' AND p_event = 'period_ended' THEN 'expired'
    WHEN p_from = 'active' AND p_event = 'payment_settled' THEN 'active'
    WHEN p_from = 'active' AND p_event = 'period_ended' THEN 'past_due'
    WHEN p_from = 'past_due' AND p_event = 'payment_settled' THEN 'active'
    WHEN p_from = 'past_due' AND p_event = 'grace_started' THEN 'grace'
    WHEN p_from = 'grace' AND p_event = 'payment_settled' THEN 'active'
    WHEN p_from = 'grace' AND p_event = 'grace_ended' THEN 'expired'
    WHEN p_from = 'suspended' AND p_event = 'reinstate' THEN 'active'
    WHEN p_from IN ('cancelled', 'expired') AND p_event = 'reactivate_checkout' THEN 'pending_payment'
    WHEN p_from IN ('cancelled', 'expired') AND p_event = 'payment_settled' THEN 'active'
    WHEN p_from IN ('trialing', 'pending_payment', 'active', 'past_due', 'grace')
         AND p_event = 'suspend' THEN 'suspended'
    WHEN p_from IN ('trialing', 'pending_payment', 'active', 'past_due', 'grace', 'suspended', 'expired')
         AND p_event = 'cancel' THEN 'cancelled'
    ELSE NULL
  END::subscription_status_enum;
$$;

-- Apply one event to an account's subscription. Locks the row, checks
-- the transition, writes the event history and keeps accounts.status
-- in step (only 'suspended' locks the workspace).
CREATE OR REPLACE FUNCTION public.billing_apply_event(
  p_account_id UUID,
  p_event TEXT,
  p_actor_kind TEXT,
  p_actor_user_id UUID,
  p_reason TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub subscriptions%ROWTYPE;
  v_from subscription_status_enum;
  v_to subscription_status_enum;
  v_grace INTEGER;
BEGIN
  SELECT * INTO v_sub FROM subscriptions WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing: no subscription for account %', p_account_id USING ERRCODE = 'P0002';
  END IF;

  v_from := v_sub.status;
  v_to := billing_next_status(v_from, p_event);
  IF v_to IS NULL THEN
    RAISE EXCEPTION 'billing: illegal transition % --%--> ?', v_sub.status, p_event USING ERRCODE = 'P0001';
  END IF;

  SELECT grace_days INTO v_grace FROM plans WHERE id = v_sub.plan_id;

  UPDATE subscriptions SET
    status = v_to,
    grace_ends_at = CASE WHEN v_to = 'grace' THEN NOW() + make_interval(days => COALESCE(v_grace, 0))
                         WHEN v_to = 'active' THEN NULL ELSE grace_ends_at END,
    cancelled_at = CASE WHEN v_to = 'cancelled' THEN NOW() ELSE cancelled_at END,
    suspended_reason = CASE WHEN v_to = 'suspended' THEN p_reason
                            WHEN p_event = 'reinstate' THEN NULL ELSE suspended_reason END,
    version = version + 1,
    updated_at = NOW()
  WHERE id = v_sub.id
  RETURNING * INTO v_sub;

  INSERT INTO subscription_events (subscription_id, account_id, event, from_status, to_status, actor_kind, actor_user_id, reason, metadata)
  VALUES (v_sub.id, p_account_id, p_event, v_from, v_to, p_actor_kind, p_actor_user_id, p_reason, p_metadata);

  UPDATE accounts SET
    status = CASE WHEN v_to = 'suspended' THEN 'suspended'::account_status_enum ELSE 'active'::account_status_enum END,
    suspended_reason = CASE WHEN v_to = 'suspended' THEN p_reason ELSE NULL END
  WHERE id = p_account_id
    AND status IS DISTINCT FROM (CASE WHEN v_to = 'suspended' THEN 'suspended' ELSE 'active' END)::account_status_enum;

  RETURN v_sub;
END;
$$;

-- Keep the legacy accounts columns (read by the existing gates and the
-- contact/member limit triggers) in step with the subscription's plan.
CREATE OR REPLACE FUNCTION public.billing_sync_account_from_plan(
  p_account_id UUID,
  p_plan_id TEXT,
  p_trial_ends_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan plans%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM plans WHERE id = p_plan_id;
  UPDATE accounts SET
    plan = p_plan_id,
    max_members = v_plan.max_members,
    max_contacts = v_plan.max_contacts,
    trial_ends_at = p_trial_ends_at
  WHERE id = p_account_id;
END;
$$;

-- ============================================================
-- CHECKOUT — open (or reuse) the invoice for a plan change
--
-- The amount is derived HERE from the plan price, not taken from the
-- caller: amount = plan.price_minor - credit (credit only for upgrades,
-- capped at the price). The TypeScript layer computes the credit with
-- the founder-approved proration policy.
-- ============================================================
CREATE OR REPLACE FUNCTION public.billing_open_checkout(
  p_account_id UUID,
  p_plan_id TEXT,
  p_kind invoice_kind_enum,
  p_credit_minor BIGINT,
  p_actor_user_id UUID,
  p_invoice_ttl_hours INTEGER DEFAULT 72
) RETURNS invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan plans%ROWTYPE;
  v_sub subscriptions%ROWTYPE;
  v_invoice invoices%ROWTYPE;
  v_amount BIGINT;
  v_credit BIGINT := GREATEST(COALESCE(p_credit_minor, 0), 0);
BEGIN
  -- One checkout at a time per account.
  PERFORM 1 FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing: unknown account' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_plan FROM plans WHERE id = p_plan_id AND is_active;
  IF NOT FOUND OR v_plan.price_minor IS NULL THEN
    RAISE EXCEPTION 'billing: plan_not_for_sale' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind = 'downgrade' THEN
    RAISE EXCEPTION 'billing: downgrades are scheduled, not invoiced' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind <> 'upgrade' THEN
    v_credit := 0;
  END IF;
  v_amount := GREATEST(v_plan.price_minor - LEAST(v_credit, v_plan.price_minor), 0);
  IF v_amount = 0 THEN
    RAISE EXCEPTION 'billing: zero-amount checkout must be granted by an operator' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_sub FROM subscriptions WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO subscriptions (account_id, plan_id, status)
    VALUES (p_account_id, p_plan_id, 'pending_payment')
    RETURNING * INTO v_sub;
    INSERT INTO subscription_events (subscription_id, account_id, event, from_status, to_status, actor_kind, actor_user_id, reason)
    VALUES (v_sub.id, p_account_id, 'checkout_started', NULL, 'pending_payment', 'customer', p_actor_user_id, 'first checkout');
  ELSIF v_sub.status = 'suspended' THEN
    RAISE EXCEPTION 'billing: subscription suspended' USING ERRCODE = 'P0001';
  ELSIF v_sub.status = 'trialing' THEN
    v_sub := billing_apply_event(p_account_id, 'checkout_started', 'customer', p_actor_user_id, NULL);
  ELSIF v_sub.status IN ('cancelled', 'expired') THEN
    v_sub := billing_apply_event(p_account_id, 'reactivate_checkout', 'customer', p_actor_user_id, NULL);
  END IF;

  IF p_kind = 'renewal' AND p_plan_id NOT IN (v_sub.plan_id, COALESCE(v_sub.pending_plan_id, v_sub.plan_id)) THEN
    RAISE EXCEPTION 'billing: renewal must be for the current or scheduled plan' USING ERRCODE = 'P0001';
  END IF;

  -- Reuse an identical open invoice (double click, retry); otherwise
  -- void the stale one so the account never holds two open bills.
  SELECT * INTO v_invoice FROM invoices WHERE account_id = p_account_id AND status = 'open' FOR UPDATE;
  IF FOUND THEN
    IF v_invoice.plan_id = p_plan_id AND v_invoice.kind = p_kind AND v_invoice.amount_minor = v_amount
       AND v_invoice.expires_at > NOW() THEN
      RETURN v_invoice;
    END IF;
    IF EXISTS (SELECT 1 FROM payment_attempts WHERE invoice_id = v_invoice.id AND status = 'pending_verification') THEN
      RAISE EXCEPTION 'billing: a payment for the open invoice is waiting for verification' USING ERRCODE = 'P0001';
    END IF;
    UPDATE payment_attempts SET status = 'cancelled', updated_at = NOW()
      WHERE invoice_id = v_invoice.id AND status = 'awaiting_customer';
    UPDATE invoices SET status = 'void', voided_at = NOW(), updated_at = NOW() WHERE id = v_invoice.id;
  END IF;

  INSERT INTO invoices (account_id, subscription_id, plan_id, kind, amount_minor, credit_minor, currency, period_days, expires_at, created_by)
  VALUES (p_account_id, v_sub.id, p_plan_id, p_kind, v_amount, LEAST(v_credit, v_plan.price_minor), v_plan.currency,
          v_plan.period_days, NOW() + make_interval(hours => GREATEST(p_invoice_ttl_hours, 1)), p_actor_user_id)
  RETURNING * INTO v_invoice;

  RETURN v_invoice;
END;
$$;

-- Schedule a cheaper plan for the next renewal. No money moves.
CREATE OR REPLACE FUNCTION public.billing_schedule_downgrade(
  p_account_id UUID,
  p_plan_id TEXT,
  p_actor_user_id UUID
) RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM subscriptions WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_sub.status NOT IN ('active', 'past_due', 'grace') THEN
    RAISE EXCEPTION 'billing: no paid subscription to downgrade' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM plans WHERE id = p_plan_id AND is_active AND price_minor IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing: plan_not_for_sale' USING ERRCODE = 'P0001';
  END IF;

  UPDATE subscriptions SET
    pending_plan_id = CASE WHEN p_plan_id = plan_id THEN NULL ELSE p_plan_id END,
    version = version + 1, updated_at = NOW()
  WHERE id = v_sub.id RETURNING * INTO v_sub;

  INSERT INTO subscription_events (subscription_id, account_id, event, from_status, to_status, actor_kind, actor_user_id, metadata)
  VALUES (v_sub.id, p_account_id, 'downgrade_scheduled', v_sub.status, v_sub.status, 'customer', p_actor_user_id,
          jsonb_build_object('pending_plan_id', v_sub.pending_plan_id));
  RETURN v_sub;
END;
$$;

-- ============================================================
-- PAYMENT ATTEMPTS
-- ============================================================
CREATE OR REPLACE FUNCTION public.billing_create_payment_attempt(
  p_invoice_id UUID,
  p_account_id UUID,
  p_provider TEXT,
  p_idempotency_key TEXT,
  p_reference TEXT,
  p_upi_uri TEXT,
  p_checkout_url TEXT,
  p_provider_session_id TEXT,
  p_ttl_minutes INTEGER DEFAULT 30
) RETURNS payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_attempt payment_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_attempt FROM payment_attempts WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_attempt.invoice_id <> p_invoice_id OR v_attempt.account_id <> p_account_id THEN
      RAISE EXCEPTION 'billing: idempotency key reused for a different invoice' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_attempt;
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR v_invoice.account_id <> p_account_id THEN
    RAISE EXCEPTION 'billing: invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invoice.status <> 'open' OR v_invoice.expires_at <= NOW() THEN
    RAISE EXCEPTION 'billing: invoice_not_open' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO payment_attempts (invoice_id, account_id, provider, idempotency_key, reference, amount_minor, currency,
                                upi_uri, checkout_url, provider_session_id, expires_at)
  VALUES (p_invoice_id, p_account_id, p_provider, p_idempotency_key, p_reference, v_invoice.amount_minor,
          v_invoice.currency, p_upi_uri, p_checkout_url, p_provider_session_id,
          LEAST(NOW() + make_interval(mins => GREATEST(p_ttl_minutes, 5)), v_invoice.expires_at))
  RETURNING * INTO v_attempt;
  RETURN v_attempt;
END;
$$;

-- Customer says "I paid, here is my UTR". Records a CLAIM only.
CREATE OR REPLACE FUNCTION public.billing_submit_customer_utr(
  p_attempt_id UUID,
  p_account_id UUID,
  p_utr TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt payment_attempts%ROWTYPE;
  v_utr TEXT := upper(regexp_replace(COALESCE(p_utr, ''), '[\s-]', '', 'g'));
BEGIN
  IF v_utr !~ '^[A-Z0-9]{10,22}$' THEN
    RAISE EXCEPTION 'billing: invalid_utr' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_attempt FROM payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.account_id <> p_account_id THEN
    RAISE EXCEPTION 'billing: payment attempt not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_attempt.status NOT IN ('awaiting_customer', 'pending_verification', 'expired') THEN
    RAISE EXCEPTION 'billing: attempt_not_open' USING ERRCODE = 'P0001';
  END IF;

  UPDATE payment_attempts SET
    customer_utr = v_utr,
    customer_submitted_at = NOW(),
    status = 'pending_verification',
    updated_at = NOW()
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object(
    'status', 'pending_verification',
    'utr_already_settled', EXISTS (SELECT 1 FROM billing_ledger WHERE bank_utr = v_utr AND entry_type = 'settlement'),
    'utr_claimed_elsewhere', EXISTS (SELECT 1 FROM payment_attempts WHERE customer_utr = v_utr AND id <> p_attempt_id)
  );
END;
$$;

-- ============================================================
-- SETTLEMENT — the ONLY way an invoice becomes paid
--
-- Called after a billing operator has seen the money in the receiving
-- bank account. Re-checks everything inside one transaction, writes
-- the ledger (unique UTR), pays the invoice and extends the plan.
-- ============================================================
CREATE OR REPLACE FUNCTION public.billing_settle_payment(
  p_attempt_id UUID,
  p_bank_utr TEXT,
  p_amount_minor BIGINT,
  p_currency TEXT,
  p_received_into TEXT,
  p_received_at TIMESTAMPTZ,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_note TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt payment_attempts%ROWTYPE;
  v_invoice invoices%ROWTYPE;
  v_sub subscriptions%ROWTYPE;
  v_from subscription_status_enum;
  v_to subscription_status_enum;
  v_start TIMESTAMPTZ;
  v_utr TEXT := upper(regexp_replace(COALESCE(p_bank_utr, ''), '[\s-]', '', 'g'));
BEGIN
  IF v_utr !~ '^[A-Z0-9]{10,22}$' THEN
    RAISE EXCEPTION 'billing: invalid_utr' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_attempt FROM payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing: payment attempt not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_attempt.status NOT IN ('awaiting_customer', 'pending_verification', 'expired') THEN
    RAISE EXCEPTION 'billing: attempt_not_verifiable' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = v_attempt.invoice_id FOR UPDATE;
  IF v_invoice.status <> 'open' THEN
    RAISE EXCEPTION 'billing: invoice_not_open' USING ERRCODE = 'P0001';
  END IF;
  IF p_currency IS DISTINCT FROM v_invoice.currency OR p_currency IS DISTINCT FROM v_attempt.currency THEN
    RAISE EXCEPTION 'billing: currency_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_minor IS DISTINCT FROM v_invoice.amount_minor OR p_amount_minor IS DISTINCT FROM v_attempt.amount_minor THEN
    RAISE EXCEPTION 'billing: amount_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF p_received_at IS NULL OR p_received_at > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'billing: received_in_future' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_sub FROM subscriptions WHERE id = v_invoice.subscription_id FOR UPDATE;
  v_from := v_sub.status;
  v_to := billing_next_status(v_from, 'payment_settled');
  IF v_to IS NULL THEN
    -- e.g. suspended: an operator must reinstate (or refund) first.
    RAISE EXCEPTION 'billing: subscription is % — reinstate it before settling', v_from USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO billing_ledger (account_id, invoice_id, payment_attempt_id, entry_type, amount_minor, currency,
                                bank_utr, received_into, received_at, recorded_by, note)
    VALUES (v_attempt.account_id, v_invoice.id, v_attempt.id, 'settlement', p_amount_minor, p_currency,
            v_utr, p_received_into, p_received_at, p_actor_user_id, p_note);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'billing: duplicate_utr' USING ERRCODE = 'P0001';
  END;

  UPDATE payment_attempts SET status = 'verified', verified_at = NOW(), verified_by = p_actor_user_id, updated_at = NOW()
    WHERE id = v_attempt.id;
  UPDATE payment_attempts SET status = 'cancelled', updated_at = NOW()
    WHERE invoice_id = v_invoice.id AND id <> v_attempt.id AND status IN ('awaiting_customer', 'pending_verification', 'expired');
  UPDATE invoices SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = v_invoice.id;

  v_start := CASE
    WHEN v_invoice.kind = 'renewal' AND v_sub.current_period_end IS NOT NULL AND v_sub.current_period_end > NOW()
      THEN v_sub.current_period_end
    ELSE NOW()
  END;

  UPDATE subscriptions SET
    plan_id = v_invoice.plan_id,
    pending_plan_id = CASE WHEN pending_plan_id = v_invoice.plan_id THEN NULL ELSE pending_plan_id END,
    status = v_to,
    current_period_start = v_start,
    current_period_end = v_start + make_interval(days => v_invoice.period_days),
    trial_ends_at = NULL,
    grace_ends_at = NULL,
    cancel_at_period_end = FALSE,
    cancelled_at = NULL,
    version = version + 1,
    updated_at = NOW()
  WHERE id = v_sub.id
  RETURNING * INTO v_sub;

  INSERT INTO subscription_events (subscription_id, account_id, event, from_status, to_status, actor_kind, actor_user_id, metadata)
  VALUES (v_sub.id, v_sub.account_id, 'payment_settled', v_from, v_to, 'operator', p_actor_user_id,
          jsonb_build_object('invoice_id', v_invoice.id, 'kind', v_invoice.kind, 'period_end', v_sub.current_period_end));

  PERFORM billing_sync_account_from_plan(v_sub.account_id, v_sub.plan_id, NULL);
  UPDATE accounts SET status = 'active', suspended_reason = NULL WHERE id = v_sub.account_id AND status <> 'active';

  INSERT INTO billing_audit_log (actor_user_id, actor_email, action, account_id, target_type, target_id, details)
  VALUES (p_actor_user_id, p_actor_email, 'payment.settled', v_sub.account_id, 'payment_attempt', v_attempt.id::text,
          jsonb_build_object('invoice', v_invoice.number, 'amount_minor', p_amount_minor, 'currency', p_currency,
                             'utr', v_utr, 'received_into', p_received_into, 'received_at', p_received_at,
                             'customer_utr', v_attempt.customer_utr, 'note', p_note));

  RETURN jsonb_build_object('invoice_id', v_invoice.id, 'invoice_number', v_invoice.number,
                            'subscription_status', v_to, 'plan_id', v_sub.plan_id,
                            'current_period_end', v_sub.current_period_end);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_reject_attempt(
  p_attempt_id UUID,
  p_reason TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT
) RETURNS payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt payment_attempts%ROWTYPE;
BEGIN
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'billing: a rejection reason is required' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_attempt FROM payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing: payment attempt not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_attempt.status NOT IN ('awaiting_customer', 'pending_verification', 'expired') THEN
    RAISE EXCEPTION 'billing: attempt_not_open' USING ERRCODE = 'P0001';
  END IF;

  UPDATE payment_attempts SET status = 'rejected', rejected_reason = p_reason, verified_by = p_actor_user_id,
    updated_at = NOW()
  WHERE id = p_attempt_id RETURNING * INTO v_attempt;

  INSERT INTO billing_audit_log (actor_user_id, actor_email, action, account_id, target_type, target_id, details)
  VALUES (p_actor_user_id, p_actor_email, 'payment.rejected', v_attempt.account_id, 'payment_attempt',
          v_attempt.id::text, jsonb_build_object('reason', p_reason, 'customer_utr', v_attempt.customer_utr));
  RETURN v_attempt;
END;
$$;

-- Refunds are recorded after the money has actually been sent back.
-- They never change the plan on their own: the operator decides
-- whether to cancel or suspend as a separate, audited action.
CREATE OR REPLACE FUNCTION public.billing_record_refund(
  p_invoice_id UUID,
  p_amount_minor BIGINT,
  p_bank_reference TEXT,
  p_reason TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_net BIGINT;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'billing: refund amount must be positive' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'billing: a refund reason is required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR v_invoice.status NOT IN ('paid', 'refunded') THEN
    RAISE EXCEPTION 'billing: only paid invoices can be refunded' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_net
    FROM billing_ledger WHERE invoice_id = p_invoice_id AND entry_type IN ('settlement', 'refund');
  IF p_amount_minor > v_net THEN
    RAISE EXCEPTION 'billing: refund exceeds the net amount paid (%)', v_net USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO billing_ledger (account_id, invoice_id, entry_type, amount_minor, currency, bank_utr, recorded_by, note)
  VALUES (v_invoice.account_id, p_invoice_id, 'refund', -p_amount_minor, v_invoice.currency,
          NULLIF(upper(regexp_replace(COALESCE(p_bank_reference, ''), '[\s-]', '', 'g')), ''), p_actor_user_id, p_reason);

  IF p_amount_minor = v_net THEN
    UPDATE invoices SET status = 'refunded', updated_at = NOW() WHERE id = p_invoice_id;
  END IF;

  INSERT INTO billing_audit_log (actor_user_id, actor_email, action, account_id, target_type, target_id, details)
  VALUES (p_actor_user_id, p_actor_email, 'invoice.refunded', v_invoice.account_id, 'invoice', p_invoice_id::text,
          jsonb_build_object('amount_minor', p_amount_minor, 'reference', p_bank_reference, 'reason', p_reason,
                             'net_after', v_net - p_amount_minor));

  RETURN jsonb_build_object('invoice_id', p_invoice_id, 'net_paid_minor', v_net - p_amount_minor,
                            'fully_refunded', p_amount_minor = v_net);
END;
$$;

-- ============================================================
-- OPERATOR TOOLS (audited)
-- ============================================================

-- Put an account on a plan without payment: start a trial, grant a
-- complimentary period, or correct an entitlement. Always audited.
CREATE OR REPLACE FUNCTION public.billing_admin_set_subscription(
  p_account_id UUID,
  p_plan_id TEXT,
  p_status subscription_status_enum,
  p_ends_at TIMESTAMPTZ,
  p_reason TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT
) RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub subscriptions%ROWTYPE;
  v_from subscription_status_enum;
BEGIN
  IF p_status NOT IN ('trialing', 'active') THEN
    RAISE EXCEPTION 'billing: operators set trialing or active; use events for other states' USING ERRCODE = 'P0001';
  END IF;
  IF p_ends_at IS NULL OR p_ends_at <= NOW() THEN
    RAISE EXCEPTION 'billing: end date must be in the future' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'billing: a reason is required' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM plans WHERE id = p_plan_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing: unknown or inactive plan' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_sub FROM subscriptions WHERE account_id = p_account_id FOR UPDATE;

  IF NOT FOUND THEN
    v_from := NULL;
    INSERT INTO subscriptions (account_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
    VALUES (p_account_id, p_plan_id, p_status,
            CASE WHEN p_status = 'trialing' THEN p_ends_at END,
            CASE WHEN p_status = 'active' THEN NOW() END,
            CASE WHEN p_status = 'active' THEN p_ends_at END)
    RETURNING * INTO v_sub;
  ELSE
    v_from := v_sub.status;
    UPDATE subscriptions SET
      plan_id = p_plan_id,
      pending_plan_id = NULL,
      status = p_status,
      trial_ends_at = CASE WHEN p_status = 'trialing' THEN p_ends_at END,
      current_period_start = CASE WHEN p_status = 'active' THEN LEAST(COALESCE(current_period_start, NOW()), NOW()) END,
      current_period_end = CASE WHEN p_status = 'active' THEN p_ends_at END,
      grace_ends_at = NULL,
      cancel_at_period_end = FALSE,
      cancelled_at = NULL,
      suspended_reason = NULL,
      version = version + 1,
      updated_at = NOW()
    WHERE id = v_sub.id
    RETURNING * INTO v_sub;
  END IF;

  INSERT INTO subscription_events (subscription_id, account_id, event, from_status, to_status, actor_kind, actor_user_id, reason, metadata)
  VALUES (v_sub.id, p_account_id, 'operator_override', v_from, p_status, 'operator', p_actor_user_id, p_reason,
          jsonb_build_object('plan_id', p_plan_id, 'ends_at', p_ends_at));

  PERFORM billing_sync_account_from_plan(p_account_id, p_plan_id, CASE WHEN p_status = 'trialing' THEN p_ends_at END);
  UPDATE accounts SET
    status = (CASE WHEN p_status = 'trialing' THEN 'trialing' ELSE 'active' END)::account_status_enum,
    suspended_reason = NULL
  WHERE id = p_account_id;

  INSERT INTO billing_audit_log (actor_user_id, actor_email, action, account_id, target_type, target_id, details)
  VALUES (p_actor_user_id, p_actor_email, 'subscription.override', p_account_id, 'subscription', v_sub.id::text,
          jsonb_build_object('from_status', v_from, 'to_status', p_status, 'plan_id', p_plan_id,
                             'ends_at', p_ends_at, 'reason', p_reason));
  RETURN v_sub;
END;
$$;

-- suspend / reinstate / cancel by an operator, audited.
CREATE OR REPLACE FUNCTION public.billing_admin_event(
  p_account_id UUID,
  p_event TEXT,
  p_reason TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT
) RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub subscriptions%ROWTYPE;
BEGIN
  IF p_event NOT IN ('suspend', 'reinstate', 'cancel') THEN
    RAISE EXCEPTION 'billing: operators may only suspend, reinstate or cancel' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'billing: a reason is required' USING ERRCODE = 'P0001';
  END IF;

  v_sub := billing_apply_event(p_account_id, p_event, 'operator', p_actor_user_id, p_reason);

  INSERT INTO billing_audit_log (actor_user_id, actor_email, action, account_id, target_type, target_id, details)
  VALUES (p_actor_user_id, p_actor_email, 'subscription.' || p_event, p_account_id, 'subscription', v_sub.id::text,
          jsonb_build_object('to_status', v_sub.status, 'reason', p_reason));
  RETURN v_sub;
END;
$$;

-- Customer cancels: service continues to the end of the paid period.
CREATE OR REPLACE FUNCTION public.billing_cancel_at_period_end(
  p_account_id UUID,
  p_cancel BOOLEAN,
  p_actor_user_id UUID
) RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM subscriptions WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_sub.status NOT IN ('active', 'past_due', 'grace', 'trialing') THEN
    RAISE EXCEPTION 'billing: nothing to cancel' USING ERRCODE = 'P0001';
  END IF;
  UPDATE subscriptions SET cancel_at_period_end = p_cancel, version = version + 1, updated_at = NOW()
    WHERE id = v_sub.id RETURNING * INTO v_sub;
  INSERT INTO subscription_events (subscription_id, account_id, event, from_status, to_status, actor_kind, actor_user_id)
  VALUES (v_sub.id, p_account_id, CASE WHEN p_cancel THEN 'cancel_scheduled' ELSE 'cancel_withdrawn' END,
          v_sub.status, v_sub.status, 'customer', p_actor_user_id);
  RETURN v_sub;
END;
$$;

-- ============================================================
-- ENTITLEMENTS — what an account may do right now
--
-- No subscription row  → legacy: today's accounts.status/trial gate,
--                         unlimited, metered but never blocked.
-- With a subscription  → its status + plan limits.
-- ============================================================
CREATE OR REPLACE FUNCTION public.billing_entitlements(p_account_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub subscriptions%ROWTYPE;
  v_plan plans%ROWTYPE;
  v_acc RECORD;
BEGIN
  SELECT * INTO v_sub FROM subscriptions WHERE account_id = p_account_id;
  IF NOT FOUND THEN
    SELECT status, trial_ends_at INTO v_acc FROM accounts WHERE id = p_account_id;
    RETURN jsonb_build_object(
      'source', 'legacy',
      'status', v_acc.status,
      'chargeable', v_acc.status = 'active'
                    OR (v_acc.status = 'trialing' AND (v_acc.trial_ends_at IS NULL OR v_acc.trial_ends_at > NOW())),
      'plan_id', NULL,
      'limits', '{}'::jsonb
    );
  END IF;

  SELECT * INTO v_plan FROM plans WHERE id = v_sub.plan_id;
  RETURN jsonb_build_object(
    'source', 'subscription',
    'status', v_sub.status,
    'chargeable', v_sub.status IN ('trialing', 'active', 'past_due', 'grace')
                  AND NOT (v_sub.status = 'trialing' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at <= NOW()),
    'plan_id', v_sub.plan_id,
    'pending_plan_id', v_sub.pending_plan_id,
    'current_period_end', v_sub.current_period_end,
    'trial_ends_at', v_sub.trial_ends_at,
    'grace_ends_at', v_sub.grace_ends_at,
    'cancel_at_period_end', v_sub.cancel_at_period_end,
    'limits', jsonb_strip_nulls(jsonb_build_object(
      'max_ai_agents', v_plan.max_ai_agents,
      'max_whatsapp_numbers', v_plan.max_whatsapp_numbers,
      'max_members', v_plan.max_members,
      'max_contacts', v_plan.max_contacts,
      'max_active_automations', v_plan.max_active_automations,
      'max_integrations', v_plan.max_integrations,
      'knowledge_storage_mb', v_plan.knowledge_storage_mb,
      'messages', v_plan.monthly_messages,
      'ai_responses', v_plan.monthly_ai_responses,
      'ai_tokens', v_plan.monthly_ai_tokens,
      'workflow_runs', v_plan.monthly_workflow_runs
    ))
  );
END;
$$;

-- ============================================================
-- USAGE METERING — reserve → commit / release
--
-- Monthly metrics reset on the 1st (UTC). A reservation holds quota
-- while expensive work runs; commit records what was really used;
-- release returns it (failure). Each reservation carries a caller
-- idempotency key (e.g. 'ai_reply:<wamid>'), so a retried WhatsApp
-- delivery can never be charged twice. Unreleased reservations of a
-- crashed worker expire and are returned by billing_reconcile().
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_counters (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('messages', 'ai_responses', 'ai_tokens', 'workflow_runs')),
  period_start DATE NOT NULL,
  used BIGINT NOT NULL DEFAULT 0 CHECK (used >= 0),
  reserved BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  -- Attempts refused because of the quota, for the usage dashboard.
  blocked BIGINT NOT NULL DEFAULT 0 CHECK (blocked >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, metric, period_start)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_counters_select ON usage_counters;
CREATE POLICY usage_counters_select ON usage_counters FOR SELECT
  USING (is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON usage_counters FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS usage_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  period_start DATE NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  amount BIGINT NOT NULL CHECK (amount > 0),
  committed_amount BIGINT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  UNIQUE (account_id, metric, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_usage_reservations_open ON usage_reservations(expires_at) WHERE status = 'reserved';

ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON usage_reservations FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.usage_metric_limit(p_account_id UUID, p_metric TEXT)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_metric
    WHEN 'messages' THEN p.monthly_messages
    WHEN 'ai_responses' THEN p.monthly_ai_responses
    WHEN 'ai_tokens' THEN p.monthly_ai_tokens
    WHEN 'workflow_runs' THEN p.monthly_workflow_runs
  END
  FROM subscriptions s JOIN plans p ON p.id = s.plan_id
  WHERE s.account_id = p_account_id;
$$;

CREATE OR REPLACE FUNCTION public.usage_reserve(
  p_account_id UUID,
  p_metric TEXT,
  p_amount BIGINT,
  p_idempotency_key TEXT,
  p_ttl_seconds INTEGER DEFAULT 300
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period DATE := date_trunc('month', NOW() AT TIME ZONE 'UTC')::date;
  v_counter usage_counters%ROWTYPE;
  v_existing usage_reservations%ROWTYPE;
  v_limit BIGINT;
  v_ent JSONB;
  v_id UUID;
BEGIN
  IF p_metric NOT IN ('messages', 'ai_responses', 'ai_tokens', 'workflow_runs') THEN
    RAISE EXCEPTION 'usage: unknown metric %', p_metric USING ERRCODE = 'P0001';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'usage: amount must be positive' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO usage_counters (account_id, metric, period_start)
  VALUES (p_account_id, p_metric, v_period)
  ON CONFLICT DO NOTHING;
  -- The counter row lock serialises every reservation for this
  -- account+metric+month, so concurrent workers cannot overshoot.
  SELECT * INTO v_counter FROM usage_counters
    WHERE account_id = p_account_id AND metric = p_metric AND period_start = v_period FOR UPDATE;

  SELECT * INTO v_existing FROM usage_reservations
    WHERE account_id = p_account_id AND metric = p_metric AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', v_existing.status <> 'released', 'duplicate', TRUE,
                              'reservation_id', v_existing.id, 'status', v_existing.status);
  END IF;

  v_ent := billing_entitlements(p_account_id);
  IF NOT (v_ent->>'chargeable')::boolean THEN
    UPDATE usage_counters SET blocked = blocked + 1, updated_at = NOW()
      WHERE account_id = p_account_id AND metric = p_metric AND period_start = v_period;
    RETURN jsonb_build_object('ok', FALSE, 'duplicate', FALSE, 'reason', 'subscription_inactive',
                              'status', v_ent->>'status');
  END IF;

  v_limit := usage_metric_limit(p_account_id, p_metric);
  IF v_limit IS NOT NULL AND v_counter.used + v_counter.reserved + p_amount > v_limit THEN
    UPDATE usage_counters SET blocked = blocked + 1, updated_at = NOW()
      WHERE account_id = p_account_id AND metric = p_metric AND period_start = v_period;
    RETURN jsonb_build_object('ok', FALSE, 'duplicate', FALSE, 'reason', 'quota_exceeded',
                              'used', v_counter.used, 'reserved', v_counter.reserved, 'limit', v_limit);
  END IF;

  UPDATE usage_counters SET reserved = reserved + p_amount, updated_at = NOW()
    WHERE account_id = p_account_id AND metric = p_metric AND period_start = v_period;
  INSERT INTO usage_reservations (account_id, metric, period_start, idempotency_key, amount, status, expires_at)
  VALUES (p_account_id, p_metric, v_period, p_idempotency_key, p_amount, 'reserved',
          NOW() + make_interval(secs => GREATEST(p_ttl_seconds, 10)))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', TRUE, 'duplicate', FALSE, 'reservation_id', v_id,
                            'used', v_counter.used, 'reserved', v_counter.reserved + p_amount, 'limit', v_limit);
END;
$$;

-- Settle a reservation. p_actual NULL = the reserved amount. Actual
-- may exceed the reservation (e.g. a longer AI answer): it is recorded
-- in full, because the provider already billed us for it.
CREATE OR REPLACE FUNCTION public.usage_commit(p_reservation_id UUID, p_actual BIGINT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res usage_reservations%ROWTYPE;
  v_actual BIGINT;
BEGIN
  SELECT * INTO v_res FROM usage_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_found');
  END IF;
  IF v_res.status <> 'reserved' THEN
    RETURN jsonb_build_object('ok', v_res.status = 'committed', 'reason', 'already_' || v_res.status);
  END IF;
  v_actual := GREATEST(COALESCE(p_actual, v_res.amount), 0);

  UPDATE usage_counters SET
    reserved = GREATEST(reserved - v_res.amount, 0),
    used = used + v_actual,
    updated_at = NOW()
  WHERE account_id = v_res.account_id AND metric = v_res.metric AND period_start = v_res.period_start;
  UPDATE usage_reservations SET status = 'committed', committed_amount = v_actual, settled_at = NOW()
    WHERE id = v_res.id;
  RETURN jsonb_build_object('ok', TRUE, 'committed', v_actual);
END;
$$;

CREATE OR REPLACE FUNCTION public.usage_release(p_reservation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res usage_reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_res FROM usage_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_found');
  END IF;
  IF v_res.status <> 'reserved' THEN
    RETURN jsonb_build_object('ok', v_res.status = 'released', 'reason', 'already_' || v_res.status);
  END IF;
  UPDATE usage_counters SET reserved = GREATEST(reserved - v_res.amount, 0), updated_at = NOW()
    WHERE account_id = v_res.account_id AND metric = v_res.metric AND period_start = v_res.period_start;
  UPDATE usage_reservations SET status = 'released', settled_at = NOW() WHERE id = v_res.id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

-- Meter something that must never be blocked (an inbound customer
-- message is always stored). Idempotent by key; counts over the limit.
CREATE OR REPLACE FUNCTION public.usage_record(
  p_account_id UUID,
  p_metric TEXT,
  p_amount BIGINT,
  p_idempotency_key TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period DATE := date_trunc('month', NOW() AT TIME ZONE 'UTC')::date;
  v_inserted INTEGER;
BEGIN
  IF p_metric NOT IN ('messages', 'ai_responses', 'ai_tokens', 'workflow_runs') OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'usage: invalid record' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO usage_reservations (account_id, metric, period_start, idempotency_key, amount, committed_amount,
                                  status, expires_at, settled_at)
  VALUES (p_account_id, p_metric, v_period, p_idempotency_key, p_amount, p_amount, 'committed', NOW(), NOW())
  ON CONFLICT (account_id, metric, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN FALSE;
  END IF;
  INSERT INTO usage_counters (account_id, metric, period_start, used)
  VALUES (p_account_id, p_metric, v_period, p_amount)
  ON CONFLICT (account_id, metric, period_start)
  DO UPDATE SET used = usage_counters.used + EXCLUDED.used, updated_at = NOW();
  RETURN TRUE;
END;
$$;

-- ============================================================
-- SHARED RATE LIMITER — fixed window, atomic upsert
-- Works across every serverless instance (unlike the in-memory Map).
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT NOT NULL CHECK (length(bucket_key) BETWEEN 1 AND 200),
  window_start TIMESTAMPTZ NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rate_limit_buckets FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  p_key TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window INTEGER := GREATEST(p_window_seconds, 1);
  v_start TIMESTAMPTZ := to_timestamp(floor(extract(epoch FROM NOW()) / v_window) * v_window);
  v_hits INTEGER;
BEGIN
  INSERT INTO rate_limit_buckets (bucket_key, window_start, hits)
  VALUES (p_key, v_start, 1)
  ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = rate_limit_buckets.hits + 1
  RETURNING hits INTO v_hits;

  RETURN jsonb_build_object(
    'allowed', v_hits <= p_limit,
    'remaining', GREATEST(p_limit - v_hits, 0),
    'reset_at', v_start + make_interval(secs => v_window),
    'limit', p_limit
  );
END;
$$;

-- ============================================================
-- WHATSAPP INBOUND IDEMPOTENCY — Meta retries deliveries
-- ============================================================
CREATE TABLE IF NOT EXISTS inbound_message_claims (
  phone_number_id TEXT NOT NULL,
  wamid TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (phone_number_id, wamid)
);
CREATE INDEX IF NOT EXISTS idx_inbound_message_claims_claimed ON inbound_message_claims(claimed_at);
ALTER TABLE inbound_message_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbound_message_claims FROM anon, authenticated;

-- TRUE the first time a message is seen, FALSE for a redelivery.
CREATE OR REPLACE FUNCTION public.claim_inbound_message(
  p_phone_number_id TEXT,
  p_wamid TEXT,
  p_account_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  INSERT INTO inbound_message_claims (phone_number_id, wamid, account_id)
  VALUES (p_phone_number_id, p_wamid, p_account_id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

-- ============================================================
-- DEFERRED WORK — chargeable work blocked by quota or billing.
-- The customer message is always stored; this row remembers that the
-- AI/automation did not run, so it can resume after renewal.
-- ============================================================
CREATE TABLE IF NOT EXISTS deferred_work (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ai_reply')),
  reference TEXT NOT NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL CHECK (reason IN ('quota_exceeded', 'subscription_inactive')),
  status TEXT NOT NULL DEFAULT 'blocked' CHECK (status IN ('blocked', 'resumed', 'dropped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (kind, reference)
);
CREATE INDEX IF NOT EXISTS idx_deferred_work_blocked ON deferred_work(account_id, created_at) WHERE status = 'blocked';

ALTER TABLE deferred_work ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deferred_work_select ON deferred_work;
CREATE POLICY deferred_work_select ON deferred_work FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE INSERT, UPDATE, DELETE ON deferred_work FROM anon, authenticated;

-- ============================================================
-- NOTIFICATIONS — let billing and quota alerts reach owners/admins
-- ============================================================
DO $$
DECLARE
  v_name TEXT;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.notifications'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%conversation_assigned%'
  LOOP
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'quota_exhausted', 'billing'));

-- At most one alert of a type per account every 6 hours.
CREATE OR REPLACE FUNCTION public.billing_notify_admins(
  p_account_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_body TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM notifications WHERE account_id = p_account_id AND type = p_type
             AND created_at > NOW() - INTERVAL '6 hours') THEN
    RETURN 0;
  END IF;
  INSERT INTO notifications (account_id, user_id, type, title, body)
  SELECT p_account_id, p.user_id, p_type, p_title, p_body
  FROM profiles p
  WHERE p.account_id = p_account_id AND p.account_role IN ('owner', 'admin');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ============================================================
-- RECONCILIATION — run by the billing cron; safe to run any time,
-- any number of times. Repairs anything a missed event left behind.
-- ============================================================
CREATE OR REPLACE FUNCTION public.billing_reconcile()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_attempts INTEGER;
  v_invoices INTEGER;
  v_transitions INTEGER := 0;
  v_released INTEGER := 0;
  v_event TEXT;
BEGIN
  UPDATE payment_attempts SET status = 'expired', updated_at = NOW()
    WHERE status = 'awaiting_customer' AND expires_at <= NOW();
  GET DIAGNOSTICS v_attempts = ROW_COUNT;

  -- Open invoices past their deadline expire unless a customer has
  -- reported a payment that staff still have to check.
  UPDATE invoices i SET status = 'expired', updated_at = NOW()
    WHERE i.status = 'open' AND i.expires_at <= NOW()
      AND NOT EXISTS (SELECT 1 FROM payment_attempts a
                      WHERE a.invoice_id = i.id AND a.status = 'pending_verification');
  GET DIAGNOSTICS v_invoices = ROW_COUNT;

  FOR v_row IN
    SELECT s.account_id, s.status, s.cancel_at_period_end, s.current_period_end, s.grace_ends_at, s.trial_ends_at
    FROM subscriptions s
    WHERE (s.status = 'active' AND s.current_period_end <= NOW())
       OR s.status = 'past_due'
       OR (s.status = 'grace' AND s.grace_ends_at <= NOW())
       OR (s.status = 'trialing' AND s.trial_ends_at <= NOW())
    FOR UPDATE SKIP LOCKED
  LOOP
    v_event := CASE
      WHEN v_row.status = 'active' AND v_row.cancel_at_period_end THEN 'cancel'
      WHEN v_row.status IN ('active', 'trialing') THEN 'period_ended'
      WHEN v_row.status = 'past_due' THEN 'grace_started'
      WHEN v_row.status = 'grace' THEN 'grace_ended'
    END;
    PERFORM billing_apply_event(v_row.account_id, v_event, 'system', NULL, 'scheduled reconciliation');
    v_transitions := v_transitions + 1;

    IF v_event IN ('period_ended', 'grace_ended') THEN
      PERFORM billing_notify_admins(v_row.account_id, 'billing',
        CASE WHEN v_event = 'grace_ended' THEN 'Your subscription has expired'
             ELSE 'Your subscription needs renewal' END,
        'Renew from Settings → Billing to keep AI replies and automations running.');
    END IF;
  END LOOP;

  WITH expired AS (
    SELECT id FROM usage_reservations WHERE status = 'reserved' AND expires_at <= NOW()
    FOR UPDATE SKIP LOCKED
  )
  SELECT COUNT(*) INTO v_released FROM expired, LATERAL usage_release(expired.id);

  DELETE FROM rate_limit_buckets WHERE window_start < NOW() - INTERVAL '1 day';
  DELETE FROM inbound_message_claims WHERE claimed_at < NOW() - INTERVAL '7 days';

  RETURN jsonb_build_object('attempts_expired', v_attempts, 'invoices_expired', v_invoices,
                            'subscription_transitions', v_transitions, 'reservations_released', v_released);
END;
$$;

-- ============================================================
-- GRANTS — every function above is server-only.
-- ============================================================
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'billing_forbid_mutation()',
    'billing_next_status(subscription_status_enum, text)',
    'billing_apply_event(uuid, text, text, uuid, text, jsonb)',
    'billing_sync_account_from_plan(uuid, text, timestamptz)',
    'billing_open_checkout(uuid, text, invoice_kind_enum, bigint, uuid, integer)',
    'billing_schedule_downgrade(uuid, text, uuid)',
    'billing_create_payment_attempt(uuid, uuid, text, text, text, text, text, text, integer)',
    'billing_submit_customer_utr(uuid, uuid, text)',
    'billing_settle_payment(uuid, text, bigint, text, text, timestamptz, uuid, text, text)',
    'billing_reject_attempt(uuid, text, uuid, text)',
    'billing_record_refund(uuid, bigint, text, text, uuid, text)',
    'billing_admin_set_subscription(uuid, text, subscription_status_enum, timestamptz, text, uuid, text)',
    'billing_admin_event(uuid, text, text, uuid, text)',
    'billing_cancel_at_period_end(uuid, boolean, uuid)',
    'billing_entitlements(uuid)',
    'usage_metric_limit(uuid, text)',
    'usage_reserve(uuid, text, bigint, text, integer)',
    'usage_commit(uuid, bigint)',
    'usage_release(uuid)',
    'usage_record(uuid, text, bigint, text)',
    'rate_limit_hit(text, integer, integer)',
    'claim_inbound_message(text, text, uuid)',
    'billing_notify_admins(uuid, text, text, text)',
    'billing_reconcile()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', v_fn);
  END LOOP;
END $$;
