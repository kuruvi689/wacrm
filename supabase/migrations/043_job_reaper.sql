-- 043: job reaper bookkeeping for automation_pending_executions.
--
-- The cron drain claims a due row by flipping status pending -> running.
-- If the invocation dies mid-run (timeout, deploy, crash) the row stays
-- 'running' forever. The reaper in /api/automations/cron uses claimed_at
-- to find rows stuck for > 10 minutes and uses attempts to allow exactly
-- one retry before marking the row failed.
--
-- Idempotent: safe to re-run.

ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_automation_pending_running
  ON automation_pending_executions(claimed_at)
  WHERE status = 'running';
