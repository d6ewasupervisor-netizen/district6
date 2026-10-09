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
    studioRoot: document.getElementById('studio-root'),
    doneBtn: document.getElementById('done-btn'),
    previewBtn: document.getElementById('preview-btn'),
    commitBtn: document.getElementById('commit-btn'),
    signInRequired: document.getElementById('sign-in-required'),
  };

  let current = null;
  let draft = null;
  let studioEditor = null;
  let previewOn = false;
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
    if (!studioEditor || !draft || previewOn) return;
    try {
      const html = studioEditor.getHtml();
      if (!html || !String(html).trim()) return;
      draft.projectJson = studioEditor.getProjectData ? studioEditor.getProjectData() : draft.projectJson;
      draft.html = html;
      draft.css = (studioEditor.getCss && studioEditor.getCss()) || '';
    } catch (_e) { /* tearing down */ }
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

  async function initStudio() {
    const preset = window['grapesjs-preset-webpage'];
    if (!window.grapesjs || !preset) {
      showStatus('The editor could not load. Refresh and try again.', 'error');
      return;
    }
    const html = draft.html || '<section class="card"><h2>Heading</h2><p>Text</p></section>';
    const css = draft.css || (isDoc(current.key) ? DOC_CSS : '');
    const docMode = isDoc(current.key);
    setPreview(false);
    els.studioRoot.innerHTML = '';
    studioEditor = window.grapesjs.init({
      container: '#studio-root',
      height: '100%',
      width: 'auto',
      fromElement: false,
      components: html,
      style: css,
      storageManager: false,
      noticeOnUnload: false,
      plugins: [preset],
      canvas: {
        styles: docMode ? [] : ['assets/styles.css'],
      },
    });
    studioEditor.on('update', scheduleSave);
    studioEditor.on('load', () => {
      try { studioEditor.setComponents(html); } catch (_e) { /* already on the canvas */ }
      if (css) {
        try { studioEditor.setStyle(css); } catch (_e2) { /* keep existing */ }
      }
    });
  }

  function togglePreview() {
    if (!studioEditor) return;
    if (previewOn) {
      studioEditor.stopCommand('preview');
      setPreview(false);
      return;
    }
    captureFromStudio();
    studioEditor.runCommand('preview');
    setPreview(true);
  }

  function destroyStudio() {
    if (studioEditor && previewOn) {
      try { studioEditor.stopCommand('preview'); } catch (_e) { /* already closed */ }
    }
    captureFromStudio();
    if (studioEditor && studioEditor.destroy) {
      try { studioEditor.destroy(); } catch (_e2) { /* already gone */ }
    }
    studioEditor = null;
    setPreview(false);
    els.studioRoot.innerHTML = '';
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
    await initStudio();
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
          await initStudio();
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
          await initStudio();
          showStatus('Finished. Commit to save all changes when you are ready.', 'ok');
        } else {
          showStatus((data && data.error) || 'Could not finish the page.', 'error');
        }
      });
    }
    fillGrid(els.docGrid, DOCS);
    fillGrid(els.hubGrid, HUBS);
    els.backBtn.addEventListener('click', backToChooser);
    els.previewBtn.addEventListener('click', togglePreview);
    els.commitBtn.addEventListener('click', commitChanges);
  }

  start();
})();
