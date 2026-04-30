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
- `POST /api/request-link` — issue a tokenized link (rate-limited 5/hour/IP, `@retailodyssey.com` only)
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

### Add or replace a policy document

- Drop the new PDF into `frontend/docs/` using one of the existing names (`attendance.pdf`, `dress-code.pdf`, `sop.pdf`).
- Adding a *fourth* required document means:
  1. A new `.doc-card` block in `frontend/sign.html` with `data-doc="<key>"`.
  2. Add the new key to the `docs` array in `frontend/js/sign.js`.
  3. Extend `viewTimestamps` handling in `backend/routes/submit.js` and the `signatures` schema (new `*_viewed_at` column).
  4. Update the doc list rendered in `backend/lib/email.js`, the `documents` array built in `backend/lib/pdf.js`, and the `{{#each documents}}` section of `backend/lib/templates/receipt.html`.

### Add or replace a reference document

Reference materials (`handbook.pdf`, `kompass.pdf`, `vendor.pdf`) are linked from `sign.html` for context but are **not** required to acknowledge.

- Drop the new PDF into `frontend/docs/`.
- To add a new one: copy an existing `.ref-card` block in `frontend/sign.html`, point `data-pdf-src` and `href` at the new file, and adjust the title/description.

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
