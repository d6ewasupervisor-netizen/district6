# ROADMAP — District 6 Compliance Hub

## Next

- One-time Railway setup (dashboard, values not printed): set `GRAPESJS_PUBLIC_KEY` and `GRAPESJS_API_KEY` to the same values as the repo-root `.env`, plus `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` (fine-grained, contents write), `GITHUB_REPO=d6ewasupervisor-netizen/district6`.
- Set the Railway service **watch path to `/backend/**`** so content-only commits (frontend) do not rebuild the API/Chromium image.
- Open `components.html?mode=manual` on the live site and confirm the Studio canvas loads with the fetched public key.
- Optionally publish each page once (Commit to save all changes) so `component_pages` has rows and `/api/content/:pageKey` serves hydrated content.

## Later

- Monitor receipt rendering with a published (Studio) receipt page — Handlebars tokens must survive the editor.
- Access-list page intentionally stays fixed (sign-in safety).