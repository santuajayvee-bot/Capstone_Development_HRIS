/* ============================================================
   public/js/login.js - Login form
   ============================================================ */

let activeMfaChallenge = null;

function loginError(message, warning = false) {
  const errEl = document.getElementById('login-err');
  if (!errEl) return;
  errEl.textContent = message;
  errEl.className = warning ? 'login-err is-warning' : 'login-err';
  errEl.style.display = 'block';
}

function clearLoginError() {
  const errEl = document.getElementById('login-err');
  if (!errEl) return;
  errEl.className = 'login-err';
  errEl.style.display = 'none';
}

function completeAuthenticatedLogin(data) {
  activeMfaChallenge = null;
  saveAuth(data.accessToken || data.token, data.user);
  buildSidebar(data.user);

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  if (typeof initAttendanceRealtime === 'function') {
    initAttendanceRealtime();
  }

  if (data.mustChangePassword || data.user?.mustChangePassword || data.user?.forcePasswordChange) {
    loginError('Please change your temporary password before continuing.', true);
    if (typeof showToast === 'function') {
      showToast('Please change your temporary password before continuing.', 'error');
    }
    navigate('self-service', null, { forcePasswordChange: true });
    return;
  }

  navigate('dashboard', null);
}

function setLoginStep(mfaRequired) {
  const passwordStep = document.getElementById('login-password-step');
  const mfaStep = document.getElementById('login-mfa-step');
  if (passwordStep) passwordStep.hidden = mfaRequired;
  if (mfaStep) mfaStep.hidden = !mfaRequired;
}

function showMfaStep(data) {
  activeMfaChallenge = {
    challengeId: data.challengeId,
    mfaToken: data.mfaToken,
    codeLength: Number(data.codeLength) || 6,
  };
  document.getElementById('mfa-phone-number').textContent = data.maskedPhoneNumber || '';
  const codeInput = document.getElementById('mfa-code');
  codeInput.value = '';
  codeInput.maxLength = activeMfaChallenge.codeLength;
  setLoginStep(true);
  document.getElementById('mfa-code').focus();
}

function cancelMfaLogin() {
  activeMfaChallenge = null;
  const password = document.getElementById('password');
  if (password) password.value = '';
  setLoginStep(false);
  clearLoginError();
  document.getElementById('username')?.focus();
}

async function verifyMfaCode() {
  const code = document.getElementById('mfa-code')?.value.trim() || '';
  const button = document.getElementById('mfa-verify-btn');
  clearLoginError();

  if (!activeMfaChallenge?.challengeId || !activeMfaChallenge?.mfaToken) {
    cancelMfaLogin();
    loginError('MFA challenge is no longer available. Please sign in again.');
    return;
  }
  if (!new RegExp(`^\\d{${activeMfaChallenge.codeLength}}$`).test(code)) {
    loginError('Enter the verification code sent to your registered mobile number.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Verifying...';
  try {
    const response = await fetch('/api/auth/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...activeMfaChallenge, code }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      loginError(data.message || data.error || 'Invalid verification code.', response.status === 429);
      if ([409, 410, 429].includes(response.status)) activeMfaChallenge = null;
      return;
    }
    completeAuthenticatedLogin(data);
  } catch (_) {
    loginError('Cannot reach the server. Please try again.');
  } finally {
    button.disabled = false;
    button.textContent = 'Verify code';
  }
}

async function resendMfaCode() {
  const button = document.getElementById('mfa-resend-btn');
  clearLoginError();
  if (!activeMfaChallenge?.challengeId || !activeMfaChallenge?.mfaToken) {
    cancelMfaLogin();
    loginError('MFA challenge is no longer available. Please sign in again.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Sending...';
  try {
    const response = await fetch('/api/auth/mfa/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activeMfaChallenge),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      loginError(data.message || data.error || 'Failed to resend MFA code.', response.status === 429);
      return;
    }
    document.getElementById('mfa-phone-number').textContent = data.maskedPhoneNumber || document.getElementById('mfa-phone-number').textContent;
    loginError('A new verification code has been sent.', true);
  } catch (_) {
    loginError('Cannot reach the server. Please try again.');
  } finally {
    button.disabled = false;
    button.textContent = 'Resend code';
  }
}

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const btnEl = document.getElementById('login-submit-btn');

  clearLoginError();

  if (!username || !password) {
    loginError('Please enter username and password.');
    return;
  }

  btnEl.textContent = 'Logging in...';
  btnEl.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      const message = data.message || data.error || 'Login failed.';
      loginError(message, res.status === 423 || Number(data.remaining_attempts || 0) <= 2);
      return;
    }

    if (data.mfaRequired) {
      showMfaStep(data);
      return;
    }

    completeAuthenticatedLogin(data);
  } catch (err) {
    loginError('Cannot reach server. Is it running?');
  } finally {
    btnEl.textContent = 'Login';
    btnEl.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('password')
    .addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('mfa-code')
    .addEventListener('keydown', e => { if (e.key === 'Enter') verifyMfaCode(); });
});

window.doLogin = doLogin;
window.cancelMfaLogin = cancelMfaLogin;
window.resendMfaCode = resendMfaCode;
window.verifyMfaCode = verifyMfaCode;
