(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;

  // Element references are resolved after d6-content-ready: hydrating published
  // content swaps the [data-d6-canvas] subtree, so earlier references go stale.
  let emailEl = null;
  let sendBtn = null;
  let statusEl = null;
  let overlay = null;
  let overlayBackdrop = null;
  let overlayForm = null;
  let overlaySuccess = null;
  let overlayStatus = null;
  let overlayName = null;
  let overlayEmail = null;
  let overlayReason = null;
  let overlaySubmit = null;
  let overlayCancel = null;
  let overlayCloseOk = null;

  // Phrase in the server error that should trigger the overlay
  const ACCESS_LIST_ERROR = 'not on the access list';

  function whenContentReady(fn) {
    if (window.__D6_CONTENT_STATE) {
      fn(window.__D6_CONTENT_STATE);
      return;
    }
    document.addEventListener('d6-content-ready', function (e) {
      fn((e && e.detail) || {});
    }, { once: true });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  function showStatus(kind, msg) {
    statusEl.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
  }
  function hideStatus() { statusEl.classList.add('hidden'); }

  function showOverlayStatus(kind, msg) {
    overlayStatus.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    overlayStatus.textContent = msg;
    overlayStatus.classList.remove('hidden');
  }
  function hideOverlayStatus() { overlayStatus.classList.add('hidden'); }

  // ── Overlay open / close ─────────────────────────────────────────────────────

  function openOverlay(prefillEmail) {
    overlayEmail.value = prefillEmail || '';
    overlayName.value  = '';
    overlayReason.value = '';
    overlaySubmit.disabled   = false;
    overlaySubmit.textContent = 'Request access';
    hideOverlayStatus();

    // Reset to form view (in case a previous success was shown)
    overlayForm.classList.remove('hidden');
    overlaySuccess.classList.add('hidden');

    overlay.classList.remove('hidden');
    document.body.classList.add('overlay-open');

    // Focus name field after animation
    setTimeout(function () { overlayName.focus(); }, 80);
  }

  function closeOverlay() {
    overlay.classList.add('hidden');
    document.body.classList.remove('overlay-open');
    emailEl.focus();
  }

  // ── Link-request flow ────────────────────────────────────────────────────────

  async function send() {
    hideStatus();
    const email = (emailEl.value || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      showStatus('error', 'Please enter a valid email address.');
      return;
    }
    // The server is the authoritative source for the access list.

    sendBtn.disabled  = true;
    sendBtn.textContent = 'Sending…';

    try {
      const res  = await fetch(API_BASE + '/api/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(function () { return {}; });

      if (!res.ok || !data.ok) {
        const msg = data.error || 'Could not send link. Please try again.';
        showStatus('error', msg);
        sendBtn.disabled  = false;
        sendBtn.textContent = 'Send my link';

        // If the email isn't recognised, immediately open the request-access overlay
        if (msg.toLowerCase().includes(ACCESS_LIST_ERROR)) {
          openOverlay(email);
        }
        return;
      }

      showStatus('ok', 'Check your email — your secure link is on its way.');
      emailEl.value = '';
      sendBtn.textContent = 'Sent';
      setTimeout(function () {
        sendBtn.disabled  = false;
        sendBtn.textContent = 'Send my link';
      }, 4000);
    } catch (err) {
      showStatus('error', 'Network error. Please try again.');
      sendBtn.disabled  = false;
      sendBtn.textContent = 'Send my link';
    }
  }

  // ── Access-request overlay submission ────────────────────────────────────────

  async function submitAccessRequest() {
    hideOverlayStatus();
    const name   = (overlayName.value   || '').trim();
    const email  = (overlayEmail.value  || '').trim().toLowerCase();
    const reason = (overlayReason.value || '').trim();

    if (!name) {
      showOverlayStatus('error', 'Please enter your full name.');
      overlayName.focus();
      return;
    }
    if (!isValidEmail(email)) {
      showOverlayStatus('error', 'Please enter a valid email address.');
      overlayEmail.focus();
      return;
    }

    overlaySubmit.disabled    = true;
    overlaySubmit.textContent = 'Submitting…';

    try {
      const res  = await fetch(API_BASE + '/api/access-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, reason }),
      });
      const data = await res.json().catch(function () { return {}; });

      if (!res.ok || !data.ok) {
        showOverlayStatus('error', data.error || 'Could not submit your request. Please try again.');
        overlaySubmit.disabled    = false;
        overlaySubmit.textContent = 'Request access';
        return;
      }

      // Switch to success view inside the overlay
      overlayForm.classList.add('hidden');
      overlaySuccess.classList.remove('hidden');
      overlayCloseOk.focus();
    } catch (err) {
      showOverlayStatus('error', 'Network error. Please try again.');
      overlaySubmit.disabled    = false;
      overlaySubmit.textContent = 'Request access';
    }
  }

  // ── Wiring (after the hydrator swaps in any published content) ───────────────

  function start() {
    emailEl   = document.getElementById('email');
    sendBtn   = document.getElementById('send-btn');
    statusEl  = document.getElementById('status');

    overlay          = document.getElementById('access-overlay');
    overlayBackdrop  = document.getElementById('overlay-backdrop');
    overlayForm      = document.getElementById('overlay-form');
    overlaySuccess   = document.getElementById('overlay-success');
    overlayStatus    = document.getElementById('overlay-status');
    overlayName      = document.getElementById('overlay-name');
    overlayEmail     = document.getElementById('overlay-email');
    overlayReason    = document.getElementById('overlay-reason');
    overlaySubmit    = document.getElementById('overlay-submit');
    overlayCancel    = document.getElementById('overlay-cancel');
    overlayCloseOk   = document.getElementById('overlay-close-success');

    if (!emailEl || !sendBtn || !statusEl) return;

    overlayBackdrop.addEventListener('click', closeOverlay);
    overlayCancel.addEventListener('click', closeOverlay);
    overlayCloseOk.addEventListener('click', closeOverlay);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
        closeOverlay();
      }
    });

    // Prevent clicks inside the panel from closing the overlay
    overlay.querySelector('.access-overlay-panel').addEventListener('click', function (e) {
      e.stopPropagation();
    });

    sendBtn.addEventListener('click', send);
    emailEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

    overlaySubmit.addEventListener('click', submitAccessRequest);
    overlayEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAccessRequest(); });
    overlayReason.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAccessRequest(); });
  }

  whenContentReady(start);
})();