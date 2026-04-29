(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;
  const emailEl = document.getElementById('email');
  const sendBtn = document.getElementById('send-btn');
  const statusEl = document.getElementById('status');

  function showStatus(kind, msg) {
    statusEl.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
  }
  function hideStatus() { statusEl.classList.add('hidden'); }

  function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  async function send() {
    hideStatus();
    const email = (emailEl.value || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      showStatus('error', 'Please enter a valid email address.');
      return;
    }
    if (!email.endsWith('@retailodyssey.com')) {
      showStatus('error', 'Only @retailodyssey.com emails are accepted.');
      return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';

    try {
      const res = await fetch(API_BASE + '/api/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showStatus('error', data.error || 'Could not send link. Please try again.');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send my link';
        return;
      }
      showStatus('ok', 'Check your email — your secure link is on its way.');
      emailEl.value = '';
      sendBtn.textContent = 'Sent';
      // Re-enable after a short delay so people can request another if needed.
      setTimeout(() => {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send my link';
      }, 4000);
    } catch (err) {
      showStatus('error', 'Network error. Please try again.');
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send my link';
    }
  }

  sendBtn.addEventListener('click', send);
  emailEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') send();
  });
})();
