/* ============================================================
   public/js/login.js - Login form
   ============================================================ */

let lockoutCountdownTimer = null;
let lockoutPollTimer = null;
let activeLockoutState = null;

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

function completeAuthenticatedLogin(data) {
  stopLockoutCountdown();

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

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const btnEl = document.querySelector('.btn-login');

  stopLockoutCountdown();
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
      if (res.status === 423) {
        startLockoutCountdown(username, data);
        return;
      }

      const message = formatLoginFailureMessage(data, res.status);
      loginError(message, res.status === 423 || Number(data.remaining_attempts || 0) <= 2);
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
});

window.doLogin = doLogin;
