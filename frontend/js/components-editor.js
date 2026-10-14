/*
 * District 6 Visual Document & Hub Page Editor.
 *
 * Documents (Attendance, Dress Code, SOP, Handbook, Kompass, Vendor) open as
 * exact 8.5in × 11in US Letter pages matching the live PDFs 1:1. Hub pages
 * (Home, Acknowledgement, Thank you) and the Signed Receipt open with their
 * live styles. Every text element, list, card, callout, banner, and image is
 * editable in place without wrapper divs that break grid/flex layouts.
 */
(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;
  const JWT_KEY = 'd6-admin-jwt';
  const IDB_NAME = 'd6-component-drafts-v2';
  const IDB_STORE = 'pages';
  const SAVE_DEBOUNCE_MS = 400;

  const DOCS = [
    { key: 'doc-attendance', title: 'Attendance & Timekeeping', file: 'content/docs/attendance.html', kind: 'Required policy · 3 pages' },
    { key: 'doc-dress-code', title: 'Dress Code', file: 'content/docs/dress-code.html', kind: 'Required policy · 2 pages' },
    { key: 'doc-sop', title: 'Standard Operating Procedures', file: 'content/docs/sop.html', kind: 'Required policy · 3 pages' },
    { key: 'doc-kompass', title: 'Kompass Responsibilities', file: 'content/docs/kompass.html', kind: 'Reference · 3 pages' },
    { key: 'doc-vendor', title: 'Fred Meyer Vendor Policies', file: 'content/docs/vendor.html', kind: 'Reference · 3 pages' },
    { key: 'doc-handbook', title: 'Teammate Handbook', file: 'content/docs/handbook.html', kind: 'Reference · 56 pages' },
  ];

  const HUBS = [
    { key: 'home', title: 'Home', file: 'index.html', kind: 'Hub page' },
    { key: 'acknowledgement', title: 'Acknowledgement', file: 'sign.html', kind: 'Hub page' },
    { key: 'thankyou', title: 'Thank you', file: 'thanks.html', kind: 'Hub page' },
    { key: 'receipt', title: 'Signed Receipt PDF', file: null, kind: 'Letter PDF template' },
  ];

  const mode = new URLSearchParams(location.search).get('mode') === 'describe' ? 'describe' : 'manual';

  const els = {
    chooser: document.getElementById('chooser'),
    chooserTitle: document.getElementById('chooser-title'),
    docGrid: document.getElementById('doc-grid'),
    hubGrid: document.getElementById('hub-grid'),
    workspace: document.getElementById('workspace'),
    backBtn: document.getElementById('back-btn'),
    workTitle: document.getElementById('work-title'),
    resetBtn: document.getElementById('reset-btn'),
    previewBtn: document.getElementById('preview-btn'),
    doneBtn: document.getElementById('done-btn'),
    commitBtn: document.getElementById('commit-btn'),
    status: document.getElementById('editor-status'),
    describeBand: document.getElementById('describe-band'),
    transcript: document.getElementById('transcript'),
    describeInput: document.getElementById('describe-input'),
    describeSendBtn: document.getElementById('describe-send-btn'),
    pageHost: document.getElementById('page-host'),
    palette: document.getElementById('palette'),
    palTip: document.getElementById('pal-tip'),
    brandAssets: document.getElementById('brand-assets'),
    supplyAssets: document.getElementById('supply-assets'),
    pieceFile: document.getElementById('piece-file'),
    moveUpBtn: document.getElementById('move-up-btn'),
    moveDownBtn: document.getElementById('move-down-btn'),
    dupBlockBtn: document.getElementById('dup-block-btn'),
    delBlockBtn: document.getElementById('del-block-btn'),
    replaceImgBtn: document.getElementById('replace-img-btn'),
    pageNav: document.getElementById('page-nav'),
    pageSelect: document.getElementById('page-select'),
    addPageBtn: document.getElementById('add-page-btn'),
    signInRequired: document.getElementById('sign-in-required'),
  };

  let current = null;
  let draft = null;
  let pageRoot = null;
  let selectedBlock = null;
  let selectedImage = null;
  let activePageEl = null;
  let previewOn = false;
  let siteCssText = '';
  let docCssText = '';
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

  function isDoc(key) { return key && key.indexOf('doc-') === 0; }

  function isAccurateDocHtml(key, html) {
    if (!isDoc(key)) return Boolean(html && html.trim());
    return typeof html === 'string' && html.includes('data-doc-version="2"');
  }

  // ── IndexedDB ──────────────────────────────────────────────────────────────

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

  async function idbDelete(pageKey) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(pageKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_e) { /* ignore */ }
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
    } catch (_e) { return null; }
  }

  async function seedFromFile(target) {
    if (!target.file) {
      const res = await api('/api/admin/components/seed/receipt');
      const data = await res.json().catch(() => ({}));
      return { html: data.html || '', css: data.css || '' };
    }
    const res = await fetch(target.file, { cache: 'no-store' });
    const text = await res.text();
    if (isDoc(target.key)) {
      return { html: text, css: '' };
    }
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const canvas = doc.querySelector('[data-d6-canvas]');
    return { html: canvas ? canvas.innerHTML : text, css: '' };
  }

  async function loadDraft(target) {
    const [local, server] = await Promise.all([idbGet(target.key), fetchServerDraft(target.key)]);
    const validLocal = local && isAccurateDocHtml(target.key, local.html) ? local : null;
    const validServer = server && isAccurateDocHtml(target.key, server.html) ? server : null;
    let best = pickNewer(validLocal, validServer);
    if (!best || !best.html) {
      const seeded = await seedFromFile(target);
      best = {
        pageKey: target.key,
        projectJson: {},
        html: seeded.html,
        css: seeded.css,
        updatedAt: new Date().toISOString(),
      };
    }
    draft = best;
  }

  // ── Serialization (Strips only editor selection state) ────────────────────

  function captureCleanHtml() {
    if (!pageRoot || !draft) return;
    const clone = pageRoot.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
    clone.querySelectorAll('[data-d6-selected]').forEach((el) => el.removeAttribute('data-d6-selected'));
    clone.querySelectorAll('[data-d6-drop]').forEach((el) => el.removeAttribute('data-d6-drop'));
    const html = clone.innerHTML.trim();
    if (html) draft.html = html;
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
    captureCleanHtml();
    draft.updatedAt = new Date().toISOString();
    const body = record();
    await idbPut(body);
    try {
      await api('/api/admin/components/draft', { method: 'PUT', body: JSON.stringify(body) });
    } catch (_e) { /* IndexedDB keeps it safe */ }
    saving = false;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  function flushBeacon() {
    if (!draft) return;
    captureCleanHtml();
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

  // ── Component Templates for Palette Insertion ──────────────────────────────

  const BLOCK_TEMPLATES = {
    hero:
      '<div class="hero">' +
        '<div class="hero-title-row">' +
          '<h1>Policy Title</h1>' +
          '<span class="edition-inline">| &nbsp;S P R I N G &nbsp;2 0 2 6 &nbsp;E D I T I O N</span>' +
        '</div>' +
        '<div class="meta-line"><strong>Effective May 1, 2026</strong> &nbsp;&middot;&nbsp; Owner: April Gauthier, Supervisor, Eastern Washington</div>' +
      '</div>',
    h2: '<h2>Section Heading</h2>',
    h3: '<h3>Subsection Heading</h3>',
    p: '<p>Enter policy text here.</p>',
    ul: '<ul><li>First key expectation or requirement.</li><li>Second expectation or requirement.</li></ul>',
    'callout-info':
      '<div class="callout info">' +
        '<div class="callout-title">Key Reminder</div>' +
        '<p>Enter important reminder details here with <strong>highlighted key terms</strong>.</p>' +
      '</div>',
    'callout-warn':
      '<div class="callout warn">' +
        '<div class="callout-title">&#9888; Important Requirement</div>' +
        '<p><strong>Advance notice required.</strong> Provide the supporting details here.</p>' +
      '</div>',
    'callout-danger':
      '<div class="callout danger">' +
        '<div class="callout-title">&#9888; Critical Rule</div>' +
        '<p>Contact your <strong>direct Supervisor</strong> immediately if this situation occurs.</p>' +
      '</div>',
    'grid-2':
      '<div class="grid-2">' +
        '<div class="info-card">' +
          '<div class="card-eyebrow">Left Column Title</div>' +
          '<ul><li>First point</li><li>Second point</li></ul>' +
        '</div>' +
        '<div class="info-card">' +
          '<div class="card-eyebrow">Right Column Title</div>' +
          '<ul><li>First point</li><li>Second point</li></ul>' +
        '</div>' +
      '</div>',
    'ok-no-grid':
      '<div class="grid-2">' +
        '<div class="status-box ok" style="margin:0;">' +
          '<div class="status-header">&#10003; Acceptable</div>' +
          '<ul><li>Approved item one</li><li>Approved item two</li></ul>' +
        '</div>' +
        '<div class="status-box no" style="margin:0;">' +
          '<div class="status-header">&#10005; Not Acceptable</div>' +
          '<ul><li>Prohibited item one</li><li>Prohibited item two</li></ul>' +
        '</div>' +
      '</div>',
    'step-row':
      '<div class="step-row">' +
        '<span class="step-badge">1</span>' +
        '<div class="step-body">' +
          '<p class="step-title">Step Title</p>' +
          '<p class="step-detail">Describe what happens during this step.</p>' +
        '</div>' +
      '</div>',
    'phase-card':
      '<div class="phase-card phase-1">' +
        '<span class="phase-pill">Phase 1 &middot; Step</span>' +
        '<div class="phase-title">Phase Heading</div>' +
        '<ul><li>First action item</li><li>Second action item</li></ul>' +
      '</div>',
    references:
      '<div class="references-box">' +
        '<div class="ref-label">References</div>' +
        '<p class="ref-links"><strong>Teammate Handbook</strong> &nbsp;&middot;&nbsp; <strong>Fred Meyer Vendor Policies</strong> &nbsp;&middot;&nbsp; <strong>Kompass Program Responsibilities</strong></p>' +
      '</div>',
    img:
      '<div class="d6-graphic d6-graphic-logo">' +
        '<img src="assets/logo.png" alt="Image" style="max-width:100%;max-height:0.72in;width:auto;height:auto;object-fit:contain;background:transparent;" />' +
      '</div>',
  };

  function assetUrl(relPath) {
    return 'assets/' + String(relPath).split('/').map((part) => encodeURIComponent(part)).join('/');
  }

  const PAGE_GRAPHICS = [
    {
      mount: 'brand',
      kind: 'logo',
      file: 'Page Assets/Brand Assets/advantage logo.png',
      label: 'Advantage',
      alt: 'Advantage logo',
      tip: 'The Advantage mark. The background is clear, so it sits on a white page or on a color bar.',
    },
    {
      mount: 'brand',
      kind: 'logo',
      file: 'Page Assets/Brand Assets/fred meyer logo long.png',
      label: 'Fred Meyer',
      alt: 'Fred Meyer logo',
      tip: 'The Fred Meyer wordmark in red. The background is clear.',
    },
    {
      mount: 'brand',
      kind: 'logo',
      file: 'Page Assets/Brand Assets/fred meyer logo stacked.png',
      label: 'Fred Meyer stacked',
      alt: 'Fred Meyer stacked logo',
      tip: 'The Fred Meyer mark stacked on two lines. The background is clear.',
    },
    {
      mount: 'brand',
      kind: 'logo',
      file: 'Page Assets/Brand Assets/fred meyer shopping cart logo.png',
      label: 'Fred Meyer cart',
      alt: 'Fred Meyer shopping cart',
      tip: 'The small Fred Meyer shopping-cart mark. The background is clear.',
    },
    {
      mount: 'brand',
      kind: 'logo',
      file: 'Page Assets/Brand Assets/retail odyssey logo stacked.png',
      label: 'Odyssey stacked',
      alt: 'The Retail Odyssey Company logo',
      tip: 'The full Retail Odyssey mark, with the compass and the company name. It reads on a white page.',
    },
    {
      mount: 'brand',
      kind: 'logo',
      file: 'Page Assets/Brand Assets/retail odyssey new logo.png',
      label: 'RO monogram',
      alt: 'Retail Odyssey monogram',
      tip: 'The white RO monogram. Put it on a navy or dark bar. On a white page the letters will not show.',
    },
    {
      mount: 'brand',
      kind: 'logo',
      file: 'Page Assets/Brand Assets/sas retail services logo.png',
      label: 'SAS',
      alt: 'SAS Retail Services logo',
      tip: 'The SAS Retail Services wordmark. The background is clear, and it reads on a white page.',
    },
    {
      mount: 'brand',
      kind: 'logo',
      file: 'Page Assets/Brand Assets/the retail odyssey long logo.png',
      label: 'Odyssey wordmark',
      alt: 'The Retail Odyssey wordmark',
      tip: 'The long Retail Odyssey wordmark. The background is clear, and it reads on a white page.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_clipboard.png',
      label: 'Clipboard',
      alt: 'Clipboard',
      tip: 'A clipboard with a clear background. Useful in a supplies list or next to a short note.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_gloves.png',
      label: 'Gloves',
      alt: 'Work gloves',
      tip: 'A pair of work gloves with a clear background.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_highlighter.png',
      label: 'Highlighter',
      alt: 'Highlighter',
      tip: 'A highlighter with a clear background.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_paper_towels.png',
      label: 'Paper towels',
      alt: 'Paper towels',
      tip: 'A roll of paper towels with a clear background. The white of the roll itself stays.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_pen.png',
      label: 'Pen',
      alt: 'Pen',
      tip: 'A pen with a clear background.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_screwdriver.png',
      label: 'Screwdriver',
      alt: 'Screwdriver',
      tip: 'A screwdriver with a clear background.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_spray_cleaner.png',
      label: 'Spray cleaner',
      alt: 'Spray cleaner',
      tip: 'A spray bottle with a clear background.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_step_stool.png',
      label: 'Step stool',
      alt: 'Step stool',
      tip: 'A step stool with a clear background.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_tablet.png',
      label: 'Tablet',
      alt: 'Tablet',
      tip: 'A tablet with a clear background.',
    },
    {
      mount: 'supply',
      kind: 'icon',
      file: 'Page Assets/retailer_asset_tape_measure.png',
      label: 'Tape measure',
      alt: 'Tape measure',
      tip: 'A tape measure with a clear background.',
    },
  ];

  function graphicHtml(item) {
    const maxH = item.kind === 'icon' ? '1.05in' : '0.72in';
    const klass = item.kind === 'icon' ? 'd6-graphic d6-graphic-icon' : 'd6-graphic d6-graphic-logo';
    return (
      '<div class="' + klass + '">' +
        '<img src="' + item.src + '" alt="' + item.alt + '" style="max-width:100%;max-height:' + maxH + ';width:auto;height:auto;object-fit:contain;background:transparent;" />' +
      '</div>'
    );
  }

  function insertGraphic(item, beforeEl) {
    const holder = document.createElement('div');
    holder.innerHTML = graphicHtml(item);
    const newEl = holder.firstElementChild;
    if (!newEl || !pageRoot) return;
    if (beforeEl && beforeEl.parentNode) {
      beforeEl.before(newEl);
    } else if (selectedBlock && selectedBlock.parentNode && !selectedBlock.classList.contains('d6-doc-page')) {
      selectedBlock.after(newEl);
    } else {
      const targetPage =
        activePageEl ||
        (pageRoot.querySelector && pageRoot.querySelector('.d6-doc-page')) ||
        (pageRoot.querySelector && pageRoot.querySelector('.d6-receipt-wrap')) ||
        pageRoot;
      const footer = targetPage.querySelector && targetPage.querySelector(':scope > .d6-page-footer');
      if (footer) footer.before(newEl);
      else targetPage.appendChild(newEl);
    }
    const img = newEl.querySelector('img');
    selectBlock(newEl, img);
    newEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    scheduleSave();
  }

  function placePaletteTip(btn) {
    const text = btn.getAttribute('data-tip');
    if (!text || !els.palTip) return;
    const tip = els.palTip;
    tip.textContent = text;
    tip.classList.add('on');
    const rect = btn.getBoundingClientRect();
    const gap = 8;
    let left = rect.right + gap;
    tip.style.left = left + 'px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    if (left + tw > window.innerWidth - 8) left = Math.max(8, rect.left - tw - gap);
    let top = Math.max(8, rect.top);
    if (top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hidePaletteTip() {
    if (els.palTip) els.palTip.classList.remove('on');
  }

  function mountAssetButton(grid, item) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.draggable = true;
    btn.setAttribute('data-src', item.src);
    btn.setAttribute('data-alt', item.alt);
    btn.setAttribute('data-kind', item.kind);
    btn.setAttribute('data-tip', item.tip);
    const img = document.createElement('img');
    img.src = item.src;
    img.alt = '';
    btn.appendChild(img);
    btn.appendChild(document.createTextNode(item.label));
    btn.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/d6-src', item.src);
      event.dataTransfer.setData('text/d6-alt', item.alt);
      event.dataTransfer.setData('text/d6-kind', item.kind);
      event.dataTransfer.setData('text/plain', item.label);
    });
    btn.addEventListener('click', () => {
      if (selectedImage) {
        selectedImage.setAttribute('src', item.src);
        selectedImage.setAttribute('alt', item.alt);
        scheduleSave();
        return;
      }
      insertGraphic(item, null);
    });
    grid.appendChild(btn);
  }

  function mountAssetPalette() {
    if (!els.brandAssets || !els.supplyAssets) return;
    PAGE_GRAPHICS.forEach((item) => {
      item.src = assetUrl(item.file);
      const grid = item.mount === 'supply' ? els.supplyAssets : els.brandAssets;
      mountAssetButton(grid, item);
    });
    if (!els.palette) return;
    els.palette.addEventListener('mouseover', (event) => {
      const btn = event.target.closest && event.target.closest('button[data-tip]');
      if (!btn || !els.palette.contains(btn)) return;
      placePaletteTip(btn);
    });
    els.palette.addEventListener('mouseout', (event) => {
      const btn = event.target.closest && event.target.closest('button[data-tip]');
      if (!btn) return;
      const next = event.relatedTarget;
      if (next && btn.contains(next)) return;
      hidePaletteTip();
    });
    els.palette.addEventListener('scroll', hidePaletteTip);
  }

  const SHADOW_EDITOR_CSS = [
    ':host { display: block; }',
    '.d6-sheet { min-height: 100%; }',
    '.d6-hub-wrap { max-width: 820px; margin: 0 auto; background: #f4f6fa; padding: 12px 20px 48px; border-radius: 10px; box-shadow: 0 6px 24px rgba(15, 23, 42, 0.12); }',
    '.d6-receipt-wrap { width: 8.5in; min-height: 11in; padding: 0.55in 0.6in; margin: 0 auto 28px; background: #fff; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14); border-radius: 3px; }',
    '[contenteditable="true"] { outline: none; }',
    '.d6-sheet:not(.d6-preview) .d6-doc-page > *:hover,',
    '.d6-sheet:not(.d6-preview) .d6-receipt-wrap > *:hover,',
    '.d6-sheet:not(.d6-preview) .d6-hub-wrap .card:hover,',
    '.d6-sheet:not(.d6-preview) .d6-hub-wrap h1:hover,',
    '.d6-sheet:not(.d6-preview) .d6-hub-wrap p.lead:hover {',
    '  outline: 1px dashed #62b5e5;',
    '  outline-offset: 3px;',
    '}',
    '.d6-sheet:not(.d6-preview) [data-d6-selected="1"] {',
    '  outline: 2px solid #003a70 !important;',
    '  outline-offset: 3px;',
    '  border-radius: 4px;',
    '}',
    '.d6-sheet:not(.d6-preview) [data-d6-drop="1"] {',
    '  box-shadow: 0 -3px 0 0 #003a70 !important;',
    '}',
    'img { cursor: pointer; }',
  ].join('\n');

  function selectBlock(blockEl, imgEl) {
    if ( pageRoot ) {
      pageRoot.querySelectorAll('[data-d6-selected]').forEach((el) => el.removeAttribute('data-d6-selected'));
    }
    selectedBlock = blockEl || null;
    selectedImage = imgEl || null;
    if (selectedBlock && !previewOn) {
      selectedBlock.setAttribute('data-d6-selected', '1');
      const pg = selectedBlock.closest('.d6-doc-page');
      if (pg) activePageEl = pg;
    }
    if (els.replaceImgBtn) {
      els.replaceImgBtn.classList.toggle('hidden', !selectedImage);
    }
  }

  function findSelectableBlock(target) {
    if (!target || !pageRoot || !pageRoot.contains(target)) return null;
    const page = target.closest('.d6-doc-page');
    if (page) {
      activePageEl = page;
      let node = target;
      while (node && node.parentElement !== page) {
        node = node.parentElement;
      }
      if (node && node.parentElement === page) return node;
      return page;
    }
    const receiptWrap = target.closest('.d6-receipt-wrap');
    if (receiptWrap) {
      let node = target;
      while (node && node.parentElement !== receiptWrap) {
        node = node.parentElement;
      }
      if (node && node.parentElement === receiptWrap) return node;
    }
    const hubBlock = target.closest('.doc-card, .ref-card, section.card, h1, p.lead, .brand, footer');
    if (hubBlock) return hubBlock;
    return null;
  }

  function refreshPageNav() {
    if (!pageRoot || !isDoc(current && current.key)) {
      els.pageNav.classList.add('hidden');
      return;
    }
    const pages = Array.from(pageRoot.querySelectorAll('.d6-doc-page'));
    if (!pages.length) {
      els.pageNav.classList.add('hidden');
      return;
    }
    els.pageNav.classList.remove('hidden');
    els.pageSelect.innerHTML = '';
    const total = pages.length;
    pages.forEach((pg, idx) => {
      const num = idx + 1;
      pg.setAttribute('data-page', String(num));
      const footerRight = pg.querySelector('.d6-page-footer span:last-child');
      if (footerRight && /Page\s+\d+\s+of\s+\d+/i.test(footerRight.textContent)) {
        footerRight.textContent = footerRight.textContent.replace(/Page\s+\d+\s+of\s+\d+/i, 'Page ' + num + ' of ' + total);
      }
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = 'Page ' + num + ' of ' + total;
      els.pageSelect.appendChild(opt);
    });
  }

  function insertSnippet(blockKey, beforeEl) {
    const html = BLOCK_TEMPLATES[blockKey] || BLOCK_TEMPLATES.p;
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const newEl = holder.firstElementChild;
    if (!newEl || !pageRoot) return;

    if (beforeEl && beforeEl.parentNode) {
      beforeEl.before(newEl);
    } else if (selectedBlock && selectedBlock.parentNode && !selectedBlock.classList.contains('d6-doc-page')) {
      selectedBlock.after(newEl);
    } else {
      const targetPage =
        activePageEl ||
        (pageRoot.querySelector && pageRoot.querySelector('.d6-doc-page')) ||
        (pageRoot.querySelector && pageRoot.querySelector('.d6-receipt-wrap')) ||
        pageRoot;
      const footer = targetPage.querySelector && targetPage.querySelector(':scope > .d6-page-footer');
      if (footer) footer.before(newEl);
      else targetPage.appendChild(newEl);
    }
    selectBlock(newEl, null);
    newEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    scheduleSave();
  }

  function addNewPage() {
    if (!pageRoot || !isDoc(current && current.key)) return;
    const sheet = pageRoot.querySelector('.d6-doc-sheet') || pageRoot;
    const pages = sheet.querySelectorAll('.d6-doc-page');
    const nextNum = pages.length + 1;
    const sampleFooterLeft =
      (pages[0] && pages[0].querySelector('.d6-page-footer span:first-child') &&
        pages[0].querySelector('.d6-page-footer span:first-child').textContent) ||
      ('Retail Odyssey | ' + current.title + ' | Spring 2026');
    const sec = document.createElement('section');
    sec.className = 'd6-doc-page';
    sec.setAttribute('data-page', String(nextNum));
    sec.setAttribute('contenteditable', previewOn ? 'false' : 'true');
    sec.innerHTML =
      '<h2 class="h2-top">New Section</h2>' +
      '<p>Enter policy content for this page.</p>' +
      '<footer class="d6-page-footer">' +
        '<span>' + sampleFooterLeft + '</span>' +
        '<span>Page ' + nextNum + ' of ' + nextNum + '</span>' +
      '</footer>';
    sheet.appendChild(sec);
    activePageEl = sec;
    refreshPageNav();
    els.pageSelect.value = String(nextNum - 1);
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    scheduleSave();
  }

  function renderPage() {
    setPreview(false);
    selectedBlock = null;
    selectedImage = null;
    activePageEl = null;
    if (els.replaceImgBtn) els.replaceImgBtn.classList.add('hidden');

    const docMode = isDoc(current.key);
    const receiptMode = current.key === 'receipt';
    let baseCss = '';
    if (docMode) {
      baseCss = docCssText + '\n' + (draft.css || '');
    } else if (receiptMode) {
      baseCss = docCssText + '\n' + (draft.css || '');
    } else {
      baseCss = siteCssText + '\n' + (draft.css || '');
    }

    if (!els.pageHost.shadowRoot) els.pageHost.attachShadow({ mode: 'open' });
    const shadow = els.pageHost.shadowRoot;

    let innerWrapClass = 'd6-sheet';
    let bodyHtml = draft.html || '';
    if (receiptMode && !bodyHtml.includes('d6-receipt-wrap')) {
      innerWrapClass = 'd6-sheet d6-receipt-wrap';
    } else if (!docMode && !receiptMode) {
      innerWrapClass = 'd6-sheet d6-hub-wrap';
    }

    shadow.innerHTML =
      '<style>' + SHADOW_EDITOR_CSS + '\n' + baseCss + '</style>' +
      '<div class="' + innerWrapClass + '" id="sheet"></div>';

    pageRoot = shadow.getElementById('sheet');
    pageRoot.innerHTML = bodyHtml;

    if (docMode) {
      const pages = pageRoot.querySelectorAll('.d6-doc-page');
      pages.forEach((pg) => pg.setAttribute('contenteditable', 'true'));
      activePageEl = pages[0] || null;
    } else {
      pageRoot.setAttribute('contenteditable', 'true');
    }

    refreshPageNav();

    pageRoot.addEventListener('input', scheduleSave);

    pageRoot.addEventListener('click', (event) => {
      const anchor = event.target.closest && event.target.closest('a');
      if (anchor) event.preventDefault();
      const button = event.target.closest && event.target.closest('button');
      if (button) event.preventDefault();

      const img = event.target.closest && event.target.closest('img');
      const block = findSelectableBlock(event.target);
      selectBlock(block, img || null);
    });

    pageRoot.addEventListener('dragover', (event) => {
      if (previewOn) return;
      event.preventDefault();
      const over = findSelectableBlock(event.target);
      pageRoot.querySelectorAll('[data-d6-drop]').forEach((el) => el.removeAttribute('data-d6-drop'));
      if (over && !over.classList.contains('d6-doc-page')) {
        over.setAttribute('data-d6-drop', '1');
      }
    });

    pageRoot.addEventListener('dragleave', () => {
      if (!pageRoot) return;
      pageRoot.querySelectorAll('[data-d6-drop]').forEach((el) => el.removeAttribute('data-d6-drop'));
    });

    pageRoot.addEventListener('drop', (event) => {
      if (previewOn) return;
      event.preventDefault();
      pageRoot.querySelectorAll('[data-d6-drop]').forEach((el) => el.removeAttribute('data-d6-drop'));
      const hit = findSelectableBlock(event.target);
      const before = hit && !hit.classList.contains('d6-doc-page') ? hit : null;
      const graphicSrc = event.dataTransfer.getData('text/d6-src');
      if (graphicSrc) {
        insertGraphic({
          src: graphicSrc,
          alt: event.dataTransfer.getData('text/d6-alt') || 'Graphic',
          kind: event.dataTransfer.getData('text/d6-kind') === 'icon' ? 'icon' : 'logo',
        }, before);
        return;
      }
      const blockKey = event.dataTransfer.getData('text/d6-new');
      if (blockKey) insertSnippet(blockKey, before);
    });
  }

  function setPreview(on) {
    previewOn = on;
    els.previewBtn.textContent = on ? 'Back to editing' : 'Preview';
    els.previewBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    document.body.classList.toggle('d6-previewing', on);
  }

  function togglePreview() {
    setPreview(!previewOn);
    if (!pageRoot) return;
    pageRoot.classList.toggle('d6-preview', previewOn);
    if (previewOn) selectBlock(null, null);
    const editables = isDoc(current && current.key)
      ? pageRoot.querySelectorAll('.d6-doc-page')
      : [pageRoot];
    editables.forEach((el) => el.setAttribute('contenteditable', previewOn ? 'false' : 'true'));
  }

  function destroyWorkspace() {
    captureCleanHtml();
    pageRoot = null;
    selectedBlock = null;
    selectedImage = null;
    activePageEl = null;
    if (els.pageHost.shadowRoot) els.pageHost.shadowRoot.innerHTML = '';
    setPreview(false);
  }

  async function resetCurrentToDefault() {
    if (!current) return;
    clearTimeout(saveTimer);
    hideStatus();
    await idbDelete(current.key);
    try {
      await api('/api/admin/components/draft/' + current.key, { method: 'DELETE' });
    } catch (_e) { /* ignore */ }
    const seeded = await seedFromFile(current);
    draft = {
      pageKey: current.key,
      projectJson: {},
      html: seeded.html,
      css: seeded.css,
      updatedAt: new Date().toISOString(),
    };
    renderPage();
    await saveNow();
    showStatus('Restored the clean document layout.', 'ok');
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
    await saveNow();
  }

  async function backToChooser() {
    await saveNow();
    destroyWorkspace();
    current = null;
    draft = null;
    els.workspace.classList.add('hidden');
    els.chooser.classList.remove('hidden');
  }

  // ── Describe Mode ──────────────────────────────────────────────────────────

  function pushTranscript(who, text) {
    const div = document.createElement('div');
    div.className = 'd6-msg ' + (who === 'admin' ? 'd6-msg-admin' : 'd6-msg-page');
    div.textContent = text;
    els.transcript.appendChild(div);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  async function sendDescribeMessage() {
    const message = els.describeInput.value.trim();
    if (!message || !current) return;
    els.describeInput.value = '';
    pushTranscript('admin', message);
    els.describeInput.disabled = true;
    els.describeSendBtn.disabled = true;
    hideStatus();
    try {
      await saveNow();
      const res = await api('/api/admin/components/describe', {
        method: 'POST',
        body: JSON.stringify({ pageKey: current.key, message, history, questionsAsked }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showStatus(data.error || 'Could not apply that change. Try again.', 'error');
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
          renderPage();
          await idbPut(record());
        }
        pushTranscript('page', 'Changes applied.');
      }
    } catch (_e) {
      showStatus('Network error. Please try again.', 'error');
    } finally {
      els.describeInput.disabled = false;
      els.describeSendBtn.disabled = false;
      els.describeInput.focus();
    }
  }

  // ── Publish ────────────────────────────────────────────────────────────────

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
      showStatus(
        isDoc(current.key)
          ? 'Published. The updated PDF and document are live.'
          : 'Published. The live page updates on its next load.',
        'ok',
      );
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

  // ── Boot & Event Wiring ────────────────────────────────────────────────────

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
      els.describeSendBtn.addEventListener('click', sendDescribeMessage);
      els.describeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendDescribeMessage();
        }
      });
      els.doneBtn.addEventListener('click', async () => {
        if (!current) return;
        els.doneBtn.disabled = true;
        try {
          await saveNow();
          const res = await api('/api/admin/components/polish', {
            method: 'POST',
            body: JSON.stringify({ pageKey: current.key }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok && data.draft) {
            draft = Object.assign({}, draft, data.draft, { pageKey: current.key });
            renderPage();
            await idbPut(record());
            showStatus('Finished. Commit to save all changes when you are ready.', 'ok');
          } else {
            showStatus((data && data.error) || 'Could not finish the page.', 'error');
          }
        } finally {
          els.doneBtn.disabled = false;
        }
      });
    }

    const [siteCssRes, docCssRes] = await Promise.all([
      fetch('assets/styles.css', { cache: 'no-store' }).catch(() => null),
      fetch('assets/doc-styles.css', { cache: 'no-store' }).catch(() => null),
    ]);
    if (siteCssRes && siteCssRes.ok) siteCssText = await siteCssRes.text();
    if (docCssRes && docCssRes.ok) docCssText = await docCssRes.text();

    // Formatting commands
    document.querySelectorAll('#format-bar [data-cmd]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const cmd = btn.getAttribute('data-cmd');
        document.execCommand(cmd, false, null);
        scheduleSave();
      });
    });

    document.querySelectorAll('#format-bar .d6-swatch').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const color = btn.getAttribute('data-color');
        document.execCommand('foreColor', false, color);
        scheduleSave();
      });
    });

    // Block manipulation actions
    els.moveUpBtn.addEventListener('click', () => {
      if (!selectedBlock || selectedBlock.classList.contains('d6-doc-page')) return;
      const prev = selectedBlock.previousElementSibling;
      if (prev && !prev.classList.contains('logo-band')) {
        prev.before(selectedBlock);
        scheduleSave();
      }
    });

    els.moveDownBtn.addEventListener('click', () => {
      if (!selectedBlock || selectedBlock.classList.contains('d6-doc-page')) return;
      const next = selectedBlock.nextElementSibling;
      if (next && !next.classList.contains('d6-page-footer')) {
        next.after(selectedBlock);
        scheduleSave();
      }
    });

    els.dupBlockBtn.addEventListener('click', () => {
      if (!selectedBlock) return;
      const clone = selectedBlock.cloneNode(true);
      clone.removeAttribute('data-d6-selected');
      selectedBlock.after(clone);
      if (selectedBlock.classList.contains('d6-doc-page')) refreshPageNav();
      selectBlock(clone, null);
      scheduleSave();
    });

    els.delBlockBtn.addEventListener('click', () => {
      if (!selectedBlock) return;
      if (selectedBlock.classList.contains('d6-doc-page')) {
        const allPages = pageRoot.querySelectorAll('.d6-doc-page');
        if (allPages.length <= 1) return;
      }
      const nextFocus = selectedBlock.nextElementSibling || selectedBlock.previousElementSibling;
      selectedBlock.remove();
      refreshPageNav();
      selectBlock(nextFocus, null);
      scheduleSave();
    });

    els.replaceImgBtn.addEventListener('click', () => {
      if (selectedImage) els.pieceFile.click();
    });

    els.pageSelect.addEventListener('change', () => {
      if (!pageRoot) return;
      const idx = Number(els.pageSelect.value) || 0;
      const pages = pageRoot.querySelectorAll('.d6-doc-page');
      if (pages[idx]) {
        activePageEl = pages[idx];
        pages[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    els.addPageBtn.addEventListener('click', addNewPage);
    els.resetBtn.addEventListener('click', resetCurrentToDefault);

    mountAssetPalette();

    // Palette drag OR click to insert
    document.querySelectorAll('#palette button[data-block]').forEach((btn) => {
      const kind = btn.getAttribute('data-block');
      btn.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/d6-new', kind);
        event.dataTransfer.setData('text/plain', kind);
      });
      btn.addEventListener('click', () => {
        insertSnippet(kind, null);
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
