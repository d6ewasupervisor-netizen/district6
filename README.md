# District 6 Compliance Hub

A policy acknowledgement hub for District 6 retail merchandising teammates. Teammates request a tokenized email link, view three policy PDFs, sign electronically on a touch-friendly canvas, and the system emails a signed PDF receipt to their supervisor (with the signer CC'd). Phase 1 only — no admin dashboard, no version-aware re-sign.

## Architecture

- **Frontend** (`/frontend`) — Static HTML/CSS/JS hosted on GitHub Pages. No build step. Vanilla JS plus a vendored copy of `signature_pad`.
- **Backend** (`/backend`) — Node.js + Express on Railway. ESM modules.
- **Database** — Railway Postgres. Schema is in `backend/migrations/001_init.sql` and runs idempotently on every boot.
- **Email** — Resend.
- **PDF receipts** — Handlebars template (`backend/lib/templates/receipt.html`) rendered by headless Chromium via Puppeteer, generated server-side and stored in `signatures.pdf_bytes`.

## Local development

### Backend

```bash
cd backend
cp .env.example .env   # then fill in DATABASE_URL, JWT_SECRET, RESEND_API_KEY, etc.
npm install
npm run dev
```

The server listens on `PORT` (default `3000`), runs migrations on boot, and exposes:

- `GET  /api/health` — health probe
- `POST /api/request-link` — issue a tokenized link (rate-limited 5/hour/IP; approved work domains or allowlist)
- `GET  /api/verify-token?token=…` — validate a token before showing the hub
- `POST /api/submit` — submit name + signature, generate PDF, email receipt

### Frontend

The frontend is static. The simplest workflow is VS Code + Live Server:

1. Open the repo in VS Code.
2. Right-click `frontend/index.html` → **Open with Live Server**.
3. The frontend looks for `window.D6_CONFIG.API_BASE`. On `localhost` it defaults to `http://localhost:3000`. Override on the fly with a hash, e.g. `#api=http://localhost:3000`.

For production, edit `frontend/js/config.js` so the non-localhost branch points at the Railway-deployed API URL.

## Deployment

### Frontend → GitHub Pages

1. Push to `main`.
2. In repo **Settings → Pages**, set Source to **Deploy from branch**, branch `main`, folder `/frontend`.
3. The hub is served at the GitHub Pages URL (e.g. `https://<org>.github.io/district6/`).

### Backend → Railway

1. Connect the repo in Railway.
2. Set the service root directory to `/backend`.
3. **Set the builder to Dockerfile** (Service → Settings → Build → Builder). The repo ships `backend/Dockerfile`; with Service Root = `/backend`, Railway picks it up automatically. See [Why Dockerfile, not Nixpacks](#why-dockerfile-not-nixpacks) for context.
4. Add a Postgres plugin (Railway injects `DATABASE_URL`).
5. Set the remaining env vars from `backend/.env.example`:
   - `JWT_SECRET` — `openssl rand -base64 48`
   - `RESEND_API_KEY`
   - `EMAIL_FROM`, `EMAIL_TO`
   - `FRONTEND_BASE_URL` — the GitHub Pages URL (no trailing slash). Used to build links *and* as the primary CORS-allowed origin.
   - `EXTRA_ALLOWED_ORIGINS` *(optional)* — CSV of additional exact-match CORS origins for preview deploys, e.g. `https://staging.example.com,https://pr-42.example.com`. **No wildcards** — entries are matched as literal strings, so `*.github.io` will not match anything.
   - `PGSSL` *(optional)* — `disable` | `require` | `no-verify` | `verify-full`. Leave unset to honor `sslmode=` in `DATABASE_URL`. Set `require` for the Railway public TCP proxy; leave unset (or `disable`) for the `*.railway.internal` private hostname.
   - `LINK_TTL_DAYS` — defaults to 30 if omitted.
   - Component editor: `GRAPESJS_PUBLIC_KEY` and `GRAPESJS_API_KEY` (same values as the gitignored repo-root `.env`; that file never deploys), `ANTHROPIC_API_KEY` (content editing calls), `GITHUB_TOKEN` (fine-grained, contents: write) and `GITHUB_REPO=d6ewasupervisor-netizen/district6` (publish commits).
   - **Watch Path** (Service → Settings): set to `/backend/**`. Content publishes only commit `frontend/**` files, so with the watch path set they never rebuild the API image. The one-time feature push changes `backend/` and does deploy.
6. Deploy. Migrations run automatically on every boot. The `schema_migrations` table tracks which files have already been applied, so re-running the same image is a no-op.
7. Update `frontend/js/config.js` `API_BASE` to the Railway-issued URL and push.

#### Why Dockerfile, not Nixpacks

The receipt PDF pipeline renders a Handlebars template through headless Chromium (Puppeteer). Chromium needs a curated set of system libs (`libnss3`, `libgbm1`, `libcups2`, …) and the open-source **Carlito** font (the Calibri stand-in used in the policy PDFs) so the receipt's typography matches. Both are easier to express as `apt-get install` lines than to coax out of Nixpacks, and the resulting image is reproducible offline (`docker build backend/`). `backend/Dockerfile` is the source of truth for the deploy image — its top-of-file comment lists every package and why.

If you're migrating an existing Railway service from Nixpacks:
1. Service → Settings → Build → **Builder = Dockerfile**.
2. Leave **Root Directory = `/backend`** as-is. Railway will look for `Dockerfile` relative to the root.
3. Trigger a redeploy. First build takes ~3–5 minutes (apt + `npm ci` + Chromium download); subsequent builds reuse the apt and `node_modules` layers.

#### Smoke-testing the receipt pipeline

```bash
cd backend
npm run smoke:receipt
```

Renders a sample acknowledgement to a temp file and asserts the output is a non-trivial PDF. Useful before pushing template or renderer changes; runs on Windows, macOS, and Linux. The temp path is printed on success so you can open the PDF and eyeball the layout.

## Operations

### Supervisor receipt email delivery

Signed PDF receipts to `EMAIL_TO` are **queued in Postgres** (`receipt_email_outbox`, same transaction as the `signatures` insert) and delivered by a lightweight in-process worker (`MAIL_RECEIPT_OUTBOX_POLL_MS`, default 45s). Resend failures use **exponential backoff** (configurable via `MAIL_RECEIPT_OUTBOX_*` in `.env.example`); by default there is **no cap** on attempts (`MAIL_RECEIPT_OUTBOX_MAX_ATTEMPTS=0`). Runs one worker inside each Railway `web` dyno (`MAIL_RECEIPT_OUTBOX_POLL_MS`). If you run **multiple concurrent Node backends** pointing at the same database, coordinate with leases or migrate to an external queue; otherwise two instances can rarely double-send during the Resend latency window after a DB claim commits.

To verify delivery or debug a stuck send:

```sql
SELECT o.id, o.signature_id, o.attempts, o.sent_at, o.next_attempt_at, o.last_error
FROM receipt_email_outbox o
WHERE o.sent_at IS NULL
ORDER BY o.next_attempt_at, o.id;
```

### Add or replace a policy document

- Drop the new PDF into `frontend/docs/` (or upload it from the component editor — uploads are stored in Postgres and written into `frontend/docs/` at publish).
- Publish the Acknowledgement page from the component editor with the updated policy cards (each required card is a `.doc-card` carrying `data-doc="<key>"`). Publishing syncs `policy_documents`; `backend/routes/submit.js` then requires a viewed timestamp for every active required row and the receipt lists exactly that set. The old fixed key list is gone.

### Add or replace a reference document

Reference materials (`handbook.pdf`, `kompass.pdf`, `vendor.pdf`) are linked from the Acknowledgement page for context but are **not** required to acknowledge.

- Drop the new PDF into `frontend/docs/` (or upload it from the component editor).
- Add a `.ref-card` block (Reference PDF card) on the Acknowledgement page and publish. Reference rows sync into `policy_documents` with `kind='reference'`.

### How the read-gate works

The required policies use a "scroll to the end" gate, not a timer:

- The acknowledgement checkbox stays disabled until the reader scrolls to the bottom of that PDF inside the in-app viewer.
- If the reader has been on a PDF for more than 45 seconds without reaching the end, a bouncing down-arrow appears at the bottom of the viewer as a hint. There is no visible countdown.
- Reference materials open in the same viewer with the gate disabled.

### Revoke a tokenized link

Delete the row from `link_requests` by its `jti`. Any future submit attempt with that token will fail because the foreign-key target is gone, and `verify-token` will return "Link not recognized."

```sql
DELETE FROM link_requests WHERE jti = '<jti>';
```

### Pull signatures for HR

```sql
SELECT email, full_name, signed_at, doc_version
FROM signatures
ORDER BY signed_at DESC;
```

To export a single receipt PDF:

```sql
\lo_export 0 '/tmp/receipt.pdf'  -- if you've previously \lo_import'ed
-- or simpler: SELECT pdf_bytes FROM signatures WHERE id = <id>; then save the bytea
```

In practice, retrieve `pdf_bytes` via a small script (`pg` driver → `fs.writeFileSync`).

## Component editor (published page content)

The signed-in admin panel has two buttons: **Update Components** (`components.html?mode=manual`, GrapesJS Studio canvas) and **Describe your changes** (`components.html?mode=describe`, message loop with a live preview). Both modes edit one shared draft per page — mirrored to browser IndexedDB (`d6-component-drafts`) and Postgres (`component_drafts`), newest `updatedAt` wins on load. The page picker covers Home, Acknowledgement, Thank you, and Receipt (the access-list page stays fixed).

**Commit to save all changes** publishes the current draft: HTML sanitize (strips `script`/`iframe`/`object`/`embed`, `on*` handlers, `javascript:` URLs) → required hook checks (missing hooks are named in a plain sentence) → `policy_documents` sync for the Acknowledgement page → `component_pages` upsert → one GitHub commit of `frontend/content/<pageKey>.json`, `frontend/content/<pageKey>.css`, and any new `frontend/docs/` or `frontend/assets/uploads/` files. Uploads live in Postgres (`component_assets`) and are served at `GET /api/content/assets/:id` until that commit writes the bytes into `frontend/`.

Public pages hydrate via `frontend/js/content-hydrate.js` → `GET /api/content/:pageKey` (30s cache) before `request-link.js`/`sign.js` initialize; if the fetch fails, the HTML already in the file stays. Receipt PDFs render from the published receipt page when one exists (still Handlebars → Puppeteer via `backend/lib/receipt-renderer.js`), otherwise from `backend/lib/templates/receipt.html`.

Editing is driven by two content passes against the Messages API (`backend/lib/claude-components.js`, server-only): a layout pass that asks up to three clarifying questions then applies changes to the draft, and a finish pass that runs on **I'm done** or automatically before Commit if it has not run yet.

**Railway watch path:** `Service → Settings → Watch Path = /backend/**`. Content publishes commit `frontend/**` only, so they never rebuild the API/Chromium image — publishing is live on the next page load via Postgres plus the Pages content files.

## File layout

```
frontend/                  # GitHub Pages root
  index.html               # Request-link page
  sign.html                # The acknowledgement hub (gated by ?token=)
  thanks.html              # Post-submit success page
  docs/                    # Policy PDFs (attendance, dress-code, sop) +
                           # reference PDFs (handbook, kompass, vendor)
  assets/{logo.png,styles.css}
  js/{config,request-link,sign,pdf-viewer,signature_pad.umd.min}.js

backend/
  server.js                # Express bootstrap + migrations on boot
  routes/                  # request-link, verify-token, submit
  lib/                     # db, email, pdf, tokens
  migrations/001_init.sql
  .env.example
```

## Out of scope (future phases)

- Phase 2 — Admin dashboard
- Phase 3 — Version-aware re-sign prompts and DNS swap to `district6.retail-odyssey.com`
