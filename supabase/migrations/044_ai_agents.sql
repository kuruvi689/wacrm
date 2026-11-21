-- ============================================================
-- 044_ai_agents.sql — named AI agents with immutable versions,
-- tool-call audit log, and richer AI usage logging.
--
-- Model
--   - `ai_agents`         one row per agent. At most ONE agent per
--                         account may be 'active' (partial unique
--                         index) — that agent answers WhatsApp
--                         auto-replies. 'paused' stops replies at once.
--   - `ai_agent_versions` immutable snapshots of an agent's behaviour
--                         (model, prompt, knowledge, constraints, tool
--                         permissions). Editing an agent INSERTS a new
--                         version; rollback just points
--                         `ai_agents.current_version_id` at an older one.
--   - `ai_agent_events`   small audit trail (created / version_created /
--                         rollback / status changes) — this is where
--                         rollbacks are recorded.
--   - `ai_tool_calls`     one row per tool invocation by an agent.
--                         Arguments are summarised (keys + sizes), never
--                         stored verbatim, so no customer text lands here.
--
-- Provider API keys STAY in `ai_configs` (AES-GCM encrypted, never sent
-- to the browser). Versions only choose provider + model.
--
-- RLS: members read; writes happen from server routes with the service
-- role after requireRole('admin'), so `authenticated` has no write
-- policies. Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ai_agents
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description        text,
  role               text,
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'testing', 'active', 'paused')),
  current_version_id uuid,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_account ON ai_agents(account_id, created_at);

-- At most one active agent per account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agents_one_active
  ON ai_agents(account_id) WHERE status = 'active';

-- ------------------------------------------------------------
-- 2. ai_agent_versions (immutable)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agent_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version_number       integer NOT NULL CHECK (version_number >= 1),
  provider             text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model                text NOT NULL,
  temperature          numeric(3, 2) NOT NULL DEFAULT 0.4
                         CHECK (temperature >= 0 AND temperature <= 2),
  max_output_tokens    integer NOT NULL DEFAULT 1024
                         CHECK (max_output_tokens BETWEEN 64 AND 4096),
  context_message_limit integer NOT NULL DEFAULT 20
                         CHECK (context_message_limit BETWEEN 1 AND 50),
  system_prompt        text,
  business_knowledge   text,
  response_constraints text,
  tool_permissions     text[] NOT NULL DEFAULT '{}',
  -- Optional per-agent n8n endpoint for the `n8n_webhook` tool. HTTPS
  -- only; re-validated (SSRF guard) on every call. The HMAC signing
  -- secret lives encrypted in ai_configs.tool_webhook_secret.
  n8n_webhook_url      text CHECK (n8n_webhook_url IS NULL OR n8n_webhook_url ~* '^https://'),
  handoff_on_failure   boolean NOT NULL DEFAULT true,
  notes                text,
  created_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_versions_agent
  ON ai_agent_versions(agent_id, version_number DESC);

-- current_version_id → versions (added after both tables exist; the
-- agents table is created first so the FK can't be inline).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_current_version_fk'
  ) THEN
    ALTER TABLE ai_agents
      ADD CONSTRAINT ai_agents_current_version_fk
      FOREIGN KEY (current_version_id) REFERENCES ai_agent_versions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Versions are append-only. Direct UPDATE/DELETE is refused. Changes
-- that arrive through an FK action (cascade on agent/account delete, or
-- SET NULL on created_by when a user is removed) run nested
-- (pg_trigger_depth() > 1) and are allowed so those deletes still work.
CREATE OR REPLACE FUNCTION ai_agent_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'ai_agent_versions rows are immutable (create a new version instead)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_agent_versions_immutable ON ai_agent_versions;
CREATE TRIGGER trg_ai_agent_versions_immutable
  BEFORE UPDATE OR DELETE ON ai_agent_versions
  FOR EACH ROW EXECUTE FUNCTION ai_agent_versions_immutable();

REVOKE ALL ON FUNCTION ai_agent_versions_immutable() FROM PUBLIC, anon, authenticated;

-- A version must carry its agent's account_id, and an agent may only
-- point current_version_id at one of ITS OWN versions (tenant safety
-- even if a route has a bug).
CREATE OR REPLACE FUNCTION ai_agent_versions_check_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_agents WHERE id = NEW.agent_id AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'ai_agent_versions.account_id must match the agent account' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_agent_versions_check_account ON ai_agent_versions;
CREATE TRIGGER trg_ai_agent_versions_check_account
  BEFORE INSERT ON ai_agent_versions
  FOR EACH ROW EXECUTE FUNCTION ai_agent_versions_check_account();

CREATE OR REPLACE FUNCTION ai_agents_check_current_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ai_agent_versions WHERE id = NEW.current_version_id AND agent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'current_version_id must be a version of this agent' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_agents_check_current_version ON ai_agents;
CREATE TRIGGER trg_ai_agents_check_current_version
  BEFORE INSERT OR UPDATE OF current_version_id ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION ai_agents_check_current_version();

REVOKE ALL ON FUNCTION ai_agent_versions_check_account() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ai_agents_check_current_version() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. ai_agent_events (append-only audit trail incl. rollbacks)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agent_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event           text NOT NULL
                    CHECK (event IN ('created', 'version_created', 'activated', 'paused', 'rollback')),
  from_version_id uuid,
  to_version_id   uuid,
  actor_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_events_agent
  ON ai_agent_events(agent_id, created_at DESC);

-- Append-only, same rule as versions: direct UPDATE/DELETE is refused;
-- FK cascades (nested trigger depth) still work.
CREATE OR REPLACE FUNCTION ai_agent_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'ai_agent_events rows are append-only'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_agent_events_append_only ON ai_agent_events;
CREATE TRIGGER trg_ai_agent_events_append_only
  BEFORE UPDATE OR DELETE ON ai_agent_events
  FOR EACH ROW EXECUTE FUNCTION ai_agent_events_append_only();

REVOKE ALL ON FUNCTION ai_agent_events_append_only() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. ai_tool_calls
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_tool_calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id         uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  agent_version_id uuid,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  tool             text NOT NULL,
  status           text NOT NULL
                     CHECK (status IN ('ok', 'error', 'denied', 'timeout', 'invalid', 'dry_run')),
  latency_ms       integer,
  error            text,
  -- Keys + sizes only, e.g. "query:str(34)". Never message content.
  args_summary     text,
  source           text NOT NULL DEFAULT 'auto_reply'
                     CHECK (source IN ('auto_reply', 'draft', 'playground', 'simulation')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_account_created
  ON ai_tool_calls(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_agent
  ON ai_tool_calls(agent_id, created_at DESC);

-- ------------------------------------------------------------
-- 5. ai_usage_log — richer columns
-- ------------------------------------------------------------
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS agent_version_id uuid;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS latency_ms integer;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ok'
  CHECK (status IN ('ok', 'error', 'timeout', 'blocked'));
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS error_code text;
-- Micro-USD (1e-6 USD), estimated from the per-model price table in
-- src/lib/ai/pricing.ts. NULL = unknown model. Estimate only.
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS estimated_cost_micros bigint;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'auto_reply'
  CHECK (source IN ('auto_reply', 'draft', 'playground', 'simulation'));
-- True when this turn ended in a handoff to a human.
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS handoff boolean NOT NULL DEFAULT false;

-- Historic rows were drafts or auto-replies; keep `source` truthful.
UPDATE ai_usage_log SET source = 'draft' WHERE mode = 'draft' AND source = 'auto_reply';

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_agent_created
  ON ai_usage_log(agent_id, created_at DESC);

-- ------------------------------------------------------------
-- 6. ai_configs additions
-- ------------------------------------------------------------
-- HMAC secret for the n8n_webhook tool (AES-GCM encrypted like api_key).
-- Server-side only; never returned to the browser.
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS tool_webhook_secret text;

-- ------------------------------------------------------------
-- 7. RLS
-- ------------------------------------------------------------
ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agents_select ON ai_agents;
CREATE POLICY ai_agents_select ON ai_agents FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

ALTER TABLE ai_agent_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_versions_select ON ai_agent_versions;
CREATE POLICY ai_agent_versions_select ON ai_agent_versions FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

ALTER TABLE ai_agent_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_events_select ON ai_agent_events;
CREATE POLICY ai_agent_events_select ON ai_agent_events FOR SELECT
  USING (is_account_member(account_id, 'admin'));

ALTER TABLE ai_tool_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_tool_calls_select ON ai_tool_calls;
CREATE POLICY ai_tool_calls_select ON ai_tool_calls FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- No INSERT/UPDATE/DELETE policies for `authenticated`: all writes go
-- through service-role server routes after a role check.
REVOKE INSERT, UPDATE, DELETE ON ai_agents, ai_agent_versions, ai_agent_events, ai_tool_calls
  FROM anon, authenticated;

-- ------------------------------------------------------------
-- 8. Atomic activation: make one agent the account's active agent,
--    pausing whichever was active, in one transaction (the partial
--    unique index would otherwise reject the intermediate state).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ai_agent_activate(p_agent_id uuid, p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM ai_agents
    WHERE id = p_agent_id AND account_id = p_account_id AND current_version_id IS NOT NULL
  ) INTO v_ok;
  IF NOT v_ok THEN
    RETURN false;
  END IF;

  UPDATE ai_agents
     SET status = 'paused', updated_at = now()
   WHERE account_id = p_account_id AND status = 'active' AND id <> p_agent_id;

  UPDATE ai_agents
     SET status = 'active', updated_at = now()
   WHERE id = p_agent_id AND account_id = p_account_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION ai_agent_activate(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ai_agent_activate(uuid, uuid) TO service_role;

-- ------------------------------------------------------------
-- 9. Backfill: one agent + version 1 per existing ai_configs row that
--    has no agent yet. 'active' only when the account already had the
--    assistant AND auto-reply switched on, so behaviour is unchanged.
-- ------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_agent uuid;
  v_ver uuid;
BEGIN
  FOR r IN
    SELECT c.*
      FROM ai_configs c
     WHERE NOT EXISTS (SELECT 1 FROM ai_agents a WHERE a.account_id = c.account_id)
  LOOP
    v_agent := gen_random_uuid();
    v_ver := gen_random_uuid();

    INSERT INTO ai_agents (id, account_id, name, description, role, status, created_by)
    VALUES (
      v_agent, r.account_id, 'Support agent',
      'Migrated from the original AI assistant settings.', 'support',
      CASE WHEN r.is_active AND r.auto_reply_enabled THEN 'active' ELSE 'draft' END,
      r.created_by
    );

    INSERT INTO ai_agent_versions (
      id, agent_id, account_id, version_number, provider, model,
      temperature, max_output_tokens, context_message_limit,
      system_prompt, tool_permissions, handoff_on_failure, notes, created_by
    ) VALUES (
      v_ver, v_agent, r.account_id, 1, r.provider, r.model,
      0.4, 1024, 20,
      r.system_prompt, '{}', true, 'Backfilled from ai_configs', r.created_by
    );

    UPDATE ai_agents SET current_version_id = v_ver WHERE id = v_agent;

    INSERT INTO ai_agent_events (account_id, agent_id, to_version_id, event, actor_user_id)
    VALUES (r.account_id, v_agent, v_ver, 'created', r.created_by);
  END LOOP;
END $$;
