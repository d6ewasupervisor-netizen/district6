CREATE TABLE IF NOT EXISTS link_requests (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  jti TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_link_requests_email ON link_requests(email);
CREATE INDEX IF NOT EXISTS idx_link_requests_jti ON link_requests(jti);

CREATE TABLE IF NOT EXISTS signatures (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  signature_data_url TEXT NOT NULL,
  doc_version TEXT NOT NULL DEFAULT 'Spring 2026 Edition',
  attendance_viewed_at TIMESTAMPTZ NOT NULL,
  dress_code_viewed_at TIMESTAMPTZ NOT NULL,
  sop_viewed_at TIMESTAMPTZ NOT NULL,
  agreed_at TIMESTAMPTZ NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT,
  jti TEXT NOT NULL REFERENCES link_requests(jti),
  pdf_bytes BYTEA
);

CREATE INDEX IF NOT EXISTS idx_signatures_email ON signatures(email);
CREATE INDEX IF NOT EXISTS idx_signatures_signed_at ON signatures(signed_at);
