# ROADMAP — District 6 Compliance Hub

## Next

- SMS PIN secrets (one-time): generate a key for app slug `district6`, append `district6:<key>` to Railway `APP_KEYS` on the **sms-outbox** service, then set only `<key>` on the District 6 service as `SMS_OUTBOX_KEY` (optional `SMS_OUTBOX_URL`, defaults to the production gateway). Do not commit or print the key.
- Save the first mobile numbers from the signed-in admin panel (**Text sign-in numbers**) — password login is how an admin reaches that card before any PIN works.
- One-time Railway setup (dashboard, values not printed): set `GRAPESJS_PUBLIC_KEY` and `GRAPESJS_API_KEY` to the same values as the repo-root `.env`, plus `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` (fine-grained, contents write), `GITHUB_REPO=d6ewasupervisor-netizen/district6`.
- Set the Railway service **watch path to `/backend/**`** so content-only commits (frontend) do not rebuild the API/Chromium image.
- Open `components.html?mode=manual` on the live site and confirm the Studio canvas loads with the fetched public key.
- Optionally publish each page once (Commit to save all changes) so `component_pages` has rows and `/api/content/:pageKey` serves hydrated content.

## Later

- Monitor receipt rendering with a published (Studio) receipt page — Handlebars tokens must survive the editor.
- Access-list page intentionally stays fixed (sign-in safety).