-- Name stored with the text-sign-in number. Work-domain people are not rows
-- in allowed_emails, so the name lives here.
ALTER TABLE login_phones ADD COLUMN IF NOT EXISTS display_name TEXT;
