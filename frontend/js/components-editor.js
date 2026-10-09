/*
 * Page editor. The page on screen is the page that gets saved.
 * Click the words to change them. Click a picture to replace it. Click a
 * link to change where it goes. Nothing here opens another sign-in.
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
    home: { key: 'home', file: 'index.html' },
    acknowledgement: { key: 'acknowledgement', file: 'sign.html' },
    thankyou: { key: 'thankyou', file: 'thanks.html' },
    receipt: { key: 'receipt', file: null },
  };

  const TEXT_SELECTOR = 'h1,h2,h3,h4,p,li,a,button,span,label,footer,td,th,figcaption';

  const els = {
    signInRequired: document.getElementById('sign-in-required'),
    editorBody: document.getElementById('editor-body'),
    status: document.getElementById('editor-status'),
    describeBand: document.getElementById('describe-band'),
    transcript: document.getElementById('transcript'),
    describeInput: document.getElementById('describe-input'),
    stage: document.getElementById('page-stage'),
    draftCss: document.getElementById('draft-css'),
    doneBtn: document.getElementById('done-btn'),
    commitBtn: document.getElementById('commit-btn'),
    pieceBar: document.getElementById('piece-bar'),
    pieceLinkLabel: document.getElementById('piece-link-label'),
    pieceLink: document.getElementById('piece-link'),
    pieceImage: document.getElementById('piece-image'),
    pieceFile: document.getElementById('piece-file'),
    pageButtons: Array.from(document.querySelectorAll('.d6-pages button')),
  };

  const mode =
    new URLSearchParams(location.search).get('mode') === 'describe' ? 'describe' : 'manual';

  let currentPageKey = 'home';
  let draft = null;
  let saveTimer = null;
  let saving = false;
  let selectedLink = null;
  let selectedImage = null;
  let questionsAsked = 0;
  const history = [];

  function jwt() {
    try { return sessionStorage.getItem(JWT_KEY) || ''; } catch (_e) { return ''; }
  }

  function showStatus(kind, msg) {
    els.status.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    els.status.textContent = msg;
    els.status.classList.remove('hidden');
  }
  function hideStatus() {
    els.status.classList.add('hidden');
  }

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
    if (res.status === 401) {
      showStatus('error', 'Sign in on the admin page first.');
    }
    return res;
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
    } catch (_e) { /* server copy still exists */ }
  }

  function readStageHtml() {
    const clone = els.stage.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
    return clone.innerHTML;
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
    if (!best.html) {
      const seeded = await seedDraft(pageKey);
      if (seeded.html) {
        best.html = seeded.html;
        best.css = best.css || seeded.css;
      }
    }
    draft = best;
    return draft;
  }

  function captureStage() {
    if (!draft || !els.stage.childNodes.length) return;
    draft.html = readStageHtml();
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
    captureStage();
    draft.updatedAt = new Date().toISOString();
    const record = toDraftRecord();
    await idbPut(record);
    try {
      await api('/api/admin/components/draft', {
        method: 'PUT',
        body: JSON.stringify(record),
      });
    } catch (_e) { /* IndexedDB covers a dropped connection */ }
    saving = false;
  }

  function flushBeacon() {
    clearTimeout(saveTimer);
    if (!draft) return;
    captureStage();
    draft.updatedAt = new Date().toISOString();
    const record = toDraftRecord();
    idbPut(record);
    const token = jwt();
    if (!token) return;
    try {
      const blob = new Blob([JSON.stringify(record)], { type: 'application/json' });
      navigator.sendBeacon(
        API_BASE + '/api/admin/components/draft?token=' + encodeURIComponent(token),
        blob,
      );
    } catch (_e) { /* unload */ }
  }

  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon();
  });

  function hidePieceBar() {
    selectedLink = null;
    selectedImage = null;
    els.pieceBar.classList.add('hidden');
    els.pieceLinkLabel.classList.add('hidden');
    els.pieceLink.classList.add('hidden');
    els.pieceImage.classList.add('hidden');
  }

  function showLinkBar(anchor) {
    selectedLink = anchor;
    selectedImage = null;
    els.pieceLink.value = anchor.getAttribute('href') || '';
    els.pieceLinkLabel.classList.remove('hidden');
    els.pieceLink.classList.remove('hidden');
    els.pieceImage.classList.add('hidden');
    els.pieceBar.classList.remove('hidden');
  }

  function showImageBar(img) {
    selectedImage = img;
    selectedLink = null;
    els.pieceLink.classList.add('hidden');
    els.pieceImage.classList.remove('hidden');
    els.pieceBar.classList.remove('hidden');
  }

  function markEditable(root) {
    root.querySelectorAll(TEXT_SELECTOR).forEach((el) => {
      if (el.closest('svg')) return;
      if (el.querySelector('input, canvas, svg, select, textarea')) return;
      el.setAttribute('contenteditable', 'true');
    });
  }

  function renderStage() {
    hidePieceBar();
    els.draftCss.textContent = draft.css || '';
    els.stage.innerHTML = draft.html || '';
    markEditable(els.stage);
  }

  function paintPageButtons() {
    els.pageButtons.forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-page') === currentPageKey ? 'true' : 'false');
    });
  }

  els.stage.addEventListener('input', scheduleSave);

  els.stage.addEventListener('click', (event) => {
    const anchor = event.target.closest('a');
    const image = event.target.closest('img');
    if (anchor && els.stage.contains(anchor)) {
      event.preventDefault();
      showLinkBar(anchor);
      return;
    }
    if (image && els.stage.contains(image)) {
      event.preventDefault();
      showImageBar(image);
      return;
    }
    const button = event.target.closest('button');
    if (button && els.stage.contains(button)) event.preventDefault();
    hidePieceBar();
  });

  els.stage.addEventListener('submit', (event) => event.preventDefault());

  els.pieceLink.addEventListener('input', () => {
    if (!selectedLink) return;
    selectedLink.setAttribute('href', els.pieceLink.value.trim());
    scheduleSave();
  });

  els.pieceImage.addEventListener('click', () => els.pieceFile.click());

  els.pieceFile.addEventListener('change', async () => {
    const file = els.pieceFile.files && els.pieceFile.files[0];
    els.pieceFile.value = '';
    if (!file || !selectedImage) return;
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
      if (!res.ok || !data.ok) {
        showStatus('error', data.error || 'Could not store that image.');
        return;
      }
      selectedImage.setAttribute('src', data.url);
      hideStatus();
      scheduleSave();
    } catch (_e) {
      showStatus('error', 'Network error. Please try again.');
    }
  });

  function pushTranscript(who, text) {
    const div = document.createElement('div');
    div.className = 'd6-msg ' + (who === 'admin' ? 'd6-msg-admin' : 'd6-msg-page');
    div.textContent = text;
    els.transcript.appendChild(div);
  }

  async function sendDescribeMessage() {
    const message = els.describeInput.value.trim();
    if (!message) return;
    els.describeInput.value = '';
    pushTranscript('admin', message);
    els.describeInput.disabled = true;
    hideStatus();
    try {
      await saveNow();
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
          renderStage();
          await idbPut(toDraftRecord());
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
        renderStage();
        await idbPut(toDraftRecord());
      }
      showStatus('ok', 'Finished. Commit to save all changes when you are ready.');
    } catch (_e) {
      showStatus('error', 'Network error. Please try again.');
    } finally {
      els.doneBtn.disabled = false;
    }
  }

  async function commitChanges() {
    els.commitBtn.disabled = true;
    els.commitBtn.textContent = 'Saving…';
    hideStatus();
    try {
      await saveNow();
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

  async function openPage(pageKey) {
    if (draft && draft.pageKey !== pageKey) await saveNow();
    currentPageKey = pageKey;
    try { sessionStorage.setItem(LAST_PAGE_KEY, pageKey); } catch (_e) { /* ignore */ }
    paintPageButtons();
    hideStatus();
    questionsAsked = 0;
    history.length = 0;
    els.transcript.textContent = '';
    await loadDraft(pageKey);
    renderStage();
    await saveNow();
  }

  async function start() {
    if (!jwt()) {
      els.signInRequired.classList.remove('hidden');
      return;
    }
    document.title = (mode === 'describe' ? 'Describe your changes' : 'Update Components') +
      ' — District 6 Compliance Hub';
    els.editorBody.classList.remove('hidden');
    if (mode === 'describe') {
      els.describeBand.classList.remove('hidden');
      els.doneBtn.classList.remove('hidden');
      els.doneBtn.addEventListener('click', runFinishPass);
      els.describeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendDescribeMessage();
        }
      });
    }

    els.pageButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-page');
        if (next && next !== currentPageKey) openPage(next);
      });
    });
    els.commitBtn.addEventListener('click', commitChanges);

    let initial = 'home';
    try { initial = sessionStorage.getItem(LAST_PAGE_KEY) || 'home'; } catch (_e) { /* ignore */ }
    if (!PAGES[initial]) initial = 'home';
    await openPage(initial);
  }

  start();
})();
