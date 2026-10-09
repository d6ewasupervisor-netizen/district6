/*
 * Server-side content-generation calls for the component editor.
 *
 * The Messages API is only ever called from the backend (ANTHROPIC_API_KEY on
 * the Railway service). The browser never sees that key, and no token for git
 * is passed into these prompts — publishing stays in the route layer.
 *
 * Two jobs:
 *  - runLayoutTurn  (claude-haiku-5-5): the clarifying-question loop, or an
 *    apply turn returning a patch (text, images, links, new blocks, removed
 *    blocks, CSS) plus summaryForPolish listing every choice the admin made.
 *  - runPolishPass  (claude-sonnet-5-5): takes summaryForPolish + the current
 *    project JSON and returns the final project JSON, HTML, and CSS.
 *
 * Responses must be JSON only. temperature/top_p/top_k are deliberately omitted.
 */
import {
  queryAll,
  parseHtmlTree,
  openTagHtml,
  escapeText,
  applyRangeEdits,
} from './component-sanitize.js';

export const LAYOUT_MODEL = 'claude-haiku-5-5';
export const POLISH_MODEL = 'claude-sonnet-5-5';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const HOOK_RULES = {
  home: 'Keep #email, #send-btn, and #access-overlay in the HTML.',
  acknowledgement:
    'Keep #hub, #full-name, #signature-pad, #clear-sig, #agree-check, #submit-btn, and at least one [data-doc] element in the HTML.',
  receipt:
    'Keep the Handlebars tokens {{fullName}}, {{email}}, {{{signatureDataUrl}}}, {{agreedAtPacific}}, the {{#each documents}} loop, and {{docVersion}} in the HTML.',
  thankyou: 'No functional hooks on this page.',
};

const SELECTOR_RULES = `Selectors may only use tag names, #id, .class, [attr], [attr="value"], and descendant (space) combinators.`;

const PATCH_SHAPE = `The patch must be a JSON object with these keys (all optional, use only what is needed):
{
  "text": [{ "selector": "...", "content": "plain text" }],
  "images": [{ "selector": "...", "src": "url", "alt": "optional" }],
  "links": [{ "selector": "...", "href": "url", "label": "optional plain text" }],
  "newBlocks": ["html string"],
  "removedBlocks": ["selector"],
  "css": "additional css rules"
}`;

/** Extract the first JSON object from a model response (tolerates code fences). */
export function parseModelJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Response did not contain JSON.');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Raw Messages API call. Throws on non-2xx; never includes the key in errors. */
export async function callClaude({ model, system, messages, maxTokens = 4096, fetchImpl = fetch }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('Content editing is not configured on the server yet.');
    err.status = 503;
    throw err;
  }
  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[claude-components] API error', res.status, detail.slice(0, 500));
    const err = new Error('The editing service returned an error. Try again shortly.');
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    : '';
  return text;
}

// ── Layout turn (clarifying question, or apply) ──────────────────────────────

function layoutSystemPrompt({ pageKey, apply }) {
  const base = `You are revising the public "${pageKey}" page of a small retail compliance website.
${HOOK_RULES[pageKey] || ''}
${SELECTOR_RULES}

You are talking to the site administrator through a form. Reply with ONLY one JSON object, no prose and no code fences.`;
  if (apply) {
    return `${base}

This is an apply turn: make the changes the administrator asked for across the whole conversation. Return:
{ "patch": ${PATCH_SHAPE}, "summaryForPolish": "a complete list of every choice the administrator made in this conversation (wording, placement, styling, ordering, what was kept and what was removed)" }`;
  }
  return `${base}

This is a question turn. Ask exactly one short clarifying question about the next most important thing you need to know before making changes. Do not make changes yet. Return:
{ "question": "your single question" }`;
}

/**
 * @param {{ pageKey: string, html: string, css: string, projectJson: object,
 *           history: Array<{who: string, text: string}>, apply: boolean }} opts
 * @returns {Promise<{kind:'question', question: string} | {kind:'patch', patch: object, summaryForPolish: string}>}
 */
export async function runLayoutTurn({ pageKey, html, css, projectJson, history = [], apply = false, fetchImpl }) {
  const context = JSON.stringify(
    {
      pageKey,
      currentHtml: html,
      currentCss: css,
      currentProjectJson: projectJson || {},
      conversation: history.map((h) => ({ who: h.who, text: h.text })),
    },
    null,
    2,
  );
  const text = await callClaude({
    model: LAYOUT_MODEL,
    system: layoutSystemPrompt({ pageKey, apply }),
    messages: [{ role: 'user', content: context }],
    fetchImpl,
  });
  const parsed = parseModelJson(text);
  if (apply) {
    const patch = parsed.patch && typeof parsed.patch === 'object' ? parsed.patch : {};
    return {
      kind: 'patch',
      patch,
      summaryForPolish: String(parsed.summaryForPolish || ''),
    };
  }
  return {
    kind: 'question',
    question: String(parsed.question || '').trim(),
  };
}

// ── Polish pass ──────────────────────────────────────────────────────────────

function polishSystemPrompt(pageKey) {
  return `You are doing the final polish pass on the public "${pageKey}" page of a small retail compliance website.
${HOOK_RULES[pageKey] || ''}
You receive a summary of every choice the administrator made and the current page state. Produce the final, cleaned-up version: consistent copy, spacing, and styling that matches the choices in the summary. Do not invent new requirements.
Reply with ONLY one JSON object, no prose and no code fences:
{
  "projectJson": { "pages": [{ "name": "${pageKey}", "component": "full final HTML", "styles": "full final CSS" }] },
  "html": "full final HTML",
  "css": "full final CSS"
}`;
}

/**
 * @returns {Promise<{ projectJson: object, html: string, css: string }>}
 */
export async function runPolishPass({ pageKey, html, css, projectJson, summaryForPolish = '', fetchImpl }) {
  const context = JSON.stringify(
    {
      pageKey,
      summaryForPolish,
      currentHtml: html,
      currentCss: css,
      currentProjectJson: projectJson || {},
    },
    null,
    2,
  );
  const text = await callClaude({
    model: POLISH_MODEL,
    system: polishSystemPrompt(pageKey),
    messages: [{ role: 'user', content: context }],
    fetchImpl,
  });
  const parsed = parseModelJson(text);
  const finalHtml = typeof parsed.html === 'string' ? parsed.html : html;
  const finalCss = typeof parsed.css === 'string' ? parsed.css : css;
  const finalProject =
    parsed.projectJson && typeof parsed.projectJson === 'object' && parsed.projectJson.pages
      ? parsed.projectJson
      : { pages: [{ name: pageKey, component: finalHtml, styles: finalCss }] };
  return { projectJson: finalProject, html: finalHtml, css: finalCss };
}

// ── Patch application (deterministic, server-side) ───────────────────────────

function closeTagLen(html, el) {
  const close = `</${el.tag}>`;
  return html.slice(el.end - close.length, el.end).toLowerCase() === close.toLowerCase()
    ? close.length
    : 0;
}

function firstInnerLink(tree, el) {
  return tree.elements.find(
    (e) => e.tag === 'a' && e.start >= el.openEnd && e.end <= el.end && e !== el,
  );
}

function removeMatching(html, selector) {
  const tree = parseHtmlTree(html);
  const matches = queryAll(tree, selector).filter(
    (el) => !queryAll(tree, selector).some((other) => other !== el && other.start <= el.start && other.end >= el.end),
  );
  if (matches.length === 0) return html;
  const edits = matches.map((el) => ({ start: el.start, end: el.end, replacement: '' }));
  return applyRangeEdits(html, edits);
}

function replaceInner(html, selector, inner) {
  const tree = parseHtmlTree(html);
  const el = queryAll(tree, selector)[0];
  if (!el) return html;
  const innerEnd = el.end - closeTagLen(html, el);
  return applyRangeEdits(html, [{ start: el.openEnd, end: innerEnd, replacement: inner }]);
}

function setAttrOnTarget(html, selector, preferredTag, attrsToSet) {
  const tree = parseHtmlTree(html);
  const el = queryAll(tree, selector)[0];
  if (!el) return html;
  let target = el;
  if (preferredTag && el.tag !== preferredTag) {
    target =
      tree.elements.find(
        (e) => e.tag === preferredTag && e.start >= el.openEnd && e.end <= el.end && e !== el,
      ) || el;
  }
  const attrs = { ...target.attrs, ...attrsToSet };
  const selfClosing = target.openEnd === target.end;
  return applyRangeEdits(html, [
    { start: target.start, end: target.openEnd, replacement: openTagHtml(target.tag, attrs, selfClosing) },
  ]);
}

/**
 * Apply a Haiku patch (text, images, links, newBlocks, removedBlocks, css) to
 * an html/css pair. Unknown selectors are skipped silently — the model is told
 * to keep required hooks, and the publish hook check is the final gate.
 */
export function applyProjectPatch(html, css, patch) {
  let out = typeof html === 'string' ? html : '';
  const p = patch && typeof patch === 'object' ? patch : {};

  for (const selector of Array.isArray(p.removedBlocks) ? p.removedBlocks : []) {
    if (typeof selector === 'string' && selector.trim()) out = removeMatching(out, selector.trim());
  }
  for (const item of Array.isArray(p.text) ? p.text : []) {
    if (!item || typeof item.selector !== 'string') continue;
    out = replaceInner(out, item.selector, escapeText(item.content));
  }
  for (const item of Array.isArray(p.images) ? p.images : []) {
    if (!item || typeof item.selector !== 'string' || typeof item.src !== 'string') continue;
    const attrs = { src: item.src };
    if (typeof item.alt === 'string') attrs.alt = item.alt;
    out = setAttrOnTarget(out, item.selector, 'img', attrs);
  }
  for (const item of Array.isArray(p.links) ? p.links : []) {
    if (!item || typeof item.selector !== 'string') continue;
    if (typeof item.href === 'string') {
      out = setAttrOnTarget(out, item.selector, 'a', { href: item.href });
    }
    if (typeof item.label === 'string') {
      const tree = parseHtmlTree(out);
      const el = queryAll(tree, item.selector)[0];
      const link = el && (el.tag === 'a' ? el : firstInnerLink(tree, el));
      if (link) {
        const innerEnd = link.end - closeTagLen(out, link);
        out = applyRangeEdits(out, [
          { start: link.openEnd, end: innerEnd, replacement: escapeText(item.label) },
        ]);
      }
    }
  }

  const blocks = (Array.isArray(p.newBlocks) ? p.newBlocks : [])
    .map((b) => (typeof b === 'string' ? b : b && typeof b.html === 'string' ? b.html : ''))
    .filter((b) => b.trim());
  if (blocks.length) out = `${out}\n${blocks.join('\n')}`;

  const extraCss = typeof p.css === 'string' ? p.css : '';
  const newCss = (typeof css === 'string' ? css : '') + (extraCss ? `\n${extraCss}` : '');
  return { html: out, css: newCss };
}