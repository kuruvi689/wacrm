-- ============================================================
-- 037_account_onboarding_and_superadmin.sql
--
-- 1. Add `onboarding_completed_at` to accounts to track completion of
--    the onboarding wizard (business name setup + WhatsApp connection).
-- 2. Backfill existing accounts that have a connected whatsapp_config row
--    so existing accounts are marked as onboarding complete.
-- 3. Add `is_super_admin` flag on profiles table for platform oversight.
-- 4. Fix SQL bug: is_super_admin helper function maps user_id (not id).
-- 5. Security fix: extend enforce_profile_privilege_columns trigger to
--    prevent browser users from modifying `is_super_admin`.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Backfill: Any existing account with a connected whatsapp_config is complete.
UPDATE accounts
SET onboarding_completed_at = COALESCE(accounts.created_at, NOW())
FROM whatsapp_config
WHERE whatsapp_config.account_id = accounts.id
  AND whatsapp_config.status = 'connected'
  AND accounts.onboarding_completed_at IS NULL;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false;

-- Create helper function for super admin evaluation (fixed user_id mapping)
CREATE OR REPLACE FUNCTION is_super_admin(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT is_super_admin FROM profiles WHERE user_id = p_user_id),
    false
  );
$$;

-- Security Fix: Extend BEFORE UPDATE trigger on profiles to block client self-promotion to is_super_admin
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id, and is_super_admin cannot be changed directly; use administrative RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();
