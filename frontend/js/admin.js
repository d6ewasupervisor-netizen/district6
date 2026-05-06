(function () {
  'use strict';

  const API_BASE = window.D6_CONFIG.API_BASE;
  const JWT_KEY = 'd6-admin-jwt';

  const gateLoading = document.getElementById('gate-loading');
  const gateAuth = document.getElementById('gate-auth');
  const blockedSection = document.getElementById('blocked-section');
  const blockedMessage = document.getElementById('blocked-message');
  const setupSection = document.getElementById('setup-section');
  const loginSection = document.getElementById('login-section');

  const setupCodeEl = document.getElementById('setup-code');
  const setupPwEl = document.getElementById('setup-password');
  const setupPw2El = document.getElementById('setup-password-confirm');
  const setupStatusEl = document.getElementById('setup-status');
  const setupSubmit = document.getElementById('setup-submit');

  const loginEmailEl = document.getElementById('login-email');
  const loginPwEl = document.getElementById('login-password');
  const loginStatusEl = document.getElementById('login-status');
  const loginSubmit = document.getElementById('login-submit');
  const loginForgotLink = document.getElementById('login-forgot-link');

  const forgotSection = document.getElementById('forgot-section');
  const forgotEmailEl = document.getElementById('forgot-email');
  const forgotStatusEl = document.getElementById('forgot-status');
  const forgotSubmit = document.getElementById('forgot-submit');
  const forgotBack = document.getElementById('forgot-back');

  const resetSection = document.getElementById('reset-section');
  const resetTokenFieldEl = document.getElementById('reset-token-field');
  const resetNewPwEl = document.getElementById('reset-new-password');
  const resetNewPw2El = document.getElementById('reset-new-password-confirm');
  const resetStatusEl = document.getElementById('reset-status');
  const resetSubmit = document.getElementById('reset-submit');
  const resetBack = document.getElementById('reset-back');

  const adminPanel = document.getElementById('admin-panel');
  const signedInAsEl = document.getElementById('signed-in-as');
  const lockBtn = document.getElementById('lock-btn');
  const changeCurrentPwEl = document.getElementById('change-current');
  const changeNewPwEl = document.getElementById('change-new');
  const changeNewPw2El = document.getElementById('change-new2');
  const changePwStatusEl = document.getElementById('change-pw-status');
  const changeSubmit = document.getElementById('change-submit');
  const newEmailEl = document.getElementById('new-email');
  const newNoteEl = document.getElementById('new-note');
  const addBtn = document.getElementById('add-btn');
  const addStatusEl = document.getElementById('add-status');
  const adminBannerEl = document.getElementById('admin-banner');
  const listLoadingEl = document.getElementById('list-loading');
  const listEmptyEl = document.getElementById('list-empty');
  const tableWrapEl = document.getElementById('table-wrap');
  const listBodyEl = document.getElementById('list-body');

  function getJwt() {
    try {
      return sessionStorage.getItem(JWT_KEY) || '';
    } catch (_e) {
      return '';
    }
  }

  function setJwt(token) {
    try {
      sessionStorage.setItem(JWT_KEY, token);
    } catch (_e) { /* ignore */ }
  }

  function clearJwt() {
    try {
      sessionStorage.removeItem(JWT_KEY);
    } catch (_e) { /* ignore */ }
  }

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + getJwt(),
    };
  }

  function hide(el) {
    el.classList.add('hidden');
  }
  function show(el) {
    el.classList.remove('hidden');
  }

  function showNotice(el, kind, msg) {
    el.className = 'notice ' + (kind === 'error' ? 'notice-error' : 'notice-ok');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideNotice(el) {
    el.classList.add('hidden');
  }

  function showBanner(kind, msg) {
    showNotice(adminBannerEl, kind, msg);
  }
  function hideBanner() {
    hideNotice(adminBannerEl);
  }

  function showGateLoading() {
    show(gateLoading);
    hide(gateAuth);
    hide(adminPanel);
  }

  function showAuthGate() {
    hide(gateLoading);
    show(gateAuth);
    hide(adminPanel);
  }

  function showPanel() {
    hide(gateLoading);
    hide(gateAuth);
    show(adminPanel);
  }

  function takeResetTokenFromUrl() {
    try {
      const p = new URLSearchParams(window.location.search);
      const t = (p.get('reset') || '').trim();
      if (!t) return '';
      window.history.replaceState({}, '', window.location.pathname);
      return t;
    } catch (_e) {
      return '';
    }
  }

  function resetAuthSections() {
    hide(blockedSection);
    hide(setupSection);
    hide(loginSection);
    hide(forgotSection);
    hide(resetSection);
  }

  async function verifySession() {
    const jwt = getJwt();
    if (!jwt) return false;
    try {
      const res = await fetch(API_BASE + '/api/admin/session/me', {
        headers: { Authorization: 'Bearer ' + jwt },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return false;
      signedInAsEl.textContent = 'Signed in as ' + (data.email || 'admin');
      return true;
    } catch (_err) {
      return false;
    }
  }

  async function openAuthFlowFromStatus() {
    resetAuthSections();
    showAuthGate();
    try {
      const res = await fetch(API_BASE + '/api/admin/session/status');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        show(blockedSection);
        blockedMessage.textContent =
          data.error ||
          'Cannot reach the admin service. Check your connection.';
        return;
      }

      if (data.needsPasswordSetup) {
        if (!data.setupTokenConfigured) {
          show(blockedSection);
          blockedMessage.textContent =
            'First-time setup is waiting on the server: your IT contact must add ADMIN_SETUP_TOKEN ' +
            'in Railway, redeploy, send you the code, then you can create your password.';
          return;
        }
        show(setupSection);
        setupCodeEl.focus();
        return;
      }

      show(loginSection);
      loginEmailEl.value = '';
      hideNotice(forgotStatusEl);
      hideNotice(resetStatusEl);
      loginPwEl.focus();
    } catch (_err) {
      show(blockedSection);
      blockedMessage.textContent =
        'Network error talking to the API. If you are offline or the server is down, try again when connected.';
    }
  }

  async function init() {
    const resetTok = takeResetTokenFromUrl();
    if (resetTok) {
      clearJwt();
      hide(gateLoading);
      showAuthGate();
      hideNotice(resetStatusEl);
      resetAuthSections();
      show(resetSection);
      resetTokenFieldEl.value = resetTok;
      resetNewPwEl.value = '';
      resetNewPw2El.value = '';
      resetNewPwEl.focus();
      return;
    }

    showGateLoading();
    if (await verifySession()) {
      showPanel();
      await refreshList();
      return;
    }
    clearJwt();
    await openAuthFlowFromStatus();
  }

  function renderRows(rows) {
    listBodyEl.innerHTML = '';
    if (!rows || !rows.length) {
      show(listEmptyEl);
      hide(tableWrapEl);
      return;
    }
    hide(listEmptyEl);
    show(tableWrapEl);

    rows.forEach(function (row) {
      const tr = document.createElement('tr');
      const tdEmail = document.createElement('td');
      tdEmail.setAttribute('data-label', 'Email');
      tdEmail.textContent = row.email;
      const tdNote = document.createElement('td');
      tdNote.setAttribute('data-label', 'Note');
      tdNote.textContent = row.note || '';
      tdNote.className = tdNote.textContent ? '' : 'admin-muted';
      if (!tdNote.textContent) tdNote.textContent = '—';

      const tdRm = document.createElement('td');
      tdRm.className = 'admin-col-action';
      tdRm.setAttribute('data-label', '');
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'admin-remove-btn admin-touch-btn';
      rmBtn.textContent = 'Remove';
      rmBtn.setAttribute('aria-label', 'Remove ' + row.email);
      rmBtn.addEventListener('click', function () {
        if (!window.confirm('Remove ' + row.email + ' from the access list?')) return;
        removeEmail(row.email);
      });
      tdRm.appendChild(rmBtn);

      tr.appendChild(tdEmail);
      tr.appendChild(tdNote);
      tr.appendChild(tdRm);
      listBodyEl.appendChild(tr);
    });
  }

  async function refreshList() {
    hideBanner();
    show(listLoadingEl);
    listLoadingEl.textContent = 'Loading…';
    hide(tableWrapEl);
    hide(listEmptyEl);

    try {
      const res = await fetch(API_BASE + '/api/admin/allowed-emails', {
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      hide(listLoadingEl);

      if (res.status === 401) {
        clearJwt();
        hideNotice(addStatusEl);
        await openAuthFlowFromStatus();
        showNotice(loginStatusEl, 'error', 'Session expired. Sign in again.');
        return;
      }
      if (!res.ok || !data.ok) {
        showBanner('error', data.error || 'Could not load the list.');
        return;
      }
      renderRows(data.emails);
    } catch (_err) {
      hide(listLoadingEl);
      showBanner('error', 'Network error. Check your connection and API URL.');
    }
  }

  async function removeEmail(email) {
    try {
      const res = await fetch(API_BASE + '/api/admin/allowed-emails', {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ email: email }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        clearJwt();
        await openAuthFlowFromStatus();
        return;
      }
      if (!res.ok || !data.ok) {
        window.alert(data.error || 'Could not remove.');
        return;
      }
      await refreshList();
    } catch (_err) {
      window.alert('Network error.');
    }
  }

  async function addEmail() {
    hideNotice(addStatusEl);
    const email = (newEmailEl.value || '').trim().toLowerCase();
    const note = (newNoteEl.value || '').trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showNotice(addStatusEl, 'error', 'Enter a valid email address.');
      return;
    }

    addBtn.disabled = true;
    addBtn.textContent = 'Saving…';

    try {
      const res = await fetch(API_BASE + '/api/admin/allowed-emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ email: email, note: note || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        clearJwt();
        await openAuthFlowFromStatus();
        addBtn.disabled = false;
        addBtn.textContent = 'Save to list';
        return;
      }
      if (!res.ok || !data.ok) {
        showNotice(addStatusEl, 'error', data.error || 'Could not save.');
        addBtn.disabled = false;
        addBtn.textContent = 'Save to list';
        return;
      }
      showNotice(addStatusEl, 'ok', 'Saved.');
      newEmailEl.value = '';
      newNoteEl.value = '';
      await refreshList();
    } catch (_err) {
      showNotice(addStatusEl, 'error', 'Network error.');
    }
    addBtn.disabled = false;
    addBtn.textContent = 'Save to list';
  }

  async function submitSetup() {
    hideNotice(setupStatusEl);
    const code = (setupCodeEl.value || '').trim();
    const pw = setupPwEl.value || '';
    const pw2 = setupPw2El.value || '';

    if (code.length < 8) {
      showNotice(setupStatusEl, 'error', 'Enter the full one-time setup code.');
      return;
    }
    if (pw.length < 10) {
      showNotice(setupStatusEl, 'error', 'Use at least 10 characters for your password.');
      return;
    }
    if (pw !== pw2) {
      showNotice(setupStatusEl, 'error', 'Passwords do not match.');
      return;
    }

    setupSubmit.disabled = true;
    setupSubmit.textContent = 'Saving…';

    try {
      const res = await fetch(API_BASE + '/api/admin/session/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setupToken: code,
          password: pw,
          passwordConfirm: pw2,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showNotice(setupStatusEl, 'error', data.error || 'Could not save password.');
        setupSubmit.disabled = false;
        setupSubmit.textContent = 'Save and continue';
        return;
      }
      setJwt(data.token);
      signedInAsEl.textContent = 'Signed in as ' + (data.email || '');
      setupCodeEl.value = '';
      setupPwEl.value = '';
      setupPw2El.value = '';
      showPanel();
      await refreshList();
    } catch (_err) {
      showNotice(setupStatusEl, 'error', 'Network error.');
    }
    setupSubmit.disabled = false;
    setupSubmit.textContent = 'Save and continue';
  }

  async function submitLogin() {
    hideNotice(loginStatusEl);
    const email = (loginEmailEl.value || '').trim().toLowerCase();
    const pw = loginPwEl.value || '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showNotice(loginStatusEl, 'error', 'Enter a valid email address.');
      return;
    }
    if (!pw) {
      showNotice(loginStatusEl, 'error', 'Enter your password.');
      return;
    }

    loginSubmit.disabled = true;
    loginSubmit.textContent = 'Signing in…';

    try {
      const res = await fetch(API_BASE + '/api/admin/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showNotice(loginStatusEl, 'error', data.error || 'Could not sign in.');
        loginSubmit.disabled = false;
        loginSubmit.textContent = 'Sign in';
        return;
      }
      setJwt(data.token);
      signedInAsEl.textContent = 'Signed in as ' + (data.email || '');
      loginPwEl.value = '';
      showPanel();
      await refreshList();
    } catch (_err) {
      showNotice(loginStatusEl, 'error', 'Network error.');
    }
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Sign in';
  }

  async function submitForgotPassword() {
    hideNotice(forgotStatusEl);
    const email = (forgotEmailEl.value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showNotice(forgotStatusEl, 'error', 'Enter a valid email address.');
      return;
    }
    forgotSubmit.disabled = true;
    forgotSubmit.textContent = 'Sending…';
    try {
      const res = await fetch(API_BASE + '/api/admin/session/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showNotice(forgotStatusEl, 'error', data.error || 'Could not send reset email.');
        forgotSubmit.disabled = false;
        forgotSubmit.textContent = 'Send reset link';
        return;
      }
      showNotice(
        forgotStatusEl,
        'ok',
        data.message ||
          'If this email is registered as an administrator, you will receive a link shortly.',
      );
    } catch (_err) {
      showNotice(forgotStatusEl, 'error', 'Network error.');
    }
    forgotSubmit.disabled = false;
    forgotSubmit.textContent = 'Send reset link';
  }

  async function submitResetPassword() {
    hideNotice(resetStatusEl);
    const token = (resetTokenFieldEl.value || '').trim();
    const pw = resetNewPwEl.value || '';
    const pw2 = resetNewPw2El.value || '';
    if (!token || token.length < 24) {
      showNotice(
        resetStatusEl,
        'error',
        'This reset session is missing or expired. Request a new link from Sign in.',
      );
      return;
    }
    if (pw.length < 10) {
      showNotice(resetStatusEl, 'error', 'Use at least 10 characters.');
      return;
    }
    if (pw !== pw2) {
      showNotice(resetStatusEl, 'error', 'Passwords do not match.');
      return;
    }
    resetSubmit.disabled = true;
    resetSubmit.textContent = 'Saving…';
    try {
      const res = await fetch(API_BASE + '/api/admin/session/complete-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token,
          password: pw,
          passwordConfirm: pw2,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showNotice(resetStatusEl, 'error', data.error || 'Could not reset password.');
        resetSubmit.disabled = false;
        resetSubmit.textContent = 'Save password and continue';
        return;
      }
      setJwt(data.token);
      signedInAsEl.textContent = 'Signed in as ' + (data.email || '');
      resetTokenFieldEl.value = '';
      resetNewPwEl.value = '';
      resetNewPw2El.value = '';
      hide(resetSection);
      showPanel();
      await refreshList();
    } catch (_err) {
      showNotice(resetStatusEl, 'error', 'Network error.');
    }
    resetSubmit.disabled = false;
    resetSubmit.textContent = 'Save password and continue';
  }

  async function submitChangePassword() {
    hideNotice(changePwStatusEl);
    const cur = changeCurrentPwEl.value || '';
    const pw = changeNewPwEl.value || '';
    const pw2 = changeNewPw2El.value || '';
    if (!cur) {
      showNotice(changePwStatusEl, 'error', 'Enter your current password.');
      return;
    }
    if (pw.length < 10) {
      showNotice(changePwStatusEl, 'error', 'Use at least 10 characters for your new password.');
      return;
    }
    if (pw !== pw2) {
      showNotice(changePwStatusEl, 'error', 'New passwords do not match.');
      return;
    }
    changeSubmit.disabled = true;
    changeSubmit.textContent = 'Updating…';
    try {
      const res = await fetch(API_BASE + '/api/admin/session/password', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          currentPassword: cur,
          newPassword: pw,
          newPasswordConfirm: pw2,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        clearJwt();
        hideNotice(changePwStatusEl);
        changeCurrentPwEl.value = '';
        changeNewPwEl.value = '';
        changeNewPw2El.value = '';
        await openAuthFlowFromStatus();
        showNotice(loginStatusEl, 'error', 'Session expired. Sign in again.');
        changeSubmit.disabled = false;
        changeSubmit.textContent = 'Update password';
        return;
      }
      if (!res.ok || !data.ok) {
        showNotice(changePwStatusEl, 'error', data.error || 'Could not update password.');
        changeSubmit.disabled = false;
        changeSubmit.textContent = 'Update password';
        return;
      }
      showNotice(changePwStatusEl, 'ok', 'Password updated. Use it next time you sign in.');
      changeCurrentPwEl.value = '';
      changeNewPwEl.value = '';
      changeNewPw2El.value = '';
    } catch (_err) {
      showNotice(changePwStatusEl, 'error', 'Network error.');
    }
    changeSubmit.disabled = false;
    changeSubmit.textContent = 'Update password';
  }

  lockBtn.addEventListener('click', function () {
    clearJwt();
    hideBanner();
    hideNotice(addStatusEl);
    hideNotice(changePwStatusEl);
    changeCurrentPwEl.value = '';
    changeNewPwEl.value = '';
    changeNewPw2El.value = '';
    openAuthFlowFromStatus();
  });

  loginForgotLink.addEventListener('click', function () {
    hideNotice(loginStatusEl);
    hide(loginSection);
    show(forgotSection);
    forgotEmailEl.value = (loginEmailEl.value || '').trim();
    hideNotice(forgotStatusEl);
    forgotEmailEl.focus();
  });

  forgotBack.addEventListener('click', function () {
    hideNotice(forgotStatusEl);
    hide(forgotSection);
    show(loginSection);
    loginPwEl.focus();
  });

  forgotSubmit.addEventListener('click', submitForgotPassword);

  resetBack.addEventListener('click', async function () {
    hideNotice(resetStatusEl);
    resetTokenFieldEl.value = '';
    resetNewPwEl.value = '';
    resetNewPw2El.value = '';
    hide(resetSection);
    await openAuthFlowFromStatus();
  });

  resetSubmit.addEventListener('click', submitResetPassword);

  changeSubmit.addEventListener('click', submitChangePassword);

  setupSubmit.addEventListener('click', submitSetup);
  loginSubmit.addEventListener('click', submitLogin);

  addBtn.addEventListener('click', addEmail);
  newEmailEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addEmail();
  });

  loginPwEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitLogin();
  });

  init();
})();
