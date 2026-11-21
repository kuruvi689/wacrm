-- ============================================================
-- 041_account_security_hardening.sql
--
-- Three database-level gaps found in the pre-release security audit:
--
--   1. Account admins could rewrite accounts.owner_user_id through the
--      `accounts_update` RLS policy (017). redeem_invitation (019) and
--      the public API (audit user resolution) both TRUST that column,
--      so an admin could point it at any user id. It is now writable
--      only by non-end-user sessions (service role, migrations) or by
--      transfer_account_ownership, which flips a transaction-local flag.
--
--   2. redeem_invitation deletes the joiner's old personal account when
--      it looks "empty", but the emptiness check was a hand-written list
--      that predates products, orders, api_keys, webhook_endpoints,
--      ai_configs, quick_replies, ai_knowledge_*, billing tables, etc.
--      Their ON DELETE CASCADE would have wiped that data silently. The
--      check now inspects EVERY public table that has an account_id
--      column, so tables added in future migrations are covered too.
--
--   3. Hosted Supabase grants EXECUTE on new public functions directly
--      to `anon` (default privileges), so `REVOKE ... FROM PUBLIC` in
--      018/019/024/025/030 did not hide them from the REST API for
--      signed-out callers (migration 038 already did this for the
--      internal helpers). Revoke anon from the remaining signed-in-only
--      functions. peek_invitation stays anon-callable by design (the
--      /join/<token> page calls it before sign-in).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. OWNERSHIP POINTER IS NOT USER-WRITABLE
--
-- Only requests that are NOT end-user sessions (service role,
-- migrations, direct DB) may change accounts.owner_user_id, plus the
-- transfer RPC below, which opts in for its own transaction via
-- set_config('wacrm.owner_transfer', 'on', true). The setting is
-- transaction-local and PostgREST clients cannot issue SET / set_config
-- themselves (pg_catalog functions are not exposed over /rpc).
--
-- Legitimate owner_user_id writers (audited: src/ and all migrations):
--   * INSERT in handle_new_user (017) and remove_account_member (018)
--     — inserts, not updates, so this trigger does not apply;
--   * UPDATE in transfer_account_ownership (018) — handled here.
-- ============================================================
CREATE OR REPLACE FUNCTION public.protect_account_owner_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     AND COALESCE(auth.role(), '') IN ('authenticated', 'anon')
     AND COALESCE(current_setting('wacrm.owner_transfer', true), '') <> 'on'
  THEN
    RAISE EXCEPTION 'Account ownership can only be changed through an ownership transfer'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_account_owner_column() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS protect_account_owner_column ON accounts;
CREATE TRIGGER protect_account_owner_column
  BEFORE UPDATE OF owner_user_id ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.protect_account_owner_column();

-- transfer_account_ownership: body identical to migration 018 except
-- for the single set_config line before the accounts UPDATE.
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_new_owner_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Demote current owner first so the temporary state where the
  -- account has zero owners is never visible — both writes happen
  -- in the same function transaction.
  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = auth.uid();

  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id;

  -- Authorise the owner_user_id change for this transaction only
  -- (see protect_account_owner_column above).
  PERFORM set_config('wacrm.owner_transfer', 'on', true);

  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = v_caller_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;

-- ============================================================
-- 2. redeem_invitation: COMPLETE "EMPTY ACCOUNT" CHECK
--
-- Body identical to migration 019 except the hand-written EXISTS list
-- is replaced by a scan of every public base table with an account_id
-- column. Skipped (never user data, or recreated automatically):
--   profiles            - the caller's own row, moved just below;
--   account_invitations - invites the empty account sent, now moot;
--   member_presence     - the caller's own heartbeat row;
--   notifications       - system generated;
--   subscriptions,
--   subscription_events - platform-created trial/billing bookkeeping.
-- Billing tables that record real money (invoices, payment_attempts,
-- billing_ledger) are NOT skipped, so an account with payment history
-- is refused with the same clear error instead of hitting an FK error.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN := FALSE;
  v_table TEXT;
  v_ignored TEXT[] := ARRAY[
    'profiles', 'account_invitations', 'member_presence',
    'notifications', 'subscriptions', 'subscription_events'
  ];
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if ANY table holds
  -- rows for it — joining would orphan their contacts, deals, orders,
  -- API keys, AI config, etc. Discovered from the catalog so new
  -- account-scoped tables are covered without touching this function.
  FOR v_table IN
    SELECT c.relname::TEXT
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p')
      AND a.attname = 'account_id'
      AND NOT a.attisdropped
      AND c.relname <> ALL (v_ignored)
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE account_id = $1)',
      v_table
    ) INTO v_has_data USING v_old_account_id;
    EXIT WHEN v_has_data;
  END LOOP;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — only bookkeeping rows
  -- (presence, notifications, trial subscription, its own invites)
  -- cascade away with it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;

-- ============================================================
-- 3. NO ANON EXECUTE ON SIGNED-IN-ONLY FUNCTIONS
--
-- Guarded with to_regprocedure so a function that does not exist in
-- some environment never aborts the migration. `authenticated` (and
-- `service_role` where 030/032 granted it) keep their grants.
-- peek_invitation(TEXT) is deliberately NOT listed: anon by design.
-- is_account_member(UUID, account_role_enum) is also left alone: RLS
-- policies call it and must keep evaluating for every role.
-- ============================================================
DO $$
DECLARE
  v_sig TEXT;
  v_sigs TEXT[] := ARRAY[
    'public.set_member_role(uuid, account_role_enum)',         -- 018
    'public.remove_account_member(uuid)',                      -- 018
    'public.transfer_account_ownership(uuid)',                 -- 018
    'public.redeem_invitation(text)',                          -- 019
    'public.touch_presence(text)',                             -- 024
    'public.filter_contacts_by_tags(uuid[], text, int, int)',  -- 025
    'public.match_ai_knowledge_fts(uuid, text, integer)',      -- 030/032
    'public.match_ai_knowledge_semantic(uuid, text, integer)'  -- 030/032
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
    END IF;
  END LOOP;

  -- Service-role callers (AI retrieval runs server-side) keep access.
  IF to_regprocedure('public.match_ai_knowledge_fts(uuid, text, integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.match_ai_knowledge_semantic(uuid, text, integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO service_role;
  END IF;
END $$;
