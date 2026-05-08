(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;

  // ── Link-request form elements ──────────────────────────────────────────────
  const emailEl   = document.getElementById('email');
  const sendBtn   = document.getElementById('send-btn');
  const statusEl  = document.getElementById('status');

  // ── Overlay elements ────────────────────────────────────────────────────────
  const overlay          = document.getElementById('access-overlay');
  const overlayBackdrop  = document.getElementById('overlay-backdrop');
  const overlayForm      = document.getElementById('overlay-form');
  const overlaySuccess   = document.getElementById('overlay-success');
  const overlayStatus    = document.getElementById('overlay-status');
  const overlayName      = document.getElementById('overlay-name');
  const overlayEmail     = document.getElementById('overlay-email');
  const overlayReason    = document.getElementById('overlay-reason');
  const overlaySubmit    = document.getElementById('overlay-submit');
  const overlayCancel    = document.getElementById('overlay-cancel');
  const overlayCloseOk   = document.getElementById('overlay-close-success');

  // Phrase in the server error that should trigger the overlay
  const ACCESS_LIST_ERROR = 'not on the access list';

  // ── Utilities ───────────────────────────────────────────────────────────────

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

  sendBtn.addEventListener('click', send);
  emailEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

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

  overlaySubmit.addEventListener('click', submitAccessRequest);
  overlayEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAccessRequest(); });
  overlayReason.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAccessRequest(); });
})();
