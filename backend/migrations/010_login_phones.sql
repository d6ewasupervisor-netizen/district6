-- 010 — SMS PIN login (TACTAG sms-outbox gateway).
--
-- One mobile number per email, shared by the rep flow (text code → sign.html
-- token) and the admin flow (text code → admin session). Numbers live here —
-- NOT on allowed_emails — because work-domain people never need a row there.
-- E.164 (+1 plus 10 digits) is enforced before write.

CREATE TABLE IF NOT EXISTS login_phones (
  email TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);