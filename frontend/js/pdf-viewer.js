/*
 * D6 in-app PDF viewer.
 *
 * Lazy-loads PDF.js (Mozilla) from a CDN and renders the document into a
 * fullscreen modal with continuous-scroll pages, zoom controls, page
 * navigation, keyboard shortcuts, and a Download fallback.
 *
 * Optional read-gate: when `requireScrollToEnd: true` is passed, the close
 * button (and Esc/overlay clicks) stay disabled until the reader scrolls to
 * the bottom of the document. Once the bottom is reached, `onUnlock` fires
 * and the viewer becomes closeable. There is no visible timer; if the
 * reader has been on the page for more than 45 seconds without reaching
 * the end, a bouncing down-arrow overlay is shown as a hint.
 *
 * Usage:
 *   window.D6PdfViewer.open(
 *     'docs/sop.pdf',
 *     'Standard Operating Procedures',
 *     { requireScrollToEnd: true, onUnlock: () => {} }
 *   );
 */
(function () {
  'use strict';

  const PDFJS_VERSION = '3.11.174';
  const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VERSION;
  const HINT_DELAY_MS = 45 * 1000;
  const SCROLL_END_TOLERANCE_PX = 24;

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
  let hintEl = null;
  let prevBtn, nextBtn, zoomInBtn, zoomOutBtn, zoomFitBtn;

  let currentPdf = null;
  let pageRefs = [];
  let fitScale = 1;        // computed scale to fit width
  let userScale = 1;       // multiplier on top of fit; 1 means "fit width"
  let resizeTimer = null;
  let lastFocusedEl = null;
  let scrollDebounce = null;

  // Read-gate state
  let isLocked = false;
  let unlocked = false;
  let onUnlockCallback = null;
  let hintTimer = null;

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
      '      <a class="pdf-viewer-download" data-pdf-download href="#" target="_blank" rel="noopener" download title="Download a copy">Download</a>',
      '    </div>',
      '  </div>',
      '  <div class="pdf-viewer-body" data-pdf-body tabindex="-1">',
      '    <div class="pdf-viewer-loading" data-pdf-loading>Loading document\u2026</div>',
      '    <div class="pdf-viewer-pages" data-pdf-pages></div>',
      '  </div>',
      '  <div class="pdf-viewer-hint hidden" data-pdf-hint aria-hidden="true">',
      '    <span class="pdf-viewer-hint-arrow" aria-hidden="true"></span>',
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
    hintEl = modalEl.querySelector('[data-pdf-hint]');
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
      scrollDebounce = requestAnimationFrame(function () {
        updateCurrentPageFromScroll();
        maybeUnlockFromScroll();
      });
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
    if (e.key === 'Escape') {
      if (isLocked && !unlocked) { e.preventDefault(); return; }
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
    if (isLocked && !unlocked) return;
    close();
  }

  /* ------------------- Read-gate ------------------- */

  function startReadGate(onUnlock) {
    isLocked = true;
    unlocked = false;
    onUnlockCallback = typeof onUnlock === 'function' ? onUnlock : null;
    if (modalEl) modalEl.classList.add('pdf-viewer-locked');
    if (closeBtn) {
      closeBtn.disabled = true;
      closeBtn.setAttribute('aria-disabled', 'true');
    }
    hideHint();
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      if (!isLocked || unlocked) return;
      showHint();
    }, HINT_DELAY_MS);
  }

  function maybeUnlockFromScroll() {
    if (!isLocked || unlocked) return;
    if (!bodyEl) return;
    const distanceFromBottom = bodyEl.scrollHeight - (bodyEl.scrollTop + bodyEl.clientHeight);
    if (distanceFromBottom <= SCROLL_END_TOLERANCE_PX) {
      finishReadGate();
    }
  }

  function finishReadGate() {
    if (!isLocked || unlocked) return;
    unlocked = true;
    if (modalEl) modalEl.classList.remove('pdf-viewer-locked');
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.removeAttribute('aria-disabled');
    }
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    hideHint();
    const cb = onUnlockCallback;
    onUnlockCallback = null;
    if (cb) {
      try { cb(); } catch (e) { /* ignore */ }
    }
  }

  function clearReadGate() {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    isLocked = false;
    unlocked = false;
    onUnlockCallback = null;
    if (modalEl) modalEl.classList.remove('pdf-viewer-locked');
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.removeAttribute('aria-disabled');
    }
    hideHint();
  }

  function showHint() {
    if (!hintEl) return;
    hintEl.classList.remove('hidden');
    hintEl.setAttribute('aria-hidden', 'false');
  }

  function hideHint() {
    if (!hintEl) return;
    hintEl.classList.add('hidden');
    hintEl.setAttribute('aria-hidden', 'true');
  }

  /* ------------------- Open / close ------------------- */

  async function open(url, title, options) {
    options = options || {};
    const requireScrollToEnd = !!options.requireScrollToEnd;
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

    if (requireScrollToEnd) {
      startReadGate(onUnlock);
    } else {
      clearReadGate();
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
        wrap.appendChild(canvas);
        pagesContainer.appendChild(wrap);
        pageRefs.push({
          pageNum: p,
          wrap: wrap,
          canvas: canvas,
          page: null,
          renderTask: null,
        });
      }
      pageRefs[0].page = firstPage;
      loadingEl.style.display = 'none';
      await renderAll();
      // Short docs may already fit in the viewport — check the gate now.
      maybeUnlockFromScroll();
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
    if (ref.renderTask) { try { ref.renderTask.cancel(); } catch (e) {} }
    ref.renderTask = ref.page.render({ canvasContext: ctx, viewport: viewport });
    try {
      await ref.renderTask.promise;
    } catch (e) {
      // canceled or replaced; ignore
      return;
    }
  }

  function setZoom(newScale, isFit) {
    if (!currentPdf) return;
    const savedPage = getCurrentPage();
    if (isFit) {
      userScale = 1;
    } else {
      userScale = Math.min(5, Math.max(0.4, newScale));
    }
    renderAll().then(function () {
      goToPage(savedPage, true);
      maybeUnlockFromScroll();
    });
  }

  function rerenderForFit() {
    if (!currentPdf || pageRefs.length === 0) return;
    const ref = pageRefs[0];
    if (!ref.page) return;
    const baseViewport = ref.page.getViewport({ scale: 1 });
    fitScale = computeFitScale(baseViewport.width);
    const savedPage = getCurrentPage();
    renderAll().then(function () {
      goToPage(savedPage, true);
      maybeUnlockFromScroll();
    });
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
    if (isLocked && !unlocked) return;
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
    clearReadGate();
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
      try { lastFocusedEl.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  window.D6PdfViewer = { open: open, close: close };
})();
