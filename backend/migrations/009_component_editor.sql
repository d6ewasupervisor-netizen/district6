-- 009 — Component editor (GrapesJS Studio SDK) support tables.
--
-- component_drafts : one editable draft per admin per page (mirrored in the
--                    browser via IndexedDB; newer updatedAt wins on load).
-- component_pages  : published page content served by GET /api/content/:pageKey.
-- component_assets : uploaded images/PDFs stored in Postgres (never on the
--                    Railway disk) and served at /api/content/assets/:id until
--                    the publish commit writes them into frontend/.
-- policy_documents : policy/reference cards synced from the Acknowledgement
--                    page HTML at publish; submit requires a viewed timestamp
--                    for every active required row.

CREATE TABLE IF NOT EXISTS component_drafts (
  admin_email TEXT NOT NULL,
  page_key TEXT NOT NULL,
  project_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  html TEXT NOT NULL DEFAULT '',
  css TEXT NOT NULL DEFAULT '',
  summary_for_polish TEXT,
  polished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_email, page_key)
);

CREATE TABLE IF NOT EXISTS component_pages (
  page_key TEXT PRIMARY KEY,
  html TEXT NOT NULL DEFAULT '',
  css TEXT NOT NULL DEFAULT '',
  project_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by TEXT
);

CREATE TABLE IF NOT EXISTS component_assets (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS policy_documents (
  doc_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('required', 'reference')),
  file_path TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed from the current Acknowledgement page (frontend/sign.html) so the
-- first submit before any publish still validates and renders the receipt
-- document list. Re-synced from the page HTML on every publish.
INSERT INTO policy_documents (doc_key, title, kind, file_path, sort_order) VALUES
  ('attendance', 'Attendance & Timekeeping Policy', 'required', 'docs/attendance.pdf', 0),
  ('dressCode',  'Dress Code Policy',               'required', 'docs/dress-code.pdf', 1),
  ('sop',        'Standard Operating Procedures',   'required', 'docs/sop.pdf', 2),
  ('handbook',   'Teammate Handbook',               'reference', 'docs/handbook.pdf', 0),
  ('kompass',    'Kompass Responsibilities',        'reference', 'docs/kompass.pdf', 1),
  ('vendor',     'Fred Meyer Vendor Policies',      'reference', 'docs/vendor.pdf', 2)
ON CONFLICT (doc_key) DO NOTHING;

-- Legacy per-document timestamp columns are kept for rows already stored, but
-- new submissions record an arbitrary required-doc set in signatures.doc_views
-- and may not include all three legacy keys.
ALTER TABLE signatures ALTER COLUMN attendance_viewed_at DROP NOT NULL;
ALTER TABLE signatures ALTER COLUMN dress_code_viewed_at DROP NOT NULL;
ALTER TABLE signatures ALTER COLUMN sop_viewed_at DROP NOT NULL;

ALTER TABLE signatures ADD COLUMN IF NOT EXISTS doc_views JSONB;