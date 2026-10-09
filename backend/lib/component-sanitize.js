/*
 * HTML sanitization and required-hook checks for published page content.
 *
 * Pure module — no database access — so publish validation is unit-testable.
 *
 * sanitizeHtml() strips:
 *   - <script>, <iframe>, <object>, <embed> elements (with their content)
 *   - on* event-handler attributes
 *   - javascript: URLs in href/src/action attributes
 *
 * findMissingHooks() enforces the functional hooks each published page must
 * keep so the live site keeps working after a content publish:
 *   home:           #email, #send-btn, #access-overlay
 *   acknowledgement:#hub, #full-name, #signature-pad, #clear-sig, #agree-check,
 *                   #submit-btn, and at least one [data-doc]
 *   receipt:        Handlebars tokens fullName, email, signatureDataUrl,
 *                   agreedAtPacific, the documents each-loop, docVersion
 *   thankyou:       (no required hooks)
 */

const DROP_WITH_CONTENT = ['script', 'iframe', 'object'];
const DROP_VOID = ['embed'];
const DROP_WITH_CONTENT_RE = new RegExp(
  `<(${DROP_WITH_CONTENT.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi',
);
const DROP_VOID_RE = new RegExp(`<(${DROP_VOID.join('|')})\\b[^>]*\\/?>`, 'gi');
// Unclosed leftovers: an opener with no matching close tag (truncated markup).
const DROP_UNCLOSED_RE = new RegExp(`<(${[...DROP_WITH_CONTENT, ...DROP_VOID].join('|')})\\b[^>]*$`, 'gi');

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>`]+))?/g;
const JS_URL_RE = /^\s*(?:javascript|vbscript|data:text\/html)\s*:/i;

function sanitizeAttributes(attrText) {
  const kept = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrText)) !== null) {
    const name = m[1];
    const eqAndValue = m[2] || '';
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) continue; // onclick, onload, onerror, ...
    if (/^(href|src|action|formaction|xlink:href)$/i.test(name)) {
      const value = eqAndValue.replace(/^\s*=\s*/, '').trim().replace(/^["']|["']$/g, '');
      if (JS_URL_RE.test(value)) continue;
    }
    kept.push(m[0]);
  }
  return kept.join(' ');
}

/**
 * Strip dangerous elements/attributes from an HTML fragment.
 * The two markup-only Handlebars shapes used by the receipt template are
 * untouched (they are text nodes, not tags).
 */
export function sanitizeHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  let out = html.replace(DROP_WITH_CONTENT_RE, '');
  out = out.replace(DROP_VOID_RE, '');
  out = out.replace(DROP_UNCLOSED_RE, '');
  out = out.replace(TAG_RE, (full, tagName, attrText) => {
    const attrs = sanitizeAttributes(attrText || '');
    const selfClose = /\/\s*$/.test(attrText || '');
    return `<${tagName}${attrs ? ` ${attrs}` : ''}${selfClose ? ' /' : ''}>`;
  });
  return out;
}

/** Selector/token names shown to the admin when a hook is missing. */
const RECEIPT_TOKENS = [
  { re: /\{\{\s*fullName\s*\}\}/, label: 'fullName' },
  { re: /\{\{\s*email\s*\}\}/, label: 'email' },
  { re: /\{\{\{\s*signatureDataUrl\s*\}\}\}|\{\{\s*signatureDataUrl\s*\}\}/, label: 'signatureDataUrl' },
  { re: /\{\{\s*agreedAtPacific\s*\}\}/, label: 'agreedAtPacific' },
  { re: /\{\{#each\s+documents\s*\}\}/, label: 'documents list' },
  { re: /\{\{\s*docVersion\s*\}\}/, label: 'docVersion' },
];

function idHookPresent(html, id) {
  // Matches id="email", id='email', id=email on some element.
  return new RegExp(`\\bid\\s*=\\s*(["']?)${id}\\1`, 'i').test(html);
}

/**
 * @returns {string[]} human-readable names of missing hooks (empty when OK)
 */
export function findMissingHooks(pageKey, html) {
  const src = typeof html === 'string' ? html : '';
  const missing = [];

  if (pageKey === 'home') {
    for (const id of ['email', 'send-btn', 'access-overlay']) {
      if (!idHookPresent(src, id)) missing.push(`#${id}`);
    }
  } else if (pageKey === 'acknowledgement') {
    for (const id of ['hub', 'full-name', 'signature-pad', 'clear-sig', 'agree-check', 'submit-btn']) {
      if (!idHookPresent(src, id)) missing.push(`#${id}`);
    }
    if (!/\bdata-doc\b/.test(src)) missing.push('[data-doc]');
  } else if (pageKey === 'receipt') {
    for (const token of RECEIPT_TOKENS) {
      if (!token.re.test(src)) missing.push(token.label);
    }
  }

  return missing;
}

/** Plain sentence naming what is missing, or null when everything is present. */
export function missingHooksSentence(pageKey, html) {
  const missing = findMissingHooks(pageKey, html);
  if (missing.length === 0) return null;
  return `This page is missing ${missing.join(', ')}.`;
}

// ── Minimal HTML tree / selector engine (no DOM dependency) ──────────────────
// Powers patch application in lib/claude-components.js. Supported selectors:
// tag, #id, .class, [attr], [attr="value"], and descendant (space) combinators.

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);

export function parseAttrs(attrText) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>`]+))?/g;
  let m;
  while ((m = re.exec(attrText || '')) !== null) {
    let value = m[2] != null ? m[2] : '';
    value = value.replace(/^["']|["']$/g, '');
    attrs[m[1]] = value;
  }
  return attrs;
}

/**
 * Parse a flat element tree with source ranges.
 * Element: { tag, attrs, parent, start, openEnd, end } where [start, end) is the
 * full element incl. tags and [openEnd, ...) starts the inner content.
 */
export function parseHtmlTree(html) {
  const elements = [];
  const roots = [];
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const [full, closing, tagName, attrText] = m;
    const tag = tagName.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          const el = stack[i];
          stack.splice(i, 1);
          el.end = m.index + full.length;
          break;
        }
      }
      continue;
    }
    const selfClosing = /\/\s*$/.test(attrText || '') || VOID_TAGS.has(tag);
    const el = {
      tag,
      attrs: parseAttrs(attrText),
      parent: stack.length ? stack[stack.length - 1] : null,
      start: m.index,
      openEnd: m.index + full.length,
      end: selfClosing ? m.index + full.length : null,
    };
    elements.push(el);
    if (el.parent) (el.parent.children || (el.parent.children = [])).push(el);
    else roots.push(el);
    if (!selfClosing) stack.push(el);
    else el.children = [];
  }
  // Unclosed elements extend to the end of the document.
  for (const el of stack) el.end = html.length;
  return { html, elements, roots };
}

function matchesCompound(el, compound) {
  if (compound.tag && compound.tag !== '*' && el.tag !== compound.tag) return false;
  for (const id of compound.ids) if (el.attrs.id !== id) return false;
  const classList = (el.attrs.class || '').split(/\s+/).filter(Boolean);
  for (const cls of compound.classes) if (!classList.includes(cls)) return false;
  for (const [name, value] of compound.attrs) {
    if (!(name in el.attrs)) return false;
    if (value != null && el.attrs[name] !== value) return false;
  }
  return true;
}

function parseCompound(token) {
  const compound = { tag: null, ids: [], classes: [], attrs: [] };
  const re = /([a-zA-Z][a-zA-Z0-9-]*|\*)|\.([a-zA-Z_][-a-zA-Z0-9_]*)|#([a-zA-Z_][-a-zA-Z0-9_]*)|\[([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s\]]+))?\]/g;
  let m;
  while ((m = re.exec(token)) !== null) {
    if (m[1]) compound.tag = m[1].toLowerCase();
    else if (m[2]) compound.classes.push(m[2]);
    else if (m[3]) compound.ids.push(m[3]);
    else if (m[4]) {
      let value = m[5] != null ? m[5] : null;
      if (value != null) value = value.replace(/^["']|["']$/g, '');
      compound.attrs.push([m[4], value]);
    }
  }
  return compound;
}

/** Query all elements matching a descendant-only CSS selector. */
export function queryAll(html, selector) {
  const tree = typeof html === 'string' ? parseHtmlTree(html) : html;
  const compounds = String(selector || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(parseCompound);
  if (compounds.length === 0) return [];
  return tree.elements.filter((el) => {
    let compound = compounds[compounds.length - 1];
    if (!matchesCompound(el, compound)) return false;
    for (let i = compounds.length - 2; i >= 0; i--) {
      compound = compounds[i];
      let parent = el.parent;
      while (parent && !matchesCompound(parent, compound)) parent = parent.parent;
      if (!parent) return false;
    }
    return true;
  });
}

/** Serialize an attribute map back into an open tag string. */
export function openTagHtml(tag, attrs, selfClosing = false) {
  const parts = Object.entries(attrs || {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => (v === '' ? k : `${k}="${String(v).replace(/"/g, '&quot;')}"`));
  return `<${tag}${parts.length ? ` ${parts.join(' ')}` : ''}${selfClosing ? ' /' : ''}>`;
}

export function escapeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Apply a list of { start, end, replacement } edits to html (non-overlapping,
 * applied back to front).
 */
export function applyRangeEdits(html, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of sorted) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}