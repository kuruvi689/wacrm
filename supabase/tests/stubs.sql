-- Minimal Supabase + earlier-migration stubs used by billing-migration.test.ts.
-- Only what migration 040 needs to apply: roles, the auth schema, and the
-- tenant tables it references. Not a copy of the real schema.

CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
CREATE TYPE account_role_enum AS ENUM ('owner','admin','agent','viewer');
CREATE TYPE account_status_enum AS ENUM ('trialing','active','suspended');
CREATE TABLE accounts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, owner_user_id UUID,
  plan TEXT NOT NULL DEFAULT 'free', status account_status_enum NOT NULL DEFAULT 'active', trial_ends_at TIMESTAMPTZ,
  max_members INT, max_contacts INT, suspended_reason TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE profiles (user_id UUID PRIMARY KEY, account_id UUID REFERENCES accounts(id), account_role account_role_enum);
CREATE TABLE contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID REFERENCES accounts(id));
CREATE TABLE conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID REFERENCES accounts(id));
CREATE TABLE notifications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id),
  user_id UUID NOT NULL, type TEXT NOT NULL DEFAULT 'conversation_assigned' CHECK (type IN ('conversation_assigned')),
  conversation_id UUID, contact_id UUID, actor_user_id UUID, title TEXT NOT NULL, body TEXT, read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE FUNCTION is_account_member(target_account_id UUID, min_role account_role_enum DEFAULT 'viewer')
  RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT TRUE $$;
