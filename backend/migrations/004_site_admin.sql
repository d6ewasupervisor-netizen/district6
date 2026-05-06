-- Single row: district admin who may manage allowed_emails (non-corporate addresses).
CREATE TABLE IF NOT EXISTS site_admin (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  admin_email TEXT NOT NULL,
  password_hash TEXT,
  password_set_at TIMESTAMPTZ
);

INSERT INTO site_admin (id, admin_email)
VALUES (1, 'april.gauthier@retailodyssey.com')
ON CONFLICT (id) DO NOTHING;
