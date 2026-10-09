/*
 * Chooser, then a full-window editor.
 * Documents (the PDFs people read) come first. Hub pages are second.
 * One document or one page is open at a time. Switching does not leave this screen.
 */
(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;
  const JWT_KEY = 'd6-admin-jwt';
  const IDB_NAME = 'd6-component-drafts';
  const IDB_STORE = 'pages';
  const SAVE_DEBOUNCE_MS = 400;

  const DOCS = [
    { key: 'doc-attendance', title: 'Attendance & Timekeeping', file: 'content/docs/attendance.html', kind: 'Required policy' },
    { key: 'doc-dress-code', title: 'Dress Code', file: 'content/docs/dress-code.html', kind: 'Required policy' },
    { key: 'doc-sop', title: 'Standard Operating Procedures', file: 'content/docs/sop.html', kind: 'Required policy' },
    { key: 'doc-handbook', title: 'Teammate Handbook', file: 'content/docs/handbook.html', kind: 'Reference' },
    { key: 'doc-kompass', title: 'Kompass Responsibilities', file: 'content/docs/kompass.html', kind: 'Reference' },
    { key: 'doc-vendor', title: 'Fred Meyer Vendor Policies', file: 'content/docs/vendor.html', kind: 'Reference' },
  ];

  const HUBS = [
    { key: 'home', title: 'Home', file: 'index.html' },
    { key: 'acknowledgement', title: 'Acknowledgement', file: 'sign.html' },
    { key: 'thankyou', title: 'Thank you', file: 'thanks.html' },
    { key: 'receipt', title: 'Receipt', file: null },
  ];

  const DOC_CSS = [
    '.d6-doc-page { background:#fff; padding: 8px 4px 28px; }',
    '.d6-doc-page h2 { font-size: 22px; line-height: 1.25; margin: 0 0 10px; color: #1A3A6E; }',
    '.d6-doc-page h3 { font-size: 16px; margin: 18px 0 6px; color: #1A3A6E; }',
    '.d6-doc-page p { font-size: 15px; line-height: 1.45; margin: 0 0 8px; }',
  ].join('\n');

  const mode = new URLSearchParams(location.search).get('mode') === 'describe' ? 'describe' : 'manual';

  const els = {
    chooser: document.getElementById('chooser'),
    chooserTitle: document.getElementById('chooser-title'),
    docGrid: document.getElementById('doc-grid'),
    hubGrid: document.getElementById('hub-grid'),
    workspace: document.getElementById('workspace'),
    backBtn: document.getElementById('back-btn'),
    workTitle: document.getElementById('work-title'),
    status: document.getElementById('editor-status'),
    describeBand: document.getElementById('describe-band'),
    transcript: document.getElementById('transcript'),
    describeInput: document.getElementById('describe-input'),
    pageHost: document.getElementById('page-host'),
    pieceFile: document.getElementById('piece-file'),
    doneBtn: document.getElementById('done-btn'),
    previewBtn: document.getElementById('preview-btn'),
    commitBtn: document.getElementById('commit-btn'),
    signInRequired: document.getElementById('sign-in-required'),
  };

  let current = null;
  let draft = null;
  let pageRoot = null;
  let previewOn = false;
  let siteCssText = '';
  let selectedImage = null;
  let saveTimer = null;
  let saving = false;
  let questionsAsked = 0;
  const history = [];

  function jwt() {
    try { return sessionStorage.getItem(JWT_KEY) || ''; } catch (_e) { return ''; }
  }

  function showStatus(msg, kind) {
    els.status.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    els.status.textContent = msg;
    els.status.classList.remove('hidden');
  }
  function hideStatus() { els.status.classList.add('hidden'); }

  function authHeaders() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt() };
  }

  async function api(path, options) {
    const opts = options || {};
    const res = await fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: authHeaders(),
      body: opts.body,
    });
    if (res.status === 401) showStatus('Sign in on the admin page first.', 'error');
    return res;
  }

  function targetByKey(key) {
    return DOCS.find((d) => d.key === key) || HUBS.find((h) => h.key === key) || null;
  }

  function isDoc(key) { return key.indexOf('doc-') === 0; }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE, { keyPath: 'pageKey' });
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
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(pageKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (_e) { return null; }
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
    } catch (_e) { /* server copy remains */ }
  }

  function pickNewer(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return new Date(a.updatedAt || 0) >= new Date(b.updatedAt || 0) ? a : b;
  }

  async function fetchServerDraft(pageKey) {
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
  }

  async function seedFromFile(target) {
    if (!target.file) {
      const res = await api('/api/admin/components/seed/receipt');
      const data = await res.json().catch(() => ({}));
      return { html: data.html || '', css: data.css || '' };
    }
    const res = await fetch(target.file, { cache: 'no-store' });
    const text = await res.text();
    if (isDoc(target.key)) return { html: text, css: DOC_CSS };
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const canvas = doc.querySelector('[data-d6-canvas]');
    return { html: canvas ? canvas.innerHTML : '', css: '' };
  }

  async function loadDraft(target) {
    const [local, server] = await Promise.all([idbGet(target.key), fetchServerDraft(target.key)]);
    let best = pickNewer(local, server);
    if (!best || !best.html) {
      const seeded = await seedFromFile(target);
      best = {
        pageKey: target.key,
        projectJson: {},
        html: seeded.html,
        css: seeded.css,
        updatedAt: new Date(0).toISOString(),
      };
    }
    draft = best;
  }

  function captureFromStudio() {
    if (!pageRoot || !draft) return;
    const clone = pageRoot.cloneNode(true);
    clone.querySelectorAll('.d6-block').forEach((block) => {
      const inner = block.querySelector(':scope > :not(.d6-handle)');
      if (inner) block.replaceWith(inner);
    });
    clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
    const html = clone.innerHTML.trim();
    if (!html) return;
    draft.html = html;
  }

  function record() {
    return {
      pageKey: draft.pageKey,
      projectJson: draft.projectJson || {},
      html: draft.html || '',
      css: draft.css || '',
      updatedAt: draft.updatedAt,
    };
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!draft || saving) return;
    saving = true;
    captureFromStudio();
    draft.updatedAt = new Date().toISOString();
    const body = record();
    await idbPut(body);
    try {
      await api('/api/admin/components/draft', { method: 'PUT', body: JSON.stringify(body) });
    } catch (_e) { /* indexedDB holds it */ }
    saving = false;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  function flushBeacon() {
    if (!draft) return;
    captureFromStudio();
    draft.updatedAt = new Date().toISOString();
    const body = record();
    idbPut(body);
    const token = jwt();
    if (!token) return;
    try {
      navigator.sendBeacon(
        API_BASE + '/api/admin/components/draft?token=' + encodeURIComponent(token),
        new Blob([JSON.stringify(body)], { type: 'application/json' }),
      );
    } catch (_e) { /* unload */ }
  }

  window.addEventListener('pagehide', flushBeacon);

  function setPreview(on) {
    previewOn = on;
    if (!els.previewBtn) return;
    els.previewBtn.textContent = on ? 'Back to editing' : 'Preview';
    els.previewBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  const NEW_BLOCKS = {
    h2: '<h2>Heading</h2>',
    h3: '<h3>Subheading</h3>',
    p: '<p>Text</p>',
    img: '<img src="assets/logo.png" alt="">',
  };

  const EDITOR_CSS = [
    '.d6-sheet { min-height: 100%; }',
    '.d6-block { position: relative; }',
    '.d6-block .d6-handle {',
    '  position: absolute; left: -28px; top: 4px; width: 22px; text-align: center;',
    '  cursor: grab; color: #5b6b7c; font-size: 14px; user-select: none;',
    '}',
    '.d6-block:hover { outline: 1px dashed #5BA8E0; }',
    '[contenteditable="true"]:focus { outline: 2px solid #1A3A6E; outline-offset: 2px; }',
    'img { max-width: 100%; cursor: pointer; }',
    '.d6-preview .d6-handle { display: none; }',
    '.d6-preview .d6-block:hover { outline: none; }',
  ].join('\n');

  function wrapElement(el) {
    if (!el || el.classList.contains('d6-block') || el.classList.contains('d6-handle')) return;
    if (!el.matches('h1,h2,h3,h4,p,img,ul,ol,table,a,button,blockquote')) return;
    const wrap = document.createElement('div');
    wrap.className = 'd6-block';
    wrap.draggable = true;
    const handle = document.createElement('span');
    handle.className = 'd6-handle';
    handle.textContent = '⋮⋮';
    handle.setAttribute('contenteditable', 'false');
    el.before(wrap);
    wrap.appendChild(handle);
    wrap.appendChild(el);
    if (!el.matches('img,table,ul,ol')) el.setAttribute('contenteditable', 'true');
  }

  function wrapBlocks(container) {
    Array.from(container.children).forEach((child) => {
      if (child.matches('section,div,main,article,header,footer') && !child.matches('img')) {
        wrapBlocks(child);
        return;
      }
      wrapElement(child);
    });
  }

  function nearestBlock(node) {
    while (node && node !== pageRoot) {
      if (node.classList && node.classList.contains('d6-block')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function insertHtml(html, before) {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const el = holder.firstElementChild;
    if (!el || !pageRoot) return;
    const target = before || pageRoot;
    if (before) before.before(el);
    else pageRoot.appendChild(el);
    wrapElement(el);
    scheduleSave();
  }

  function renderPage() {
    setPreview(false);
    const html = draft.html || '<section class="d6-doc-page"><h2>Heading</h2><p>Text</p></section>';
    const docMode = isDoc(current.key);
    const look = docMode ? (DOC_CSS + '\n' + (draft.css || '')) : (siteCssText + '\n' + (draft.css || ''));
    if (!els.pageHost.shadowRoot) els.pageHost.attachShadow({ mode: 'open' });
    const shadow = els.pageHost.shadowRoot;
    shadow.innerHTML = '<style>' + EDITOR_CSS + '\n' + look + '</style><div class="d6-sheet" id="sheet"></div>';
    pageRoot = shadow.getElementById('sheet');
    pageRoot.innerHTML = html;
    wrapBlocks(pageRoot);
    pageRoot.addEventListener('input', scheduleSave);
    pageRoot.addEventListener('dragstart', (event) => {
      const block = nearestBlock(event.target);
      if (!block) return;
      event.dataTransfer.setData('text/d6-move', '1');
      event.dataTransfer.setData('text/plain', 'move');
      block.dataset.moving = '1';
    });
    pageRoot.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    pageRoot.addEventListener('drop', (event) => {
      event.preventDefault();
      const fresh = event.dataTransfer.getData('text/d6-new');
      const moving = pageRoot.querySelector('[data-moving="1"]');
      const hit = nearestBlock(event.target) || pageRoot.lastElementChild;
      if (fresh) {
        insertHtml(fresh, hit);
        return;
      }
      if (moving && hit && hit !== moving) {
        hit.before(moving);
        delete moving.dataset.moving;
        scheduleSave();
      }
    });
    pageRoot.addEventListener('dragend', () => {
      pageRoot.querySelectorAll('[data-moving]').forEach((el) => delete el.dataset.moving);
    });
    pageRoot.addEventListener('click', (event) => {
      const image = event.target.closest && event.target.closest('img');
      if (image && pageRoot.contains(image)) {
        selectedImage = image;
        els.pieceFile.click();
      }
      const anchor = event.target.closest && event.target.closest('a');
      if (anchor) event.preventDefault();
    });
  }

  function togglePreview() {
    previewOn = !previewOn;
    setPreview(previewOn);
    document.body.classList.toggle('d6-previewing', previewOn);
    if (!pageRoot) return;
    pageRoot.classList.toggle('d6-preview', previewOn);
    pageRoot.querySelectorAll('[contenteditable]').forEach((el) => {
      el.setAttribute('contenteditable', previewOn ? 'false' : 'true');
    });
  }

  function destroyStudio() {
    captureFromStudio();
    pageRoot = null;
    if (els.pageHost.shadowRoot) els.pageHost.shadowRoot.innerHTML = '';
    setPreview(false);
    document.body.classList.remove('d6-previewing');
  }

  async function openTarget(target) {
    current = target;
    hideStatus();
    questionsAsked = 0;
    history.length = 0;
    els.transcript.textContent = '';
    els.workTitle.textContent = target.title;
    els.backBtn.textContent = isDoc(target.key) ? '← Documents' : '← Hub pages';
    els.chooser.classList.add('hidden');
    els.workspace.classList.remove('hidden');
    await loadDraft(target);
    renderPage();
  }

  async function backToChooser() {
    await saveNow();
    destroyStudio();
    current = null;
    draft = null;
    els.workspace.classList.add('hidden');
    els.chooser.classList.remove('hidden');
  }

  function pushTranscript(who, text) {
    const div = document.createElement('div');
    div.className = 'd6-msg ' + (who === 'admin' ? 'd6-msg-admin' : 'd6-msg-page');
    div.textContent = text;
    els.transcript.appendChild(div);
  }

  async function sendDescribeMessage() {
    const message = els.describeInput.value.trim();
    if (!message || !current) return;
    els.describeInput.value = '';
    pushTranscript('admin', message);
    els.describeInput.disabled = true;
    hideStatus();
    try {
      await saveNow();
      const res = await api('/api/admin/components/describe', {
        method: 'POST',
        body: JSON.stringify({ pageKey: current.key, message, history, questionsAsked }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showStatus(data.error || 'Could not send that. Try again.', 'error');
        return;
      }
      if (data.kind === 'question') {
        questionsAsked = Number(data.questionsAsked) || questionsAsked + 1;
        history.push({ who: 'admin', text: message }, { who: 'page', text: data.question });
        pushTranscript('page', data.question);
      } else {
        history.push({ who: 'admin', text: message });
        if (data.draft) {
          draft = Object.assign({}, draft, data.draft, { pageKey: current.key });
          destroyStudio();
          renderPage();
        }
        pushTranscript('page', 'Changes applied.');
      }
    } catch (_e) {
      showStatus('Network error. Please try again.', 'error');
    } finally {
      els.describeInput.disabled = false;
    }
  }

  async function commitChanges() {
    if (!current) return;
    els.commitBtn.disabled = true;
    els.commitBtn.textContent = 'Saving…';
    hideStatus();
    try {
      await saveNow();
      const res = await api('/api/admin/components/commit', {
        method: 'POST',
        body: JSON.stringify({ pageKey: current.key, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showStatus(data.error || 'Could not publish. Try again.', 'error');
        return;
      }
      showStatus(isDoc(current.key) ? 'Published. The PDF updates on the next load.' : 'Published. The live page updates on its next load.', 'ok');
    } catch (_e) {
      showStatus('Network error. Please try again.', 'error');
    } finally {
      els.commitBtn.disabled = false;
      els.commitBtn.textContent = 'Commit to save all changes';
    }
  }

  function fillGrid(grid, items) {
    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = item.title + (item.kind ? '<small>' + item.kind + '</small>' : '');
      btn.addEventListener('click', () => openTarget(item));
      grid.appendChild(btn);
    });
  }

  async function start() {
    if (!jwt()) {
      els.chooser.classList.add('hidden');
      els.signInRequired.classList.remove('hidden');
      return;
    }
    if (mode === 'describe') {
      document.body.classList.add('d6-describe');
      els.chooserTitle.textContent = 'Describe your changes';
      els.describeBand.classList.remove('hidden');
      els.doneBtn.classList.remove('hidden');
      els.describeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendDescribeMessage();
        }
      });
      els.doneBtn.addEventListener('click', async () => {
        await saveNow();
        const res = await api('/api/admin/components/polish', {
          method: 'POST',
          body: JSON.stringify({ pageKey: current.key }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok && data.draft) {
          draft = Object.assign({}, draft, data.draft, { pageKey: current.key });
          destroyStudio();
          renderPage();
          showStatus('Finished. Commit to save all changes when you are ready.', 'ok');
        } else {
          showStatus((data && data.error) || 'Could not finish the page.', 'error');
        }
      });
    }
    try {
      const cssRes = await fetch('assets/styles.css', { cache: 'no-store' });
      if (cssRes.ok) siteCssText = await cssRes.text();
    } catch (_e) { siteCssText = ''; }

    document.querySelectorAll('#palette button').forEach((btn) => {
      btn.addEventListener('dragstart', (event) => {
        const kind = btn.getAttribute('data-block');
        event.dataTransfer.setData('text/d6-new', NEW_BLOCKS[kind] || NEW_BLOCKS.p);
        event.dataTransfer.setData('text/plain', kind || 'p');
      });
    });
    els.pieceFile.addEventListener('change', async () => {
      const file = els.pieceFile.files && els.pieceFile.files[0];
      els.pieceFile.value = '';
      if (!file || !selectedImage) return;
      try {
        const bytesBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const res = await api('/api/admin/components/upload', {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, mime: file.type || 'image/png', bytesBase64 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          showStatus(data.error || 'Could not store that image.', 'error');
          return;
        }
        selectedImage.setAttribute('src', data.url);
        scheduleSave();
      } catch (_e) {
        showStatus('Network error. Please try again.', 'error');
      }
    });

    fillGrid(els.docGrid, DOCS);
    fillGrid(els.hubGrid, HUBS);
    els.backBtn.addEventListener('click', backToChooser);
    els.previewBtn.addEventListener('click', togglePreview);
    els.commitBtn.addEventListener('click', commitChanges);
  }

  start();
})();
