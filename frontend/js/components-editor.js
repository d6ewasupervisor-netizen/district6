/*
 * Component editor page (components.html?mode=manual | ?mode=describe).
 *
 * Manual mode runs the Studio canvas (vendored UMD builds). Describe mode runs
 * the message loop against the backend and previews the shared draft. Both
 * modes persist one draft per page: IndexedDB (d6-component-drafts / pages)
 * mirrored to the server, newest updatedAt wins on load.
 */
(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;
  const JWT_KEY = 'd6-admin-jwt';
  const IDB_NAME = 'd6-component-drafts';
  const IDB_STORE = 'pages';
  const SAVE_DEBOUNCE_MS = 400;
  const LAST_PAGE_KEY = 'd6-components-page';

  const PAGES = {
    home: { key: 'home', label: 'Home', file: 'index.html' },
    acknowledgement: { key: 'acknowledgement', label: 'Acknowledgement', file: 'sign.html' },
    thankyou: { key: 'thankyou', label: 'Thank you', file: 'thanks.html' },
    receipt: { key: 'receipt', label: 'Receipt', file: null },
  };

  const els = {
    title: document.getElementById('editor-title'),
    signInRequired: document.getElementById('sign-in-required'),
    editorBody: document.getElementById('editor-body'),
    pagePicker: document.getElementById('page-picker'),
    status: document.getElementById('editor-status'),
    manualMode: document.getElementById('manual-mode'),
    describeMode: document.getElementById('describe-mode'),
    studioRoot: document.getElementById('studio-root'),
    transcript: document.getElementById('transcript'),
    describeInput: document.getElementById('describe-input'),
    previewFrame: document.getElementById('preview-frame'),
    doneBtn: document.getElementById('done-btn'),
    commitBtn: document.getElementById('commit-btn'),
  };

  const mode =
    new URLSearchParams(location.search).get('mode') === 'describe' ? 'describe' : 'manual';

  let jwt = '';
  try { jwt = sessionStorage.getItem(JWT_KEY) || ''; } catch (_e) { jwt = ''; }

  let currentPageKey = 'home';
  let draft = null; // { pageKey, projectJson, html, css, updatedAt }
  let siteCssText = '';
  let studioEditor = null;
  let saveTimer = null;
  let saving = false;

  // Describe-mode conversation state.
  let questionsAsked = 0;
  const history = [];

  // ── Small helpers ─────────────────────────────────────────────────────────

  function showStatus(kind, msg) {
    els.status.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    els.status.textContent = msg;
    els.status.classList.remove('hidden');
  }
  function hideStatus() {
    els.status.classList.add('hidden');
  }

  function authHeaders() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt };
  }

  async function api(path, options) {
    const opts = options || {};
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: authHeaders(),
      body: opts.body,
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ── IndexedDB draft store ─────────────────────────────────────────────────

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'pageKey' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(pageKey) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(pageKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (_e) {
      return null;
    }
  }

  async function idbPut(record) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_e) {
      // Draft persistence is best-effort; the server copy still exists.
    }
  }

  function toDraftRecord() {
    return {
      pageKey: draft.pageKey,
      projectJson: draft.projectJson || {},
      html: draft.html || '',
      css: draft.css || '',
      updatedAt: draft.updatedAt,
    };
  }

  function pickNewer(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return new Date(a.updatedAt || 0) >= new Date(b.updatedAt || 0) ? a : b;
  }

  // ── Draft load / save ─────────────────────────────────────────────────────

  async function fetchServerDraft(pageKey) {
    try {
      const res = await api('/api/admin/components/draft/' + pageKey);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.draft) return null;
      return {
        pageKey,
        projectJson: data.draft.projectJson || data.draft.project_json || {},
        html: data.draft.html || '',
        css: data.draft.css || '',
        updatedAt: data.draft.updatedAt || data.draft.updated_at,
      };
    } catch (_e) {
      return null;
    }
  }

  /** First run for a page: seed from the current static page (or receipt template). */
  async function seedDraft(pageKey) {
    const page = PAGES[pageKey];
    let html = '';
    let css = '';
    if (page.file) {
      const res = await fetch(page.file, { cache: 'no-store' });
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const canvas = doc.querySelector('[data-d6-canvas]');
      html = canvas ? canvas.innerHTML : '';
    } else {
      const res = await api('/api/admin/components/seed/receipt');
      const data = await res.json().catch(() => ({}));
      html = data.html || '';
      css = data.css || '';
    }
    return {
      pageKey,
      projectJson: {},
      html,
      css,
      updatedAt: new Date(0).toISOString(),
    };
  }

  async function loadDraft(pageKey) {
    const [local, server] = await Promise.all([idbGet(pageKey), fetchServerDraft(pageKey)]);
    const best = pickNewer(local, server) || (await seedDraft(pageKey));
    draft = best;
    return draft;
  }

  function captureFromStudio() {
    if (!studioEditor || !draft) return;
    try {
      draft.projectJson = studioEditor.getProjectData();
      draft.html = studioEditor.getHtml();
      draft.css = studioEditor.getCss();
    } catch (_e) {
      // Editor may be mid-teardown during a page switch.
    }
  }

  function scheduleSave() {
    if (!draft) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!draft || saving) return;
    saving = true;
    if (mode === 'manual') captureFromStudio();
    draft.updatedAt = new Date().toISOString();
    const record = toDraftRecord();
    await idbPut(record);
    try {
      await api('/api/admin/components/draft', {
        method: 'PUT',
        body: JSON.stringify(record),
      });
    } catch (_e) {
      // Offline or transient failure: the IndexedDB copy covers refresh/back.
    }
    saving = false;
  }

  /** Best-effort final flush on pagehide / tab hide (beacon can only POST). */
  function flushBeacon() {
    clearTimeout(saveTimer);
    if (!draft) return;
    if (mode === 'manual') captureFromStudio();
    draft.updatedAt = new Date().toISOString();
    const record = toDraftRecord();
    idbPut(record);
    try {
      const blob = new Blob([JSON.stringify(record)], { type: 'application/json' });
      navigator.sendBeacon(
        API_BASE + '/api/admin/components/draft?token=' + encodeURIComponent(jwt),
        blob,
      );
    } catch (_e) {
      // Nothing else to try during unload.
    }
  }

  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon();
  });

  // ── Blocks (the full set the admin can add) ───────────────────────────────

  const POLICY_CARD_HTML =
    '<div class="doc-card policy-card" data-doc="policyKey" data-doc-title="Policy Title">' +
    '<h3 class="doc-card-title">Policy Title</h3>' +
    '<p class="doc-meta">Policy · PDF</p>' +
    '<div class="doc-card-row">' +
    '<button class="secondary doc-open" type="button" data-pdf-src="docs/example.pdf" data-pdf-title="Policy Title">Open</button>' +
    '<div class="doc-card-status" data-timer></div>' +
    '</div>' +
    '<label class="checkbox-row disabled">' +
    '<input type="checkbox" class="doc-check" disabled />' +
    '<span>I have read this document</span>' +
    '</label>' +
    '</div>';

  const REFERENCE_CARD_HTML =
    '<a class="ref-card reference-card" href="docs/example.pdf" data-ref-pdf data-ref-key="example" ' +
    'data-pdf-src="docs/example.pdf" data-pdf-title="Reference Title" target="_blank" rel="noopener">' +
    '<div class="ref-card-body">' +
    '<h3 class="ref-card-title">Reference Title</h3>' +
    '<p class="ref-card-desc">Short description of this reference document.</p>' +
    '<span class="ref-card-meta">Reference · PDF</span>' +
    '</div>' +
    '<span class="ref-card-action" aria-hidden="true">Open</span>' +
    '</a>';

  const SIGNATURE_BLOCK_HTML =
    '<section id="sign-section" class="card">' +
    '<h2 id="sign-heading">Sign your acknowledgement</h2>' +
    '<div id="submit-status" class="notice hidden" role="status" aria-live="polite"></div>' +
    '<p><strong>Email:</strong> <span id="signer-email-2" class="signer-email">—</span></p>' +
    '<label for="full-name">Full Name</label>' +
    '<input id="full-name" type="text" autocomplete="name" placeholder="First Last" />' +
    '<div style="margin-top: 16px;">' +
    '<label>Signature</label>' +
    '<div class="sig-wrap"><canvas id="signature-pad"></canvas></div>' +
    '<div class="sig-actions">' +
    '<span>Sign with your finger or mouse.</span>' +
    '<button id="clear-sig" type="button">Clear</button>' +
    '</div></div>' +
    '<div class="legal-text">By signing below, I acknowledge that I have received, reviewed, and understand the policies listed above (Spring 2026 Edition, effective May 1, 2026). I agree to follow the rules and guidelines stated in these documents and understand that violations may result in disciplinary action up to and including termination. I confirm I know how to access these policies in the future and may request additional copies from my Supervisor at any time.</div>' +
    '<label class="checkbox-row">' +
    '<input id="agree-check" type="checkbox" />' +
    '<span>I have read and agree to the acknowledgement statement above.</span>' +
    '</label>' +
    '<button id="submit-btn" class="primary" type="button" disabled>Submit Acknowledgement</button>' +
    '</section>';

  const D6_BLOCKS = [
    { id: 'd6-heading', label: 'Heading', content: '<h2>Heading</h2>' },
    { id: 'd6-text', label: 'Text', content: '<p>Text</p>' },
    { id: 'd6-image', label: 'Image', content: { type: 'image', src: 'assets/logo.png' } },
    { id: 'd6-link', label: 'Link', content: '<a href="#">Link</a>' },
    { id: 'd6-button', label: 'Button', content: '<button type="button">Button</button>' },
    {
      id: 'd6-section',
      label: 'Section',
      content: '<section class="card"><h2>Section</h2><p>Section content.</p></section>',
    },
    { id: 'd6-policy-card', label: 'Policy PDF card', content: POLICY_CARD_HTML },
    { id: 'd6-reference-card', label: 'Reference PDF card', content: REFERENCE_CARD_HTML },
    { id: 'd6-signature-block', label: 'Signature block', content: SIGNATURE_BLOCK_HTML },
  ];

  function injectSiteCss(editor) {
    if (!siteCssText) return;
    try {
      const frameEl = editor.Canvas && editor.Canvas.getFrameEl && editor.Canvas.getFrameEl();
      const doc = frameEl && frameEl.contentDocument;
      if (!doc || !doc.head) return;
      if (doc.head.querySelector('#d6-site-css')) return;
      const style = doc.createElement('style');
      style.id = 'd6-site-css';
      style.textContent = siteCssText;
      doc.head.appendChild(style);
    } catch (_e) {
      // Canvas not ready yet; retried on the next frame load.
    }
  }

  function d6PluginFactory() {
    return function d6Plugin(editor) {
      studioEditor = editor;
      editor.on('update', scheduleSave);
      editor.on('load', () => {
        injectSiteCss(editor);
        // Keep only the nine blocks this editor is meant to offer.
        const allowed = new Set(D6_BLOCKS.map((b) => b.id));
        editor.Blocks.getAll().forEach((block) => {
          if (!allowed.has(block.getId())) editor.Blocks.remove(block.getId());
        });
      });
      editor.on('canvas:frame:load', () => injectSiteCss(editor));
    };
  }

  async function uploadAssets({ files }) {
    const out = [];
    for (const file of files || []) {
      try {
        const bytesBase64 = await fileToBase64(file);
        const res = await api('/api/admin/components/upload', {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            mime: file.type || 'application/octet-stream',
            bytesBase64,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          out.push({ src: data.url, name: data.filename, mimeType: data.mime });
        }
      } catch (_e) {
        // Skip this file; the rest still upload.
      }
    }
    return out;
  }

  // ── Manual mode (Studio) ──────────────────────────────────────────────────

  async function initStudio() {
    const createStudioEditor =
      (window.GrapesJsStudioSDK &&
        (window.GrapesJsStudioSDK.default || window.GrapesJsStudioSDK.createStudioEditor)) ||
      null;
    if (!createStudioEditor) {
      showStatus('error', 'The editor could not load. Refresh and try again.');
      return;
    }
    const cfgRes = await api('/api/admin/components/studio-config');
    const cfg = await cfgRes.json().catch(() => ({}));
    if (!cfgRes.ok || !cfg.ok) {
      showStatus('error', cfg.setup || 'The editor key is not set on the server yet.');
      return;
    }

    const page = PAGES[currentPageKey];
    const projectData =
      draft.projectJson && Array.isArray(draft.projectJson.pages) && draft.projectJson.pages.length
        ? draft.projectJson
        : { pages: [{ name: page.label, component: draft.html }] };

    const plugins = [d6PluginFactory()];
    if (currentPageKey === 'receipt') {
      const preset = window.StudioSdkPlugins_presetPrintable;
      const presetPlugin =
        preset && typeof preset.init === 'function'
          ? preset.init({ selectedDevice: 'letter', fixedHeight: true })
          : preset;
      if (presetPlugin) plugins.unshift(presetPlugin);
    }

    els.studioRoot.innerHTML = '';
    await createStudioEditor({
      licenseKey: cfg.licenseKey,
      root: '#studio-root',
      project: {
        type: currentPageKey === 'receipt' ? 'document' : 'web',
        default: projectData,
      },
      storage: {
        type: 'self',
        project: projectData,
        onLoad: async () => ({ project: projectData }),
        onSave: async () => {
          captureFromStudio();
          scheduleSave();
        },
      },
      blocks: { default: D6_BLOCKS },
      assets: {
        storageType: 'self',
        onUpload: uploadAssets,
        onLoad: async () => [],
      },
      plugins,
    });
  }

  // ── Describe mode ─────────────────────────────────────────────────────────

  function refreshPreview() {
    if (!draft) return;
    els.previewFrame.srcdoc =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<style>' + (siteCssText || '') + '</style>' +
      '<style>' + (draft.css || '') + '</style>' +
      '</head><body>' + (draft.html || '') + '</body></html>';
  }

  function pushTranscript(who, text) {
    const div = document.createElement('div');
    div.className = 'd6-msg ' + (who === 'admin' ? 'd6-msg-admin' : 'd6-msg-page');
    div.textContent = text;
    els.transcript.appendChild(div);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  async function sendDescribeMessage() {
    const message = els.describeInput.value.trim();
    if (!message) return;
    els.describeInput.value = '';
    pushTranscript('admin', message);
    els.describeInput.disabled = true;
    hideStatus();
    try {
      const res = await api('/api/admin/components/describe', {
        method: 'POST',
        body: JSON.stringify({
          pageKey: currentPageKey,
          message,
          history,
          questionsAsked,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showStatus('error', data.error || 'Could not send that. Try again.');
        return;
      }
      if (data.kind === 'question') {
        questionsAsked = Number(data.questionsAsked) || questionsAsked + 1;
        history.push({ who: 'admin', text: message }, { who: 'page', text: data.question });
        pushTranscript('page', data.question);
      } else {
        history.push({ who: 'admin', text: message }, { who: 'page', text: 'Changes applied.' });
        if (data.draft) {
          draft = Object.assign({}, draft, data.draft, { pageKey: currentPageKey });
          await idbPut(toDraftRecord());
          refreshPreview();
        }
        pushTranscript('page', 'Changes applied.');
      }
    } catch (_e) {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      els.describeInput.disabled = false;
      els.describeInput.focus();
    }
  }

  /** "I'm done" — finish pass only; publishing stays on the other button. */
  async function runFinishPass() {
    els.doneBtn.disabled = true;
    hideStatus();
    try {
      await saveNow();
      const res = await api('/api/admin/components/polish', {
        method: 'POST',
        body: JSON.stringify({ pageKey: currentPageKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showStatus('error', data.error || 'Could not finish the page.');
        return;
      }
      if (data.draft) {
        draft = Object.assign({}, draft, data.draft, { pageKey: currentPageKey });
        await idbPut(toDraftRecord());
        refreshPreview();
      }
      showStatus('ok', 'Finished. Commit to save all changes when you are ready.');
    } catch (_e) {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      els.doneBtn.disabled = false;
    }
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  async function commitChanges() {
    els.commitBtn.disabled = true;
    els.commitBtn.textContent = 'Saving…';
    hideStatus();
    try {
      await saveNow();
      // In describe mode the server runs the finish pass first when this draft
      // has not had one yet, so committing early never skips it.
      const res = await api('/api/admin/components/commit', {
        method: 'POST',
        body: JSON.stringify({ pageKey: currentPageKey, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showStatus('error', data.error || 'Could not publish. Try again.');
        return;
      }
      showStatus('ok', 'Published. The live page updates on its next load.');
    } catch (_e) {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      els.commitBtn.disabled = false;
      els.commitBtn.textContent = 'Commit to save all changes';
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function openPage(pageKey) {
    currentPageKey = pageKey;
    try { sessionStorage.setItem(LAST_PAGE_KEY, pageKey); } catch (_e) { /* ignore */ }
    els.pagePicker.value = pageKey;
    hideStatus();
    await loadDraft(pageKey);
    if (mode === 'manual') {
      await initStudio();
    } else {
      refreshPreview();
    }
  }

  async function start() {
    if (!jwt) {
      els.signInRequired.classList.remove('hidden');
      return;
    }
    els.title.textContent = mode === 'describe' ? 'Describe your changes' : 'Update Components';
    document.title =
      (mode === 'describe' ? 'Describe your changes' : 'Update Components') +
      ' — District 6 Compliance Hub';
    els.editorBody.classList.remove('hidden');
    if (mode === 'manual') {
      els.describeMode.classList.add('hidden');
    } else {
      els.manualMode.classList.add('hidden');
      els.describeMode.classList.remove('hidden');
      els.doneBtn.classList.remove('hidden');
    }

    try {
      const res = await fetch('assets/styles.css', { cache: 'no-store' });
      if (res.ok) siteCssText = await res.text();
    } catch (_e) {
      siteCssText = '';
    }

    els.pagePicker.addEventListener('change', () => {
      saveNow().finally(() => openPage(els.pagePicker.value));
    });
    els.commitBtn.addEventListener('click', commitChanges);
    if (mode === 'describe') {
      els.doneBtn.addEventListener('click', runFinishPass);
      els.describeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendDescribeMessage();
        }
      });
    }

    let initial = 'home';
    try { initial = sessionStorage.getItem(LAST_PAGE_KEY) || 'home'; } catch (_e) { /* ignore */ }
    if (!PAGES[initial]) initial = 'home';
    await openPage(initial);
  }

  start();
})();