-- Multiple district admins may access /admin.html. Replaces singleton site_admin.
CREATE TABLE IF NOT EXISTS site_admins (
  email TEXT PRIMARY KEY,
  password_hash TEXT,
  password_set_at TIMESTAMPTZ
);

-- Carry forward April's row from the old table when present (password may be NULL pending first-time setup).
INSERT INTO site_admins (email, password_hash)
SELECT lower(trim(admin_email)), password_hash
FROM site_admin
WHERE id = 1;

-- Ensure April exists for first-time TOKEN setup flows if migrate insert found nothing.
INSERT INTO site_admins (email, password_hash)
VALUES ('april.gauthier@retailodyssey.com', NULL)
ON CONFLICT (email) DO NOTHING;

-- Tyson — bcrypt cost 12, matches server default ADMIN_BCRYPT_COST. Change password after first login.
INSERT INTO site_admins (email, password_hash, password_set_at)
VALUES (
  'tyson.gauthier@retailodyssey.com',
  '$2a$12$.cOXEtwrjz4Iy2TSBzvwx.xyokhyu9trdOz8jmah0ldqBzyE3UZdC',
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  password_hash = COALESCE(site_admins.password_hash, EXCLUDED.password_hash),
  password_set_at = COALESCE(site_admins.password_set_at, EXCLUDED.password_set_at);

DROP TABLE IF EXISTS site_admin;
