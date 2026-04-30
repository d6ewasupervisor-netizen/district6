(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;

  const verifyStatus = document.getElementById('verify-status');
  const hub = document.getElementById('hub');
  const signerEmailEl = document.getElementById('signer-email');
  const signerEmailEl2 = document.getElementById('signer-email-2');
  const signSection = document.getElementById('sign-section');
  const fullNameEl = document.getElementById('full-name');
  const agreeCheck = document.getElementById('agree-check');
  const submitBtn = document.getElementById('submit-btn');
  const submitStatus = document.getElementById('submit-status');
  const clearSigBtn = document.getElementById('clear-sig');
  const canvas = document.getElementById('signature-pad');

  // In-memory state — intentionally not persisted to localStorage.
  const docs = ['attendance', 'dressCode', 'sop'];
  const docState = {};
  docs.forEach((d) => {
    docState[d] = { unlocked: false, viewedAt: null };
  });

  let token = null;
  let signerEmail = null;
  let signaturePad = null;

  function showVerifyStatus(kind, msg) {
    verifyStatus.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    verifyStatus.textContent = msg;
    verifyStatus.classList.remove('hidden');
  }
  function showSubmitStatus(kind, msg) {
    submitStatus.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    submitStatus.textContent = msg;
    submitStatus.classList.remove('hidden');
  }
  function hideSubmitStatus() { submitStatus.classList.add('hidden'); }

  function getTokenFromUrl() {
    const params = new URLSearchParams(location.search);
    return params.get('token');
  }

  async function verifyToken() {
    token = getTokenFromUrl();
    if (!token) {
      showVerifyStatus('error', 'No link token provided. Please use the link from your email.');
      return;
    }
    try {
      const res = await fetch(API_BASE + '/api/verify-token?token=' + encodeURIComponent(token));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showVerifyStatus('error', data.error || 'This link is invalid or expired.');
        return;
      }
      signerEmail = data.email;
      signerEmailEl.textContent = signerEmail;
      signerEmailEl2.textContent = signerEmail;
      hub.classList.remove('hidden');
      initDocCards();
      initReferenceCards();
      initSignaturePad();
      bindFormValidation();
    } catch (err) {
      showVerifyStatus('error', 'Could not verify your link. Check your connection and try again.');
    }
  }

  function getDocCard(docKey) {
    return document.querySelector('.doc-card[data-doc="' + docKey + '"]');
  }

  function initDocCards() {
    docs.forEach((docKey) => {
      const card = getDocCard(docKey);
      const openBtn = card.querySelector('.doc-open');
      const checkbox = card.querySelector('.doc-check');
      const checkLabel = card.querySelector('.checkbox-row');
      const timer = card.querySelector('[data-timer]');

      openBtn.addEventListener('click', () => {
        const src = openBtn.getAttribute('data-pdf-src');
        const title = openBtn.getAttribute('data-pdf-title') || 'Document';
        const state = docState[docKey];
        const requireScrollToEnd = !state.unlocked;

        if (requireScrollToEnd) {
          timer.textContent = 'Reading…';
        }

        if (window.D6PdfViewer && src) {
          window.D6PdfViewer.open(src, title, {
            requireScrollToEnd: requireScrollToEnd,
            onUnlock: () => {
              if (state.unlocked) return;
              state.unlocked = true;
              timer.textContent = 'Ready to acknowledge';
              checkbox.disabled = false;
              checkLabel.classList.remove('disabled');
            },
          });
        } else if (src) {
          // Fallback if the in-app viewer failed to load.
          window.open(src, '_blank', 'noopener');
        }
      });

      checkbox.addEventListener('change', () => {
        const state = docState[docKey];
        const card = getDocCard(docKey);
        if (checkbox.checked) {
          state.viewedAt = new Date().toISOString();
          card.classList.add('complete');
          timer.textContent = 'Acknowledged';
        } else {
          state.viewedAt = null;
          card.classList.remove('complete');
        }
        maybeRevealSignSection();
      });
    });
  }

  function initReferenceCards() {
    const refCards = document.querySelectorAll('[data-ref-pdf]');
    refCards.forEach((card) => {
      card.addEventListener('click', (e) => {
        if (!window.D6PdfViewer) return; // let the browser follow the href
        e.preventDefault();
        const src = card.getAttribute('data-pdf-src');
        const title = card.getAttribute('data-pdf-title') || 'Document';
        if (!src) return;
        window.D6PdfViewer.open(src, title, { requireScrollToEnd: false });
      });
    });
  }

  function allDocsAcknowledged() {
    return docs.every((d) => !!docState[d].viewedAt);
  }

  function maybeRevealSignSection() {
    if (allDocsAcknowledged()) {
      signSection.classList.remove('hidden');
      // Resize canvas now that it's actually visible.
      resizeCanvas();
    } else {
      signSection.classList.add('hidden');
    }
    updateSubmitButton();
  }

  function resizeCanvas() {
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    // Preserve existing strokes by snapshotting if pad exists and not empty.
    const wasEmpty = !signaturePad || signaturePad.isEmpty();
    let data = null;
    if (signaturePad && !wasEmpty) {
      data = signaturePad.toData();
    }
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    if (signaturePad) {
      signaturePad.clear();
      if (data) signaturePad.fromData(data);
    }
    updateSubmitButton();
  }

  function initSignaturePad() {
    signaturePad = new SignaturePad(canvas, {
      penColor: '#0a0a0a',
      backgroundColor: '#ffffff',
      minWidth: 0.6,
      maxWidth: 2.2,
    });
    signaturePad.addEventListener('endStroke', updateSubmitButton);

    clearSigBtn.addEventListener('click', () => {
      signaturePad.clear();
      updateSubmitButton();
    });

    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', resizeCanvas);
    setTimeout(resizeCanvas, 0);
  }

  function bindFormValidation() {
    fullNameEl.addEventListener('input', updateSubmitButton);
    agreeCheck.addEventListener('change', updateSubmitButton);
    submitBtn.addEventListener('click', submit);
  }

  function updateSubmitButton() {
    const ready =
      allDocsAcknowledged() &&
      fullNameEl.value.trim().length >= 2 &&
      agreeCheck.checked &&
      signaturePad && !signaturePad.isEmpty();
    submitBtn.disabled = !ready;
  }

  async function submit() {
    hideSubmitStatus();
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    const payload = {
      token,
      fullName: fullNameEl.value.trim(),
      signatureDataUrl: signaturePad.toDataURL('image/png'),
      agreedAt: new Date().toISOString(),
      viewTimestamps: {
        attendance: docState.attendance.viewedAt,
        dressCode: docState.dressCode.viewedAt,
        sop: docState.sop.viewedAt,
      },
    };

    try {
      const res = await fetch(API_BASE + '/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showSubmitStatus('error', data.error || 'Could not submit. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Acknowledgement';
        return;
      }
      location.href = 'thanks.html';
    } catch (err) {
      showSubmitStatus('error', 'Network error. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Acknowledgement';
    }
  }

  verifyToken();
})();
