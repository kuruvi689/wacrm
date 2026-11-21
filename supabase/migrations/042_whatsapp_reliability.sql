-- ============================================================
-- 042_whatsapp_reliability.sql
--
-- WhatsApp reliability + compliance columns. Idempotent and additive:
--   * messages.error_code / error_message  — Meta error captured from
--     `failed` status callbacks (e.g. 131026 undeliverable, 131047
--     re-engagement required).
--   * contacts.opted_out_at / opt_out_source — marketing opt-out
--     (customer sent STOP / UNSUBSCRIBE). Cleared by START / SUBSCRIBE.
--
-- The inbound dedup function claim_inbound_message() is defined in a
-- different migration (040) and is intentionally not created here.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code INT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opt_out_source TEXT;

-- Broadcast / template sends look up opted-out contacts per account;
-- a partial index keeps that lookup cheap (most contacts are opted in).
CREATE INDEX IF NOT EXISTS idx_contacts_account_opted_out
  ON contacts (account_id)
  WHERE opted_out_at IS NOT NULL;

COMMENT ON COLUMN messages.error_code IS
  'Meta Cloud API error code from a failed status callback.';
COMMENT ON COLUMN messages.error_message IS
  'Meta error title/message from a failed status callback.';
COMMENT ON COLUMN contacts.opted_out_at IS
  'Set when the contact opts out of marketing (STOP/UNSUBSCRIBE); NULL = opted in.';
COMMENT ON COLUMN contacts.opt_out_source IS
  'How the opt-out was recorded, e.g. whatsapp_keyword or manual.';
