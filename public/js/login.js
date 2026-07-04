/* ============================================================
   public/js/login.js - Login form
   ============================================================ */

let lockoutCountdownTimer = null;
let lockoutPollTimer = null;
let activeLockoutState = null;
let recaptchaWidgetId = null;
let recaptchaRequired = false;
let recaptchaLoadPromise = null;

function resetLoginCaptcha() {
  if (recaptchaWidgetId !== null && window.grecaptcha) {
    window.grecaptcha.reset(recaptchaWidgetId);
  }
}

function loadGoogleRecaptcha(siteKey) {
  if (recaptchaLoadPromise) return recaptchaLoadPromise;
  recaptchaLoadPromise = new Promise((resolve, reject) => {
    window.onLgsvRecaptchaLoaded = () => {
      const container = document.getElementById('login-recaptcha-widget');
      if (!container || !window.grecaptcha) return reject(new Error('CAPTCHA widget unavailable.'));
      recaptchaWidgetId = window.grecaptcha.render(container, { sitekey: siteKey });
      resolve(recaptchaWidgetId);
    };
    const script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?onload=onLgsvRecaptchaLoaded&render=explicit';
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error('CAPTCHA provider unavailable.'));
    document.head.appendChild(script);
  });
  return recaptchaLoadPromise;
}

async function initializeLoginCaptcha() {
  const container = document.getElementById('login-captcha');
  try {
    const response = await fetch('/api/auth/captcha-config', { cache: 'no-store' });
    const config = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(config.message || 'CAPTCHA configuration unavailable.');
    recaptchaRequired = config.enabled === true;
    if (!recaptchaRequired) {
      if (container) container.hidden = true;
      return;
    }
    if (container) container.hidden = false;
    await loadGoogleRecaptcha(config.siteKey);
  } catch (_) {
    recaptchaRequired = true;
    if (container) container.hidden = false;
    loginError('Human verification is temporarily unavailable. Please refresh the page.');
  }
}

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

function formatLockoutDuration(seconds) {
  const total = Math.max(Number(seconds || 0), 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  if (minutes > 0 && remainingSeconds > 0) return `${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m`;
  return `${remainingSeconds}s`;
}

function formatLoginFailureMessage(data, status) {
  if (status === 423) {
    const duration = formatLockoutDuration(data?.lock_seconds_remaining);
    const message = data?.message || 'Account temporarily locked. Please try again later or contact your administrator.';
    return duration ? `${message} Try again in ${duration}.` : message;
  }

  const baseMessage = data?.message || data?.error || 'Login failed.';
  const remaining = Number(data?.remaining_attempts);
  if (Number.isFinite(remaining) && remaining > 0) {
    return `${baseMessage} ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before account lockout.`;
  }
  if (Number.isFinite(remaining) && remaining <= 0) {
    return 'Account temporarily locked. Please try again later or contact your administrator.';
  }
  return baseMessage;
}

function stopLockoutCountdown() {
  if (lockoutCountdownTimer) {
    clearInterval(lockoutCountdownTimer);
    lockoutCountdownTimer = null;
  }
  if (lockoutPollTimer) {
    clearInterval(lockoutPollTimer);
    lockoutPollTimer = null;
  }
  activeLockoutState = null;
}

function renderLockoutCountdown() {
  if (!activeLockoutState) return;

  const seconds = Math.max(Number(activeLockoutState.seconds || 0), 0);
  if (seconds <= 0) {
    stopLockoutCountdown();
    loginError('Account lockout expired. You may try logging in again.', true);
    return;
  }

  const duration = formatLockoutDuration(seconds);
  const message = activeLockoutState.message || 'Account temporarily locked. Please try again later.';
  loginError(`${message} Try again in ${duration}.`, true);
}

async function refreshLockoutStatus() {
  if (!activeLockoutState?.username) return;

  try {
    const res = await fetch(`/api/auth/lockout-status?username=${encodeURIComponent(activeLockoutState.username)}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await res.json();

    if (!res.ok || !data.locked) {
      stopLockoutCountdown();
      loginError('Account lockout expired. You may try logging in again.', true);
      return;
    }

    activeLockoutState.seconds = Number(data.lock_seconds_remaining || activeLockoutState.seconds || 0);
    renderLockoutCountdown();
  } catch (error) {
    // Keep the local countdown moving if the status poll temporarily fails.
  }
}

function startLockoutCountdown(username, data) {
  const seconds = Number(data?.lock_seconds_remaining || 0);
  const message = data?.message || 'Account temporarily locked. Please try again later.';

  stopLockoutCountdown();

  if (!Number.isFinite(seconds) || seconds <= 0) {
    loginError(message, true);
    return;
  }

  activeLockoutState = {
    username,
    message,
    seconds,
  };

  renderLockoutCountdown();

  lockoutCountdownTimer = setInterval(() => {
    if (!activeLockoutState) return;
    activeLockoutState.seconds = Math.max(Number(activeLockoutState.seconds || 0) - 1, 0);
    renderLockoutCountdown();
  }, 1000);

  lockoutPollTimer = setInterval(refreshLockoutStatus, 5000);
}

function continueAuthenticatedNavigation(data) {
  if (data.mustChangePassword || data.user?.mustChangePassword || data.user?.forcePasswordChange) {
    loginError('Please change your temporary password before continuing.', true);
    if (typeof showToast === 'function') {
      showToast('Please change your temporary password before continuing.', 'error');
    }
    navigate('self-service', null, { forcePasswordChange: true });
    return;
  }

  const pendingRoute = sessionStorage.getItem('vp_pending_route');
  if (pendingRoute && typeof resolveAppRoute === 'function' && typeof handleAppRoute === 'function') {
    sessionStorage.removeItem('vp_pending_route');
    const route = resolveAppRoute(pendingRoute);
    if (route?.page && typeof canAccess === 'function' && canAccess(route.page)) {
      window.history.replaceState({ path: pendingRoute }, '', pendingRoute);
      handleAppRoute({ replace: true });
      return;
    }
  }

  if (data.user?.role === 'employee') {
    navigate('employee-dashboard', null, { employeeTab: 'overview' });
  } else {
    navigate('dashboard', null);
  }
}

async function completeAuthenticatedLogin(data, options = {}) {
  stopLockoutCountdown();

  saveAuth(data.accessToken || data.token, data.user);

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  if (!options.skipDpaGate && typeof requiresDpaGate === 'function' && requiresDpaGate(data.user)) {
    if (typeof showDpaAgreementGate === 'function') {
      showDpaAgreementGate({
        afterAccept: () => {
          const acceptedUser = typeof getUser === 'function' ? getUser() : data.user;
          completeAuthenticatedLogin({ ...data, user: acceptedUser }, { skipDpaGate: true });
        },
      });
      return;
    }
  }

  buildSidebar(data.user);

  if (typeof initAttendanceRealtime === 'function') {
    initAttendanceRealtime();
  }

  continueAuthenticatedNavigation(data);
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
  const enrollment = document.getElementById('mfa-enrollment');
  const qrCode = document.getElementById('mfa-qr-code');
  const detail = document.getElementById('mfa-detail');
  const message = document.getElementById('mfa-message');
  const resendButton = document.getElementById('mfa-resend-btn');

  if (data.enrollmentRequired) {
    if (message) message.textContent = 'Scan this QR code with Google Authenticator or Microsoft Authenticator, then enter the 6-digit code.';
    if (qrCode) qrCode.src = data.qrCodeDataUrl || '';
    if (enrollment) enrollment.hidden = false;
    if (detail) detail.textContent = data.accountName ? `Account: ${data.accountName}` : '';
  } else {
    if (message) message.textContent = 'Enter the 6-digit code from your authenticator app.';
    if (qrCode) qrCode.removeAttribute('src');
    if (enrollment) enrollment.hidden = true;
    if (detail) detail.textContent = 'Codes refresh automatically every 30 seconds.';
  }

  if (resendButton) resendButton.hidden = true;
  updateMfaDevelopmentCode(null);
  const codeInput = document.getElementById('mfa-code');
  codeInput.value = '';
  codeInput.maxLength = activeMfaChallenge.codeLength;
  setLoginStep(true);
  document.getElementById('mfa-code').focus();
}

function updateMfaDevelopmentCode(mockCode) {
  const devCode = document.getElementById('mfa-dev-code');
  if (!devCode) return;
  if (mockCode) {
    devCode.hidden = false;
    devCode.textContent = `Development OTP: ${mockCode}`;
  } else {
    devCode.hidden = true;
    devCode.textContent = '';
  }
}

function cancelMfaLogin() {
  activeMfaChallenge = null;
  const password = document.getElementById('password');
  if (password) password.value = '';
  const enrollment = document.getElementById('mfa-enrollment');
  const qrCode = document.getElementById('mfa-qr-code');
  const detail = document.getElementById('mfa-detail');
  if (enrollment) enrollment.hidden = true;
  if (qrCode) qrCode.removeAttribute('src');
  if (detail) detail.textContent = '';
  updateMfaDevelopmentCode(null);
  setLoginStep(false);
  clearLoginError();
  resetLoginCaptcha();
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
    loginError('Enter the verification code from your authenticator app.');
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
    await completeAuthenticatedLogin(data);
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
    updateMfaDevelopmentCode(null);
    loginError(data.message || 'Authenticator app codes refresh automatically every 30 seconds.', true);
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

  stopLockoutCountdown();
  clearLoginError();

  if (!username || !password) {
    loginError('Please enter username and password.');
    return;
  }

  const captchaToken = recaptchaRequired && recaptchaWidgetId !== null && window.grecaptcha
    ? window.grecaptcha.getResponse(recaptchaWidgetId)
    : '';
  if (recaptchaRequired && !captchaToken) {
    loginError('Complete the human verification before signing in.');
    return;
  }

  btnEl.textContent = 'Logging in...';
  btnEl.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, captchaToken }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 423) {
        resetLoginCaptcha();
        startLockoutCountdown(username, data);
        return;
      }

      const message = formatLoginFailureMessage(data, res.status);
      loginError(message, res.status === 423 || Number(data.remaining_attempts || 0) <= 2);
      resetLoginCaptcha();
      return;
    }

    if (data.mfaRequired) {
      showMfaStep(data);
      return;
    }

    await completeAuthenticatedLogin(data);
  } catch (err) {
    resetLoginCaptcha();
    loginError('Cannot reach server. Is it running?');
  } finally {
    btnEl.textContent = 'Login';
    btnEl.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const passwordInput = document.getElementById('password');
  const passwordToggle = document.getElementById('mobile-password-toggle');
  passwordInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  passwordToggle?.addEventListener('click', () => {
    const isHidden = passwordInput?.type === 'password';
    if (!passwordInput) return;
    passwordInput.type = isHidden ? 'text' : 'password';
    passwordToggle.setAttribute('aria-pressed', String(isHidden));
    passwordToggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    passwordToggle.textContent = isHidden ? '⊘' : '⌾';
  });
  document.getElementById('mfa-code')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') verifyMfaCode(); });
  initializeLoginCaptcha();
});

window.doLogin = doLogin;
window.cancelMfaLogin = cancelMfaLogin;
window.resendMfaCode = resendMfaCode;
window.verifyMfaCode = verifyMfaCode;
window.resetLoginCaptcha = resetLoginCaptcha;
