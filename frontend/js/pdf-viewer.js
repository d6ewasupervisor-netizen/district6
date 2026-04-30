/*
 * D6 in-app PDF viewer.
 *
 * Lazy-loads PDF.js (Mozilla) from a CDN and renders the document into a
 * fullscreen modal with continuous-scroll pages, zoom controls, page
 * navigation, keyboard shortcuts, and a Download fallback.
 *
 * Features:
 *   - Optional read-lock countdown: while locked, the close/Esc/overlay are
 *     disabled and a visible MM:SS countdown is shown in the toolbar. When
 *     it reaches zero, an `onUnlock` callback fires and close is enabled.
 *   - Clickable link annotations are rendered as an overlay above each page
 *     and intercepted to open inside the in-app iframe viewer
 *     (`window.D6IframeViewer`). A small URL-rewrite map normalizes known
 *     "Teammate Handbook / Vendor Policies / Kompass Responsibilities"
 *     references to their canonical destinations, even if a PDF embeds an
 *     out-of-date URL.
 *
 * Usage:
 *   window.D6PdfViewer.open(
 *     'docs/sop.pdf',
 *     'Standard Operating Procedures',
 *     { lockMs: 60000, onUnlock: () => {} }
 *   );
 */
(function () {
  'use strict';

  const PDFJS_VERSION = '3.11.174';
  const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VERSION;

  /* ---------------------------------------------------------------- */
  /* Known external destinations referenced from inside the policy PDFs.
   * Clicks on PDF links are matched against the patterns below
   * (link text first, then URL host/path) and routed to the canonical
   * URL — this protects users from outdated links baked into the PDFs. */
  const LINK_REWRITE_RULES = [
    {
      url: 'https://the-dump-bin.web.app/',
      title: 'Teammate Handbook',
      textPatterns: [/teammate\s+handbook/i, /employee\s+handbook/i],
      urlPatterns: [/the-dump-bin\.web\.app\/?(?:#|$|\?)/i],
    },
    {
      url: 'https://the-dump-bin.web.app/vendor_policy.html',
      title: 'Fred Meyer Vendor Policies',
      textPatterns: [/(fred\s*meyer.*vendor|vendor\s+polic)/i],
      urlPatterns: [/the-dump-bin\.web\.app\/vendor[_-]?polic/i],
    },
    {
      url: 'https://the-dump-bin.web.app/kompass_responsibilities.html',
      title: 'Kompass Responsibilities',
      textPatterns: [/kompass\s+responsibilit/i, /kompass/i],
      urlPatterns: [/the-dump-bin\.web\.app\/kompass/i],
    },
  ];

  function resolveLink(rawUrl, linkText) {
    const text = String(linkText || '').trim();
    const url = String(rawUrl || '').trim();
    for (const rule of LINK_REWRITE_RULES) {
      if (text && rule.textPatterns.some(function (re) { return re.test(text); })) {
        return { url: rule.url, title: rule.title };
      }
    }
    for (const rule of LINK_REWRITE_RULES) {
      if (url && rule.urlPatterns.some(function (re) { return re.test(url); })) {
        return { url: rule.url, title: rule.title };
      }
    }
    return { url: url, title: text || url };
  }

  /* ---------------------------------------------------------------- */

  let pdfJsPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = PDFJS_BASE + '/pdf.min.js';
      s.async = true;
      s.onload = function () {
        if (!window.pdfjsLib) {
          reject(new Error('pdfjsLib not available after load'));
          return;
        }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + '/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = function () { reject(new Error('Failed to load PDF.js')); };
      document.head.appendChild(s);
    });
    return pdfJsPromise;
  }

  let modalEl = null;
  let bodyEl = null;
  let pagesContainer = null;
  let titleEl = null;
  let pageInput = null;
  let pageCountEl = null;
  let loadingEl = null;
  let downloadLink = null;
  let closeBtn = null;
  let overlayEl = null;
  let countdownEl = null;
  let prevBtn, nextBtn, zoomInBtn, zoomOutBtn, zoomFitBtn;

  let currentPdf = null;
  let pageRefs = [];
  let fitScale = 1;        // computed scale to fit width
  let userScale = 1;       // multiplier on top of fit; 1 means "fit width"
  let resizeTimer = null;
  let lastFocusedEl = null;
  let scrollDebounce = null;

  // Lock state
  let isLocked = false;
  let lockEndTime = 0;
  let lockInterval = null;
  let onUnlockCallback = null;

  function buildModal() {
    if (modalEl) return;
    modalEl = document.createElement('div');
    modalEl.id = 'pdf-viewer';
    modalEl.className = 'pdf-viewer hidden';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-labelledby', 'pdf-viewer-title');
    modalEl.innerHTML = [
      '<div class="pdf-viewer-overlay" data-close></div>',
      '<div class="pdf-viewer-panel" role="document">',
      '  <header class="pdf-viewer-header">',
      '    <h2 id="pdf-viewer-title" class="pdf-viewer-title">Document</h2>',
      '    <button class="pdf-viewer-close" type="button" data-close aria-label="Close viewer" title="Close (Esc)">&times;</button>',
      '  </header>',
      '  <div class="pdf-viewer-toolbar">',
      '    <div class="pdf-viewer-toolbar-group">',
      '      <button type="button" class="pdf-viewer-iconbtn" data-pdf-prev aria-label="Previous page" title="Previous page (\u2190)">\u2039</button>',
      '      <span class="pdf-viewer-page">',
      '        <input data-pdf-page type="number" min="1" value="1" aria-label="Current page" />',
      '        <span class="pdf-viewer-page-sep">/</span>',
      '        <span data-pdf-page-count>\u2014</span>',
      '      </span>',
      '      <button type="button" class="pdf-viewer-iconbtn" data-pdf-next aria-label="Next page" title="Next page (\u2192)">\u203A</button>',
      '    </div>',
      '    <div class="pdf-viewer-toolbar-group">',
      '      <button type="button" class="pdf-viewer-iconbtn" data-pdf-zoom-out aria-label="Zoom out" title="Zoom out (\u2212)">\u2212</button>',
      '      <button type="button" class="pdf-viewer-iconbtn pdf-viewer-fit" data-pdf-zoom-fit aria-label="Fit to width" title="Fit to width (0)">Fit</button>',
      '      <button type="button" class="pdf-viewer-iconbtn" data-pdf-zoom-in aria-label="Zoom in" title="Zoom in (+)">+</button>',
      '    </div>',
      '    <div class="pdf-viewer-toolbar-group pdf-viewer-toolbar-right">',
      '      <span class="pdf-viewer-countdown hidden" data-pdf-countdown role="status" aria-live="polite"></span>',
      '      <a class="pdf-viewer-download" data-pdf-download href="#" target="_blank" rel="noopener" download title="Download a copy">Download</a>',
      '    </div>',
      '  </div>',
      '  <div class="pdf-viewer-body" data-pdf-body tabindex="-1">',
      '    <div class="pdf-viewer-loading" data-pdf-loading>Loading document\u2026</div>',
      '    <div class="pdf-viewer-pages" data-pdf-pages></div>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(modalEl);

    titleEl = modalEl.querySelector('#pdf-viewer-title');
    bodyEl = modalEl.querySelector('[data-pdf-body]');
    pagesContainer = modalEl.querySelector('[data-pdf-pages]');
    loadingEl = modalEl.querySelector('[data-pdf-loading]');
    pageInput = modalEl.querySelector('[data-pdf-page]');
    pageCountEl = modalEl.querySelector('[data-pdf-page-count]');
    downloadLink = modalEl.querySelector('[data-pdf-download]');
    countdownEl = modalEl.querySelector('[data-pdf-countdown]');
    closeBtn = modalEl.querySelector('.pdf-viewer-close');
    overlayEl = modalEl.querySelector('.pdf-viewer-overlay');
    prevBtn = modalEl.querySelector('[data-pdf-prev]');
    nextBtn = modalEl.querySelector('[data-pdf-next]');
    zoomInBtn = modalEl.querySelector('[data-pdf-zoom-in]');
    zoomOutBtn = modalEl.querySelector('[data-pdf-zoom-out]');
    zoomFitBtn = modalEl.querySelector('[data-pdf-zoom-fit]');

    modalEl.querySelectorAll('[data-close]').forEach(function (el) {
      el.addEventListener('click', tryClose);
    });
    prevBtn.addEventListener('click', function () { goToPage(getCurrentPage() - 1); });
    nextBtn.addEventListener('click', function () { goToPage(getCurrentPage() + 1); });
    pageInput.addEventListener('change', function () {
      const n = Number(pageInput.value);
      if (Number.isFinite(n)) goToPage(n);
    });
    zoomInBtn.addEventListener('click', function () { setZoom(userScale * 1.2, false); });
    zoomOutBtn.addEventListener('click', function () { setZoom(userScale / 1.2, false); });
    zoomFitBtn.addEventListener('click', function () { setZoom(1, true); });

    bodyEl.addEventListener('scroll', function () {
      if (scrollDebounce) cancelAnimationFrame(scrollDebounce);
      scrollDebounce = requestAnimationFrame(updateCurrentPageFromScroll);
    });

    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', function () {
      if (!modalEl || modalEl.classList.contains('hidden')) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rerenderForFit, 150);
    });
  }

  function onKeyDown(e) {
    if (!modalEl || modalEl.classList.contains('hidden')) return;
    // If the iframe viewer is on top, let it handle keys.
    if (window.D6IframeViewer && window.D6IframeViewer.isOpen && window.D6IframeViewer.isOpen()) return;
    if (e.key === 'Escape') {
      if (isLocked) { e.preventDefault(); return; }
      e.preventDefault();
      close();
      return;
    }
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault(); goToPage(getCurrentPage() + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault(); goToPage(getCurrentPage() - 1);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault(); setZoom(userScale * 1.2, false);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault(); setZoom(userScale / 1.2, false);
    } else if (e.key === '0') {
      e.preventDefault(); setZoom(1, true);
    }
  }

  function tryClose() {
    if (isLocked) return;
    close();
  }

  /* ------------------- Lock / countdown ------------------- */

  function startLock(ms, onUnlock) {
    isLocked = true;
    lockEndTime = Date.now() + ms;
    onUnlockCallback = typeof onUnlock === 'function' ? onUnlock : null;
    if (modalEl) modalEl.classList.add('pdf-viewer-locked');
    if (closeBtn) {
      closeBtn.disabled = true;
      closeBtn.setAttribute('aria-disabled', 'true');
    }
    if (countdownEl) countdownEl.classList.remove('hidden');
    tickLock();
    if (lockInterval) clearInterval(lockInterval);
    lockInterval = setInterval(tickLock, 250);
  }

  function tickLock() {
    if (!isLocked) return;
    const remaining = Math.max(0, lockEndTime - Date.now());
    if (remaining <= 0) {
      finishLock();
      return;
    }
    const totalSecs = Math.ceil(remaining / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    const pad = s < 10 ? '0' + s : String(s);
    if (countdownEl) countdownEl.textContent = 'Unlocks in ' + m + ':' + pad;
  }

  function finishLock() {
    if (lockInterval) { clearInterval(lockInterval); lockInterval = null; }
    isLocked = false;
    if (modalEl) modalEl.classList.remove('pdf-viewer-locked');
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.removeAttribute('aria-disabled');
    }
    if (countdownEl) {
      countdownEl.textContent = 'Unlocked \u2713';
      countdownEl.classList.add('pdf-viewer-countdown-done');
      setTimeout(function () {
        if (countdownEl) {
          countdownEl.classList.add('hidden');
          countdownEl.classList.remove('pdf-viewer-countdown-done');
        }
      }, 2000);
    }
    const cb = onUnlockCallback;
    onUnlockCallback = null;
    if (cb) {
      try { cb(); } catch (e) { /* ignore */ }
    }
  }

  function clearLock() {
    if (lockInterval) { clearInterval(lockInterval); lockInterval = null; }
    isLocked = false;
    onUnlockCallback = null;
    if (modalEl) modalEl.classList.remove('pdf-viewer-locked');
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.removeAttribute('aria-disabled');
    }
    if (countdownEl) {
      countdownEl.classList.add('hidden');
      countdownEl.classList.remove('pdf-viewer-countdown-done');
      countdownEl.textContent = '';
    }
  }

  /* ------------------- Open / close ------------------- */

  async function open(url, title, options) {
    options = options || {};
    const lockMs = Math.max(0, Number(options.lockMs) || 0);
    const onUnlock = options.onUnlock;

    buildModal();
    titleEl.textContent = title || 'Document';
    downloadLink.href = url;
    pagesContainer.innerHTML = '';
    pageCountEl.textContent = '\u2014';
    pageInput.value = '1';
    pageInput.removeAttribute('max');
    loadingEl.style.display = '';
    loadingEl.textContent = 'Loading document\u2026';
    modalEl.classList.remove('hidden');
    document.body.classList.add('pdf-viewer-open');
    bodyEl.scrollTop = 0;
    lastFocusedEl = document.activeElement;
    setTimeout(function () { try { bodyEl.focus({ preventScroll: true }); } catch (e) {} }, 0);

    if (lockMs > 0) {
      startLock(lockMs, onUnlock);
    } else {
      clearLock();
    }

    let pdfjsLib;
    try {
      pdfjsLib = await loadPdfJs();
    } catch (err) {
      loadingEl.textContent = 'Could not load the PDF viewer. Use Download to view this document.';
      return;
    }

    try {
      const loadingTask = pdfjsLib.getDocument({
        url: url,
        cMapUrl: PDFJS_BASE + '/cmaps/',
        cMapPacked: true,
        disableAutoFetch: false,
        disableStream: false,
      });
      const pdf = await loadingTask.promise;
      currentPdf = pdf;
      pageRefs = [];
      pageCountEl.textContent = String(pdf.numPages);
      pageInput.max = String(pdf.numPages);

      const firstPage = await pdf.getPage(1);
      const baseViewport = firstPage.getViewport({ scale: 1 });
      fitScale = computeFitScale(baseViewport.width);
      userScale = 1;

      for (let p = 1; p <= pdf.numPages; p++) {
        const wrap = document.createElement('div');
        wrap.className = 'pdf-viewer-page-wrap';
        wrap.dataset.pageNum = String(p);
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-viewer-canvas';
        const linkLayer = document.createElement('div');
        linkLayer.className = 'pdf-viewer-link-layer';
        wrap.appendChild(canvas);
        wrap.appendChild(linkLayer);
        pagesContainer.appendChild(wrap);
        pageRefs.push({
          pageNum: p,
          wrap: wrap,
          canvas: canvas,
          linkLayer: linkLayer,
          page: null,
          renderTask: null,
        });
      }
      pageRefs[0].page = firstPage;
      loadingEl.style.display = 'none';
      await renderAll();
    } catch (err) {
      loadingEl.style.display = '';
      loadingEl.textContent = 'Could not load this PDF. Use Download to view it instead.';
    }
  }

  /* ------------------- Rendering ------------------- */

  function computeFitScale(baseWidth) {
    const target = Math.max(280, bodyEl.clientWidth - 32);
    return target / baseWidth;
  }

  async function renderAll() {
    if (!currentPdf) return;
    for (let i = 0; i < pageRefs.length; i++) {
      if (!currentPdf) return;
      await renderPage(pageRefs[i]);
    }
  }

  async function renderPage(ref) {
    if (!currentPdf) return;
    if (!ref.page) ref.page = await currentPdf.getPage(ref.pageNum);
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const scale = fitScale * userScale;
    const viewport = ref.page.getViewport({ scale: scale });
    const canvas = ref.canvas;
    const ctx = canvas.getContext('2d');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ref.wrap.style.width = Math.floor(viewport.width) + 'px';
    ref.linkLayer.style.width = Math.floor(viewport.width) + 'px';
    ref.linkLayer.style.height = Math.floor(viewport.height) + 'px';
    if (ref.renderTask) { try { ref.renderTask.cancel(); } catch (e) {} }
    ref.renderTask = ref.page.render({ canvasContext: ctx, viewport: viewport });
    try {
      await ref.renderTask.promise;
    } catch (e) {
      // canceled or replaced; ignore
      return;
    }
    try {
      await renderLinks(ref, viewport);
    } catch (e) {
      // ignore link layer failures
    }
  }

  async function renderLinks(ref, viewport) {
    if (!ref.page) return;
    ref.linkLayer.innerHTML = '';
    let annotations;
    try {
      annotations = await ref.page.getAnnotations({ intent: 'display' });
    } catch (e) {
      return;
    }
    if (!annotations || annotations.length === 0) return;

    let textItems = null;
    try {
      const textContent = await ref.page.getTextContent();
      textItems = textContent && textContent.items ? textContent.items : [];
    } catch (e) {
      textItems = [];
    }

    for (let i = 0; i < annotations.length; i++) {
      const annot = annotations[i];
      if (!annot || annot.subtype !== 'Link') continue;
      const targetUrl = annot.url || (annot.unsafeUrl ? annot.unsafeUrl : null);
      if (!targetUrl) continue;
      if (!annot.rect || annot.rect.length < 4) continue;

      // Convert PDF-space rect [x1,y1,x2,y2] to viewport pixel coords.
      const v1 = viewport.convertToViewportPoint(annot.rect[0], annot.rect[1]);
      const v2 = viewport.convertToViewportPoint(annot.rect[2], annot.rect[3]);
      const left = Math.min(v1[0], v2[0]);
      const top = Math.min(v1[1], v2[1]);
      const width = Math.abs(v2[0] - v1[0]);
      const height = Math.abs(v2[1] - v1[1]);
      if (width < 2 || height < 2) continue;

      const linkText = extractTextInRect(textItems, viewport, left, top, width, height);

      const a = document.createElement('a');
      a.className = 'pdf-viewer-link';
      a.href = targetUrl;
      a.style.left = left + 'px';
      a.style.top = top + 'px';
      a.style.width = width + 'px';
      a.style.height = height + 'px';
      a.setAttribute('aria-label', linkText || targetUrl);
      a.title = linkText || targetUrl;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const resolved = resolveLink(targetUrl, linkText);
        if (window.D6IframeViewer && resolved.url) {
          window.D6IframeViewer.open(resolved.url, resolved.title);
        } else if (resolved.url) {
          window.open(resolved.url, '_blank', 'noopener');
        }
      });
      ref.linkLayer.appendChild(a);
    }
  }

  function extractTextInRect(textItems, viewport, left, top, width, height) {
    if (!textItems || textItems.length === 0) return '';
    const right = left + width;
    const bottom = top + height;
    const collected = [];
    for (let i = 0; i < textItems.length; i++) {
      const item = textItems[i];
      if (!item || !item.transform || !item.str) continue;
      // transform is [a, b, c, d, e, f]; e/f are x/y in PDF space.
      const tx = pdfPointToViewport(item.transform[4], item.transform[5], viewport);
      // Approximate item box: x = tx[0], y = tx[1] - itemHeight, width = item.width * scale.
      const itemHeight = (item.height || 0) * (viewport.scale || 1);
      const itemWidth = (item.width || 0) * (viewport.scale || 1);
      const ix = tx[0];
      const iy = tx[1] - itemHeight;
      const ix2 = ix + itemWidth;
      const iy2 = tx[1];
      const intersects = ix < right && ix2 > left && iy < bottom && iy2 > top;
      if (intersects) collected.push(item.str);
      if (collected.length > 8) break;
    }
    return collected.join(' ').replace(/\s+/g, ' ').trim();
  }

  function pdfPointToViewport(x, y, viewport) {
    return viewport.convertToViewportPoint(x, y);
  }

  function setZoom(newScale, isFit) {
    if (!currentPdf) return;
    const savedPage = getCurrentPage();
    if (isFit) {
      userScale = 1;
    } else {
      userScale = Math.min(5, Math.max(0.4, newScale));
    }
    renderAll().then(function () { goToPage(savedPage, true); });
  }

  function rerenderForFit() {
    if (!currentPdf || pageRefs.length === 0) return;
    const ref = pageRefs[0];
    if (!ref.page) return;
    const baseViewport = ref.page.getViewport({ scale: 1 });
    fitScale = computeFitScale(baseViewport.width);
    const savedPage = getCurrentPage();
    renderAll().then(function () { goToPage(savedPage, true); });
  }

  function getCurrentPage() {
    return Number(pageInput.value) || 1;
  }

  function goToPage(n, instant) {
    if (!currentPdf) return;
    n = Math.min(currentPdf.numPages, Math.max(1, n));
    const ref = pageRefs[n - 1];
    if (!ref) return;
    pageInput.value = String(n);
    const top = ref.wrap.offsetTop - 8;
    if (instant) {
      bodyEl.scrollTop = top;
    } else {
      try {
        bodyEl.scrollTo({ top: top, behavior: 'smooth' });
      } catch (e) {
        bodyEl.scrollTop = top;
      }
    }
  }

  function updateCurrentPageFromScroll() {
    if (!currentPdf || pageRefs.length === 0) return;
    const probe = bodyEl.scrollTop + bodyEl.clientHeight / 3;
    let current = 1;
    for (let i = 0; i < pageRefs.length; i++) {
      if (pageRefs[i].wrap.offsetTop <= probe) {
        current = pageRefs[i].pageNum;
      } else {
        break;
      }
    }
    if (Number(pageInput.value) !== current) pageInput.value = String(current);
  }

  function close() {
    if (!modalEl) return;
    if (isLocked) return;
    modalEl.classList.add('hidden');
    document.body.classList.remove('pdf-viewer-open');
    for (let i = 0; i < pageRefs.length; i++) {
      const ref = pageRefs[i];
      if (ref.renderTask) { try { ref.renderTask.cancel(); } catch (e) {} }
    }
    pageRefs = [];
    if (pagesContainer) pagesContainer.innerHTML = '';
    if (currentPdf) {
      try { currentPdf.destroy(); } catch (e) {}
      currentPdf = null;
    }
    clearLock();
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
      try { lastFocusedEl.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  window.D6PdfViewer = { open: open, close: close };
})();
