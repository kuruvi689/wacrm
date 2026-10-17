-- ============================================================
-- 038_revoke_internal_function_access.sql
--
-- Hosted Supabase grants EXECUTE on new public functions directly to
-- `anon` and `authenticated` (default privileges), so `REVOKE ... FROM
-- PUBLIC` alone does not hide a SECURITY DEFINER function from the
-- REST API: anyone with the public anon key could call
-- /rest/v1/rpc/<name>. The Supabase security advisor flags these.
--
-- This migration closes that for functions that are internal:
--   * service-role-only helpers (called by the webhook deliverer, the
--     AI auto-reply bot, and admin maintenance) — callable ONLY by
--     service_role;
--   * trigger functions — never meant to be called directly; trigger
--     execution does not need EXECUTE for the invoking role, so
--     revoking is safe;
--   * complete_onboarding — signed-in users only (not anon).
-- Functions the dashboard legitimately calls as a signed-in user
-- (is_account_member, peek/redeem_invitation, set_member_role,
-- remove_account_member, transfer_account_ownership, touch_presence,
-- filter_contacts_by_tags, match_ai_knowledge_*) are left unchanged.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Service-role-only helpers ------------------------------------
REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, integer)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, integer)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts()             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations()        FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer)  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer)     TO service_role;
GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer)       TO service_role;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_contacts()             TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_conversations()        TO service_role;

-- Trigger functions: not callable through the REST API ---------
REVOKE ALL ON FUNCTION public.apply_platform_defaults()               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_contact_limit()                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_member_limit()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_conversation_assigned()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.broadcast_recipient_aggregate_trigger() FROM PUBLIC, anon, authenticated;

-- Onboarding: signed-in users only -----------------------------
REVOKE ALL ON FUNCTION public.complete_onboarding() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_onboarding() TO authenticated;

-- Pin the search_path of the plan-protection trigger -----------
ALTER FUNCTION public.protect_account_plan_columns() SET search_path = public;
