/*
 * Data access + pure helpers for the component editor.
 *
 * Tables (migrations/009_component_editor.sql):
 *   component_drafts  — one draft per (admin_email, page_key)
 *   component_pages   — published html/css/project_json per page_key
 *   component_assets  — uploaded images/PDFs as Postgres bytes
 *   policy_documents  — policy/reference cards synced from the Acknowledgement
 *                       page; submit requires a viewed timestamp per active
 *                       required row.
 */
import { query } from './db.js';

export const PAGE_KEYS = ['home', 'acknowledgement', 'thankyou', 'receipt'];

export function isPageKey(value) {
  return PAGE_KEYS.includes(value);
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export async function getDraft(adminEmail, pageKey) {
  const { rows } = await query(
    `SELECT admin_email, page_key, project_json, html, css,
            summary_for_polish, polished_at, updated_at
       FROM component_drafts
      WHERE admin_email = $1 AND page_key = $2`,
    [adminEmail, pageKey],
  );
  return rows[0] || null;
}

export async function saveDraft(adminEmail, draft) {
  const {
    pageKey,
    projectJson = {},
    html = '',
    css = '',
    summaryForPolish = null,
    polished = false,
  } = draft;
  const { rows } = await query(
    `INSERT INTO component_drafts
       (admin_email, page_key, project_json, html, css, summary_for_polish, polished_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, CASE WHEN $7 THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (admin_email, page_key) DO UPDATE SET
       project_json = EXCLUDED.project_json,
       html = EXCLUDED.html,
       css = EXCLUDED.css,
       summary_for_polish = COALESCE(EXCLUDED.summary_for_polish, component_drafts.summary_for_polish),
       polished_at = CASE
         WHEN $7 THEN NOW()
         WHEN EXCLUDED.html IS DISTINCT FROM component_drafts.html
           OR EXCLUDED.css IS DISTINCT FROM component_drafts.css
           OR EXCLUDED.project_json::text IS DISTINCT FROM component_drafts.project_json::text
         THEN NULL
         ELSE component_drafts.polished_at
       END,
       updated_at = NOW()
     RETURNING admin_email, page_key, project_json, html, css,
               summary_for_polish, polished_at, updated_at`,
    [
      adminEmail,
      pageKey,
      JSON.stringify(projectJson || {}),
      html,
      css,
      summaryForPolish,
      polished ? true : false,
    ],
  );
  return rows[0];
}

// ── Published pages ──────────────────────────────────────────────────────────

export async function getPublishedPage(pageKey) {
  const { rows } = await query(
    `SELECT page_key, html, css, project_json, published_at, published_by
       FROM component_pages
      WHERE page_key = $1`,
    [pageKey],
  );
  return rows[0] || null;
}

export async function upsertPublishedPage(pageKey, { html, css, projectJson }, publishedBy) {
  const { rows } = await query(
    `INSERT INTO component_pages (page_key, html, css, project_json, published_at, published_by)
     VALUES ($1, $2, $3, $4::jsonb, NOW(), $5)
     ON CONFLICT (page_key) DO UPDATE SET
       html = EXCLUDED.html,
       css = EXCLUDED.css,
       project_json = EXCLUDED.project_json,
       published_at = NOW(),
       published_by = EXCLUDED.published_by
     RETURNING page_key, html, css, project_json, published_at, published_by`,
    [pageKey, html, css, JSON.stringify(projectJson || {}), publishedBy || null],
  );
  return rows[0];
}

/**
 * Lightweight GrapesJS project JSON derived from html+css. Valid input for
 * Studio (PageProperties.component/styles accept strings), so a draft edited
 * in describe mode can always be reopened in the visual editor.
 */
export function lightweightProjectJson(pageName, html, css) {
  return {
    pages: [{ name: pageName || 'Page', component: html || '', styles: css || '' }],
  };
}

// ── Assets ───────────────────────────────────────────────────────────────────

export async function insertAsset({ filename, mime, bytes, createdBy }) {
  const { rows } = await query(
    `INSERT INTO component_assets (filename, mime, bytes, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, filename, mime, created_at`,
    [filename, mime, bytes, createdBy || null],
  );
  return rows[0];
}

export async function getAssetById(id) {
  const { rows } = await query(
    `SELECT id, filename, mime, bytes FROM component_assets WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

export function assetServeUrl(id) {
  return `/api/content/assets/${id}`;
}

function safeAssetFilename(filename) {
  const base = String(filename || 'file').replace(/\\/g, '/').split('/').pop();
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';
}

/** Where the publish commit writes the asset bytes for GitHub Pages. */
export function githubPathForAsset(asset) {
  const name = `${asset.id}-${safeAssetFilename(asset.filename)}`;
  const isPdf = (asset.mime || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(asset.filename || '');
  return isPdf ? `frontend/docs/${name}` : `frontend/assets/uploads/${name}`;
}

/** Pages-relative URL used once the publish commit lands (site root pages). */
export function pagesRelativeUrlForAsset(asset) {
  return githubPathForAsset(asset).replace(/^frontend\//, '');
}

const ASSET_URL_RE = /(?:https?:\/\/[^"'()\s]*)?\/api\/content\/assets\/(\d+)/g;

/** Asset ids referenced anywhere in an html/css string. */
export function collectAssetIds(...sources) {
  const ids = new Set();
  for (const src of sources) {
    if (typeof src !== 'string') continue;
    for (const m of src.matchAll(ASSET_URL_RE)) ids.add(Number(m[1]));
  }
  return [...ids];
}

/**
 * Rewrite /api/content/assets/:id URLs to their GitHub Pages paths.
 * @returns {{ html: string, css: string, files: Array<{ path: string, bytes: Buffer }> }}
 */
export function rewriteAssetUrls(html, css, assetsById) {
  const files = [];
  const replaceOne = (text) =>
    typeof text === 'string'
      ? text.replace(ASSET_URL_RE, (full, id) => {
          const asset = assetsById.get(Number(id));
          if (!asset) return full;
          if (!files.some((f) => f.path === githubPathForAsset(asset))) {
            files.push({ path: githubPathForAsset(asset), bytes: asset.bytes });
          }
          return pagesRelativeUrlForAsset(asset);
        })
      : text;
  return { html: replaceOne(html), css: replaceOne(css), files };
}

// ── Policy documents ─────────────────────────────────────────────────────────

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function parseAttrs(attrText) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>`]+))?/g;
  let m;
  while ((m = re.exec(attrText || '')) !== null) {
    let value = m[2] != null ? m[2] : '';
    value = value.replace(/^["']|["']$/g, '');
    attrs[m[1].toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Extract balanced elements whose opening tag matches `matches(attrs)`.
 * Matches inside an already-matched parent are suppressed (nested cards).
 */
function extractBalancedElements(html, matches) {
  const out = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const [full, closing, tagName, attrText] = m;
    const tag = tagName.toLowerCase();
    const voidTag = /^(img|br|hr|input|meta|link|source|area|base|col|embed|track|wbr)$/i.test(tag);
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          const opener = stack[i];
          stack.splice(i, 1);
          if (opener.matched) {
            out.push({
              attrs: opener.attrs,
              openTag: opener.openTag,
              inner: html.slice(opener.end, m.index),
              full: html.slice(opener.start, m.index + full.length),
            });
          }
          break;
        }
      }
      continue;
    }
    if (voidTag) continue;
    const attrs = parseAttrs(attrText);
    if (/\/\s*$/.test(attrText || '')) {
      if (matches(attrs)) out.push({ attrs, openTag: full, inner: '', full });
      continue;
    }
    let matched = matches(attrs);
    if (matched && stack.some((s) => s.matched)) matched = false;
    stack.push({ tag, attrs, start: m.index, end: m.index + full.length, openTag: full, matched });
  }
  return out;
}

/**
 * Parse policy/reference cards out of the Acknowledgement page HTML.
 * Required cards carry `data-doc="<docKey>"`; reference cards are `.ref-card`
 * elements (or anything with `data-ref-pdf`) and key off `data-ref-key`.
 */
export function parsePolicyCards(html) {
  const src = typeof html === 'string' ? html : '';
  const cards = [];

  const requiredEls = extractBalancedElements(src, (attrs) => attrs['data-doc'] != null);
  requiredEls.forEach((el, idx) => {
    const docKey = (el.attrs['data-doc'] || '').trim();
    if (!docKey) return;
    const h3 = (el.inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1];
    const pdfSrc =
      (el.inner.match(/data-pdf-src\s*=\s*["']([^"']*)["']/i) || [])[1] ||
      (el.full.match(/data-pdf-src\s*=\s*["']([^"']*)["']/i) || [])[1] ||
      (el.inner.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] ||
      '';
    cards.push({
      docKey,
      title: stripTags(el.attrs['data-doc-title'] || h3 || '') || docKey,
      kind: el.attrs['data-doc-kind'] === 'reference' ? 'reference' : 'required',
      filePath: stripTags(pdfSrc) || `docs/${docKey}.pdf`,
      sortOrder: idx,
    });
  });

  const refEls = extractBalancedElements(src, (attrs) => {
    const cls = attrs['class'] || '';
    return /\bref-card\b/.test(cls) || attrs['data-ref-pdf'] != null;
  });
  refEls.forEach((el, idx) => {
    const pdfTitle = el.attrs['data-pdf-title'] || '';
    const pdfSrc =
      (el.full.match(/data-pdf-src\s*=\s*["']([^"']*)["']/i) || [])[1] ||
      (el.full.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] ||
      '';
    const srcPath = stripTags(pdfSrc);
    const docKey = el.attrs['data-ref-key']
      ? el.attrs['data-ref-key'].trim()
      : String(pdfTitle || srcPath)
          .toLowerCase()
          .replace(/\.pdf$/i, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
    if (!docKey) return;
    const h3 = (el.inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1];
    cards.push({
      docKey,
      title: stripTags(pdfTitle || h3 || '') || docKey,
      kind: 'reference',
      filePath: srcPath || `docs/${docKey}.pdf`,
      sortOrder: idx,
    });
  });

  return cards;
}

/** Mirror the parsed cards into policy_documents; rows absent from the HTML go inactive. */
export async function syncPolicyDocuments(html) {
  const cards = parsePolicyCards(html);
  const seen = [];
  for (const card of cards) {
    seen.push(card.docKey);
    await query(
      `INSERT INTO policy_documents (doc_key, title, kind, file_path, sort_order, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
       ON CONFLICT (doc_key) DO UPDATE SET
         title = EXCLUDED.title,
         kind = EXCLUDED.kind,
         file_path = EXCLUDED.file_path,
         sort_order = EXCLUDED.sort_order,
         active = TRUE,
         updated_at = NOW()`,
      [card.docKey, card.title, card.kind, card.filePath, card.sortOrder],
    );
  }
  let deactivated = 0;
  if (seen.length > 0) {
    const { rowCount } = await query(
      `UPDATE policy_documents SET active = FALSE, updated_at = NOW()
        WHERE active = TRUE AND NOT (doc_key = ANY($1::text[]))`,
      [seen],
    );
    deactivated = rowCount;
  }
  return { cards, deactivated };
}

export async function listActiveRequiredPolicyDocs() {
  const { rows } = await query(
    `SELECT doc_key, title, kind, file_path, sort_order
       FROM policy_documents
      WHERE active = TRUE AND kind = 'required'
      ORDER BY sort_order ASC, title ASC`,
  );
  return rows;
}

export async function listActivePolicyDocs() {
  const { rows } = await query(
    `SELECT doc_key, title, kind, file_path, sort_order
       FROM policy_documents
      WHERE active = TRUE
      ORDER BY kind ASC, sort_order ASC, title ASC`,
  );
  return rows;
}

/**
 * Pure check used by submit: every active required row needs a valid viewed
 * timestamp. Returns the rows that are missing one.
 */
export function findMissingRequiredDocViews(requiredRows, viewTimestamps) {
  const missing = [];
  for (const row of requiredRows || []) {
    const ts = viewTimestamps ? viewTimestamps[row.doc_key] : undefined;
    const valid = typeof ts === 'string' && !isNaN(new Date(ts).getTime());
    if (!valid) missing.push(row);
  }
  return missing;
}