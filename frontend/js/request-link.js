(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;
  const emailEl = document.getElementById('email');
  const sendBtn = document.getElementById('send-btn');
  const statusEl = document.getElementById('status');
  const requestAccessBtn = document.getElementById('request-access-btn');

  // Request-access section elements
  const raSection = document.getElementById('request-access-section');
  const raStatusEl = document.getElementById('ra-status');
  const raNameEl = document.getElementById('ra-name');
  const raEmailEl = document.getElementById('ra-email');
  const raReasonEl = document.getElementById('ra-reason');
  const raSubmitBtn = document.getElementById('ra-submit-btn');

  // Phrase that triggers the "Request access" button
  const ACCESS_LIST_MSG = 'not on the access list';

  function showStatus(kind, msg) {
    statusEl.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
  }
  function hideStatus() { statusEl.classList.add('hidden'); }

  function showRaStatus(kind, msg) {
    raStatusEl.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    raStatusEl.textContent = msg;
    raStatusEl.classList.remove('hidden');
  }
  function hideRaStatus() { raStatusEl.classList.add('hidden'); }

  function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  function showRequestAccessButton(prefillEmail) {
    requestAccessBtn.style.display = 'block';
    if (prefillEmail && raEmailEl) {
      raEmailEl.value = prefillEmail;
    }
  }

  function hideRequestAccessButton() {
    requestAccessBtn.style.display = 'none';
  }

  // Show the request-access card when the button is clicked
  requestAccessBtn.addEventListener('click', function () {
    raSection.classList.remove('hidden');
    raSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (raNameEl) raNameEl.focus();
  });

  async function send() {
    hideStatus();
    hideRequestAccessButton();
    const email = (emailEl.value || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      showStatus('error', 'Please enter a valid email address.');
      return;
    }
    // Server is the authoritative source for the access list (corporate domain
    // OR personal allowlist). The client only validates the format here so we
    // get fast feedback on typos; the server returns a friendly rejection
    // message for addresses that aren't on the list.

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
        const msg = data.error || 'Could not send link. Please try again.';
        showStatus('error', msg);
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send my link';
        // Offer the request-access path when the email isn't on the list
        if (msg.toLowerCase().includes(ACCESS_LIST_MSG)) {
          showRequestAccessButton(email);
        }
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

  async function submitAccessRequest() {
    hideRaStatus();
    const name = (raNameEl.value || '').trim();
    const email = (raEmailEl.value || '').trim().toLowerCase();
    const reason = (raReasonEl.value || '').trim();

    if (!name) {
      showRaStatus('error', 'Please enter your full name.');
      raNameEl.focus();
      return;
    }
    if (!isValidEmail(email)) {
      showRaStatus('error', 'Please enter a valid email address.');
      raEmailEl.focus();
      return;
    }

    raSubmitBtn.disabled = true;
    raSubmitBtn.textContent = 'Submitting…';

    try {
      const res = await fetch(API_BASE + '/api/access-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showRaStatus('error', data.error || 'Could not submit your request. Please try again.');
        raSubmitBtn.disabled = false;
        raSubmitBtn.textContent = 'Submit request';
        return;
      }
      showRaStatus('ok', 'Request sent! You\'ll receive an email once a manager approves your access.');
      raNameEl.value = '';
      raEmailEl.value = '';
      raReasonEl.value = '';
      raSubmitBtn.textContent = 'Submitted';
      raSubmitBtn.disabled = true;
    } catch (err) {
      showRaStatus('error', 'Network error. Please try again.');
      raSubmitBtn.disabled = false;
      raSubmitBtn.textContent = 'Submit request';
    }
  }

  sendBtn.addEventListener('click', send);
  emailEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') send();
  });

  raSubmitBtn.addEventListener('click', submitAccessRequest);
  raEmailEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitAccessRequest();
  });
})();
