-- Self-serve access requests: stores pending/approved/denied requests from the login page.
-- Approve/deny decisions are made atomically via UPDATE … WHERE status = 'pending' RETURNING *
-- so first-click-wins without a separate lock.
CREATE TABLE IF NOT EXISTS access_requests (
  id           TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  email        TEXT        NOT NULL,
  reason       TEXT,
  status       TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT,
  decided_action TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_requests_email  ON access_requests (lower(email));
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests (status);
