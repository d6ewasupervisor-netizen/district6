# AGENT_LOG — District 6 Compliance Hub

## 2026-10-09 — The page is the editor

- Removed the GrapesJS canvas layer. The document or hub page is drawn directly. Blocks on the left drag onto that page, the ⋮⋮ handle reorders what is already there, and the words are typed in place. Preview hides the handles.

## 2026-10-09 — Visual drag-and-drop canvas

- The editor canvas is now the page itself: drag blocks, click text to change it, and Preview shows that page without the handles. The hub stylesheet no longer sits on the editor chrome, which was collapsing the preview controls.

## 2026-10-09 — Documents are the editor's first screen

- Update Components opens the six documents first (Attendance, Dress Code, SOP, Handbook, Kompass, Vendor), then the four hub pages. Each one opens alone, full window, in the drag-and-drop editor. The document text was pulled from the current PDFs. Commit on a document writes the PDF the hub opens, plus the editable HTML.

## 2026-10-09 — Page editor shows the page

- Update Components and Describe your changes now render the Home, Acknowledgement, Thank you, and Receipt pages at full width. Words are edited on the page. Pictures and links use a bar along the bottom. The editor no longer loads the studio canvas, so it does not show source or ask for another sign-in when switching pages.

## 2026-10-09 — Tyson text sign-in number

- Added `tyson.gauthier@retailodyssey.com` / `+15095727660` (Tyson Gauthier) to `login_phones`. Work domain, so no access-list row.

## 2026-10-09 — Published the four live pages

- Saved Home, Acknowledgement, Thank you, and the receipt through the same publish path as **Commit to save all changes**. No editor drafts existed, so the save used the pages already on the site. One commit: `c9748de`. `GET /api/content/:pageKey` returns 200 for all four.

## 2026-10-09 — Direct reports loaded into text sign-in

- Loaded 25 people from April's direct-report sheet into `login_phones` (name, email, E.164 phone). 17 personal addresses were also upserted on `allowed_emails` so they can request a link and a text code. Work-domain addresses were not added to that list.
- `login_phones.display_name` is migration `011`. The admin phone list shows the name.

## 2026-10-09 — Railway setup for the editor and SMS PIN

- District 6 API is the `district6` service in Railway project `serene-celebration` (`https://district6-production.up.railway.app`). GrapesJS keys were already on that service.
- Added app slug `district6` to sms-outbox `APP_KEYS`, set `SMS_OUTBOX_KEY` and `SMS_OUTBOX_URL` on the District 6 service, and mirrored `APP_KEYS` into the gitignored sms-outbox deploy-secrets file. Both services redeployed successfully. The key is not in git.
- Copied `ANTHROPIC_API_KEY` from the EOD service. Set `GITHUB_REPO`. Watch pattern is `backend/**`.
- Still missing on the District 6 service: `GITHUB_TOKEN` (contents write). Phone numbers are still entered from the signed-in **Text sign-in numbers** card.

## 2026-10-08 — District 6 SMS PIN login (TACTAG sms-outbox gateway)

- Added text-code sign-in through the shared TACTAG gateway (`POST /otp/send` / `POST /otp/verify`, `x-api-key`). No Twilio credentials; no `/sms/send` wrapper exists in the client so PINs can never ride a generic text (and OTP gets no owner copy).
- New: `migrations/010_login_phones.sql` (one E.164 number per email, shared by both flows), `lib/sms-outbox.js` (ESM port of the eod-api gateway client: sendOtp/verifyOtp/status→code map/403 rule kept, district6 user copy), `lib/sms-login.js` (normalize/mask, gates, send/verify flows with injectable deps; never stores the PIN; logs email + mask only), `routes/login-sms.js` (rep), `routes/admin-login-sms.js` (admin), `routes/admin-login-phones.js` (admin phone list).
- Rep verify issues the same `issueToken` + `link_requests` row as request-link (no email); admin verify issues `issueAdminSessionToken` like password login. Gates: rep = `isEmailAllowed`; admin = `site_admins` with `password_hash`; phone-list save = union of the two.
- UI: Home keeps **Send my link** and adds **Text me a code** → masked number + one-time-code input + **Submit code**; admin sign-in keeps the password form with the same step; signed-in panel gains the **Text sign-in numbers** card (email, mobile number, Save number, list with Remove).
- Tests (`test/sms-login.test.js`, node:test with mocked fetch): refusal for not-allowed email and for allowed email with no phone, `/otp/send` called with E.164 + app key header, 403 `OPT_IN_REQUIRED` surfaced as that rule (never the STOP copy), rep verify JWT passes `verifyToken`, admin verify token passes `verifyAdminSessionToken`, wrong code returns no token.

## 2026-10-08 — District 6 component editor (GrapesJS Studio SDK)

- Built the visual component editor feature: GrapesJS Studio SDK (manual mode) + describe mode with a two-pass polish/publish loop, draft persistence (IndexedDB + Postgres), publish pipeline (sanitize → hook checks → policy_documents sync → component_pages upsert → one GitHub commit of allowlisted content files), public content hydration, and policy-document-driven submission validation.
- New backend: `migrations/009_component_editor.sql`, `lib/component-store.js`, `lib/component-sanitize.js`, `lib/github-content-commit.js`, `lib/claude-components.js`, `lib/env-file.js`, `routes/admin-components.js`, `routes/public-content.js`.
- New frontend: `components.html`, `js/components-editor.js`, `js/content-hydrate.js`, vendored Studio SDK under `vendor/studio/`.
- Edited: `admin.html`/`admin.js` (two buttons), `index.html`/`sign.html`/`thanks.html` (`data-d6-canvas` + hydrate script), `sign.js` (reads `[data-doc]` after `d6-content-ready`), `request-link.js` (init on `d6-content-ready`), `server.js` (route mounts, 15mb JSON on component routes only), `submit.js`, `lib/pdf.js`, `lib/receipt-renderer.js` (published receipt template when present), `lib/admin-auth.js` (token query fallback for sendBeacon), `lib/email.js` + `lib/receipt-email-outbox.js` (receipt email lists the acknowledged documents from `doc_views`/`policy_documents`), `.env.example`.
- Tests in `backend/test/` with `node:test` (sanitize, hooks, policy-doc-view validation, fixture parsing for the two response shapes).