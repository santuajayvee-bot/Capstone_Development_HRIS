/* ============================================================
   public/js/login.js - Login form with Cloudflare Turnstile
   ============================================================ */

let LOGIN_TURNSTILE_WIDGET_ID = null;
let LOGIN_TURNSTILE_TOKEN = '';
let LOGIN_TURNSTILE_CONFIG = null;
let LOGIN_MFA_TOKEN = '';
let LOGIN_MFA_COOLDOWN_TIMER = null;

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

function setLoginButtonState() {
  const btnEl = document.querySelector('.btn-login');
  if (!btnEl) return;
  const turnstileRequired = Boolean(LOGIN_TURNSTILE_CONFIG?.enabled);
  btnEl.disabled = turnstileRequired && !LOGIN_TURNSTILE_TOKEN;
}

function resetLoginTurnstile() {
  LOGIN_TURNSTILE_TOKEN = '';
  if (window.turnstile && LOGIN_TURNSTILE_WIDGET_ID !== null) {
    window.turnstile.reset(LOGIN_TURNSTILE_WIDGET_ID);
  }
  setLoginButtonState();
}

function completeAuthenticatedLogin(data) {
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

function setMfaStepVisible(visible) {
  const passwordStep = document.getElementById('login-password-step');
  const mfaStep = document.getElementById('login-mfa-step');
  if (passwordStep) passwordStep.style.display = visible ? 'none' : 'block';
  if (mfaStep) mfaStep.style.display = visible ? 'block' : 'none';
}

function startMfaCooldown(seconds) {
  const resendButton = document.getElementById('btn-mfa-resend');
  if (!resendButton) return;

  let remaining = Number(seconds || 0);
  clearInterval(LOGIN_MFA_COOLDOWN_TIMER);

  const render = () => {
    if (remaining > 0) {
      resendButton.disabled = true;
      resendButton.textContent = `Resend code (${remaining}s)`;
      remaining -= 1;
    } else {
      resendButton.disabled = false;
      resendButton.textContent = 'Resend code';
      clearInterval(LOGIN_MFA_COOLDOWN_TIMER);
      LOGIN_MFA_COOLDOWN_TIMER = null;
    }
  };

  render();
  LOGIN_MFA_COOLDOWN_TIMER = setInterval(render, 1000);
}

function showMfaStep(data) {
  LOGIN_MFA_TOKEN = data.mfaToken || '';
  LOGIN_TURNSTILE_TOKEN = '';
  setMfaStepVisible(true);
  document.getElementById('mfa-code')?.focus();
  loginError(data.message || 'Verification code sent.', true);
  startMfaCooldown(data.resendCooldownSeconds || 60);
}

function cancelSmsMfa() {
  LOGIN_MFA_TOKEN = '';
  document.getElementById('mfa-code').value = '';
  setMfaStepVisible(false);
  clearLoginError();
  resetLoginTurnstile();
}

async function loadTurnstileConfig() {
  const response = await fetch('/api/auth/turnstile/config');
  if (!response.ok) throw new Error('Turnstile configuration could not be loaded.');
  LOGIN_TURNSTILE_CONFIG = await response.json();
  return LOGIN_TURNSTILE_CONFIG;
}

async function renderLoginTurnstile() {
  const target = document.getElementById('login-turnstile');
  if (!target || LOGIN_TURNSTILE_WIDGET_ID !== null || !window.turnstile) return;

  const config = LOGIN_TURNSTILE_CONFIG || await loadTurnstileConfig();
  if (config.localDevelopmentBypass) {
    target.innerHTML = '<div class="login-turnstile-local-note">Local development verification is enabled.</div>';
    LOGIN_TURNSTILE_TOKEN = 'local-development-bypass';
    setLoginButtonState();
    return;
  }
  if (!config.enabled || !config.siteKey) {
    loginError('Verification is not configured. Please contact your administrator.', true);
    setLoginButtonState();
    return;
  }

  LOGIN_TURNSTILE_WIDGET_ID = window.turnstile.render(target, {
    sitekey: config.siteKey,
    theme: 'light',
    callback: token => {
      LOGIN_TURNSTILE_TOKEN = token || '';
      clearLoginError();
      setLoginButtonState();
    },
    'expired-callback': () => {
      LOGIN_TURNSTILE_TOKEN = '';
      loginError('Verification expired. Please try again.', true);
      setLoginButtonState();
    },
    'error-callback': () => {
      LOGIN_TURNSTILE_TOKEN = '';
      loginError('Verification failed. Please try again.', true);
      setLoginButtonState();
    },
  });

  setLoginButtonState();
}

async function initLoginTurnstile() {
  try {
    await loadTurnstileConfig();
    if (window.turnstile) await renderLoginTurnstile();
    setLoginButtonState();
  } catch (error) {
    loginError('Verification could not be loaded. Please refresh the page.', true);
    const btnEl = document.querySelector('.btn-login');
    if (btnEl) btnEl.disabled = true;
  }
}

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const btnEl = document.querySelector('.btn-login');

  clearLoginError();

  if (!username || !password) {
    loginError('Please enter username and password.');
    return;
  }

  if (LOGIN_TURNSTILE_CONFIG?.enabled && !LOGIN_TURNSTILE_TOKEN) {
    loginError('Please complete verification before logging in.', true);
    return;
  }

  btnEl.textContent = 'Logging in...';
  btnEl.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        turnstileToken: LOGIN_TURNSTILE_TOKEN,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      const message = data.message || data.error || 'Login failed.';
      loginError(
        message,
        res.status === 423 || res.status === 400 || Number(data.remaining_attempts || 0) <= 2
      );
      resetLoginTurnstile();
      return;
    }

    if (data.mfaRequired) {
      showMfaStep(data);
      return;
    }

    completeAuthenticatedLogin(data);
  } catch (err) {
    loginError('Cannot reach server. Is it running?');
    resetLoginTurnstile();
  } finally {
    btnEl.textContent = 'Login';
    setLoginButtonState();
  }
}

async function verifySmsMfa() {
  const code = document.getElementById('mfa-code').value.trim();
  const btnEl = document.getElementById('btn-mfa-verify');

  clearLoginError();

  if (!LOGIN_MFA_TOKEN || !code) {
    loginError('Please enter the verification code.', true);
    return;
  }

  btnEl.textContent = 'Verifying...';
  btnEl.disabled = true;

  try {
    const res = await fetch('/api/auth/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken: LOGIN_MFA_TOKEN, otpCode: code }),
    });
    const data = await res.json();

    if (!res.ok) {
      loginError(data.message || 'Invalid verification code.', true);
      return;
    }

    LOGIN_MFA_TOKEN = '';
    completeAuthenticatedLogin(data);
  } catch (error) {
    loginError('Cannot reach server. Is it running?');
  } finally {
    btnEl.textContent = 'Verify code';
    btnEl.disabled = false;
  }
}

async function resendSmsMfa() {
  if (!LOGIN_MFA_TOKEN) {
    loginError('Please start login again.', true);
    return;
  }

  try {
    const res = await fetch('/api/auth/mfa/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken: LOGIN_MFA_TOKEN }),
    });
    const data = await res.json();

    if (!res.ok) {
      loginError(data.message || 'Could not resend verification code.', true);
      if (data.retryAfterSeconds) startMfaCooldown(data.retryAfterSeconds);
      return;
    }

    loginError(data.message || 'Verification code sent.', true);
    startMfaCooldown(data.resendCooldownSeconds || 60);
  } catch (error) {
    loginError('Cannot reach server. Is it running?');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('password')
    .addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('mfa-code')
    .addEventListener('keydown', e => { if (e.key === 'Enter') verifySmsMfa(); });
  initLoginTurnstile();
});

window.onTurnstileScriptLoaded = () => {
  renderLoginTurnstile();
};
window.doLogin = doLogin;
window.verifySmsMfa = verifySmsMfa;
window.resendSmsMfa = resendSmsMfa;
window.cancelSmsMfa = cancelSmsMfa;
