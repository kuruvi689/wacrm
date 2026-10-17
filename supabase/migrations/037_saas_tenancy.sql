-- ============================================================
-- 037_saas_tenancy.sql — Commercial SaaS layer
--
-- Adds, on top of the existing account-scoped multi-tenancy:
--   * accounts.plan / status / trial_ends_at / limits / onboarding
--   * platform_settings: single row of operator-chosen defaults that
--     every NEW account inherits (trial length, seat + contact caps)
--   * enforcement of seat + contact caps in the database, so every
--     write path (UI, public API, CSV import, MCP) is covered
--
-- Self-host safe: with platform_settings left at its defaults (all
-- NULL) new accounts are 'active', have no trial and no limits, so
-- behaviour is unchanged. Existing accounts are grandfathered the
-- same way.
--
-- Billing is intentionally NOT part of this migration; `plan` is a
-- free-text label the operator sets until a payment provider exists.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status_enum') THEN
    CREATE TYPE account_status_enum AS ENUM ('trialing', 'active', 'suspended');
  END IF;
END $$;

-- Accounts that existed before this migration have already been using
-- the product; don't push them through onboarding. This must run ONLY
-- the first time (when the column is added) — on a re-run it would
-- wrongly mark brand-new, still-onboarding tenants as done.
DO $$
DECLARE
  v_first_run BOOLEAN := NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'onboarding_completed_at'
  );
BEGIN
  -- NULL limit = unlimited.
  ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS status account_status_enum NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS max_members INTEGER CHECK (max_members IS NULL OR max_members >= 1),
    ADD COLUMN IF NOT EXISTS max_contacts INTEGER CHECK (max_contacts IS NULL OR max_contacts >= 0),
    ADD COLUMN IF NOT EXISTS suspended_reason TEXT,
    ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

  IF v_first_run THEN
    UPDATE accounts SET onboarding_completed_at = created_at;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

-- ============================================================
-- PLATFORM SETTINGS — one row, written only by the service role
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  default_trial_days INTEGER CHECK (default_trial_days IS NULL OR default_trial_days > 0),
  default_max_members INTEGER CHECK (default_max_members IS NULL OR default_max_members >= 1),
  default_max_contacts INTEGER CHECK (default_max_contacts IS NULL OR default_max_contacts >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- RLS on with no policies: only the service role (which bypasses
-- RLS) can read or write. Tenants must never see operator config.
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- NEW ACCOUNTS INHERIT THE OPERATOR DEFAULTS
-- ============================================================
CREATE OR REPLACE FUNCTION public.apply_platform_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings platform_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_settings FROM platform_settings WHERE id;

  IF FOUND THEN
    IF NEW.max_members IS NULL THEN
      NEW.max_members := v_settings.default_max_members;
    END IF;
    IF NEW.max_contacts IS NULL THEN
      NEW.max_contacts := v_settings.default_max_contacts;
    END IF;
    IF v_settings.default_trial_days IS NOT NULL AND NEW.trial_ends_at IS NULL THEN
      NEW.trial_ends_at := NOW() + make_interval(days => v_settings.default_trial_days);
      NEW.status := 'trialing';
      NEW.plan := 'trial';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apply_platform_defaults ON accounts;
CREATE TRIGGER apply_platform_defaults
  BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.apply_platform_defaults();

-- ============================================================
-- LIMIT ENFORCEMENT
--
-- Errors use ERRCODE 'P0001' with a stable machine-readable message
-- prefix ('plan_limit:') so the app can map them to a friendly
-- "upgrade your plan" response.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_contact_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_count BIGINT;
BEGIN
  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT max_contacts INTO v_limit FROM accounts WHERE id = NEW.account_id;
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_count FROM contacts WHERE account_id = NEW.account_id;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'plan_limit: contacts (% of % used)', v_count, v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_contact_limit ON contacts;
CREATE TRIGGER enforce_contact_limit
  BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contact_limit();

CREATE OR REPLACE FUNCTION public.enforce_member_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_count BIGINT;
BEGIN
  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Only when the profile is joining an account (insert, or the
  -- account_id actually changes) — not on unrelated profile edits.
  IF TG_OP = 'UPDATE' AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id THEN
    RETURN NEW;
  END IF;

  SELECT max_members INTO v_limit FROM accounts WHERE id = NEW.account_id;
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_count FROM profiles WHERE account_id = NEW.account_id;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'plan_limit: members (% of % used)', v_count, v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_member_limit ON profiles;
CREATE TRIGGER enforce_member_limit
  BEFORE INSERT OR UPDATE OF account_id ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_member_limit();

-- ============================================================
-- Let an account owner/admin mark onboarding done without opening
-- up UPDATE on the whole accounts row (plan/limits/status stay
-- operator-only because tenants have no UPDATE policy on them).
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_onboarding()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id
  FROM profiles
  WHERE user_id = auth.uid() AND account_role IN ('owner', 'admin');

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Only an account owner or admin can complete onboarding'
      USING ERRCODE = '42501';
  END IF;

  UPDATE accounts
  SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW())
  WHERE id = v_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_onboarding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_onboarding() TO authenticated;

-- ============================================================
-- TENANTS MUST NOT EDIT THEIR OWN PLAN
--
-- The existing `accounts_update` RLS policy lets any account admin
-- UPDATE the whole row. Without this guard a tenant could raise its
-- own limits or un-suspend itself straight through PostgREST. Only
-- requests that are NOT end-user sessions (service role, migrations,
-- direct DB) may change these columns.
-- ============================================================
CREATE OR REPLACE FUNCTION public.protect_account_plan_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(auth.role(), '') IN ('authenticated', 'anon') AND (
       NEW.plan IS DISTINCT FROM OLD.plan
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
    OR NEW.max_members IS DISTINCT FROM OLD.max_members
    OR NEW.max_contacts IS DISTINCT FROM OLD.max_contacts
    OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason
  ) THEN
    RAISE EXCEPTION 'Plan, status and limits can only be changed by the platform operator'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_account_plan_columns ON accounts;
CREATE TRIGGER protect_account_plan_columns
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.protect_account_plan_columns();

-- ============================================================
-- OPERATOR OVERVIEW — one round trip for the /admin console
-- Callable by the service role only.
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_account_overview()
RETURNS TABLE (
  id UUID,
  name TEXT,
  owner_email TEXT,
  plan TEXT,
  status account_status_enum,
  trial_ends_at TIMESTAMPTZ,
  max_members INTEGER,
  max_contacts INTEGER,
  suspended_reason TEXT,
  created_at TIMESTAMPTZ,
  member_count BIGINT,
  contact_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id,
    a.name,
    u.email::TEXT AS owner_email,
    a.plan,
    a.status,
    a.trial_ends_at,
    a.max_members,
    a.max_contacts,
    a.suspended_reason,
    a.created_at,
    (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id) AS member_count,
    (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contact_count
  FROM accounts a
  LEFT JOIN auth.users u ON u.id = a.owner_user_id
  ORDER BY a.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.admin_account_overview() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_account_overview() TO service_role;
