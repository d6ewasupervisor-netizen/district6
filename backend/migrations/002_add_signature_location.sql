-- Approximate city/region/country resolved from the signer's IP at submit time.
-- Best-effort, may be NULL for private/loopback IPs or geo lookup failures.
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS location TEXT;
