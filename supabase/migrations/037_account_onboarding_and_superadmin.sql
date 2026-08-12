-- ============================================================
-- 037_account_onboarding_and_superadmin.sql
--
-- 1. Add `onboarding_completed_at` to accounts to track completion of
--    the onboarding wizard (business name setup + WhatsApp connection).
-- 2. Backfill existing accounts that have a connected whatsapp_config row
--    so existing accounts are marked as onboarding complete.
-- 3. Add `is_super_admin` flag on profiles table for platform oversight.
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

-- Create helper function for super admin evaluation
CREATE OR REPLACE FUNCTION is_super_admin(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT is_super_admin FROM profiles WHERE id = p_user_id),
    false
  );
$$;
