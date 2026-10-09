/*
 * Content hydrator — loads the published page content and swaps it into the
 * [data-d6-canvas] element before request-link.js / sign.js initialize.
 *
 * On failure (offline, no published row yet, API down) the HTML already in the
 * file stays. Either way `d6-content-ready` is dispatched (and
 * window.__D6_CONTENT_STATE is set) so page scripts can bind to the final DOM.
 */
(function () {
  'use strict';

  var API_BASE = window.D6_CONFIG.API_BASE;

  function signalReady(detail) {
    window.__D6_CONTENT_STATE = detail;
    document.dispatchEvent(new CustomEvent('d6-content-ready', { detail: detail }));
  }

  var canvas = document.querySelector('[data-d6-canvas]');
  var pageKey = canvas ? String(canvas.getAttribute('data-d6-canvas') || '').trim() : '';
  if (!canvas || !pageKey) {
    signalReady({ pageKey: null, swapped: false });
    return;
  }

  fetch(API_BASE + '/api/content/' + encodeURIComponent(pageKey), { cache: 'no-store' })
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .then(function (data) {
      if (data && data.ok && typeof data.html === 'string') {
        canvas.innerHTML = data.html;
        var style = document.getElementById('d6-content-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'd6-content-style';
          document.head.appendChild(style);
        }
        style.textContent = data.css || '';
        signalReady({ pageKey: pageKey, swapped: true });
        return;
      }
      signalReady({ pageKey: pageKey, swapped: false });
    })
    .catch(function () {
      signalReady({ pageKey: pageKey, swapped: false });
    });
})();