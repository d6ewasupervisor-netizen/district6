# District 6 Compliance Hub

A policy acknowledgement hub for District 6 retail merchandising teammates. Teammates request a tokenized email link, view three policy PDFs, sign electronically on a touch-friendly canvas, and the system emails a signed PDF receipt to their supervisor (with the signer CC'd). Phase 1 only — no admin dashboard, no version-aware re-sign.

## Architecture

- **Frontend** (`/frontend`) — Static HTML/CSS/JS hosted on GitHub Pages. No build step. Vanilla JS plus a vendored copy of `signature_pad`.
- **Backend** (`/backend`) — Node.js + Express on Railway. ESM modules.
- **Database** — Railway Postgres. Schema is in `backend/migrations/001_init.sql` and runs idempotently on every boot.
- **Email** — Resend.
- **PDF receipts** — `pdfkit`, generated server-side and stored in `signatures.pdf_bytes`.

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
3. Add a Postgres plugin (Railway injects `DATABASE_URL`).
4. Set the remaining env vars from `backend/.env.example`:
   - `JWT_SECRET` — `openssl rand -base64 48`
   - `RESEND_API_KEY`
   - `EMAIL_FROM`, `EMAIL_TO`
   - `FRONTEND_BASE_URL` — the GitHub Pages URL (no trailing slash), used to build links and to allow CORS.
   - `LINK_TTL_DAYS` — defaults to 30 if omitted.
5. Deploy. Migrations run automatically on first boot.
6. Update `frontend/js/config.js` `API_BASE` to the Railway-issued URL and push.

## Operations

### Add or replace a policy document

- Drop the new PDF into `frontend/docs/` using one of the existing names (`attendance.pdf`, `dress-code.pdf`, `sop.pdf`).
- Adding a *fourth* document requires:
  1. A new `.doc-card` block in `frontend/sign.html` with `data-doc="<key>"`.
  2. Add the new key to the `docs` array in `frontend/js/sign.js`.
  3. Extend `viewTimestamps` handling in `backend/routes/submit.js` and the `signatures` schema (new `*_viewed_at` column).
  4. Update the doc list rendered in `backend/lib/email.js` and `backend/lib/pdf.js`.

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
  docs/                    # The three policy PDFs (replaced before launch)
  assets/{logo.png,styles.css}
  js/{config,request-link,sign,signature_pad.umd.min}.js

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
