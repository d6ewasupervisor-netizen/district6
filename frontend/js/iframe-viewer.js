/*
 * D6 in-app iframe viewer.
 *
 * Opens an external URL inside a modal iframe so links from the PDF viewer
 * stay within the app. Includes a "Open in new tab" fallback because some
 * sites send X-Frame-Options or CSP frame-ancestors headers that block
 * embedding.
 *
 * Usage:
 *   window.D6IframeViewer.open('https://example.com/page.html', 'Page Title');
 */
(function () {
  'use strict';

  let modalEl = null;
  let titleEl = null;
  let iframeEl = null;
  let loadingEl = null;
  let errorEl = null;
  let openInTabLink = null;
  let currentUrl = '';
  let lastFocusedEl = null;
  let loadTimer = null;

  function buildModal() {
    if (modalEl) return;
    modalEl = document.createElement('div');
    modalEl.id = 'iframe-viewer';
    modalEl.className = 'iframe-viewer hidden';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-labelledby', 'iframe-viewer-title');
    modalEl.innerHTML = [
      '<div class="iframe-viewer-overlay" data-close></div>',
      '<div class="iframe-viewer-panel" role="document">',
      '  <header class="iframe-viewer-header">',
      '    <h2 id="iframe-viewer-title" class="iframe-viewer-title">Linked page</h2>',
      '    <div class="iframe-viewer-header-actions">',
      '      <a class="iframe-viewer-newtab" data-newtab href="#" target="_blank" rel="noopener" title="Open in a new tab">Open in new tab</a>',
      '      <button class="iframe-viewer-close" type="button" data-close aria-label="Close" title="Close (Esc)">&times;</button>',
      '    </div>',
      '  </header>',
      '  <div class="iframe-viewer-body">',
      '    <div class="iframe-viewer-loading" data-iframe-loading>Loading\u2026</div>',
      '    <div class="iframe-viewer-error hidden" data-iframe-error>',
      '      <p>This page could not be embedded inside the app.</p>',
      '      <a class="iframe-viewer-error-link" data-iframe-error-link href="#" target="_blank" rel="noopener">Open it in a new tab instead</a>',
      '    </div>',
      '    <iframe data-iframe class="iframe-viewer-frame" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox" allow="clipboard-read; clipboard-write"></iframe>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(modalEl);

    titleEl = modalEl.querySelector('#iframe-viewer-title');
    iframeEl = modalEl.querySelector('[data-iframe]');
    loadingEl = modalEl.querySelector('[data-iframe-loading]');
    errorEl = modalEl.querySelector('[data-iframe-error]');
    openInTabLink = modalEl.querySelector('[data-newtab]');
    const errorLink = modalEl.querySelector('[data-iframe-error-link]');

    modalEl.querySelectorAll('[data-close]').forEach(function (el) {
      el.addEventListener('click', close);
    });

    iframeEl.addEventListener('load', function () {
      loadingEl.classList.add('hidden');
      if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    });

    document.addEventListener('keydown', onKeyDown, true);
  }

  function onKeyDown(e) {
    if (!modalEl || modalEl.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function open(url, title) {
    if (!url) return;
    buildModal();
    currentUrl = url;
    titleEl.textContent = title || 'Linked page';
    openInTabLink.href = url;
    const errorLink = modalEl.querySelector('[data-iframe-error-link]');
    if (errorLink) errorLink.href = url;
    loadingEl.classList.remove('hidden');
    errorEl.classList.add('hidden');
    iframeEl.classList.remove('hidden');
    iframeEl.src = 'about:blank';
    setTimeout(function () { iframeEl.src = url; }, 0);
    modalEl.classList.remove('hidden');
    document.body.classList.add('iframe-viewer-open');
    lastFocusedEl = document.activeElement;

    // Heuristic: if the iframe never fires `load`, the page was likely blocked
    // by X-Frame-Options / CSP. Surface a friendly fallback.
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      if (modalEl.classList.contains('hidden')) return;
      if (!loadingEl.classList.contains('hidden')) {
        loadingEl.classList.add('hidden');
        errorEl.classList.remove('hidden');
        iframeEl.classList.add('hidden');
      }
    }, 7000);
  }

  function close() {
    if (!modalEl || modalEl.classList.contains('hidden')) return;
    modalEl.classList.add('hidden');
    document.body.classList.remove('iframe-viewer-open');
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    try { iframeEl.src = 'about:blank'; } catch (e) {}
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
      try { lastFocusedEl.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function isOpen() {
    return !!(modalEl && !modalEl.classList.contains('hidden'));
  }

  window.D6IframeViewer = { open: open, close: close, isOpen: isOpen };
})();
