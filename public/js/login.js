/* ============================================================
   public/js/login.js — Login form: calls /api/auth/login, stores JWT
   ============================================================ */

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl    = document.getElementById('login-err');
  const btnEl    = document.querySelector('.btn-login');

  errEl.style.display = 'none';

  if (!username || !password) {
    errEl.textContent    = 'Please enter username and password.';
    errEl.style.display  = 'block';
    return;
  }

  // Loading state
  btnEl.textContent = 'Logging in...';
  btnEl.disabled    = true;

  try {
    const res  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      errEl.textContent   = data.error || 'Login failed.';
      errEl.style.display = 'block';
      return;
    }

    // Store JWT + user in sessionStorage
    saveAuth(data.token, data.user);

    // Build sidebar for this role
    buildSidebar(data.user);

    // Show app
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display          = 'block';

    navigate('dashboard', null);

  } catch (err) {
    errEl.textContent   = 'Cannot reach server. Is it running?';
    errEl.style.display = 'block';
  } finally {
    btnEl.textContent = 'Login';
    btnEl.disabled    = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('password')
    .addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
});

window.doLogin = doLogin;
