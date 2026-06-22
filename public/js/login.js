/* ============================================================
   public/js/login.js - Login form
   ============================================================ */

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

function formatLoginFailureMessage(data, status) {
  if (status === 423) {
    return data?.message || 'Account temporarily locked. Please try again later or contact your administrator.';
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

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const btnEl = document.querySelector('.btn-login');

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
