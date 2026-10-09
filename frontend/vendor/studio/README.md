# Vendored GrapesJS Studio SDK

Built once from npm and committed because GitHub Pages has no build step.

| File | Source |
|------|--------|
| `studio-sdk.umd.js` | `@grapesjs/studio-sdk@1.2.1` → `dist/index.umd.js` (global `GrapesJsStudioSDK`) |
| `studio-sdk.css` | `@grapesjs/studio-sdk@1.2.1` → `dist/style.css` |
| `preset-printable.umd.js` | `@grapesjs/studio-sdk-plugins@1.0.39` → `dist/presetPrintable/index.umd.js` (global `StudioSdkPlugins_presetPrintable`) |

Rebuild:

```bash
npm i @grapesjs/studio-sdk@1.2.1 @grapesjs/studio-sdk-plugins@1.0.39
cp node_modules/@grapesjs/studio-sdk/dist/index.umd.js studio-sdk.umd.js
cp node_modules/@grapesjs/studio-sdk/dist/style.css studio-sdk.css
cp node_modules/@grapesjs/studio-sdk-plugins/dist/presetPrintable/index.umd.js preset-printable.umd.js
```

The Studio license key is fetched at runtime from
`GET /api/admin/components/studio-config` — it is never baked into these files.