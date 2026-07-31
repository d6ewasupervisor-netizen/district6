-- Durably queues supervisor receipt emails alongside each signature commit.
-- A worker retries via Resend until delivery succeeds (or optional max attempts).
CREATE TABLE IF NOT EXISTS receipt_email_outbox (
  id BIGSERIAL PRIMARY KEY,
  signature_id INTEGER NOT NULL REFERENCES signatures(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  resend_email_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS receipt_email_outbox_signature_id_uidx ON receipt_email_outbox(signature_id);
CREATE INDEX IF NOT EXISTS receipt_email_outbox_pending_idx
  ON receipt_email_outbox (next_attempt_at, id)
  WHERE sent_at IS NULL;
