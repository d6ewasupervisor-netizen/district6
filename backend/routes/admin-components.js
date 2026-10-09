/*
 * Admin component-editor API (JWT-protected).
 *
 *   GET  /api/admin/components/studio-config   → Studio license key (public key)
 *   GET  /api/admin/components/draft/:pageKey  → server draft
 *   PUT  /api/admin/components/draft           → upsert draft (POST accepted for
 *                                                navigator.sendBeacon on pagehide)
 *   POST /api/admin/components/upload          → image/PDF into component_assets
 *   POST /api/admin/components/describe        → question loop / apply (rate-limited)
 *   POST /api/admin/components/polish          → final polish pass
 *   POST /api/admin/components/commit          → sanitize + hooks + publish + git commit
 *   GET  /api/admin/components/seed/receipt    → canonical receipt template source
 *
 * The renderer API key never leaves this process: it is only used for
 * server-side content calls and is never returned, logged, or committed.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdmin } from '../lib/admin-auth.js';
import {
  isPageKey,
  getDraft,
  saveDraft,
  upsertPublishedPage,
  insertAsset,
  getAssetById,
  assetServeUrl,
  collectAssetIds,
  rewriteAssetUrls,
  syncPolicyDocuments,
  lightweightProjectJson,
} from '../lib/component-store.js';
import { sanitizeHtml, missingHooksSentence } from '../lib/component-sanitize.js';
import {
  runLayoutTurn,
  runPolishPass,
  applyProjectPatch,
} from '../lib/claude-components.js';
import { commitContentFiles, isGithubConfigured } from '../lib/github-content-commit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPT_TEMPLATE_PATH = path.resolve(__dirname, '..', 'lib', 'templates', 'receipt.html');

const router = express.Router();
router.use(requireAdmin);

const describeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many messages. Try again in a minute.' },
});

const ALLOWED_UPLOAD_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// ── Studio config ────────────────────────────────────────────────────────────

router.get('/studio-config', (_req, res) => {
  const publicKey = process.env.GRAPESJS_PUBLIC_KEY || '';
  if (!publicKey) {
    return res.json({
      ok: false,
      setup: 'The editor key is not set on the server yet. Add GRAPESJS_PUBLIC_KEY to the service environment.',
    });
  }
  return res.json({ ok: true, licenseKey: publicKey });
});

// ── Drafts ───────────────────────────────────────────────────────────────────

function normalizeDraftBody(body) {
  const pageKey = body && body.pageKey;
  if (!isPageKey(pageKey)) return { error: 'Unknown page.' };
  const projectJson = body.projectJson && typeof body.projectJson === 'object' ? body.projectJson : {};
  const html = typeof body.html === 'string' ? body.html : '';
  const css = typeof body.css === 'string' ? body.css : '';
  const summaryForPolish =
    typeof body.summaryForPolish === 'string' && body.summaryForPolish ? body.summaryForPolish : null;
  return { pageKey, projectJson, html, css, summaryForPolish, polished: body.polished === true };
}

router.get('/draft/:pageKey', async (req, res) => {
  const { pageKey } = req.params;
  if (!isPageKey(pageKey)) return res.status(400).json({ ok: false, error: 'Unknown page.' });
  try {
    const draft = await getDraft(req.adminEmail, pageKey);
    return res.json({ ok: true, draft: draft || null });
  } catch (err) {
    console.error('[admin components] draft get', err);
    return res.status(500).json({ ok: false, error: 'Could not load the draft.' });
  }
});

async function upsertDraftHandler(req, res) {
  const normalized = normalizeDraftBody(req.body || {});
  if (normalized.error) return res.status(400).json({ ok: false, error: normalized.error });
  try {
    const row = await saveDraft(req.adminEmail, normalized);
    return res.json({ ok: true, updatedAt: row.updated_at, polishedAt: row.polished_at });
  } catch (err) {
    console.error('[admin components] draft save', err);
    return res.status(500).json({ ok: false, error: 'Could not save the draft.' });
  }
}

router.put('/draft', upsertDraftHandler);
router.post('/draft', upsertDraftHandler); // navigator.sendBeacon on pagehide

// ── Uploads ──────────────────────────────────────────────────────────────────

router.post('/upload', async (req, res) => {
  const body = req.body || {};
  const filename = String(body.filename || '').trim();
  const mime = String(body.mime || '').toLowerCase().split(';')[0].trim();
  const bytesBase64 = typeof body.bytesBase64 === 'string' ? body.bytesBase64 : '';
  if (!filename) return res.status(400).json({ ok: false, error: 'Filename is required.' });
  if (!ALLOWED_UPLOAD_MIME.has(mime)) {
    return res.status(400).json({ ok: false, error: 'Only PNG, JPEG, GIF, WebP images and PDF files can be uploaded.' });
  }
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (bytes.length === 0) return res.status(400).json({ ok: false, error: 'File is empty.' });
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return res.status(400).json({ ok: false, error: 'File is too large (10 MB maximum).' });
  }
  try {
    const asset = await insertAsset({ filename, mime, bytes, createdBy: req.adminEmail });
    return res.json({ ok: true, id: asset.id, url: assetServeUrl(asset.id), filename: asset.filename, mime: asset.mime });
  } catch (err) {
    console.error('[admin components] upload', err);
    return res.status(500).json({ ok: false, error: 'Could not store the file.' });
  }
});

// ── Describe mode (question loop, then apply) ────────────────────────────────

const BEGIN_RE = /\b(begin|start|go ahead|make the changes)\b/i;
const MAX_QUESTIONS = 3;

router.post('/describe', describeLimiter, async (req, res) => {
  const body = req.body || {};
  const { pageKey } = body;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const history = Array.isArray(body.history) ? body.history : [];
  const questionsAsked = Number.isInteger(body.questionsAsked) ? body.questionsAsked : 0;
  if (!isPageKey(pageKey)) return res.status(400).json({ ok: false, error: 'Unknown page.' });
  if (!message) return res.status(400).json({ ok: false, error: 'Please describe the changes you would like to see.' });

  try {
    const draft = await getDraft(req.adminEmail, pageKey);
    if (!draft) {
      return res.status(400).json({ ok: false, error: 'No draft for this page yet. Open the page and try again.' });
    }
    const apply = BEGIN_RE.test(message) || questionsAsked >= MAX_QUESTIONS;
    const result = await runLayoutTurn({
      pageKey,
      html: draft.html,
      css: draft.css,
      projectJson: draft.project_json,
      history: [...history, { who: 'admin', text: message }],
      apply,
    });

    if (result.kind === 'question') {
      return res.json({
        ok: true,
        kind: 'question',
        question: result.question,
        questionsAsked: questionsAsked + 1,
      });
    }

    const patched = applyProjectPatch(draft.html, draft.css, result.patch);
    const projectJson = lightweightProjectJson(pageKey, patched.html, patched.css);
    const row = await saveDraft(req.adminEmail, {
      pageKey,
      projectJson,
      html: patched.html,
      css: patched.css,
      summaryForPolish: result.summaryForPolish || null,
    });
    return res.json({
      ok: true,
      kind: 'applied',
      updatedAt: row.updated_at,
      draft: {
        pageKey,
        projectJson,
        html: row.html,
        css: row.css,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    console.error('[admin components] describe', err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || 'Could not update the draft.' });
  }
});

// ── Polish pass ──────────────────────────────────────────────────────────────

async function runPolishForDraft(adminEmail, pageKey) {
  const draft = await getDraft(adminEmail, pageKey);
  if (!draft) {
    const err = new Error('No draft for this page yet.');
    err.status = 400;
    throw err;
  }
  const polished = await runPolishPass({
    pageKey,
    html: draft.html,
    css: draft.css,
    projectJson: draft.project_json,
    summaryForPolish: draft.summary_for_polish || '',
  });
  const cleanHtml = sanitizeHtml(polished.html);
  const missing = missingHooksSentence(pageKey, cleanHtml + '\n' + polished.css);
  if (missing) {
    const err = new Error(missing);
    err.status = 400;
    throw err;
  }
  return saveDraft(adminEmail, {
    pageKey,
    projectJson: polished.projectJson,
    html: cleanHtml,
    css: polished.css,
    summaryForPolish: draft.summary_for_polish,
    polished: true,
  });
}

router.post('/polish', async (req, res) => {
  const { pageKey } = req.body || {};
  if (!isPageKey(pageKey)) return res.status(400).json({ ok: false, error: 'Unknown page.' });
  try {
    const row = await runPolishForDraft(req.adminEmail, pageKey);
    return res.json({
      ok: true,
      draft: {
        pageKey,
        projectJson: row.project_json,
        html: row.html,
        css: row.css,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    console.error('[admin components] polish', err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || 'Could not finish the page.' });
  }
});

// ── Publish ──────────────────────────────────────────────────────────────────

function stripJsUrlsFromCss(css) {
  return typeof css === 'string' ? css.replace(/javascript\s*:/gi, '') : '';
}

router.post('/commit', async (req, res) => {
  const body = req.body || {};
  const { pageKey } = body;
  const mode = body.mode === 'describe' ? 'describe' : 'manual';
  if (!isPageKey(pageKey)) return res.status(400).json({ ok: false, error: 'Unknown page.' });

  try {
    let draft = await getDraft(req.adminEmail, pageKey);
    if (!draft) {
      return res.status(400).json({ ok: false, error: 'No draft for this page yet.' });
    }
    // Describe mode must not skip the polish pass, even on a direct commit.
    if (mode === 'describe' && !draft.polished_at) {
      draft = await runPolishForDraft(req.adminEmail, pageKey);
    }

    const cleanHtml = sanitizeHtml(draft.html);
    const cleanCss = stripJsUrlsFromCss(draft.css);
    const missing = missingHooksSentence(pageKey, `${cleanHtml}\n${cleanCss}`);
    if (missing) {
      return res.status(400).json({ ok: false, error: missing });
    }

    if (pageKey === 'acknowledgement') {
      await syncPolicyDocuments(cleanHtml);
    }

    const assetIds = collectAssetIds(cleanHtml, cleanCss);
    const assetsById = new Map();
    for (const id of assetIds) {
      const asset = await getAssetById(id);
      if (asset) assetsById.set(id, asset);
    }
    const rewritten = rewriteAssetUrls(cleanHtml, cleanCss, assetsById);

    await upsertPublishedPage(
      pageKey,
      { html: rewritten.html, css: rewritten.css, projectJson: draft.project_json },
      req.adminEmail,
    );

    // Allowlisted paths only, one commit. backend/** is never touched, so a
    // Railway watch path of /backend/** keeps content commits from rebuilding.
    const nowIso = new Date().toISOString();
    const files = [
      {
        path: `frontend/content/${pageKey}.json`,
        bytes: JSON.stringify(
          {
            pageKey,
            html: rewritten.html,
            css: rewritten.css,
            projectJson: draft.project_json,
            publishedAt: nowIso,
            publishedBy: req.adminEmail,
          },
          null,
          2,
        ),
      },
      { path: `frontend/content/${pageKey}.css`, bytes: rewritten.css },
      ...rewritten.files,
    ];
    const github = isGithubConfigured()
      ? await commitContentFiles(files)
      : { committed: false, reason: 'GitHub token or repo not configured on the server.' };
    if (!github.committed) {
      console.warn('[admin components] publish without git commit:', github.reason);
    }

    return res.json({
      ok: true,
      published: true,
      github,
      content: { pageKey, html: rewritten.html, css: rewritten.css },
    });
  } catch (err) {
    console.error('[admin components] commit', err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || 'Could not publish the page.' });
  }
});

// ── Seed content ─────────────────────────────────────────────────────────────
// The receipt lives in backend/lib/templates/receipt.html (not on Pages), so
// the editor seeds its starting draft from here. Other pages seed from their
// static HTML files served alongside the editor.

router.get('/seed/receipt', (_req, res) => {
  try {
    const src = fs.readFileSync(RECEIPT_TEMPLATE_PATH, 'utf8');
    const css = (src.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [])
      .map((block) => block.replace(/^<style[^>]*>/i, '').replace(/<\/style>$/i, ''))
      .join('\n');
    const bodyMatch = src.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const html = bodyMatch ? bodyMatch[1].trim() : src;
    return res.json({ ok: true, pageKey: 'receipt', html, css });
  } catch (err) {
    console.error('[admin components] seed receipt', err);
    return res.status(500).json({ ok: false, error: 'Could not load the receipt template.' });
  }
});

export default router;