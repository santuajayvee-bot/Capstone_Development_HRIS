/* ============================================================
   public/js/auth.js — Client-side auth: JWT, role guard, sidebar
   ============================================================ */

// ── Role → permitted pages ────────────────────────────────────
const ROLE_PERMISSIONS = {
  admin: [
    'dashboard', 'employees', 'leave', 'requests',
    'attendance', 'payroll', 'salary-calculation', 'onboarding', 'blockchain', '201file',
  ],
  hr_admin: [
    'dashboard', 'employees', 'leave', 'requests',
    'attendance', 'payroll', 'salary-calculation', 'onboarding', 'blockchain', '201file',
  ],
  system_admin: [
    'dashboard', 'system-admin', 'blockchain',
  ],
  payroll_officer: [
    'dashboard', 'attendance', 'leave', 'payroll', 'salary-calculation', 'requests',
  ],
  payroll_manager: [
    'dashboard', 'attendance', 'leave', 'payroll', 'salary-calculation', 'requests', 'reports',
  ],
  employee: [
    'dashboard', 'requests', 'attendance',
  ],
};

// ── Sidebar nav items per role ────────────────────────────────
const NAV_CONFIG = {
  admin: [
    { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
    { page: 'employees', icon: '👥', label: 'Employees' },
    { page: 'leave', icon: '📅', label: 'Leave Management' },
    { page: 'requests', icon: '📋', label: 'Request' },
    { page: 'attendance', icon: '⏰', label: 'Attendance' },
    { page: '201file', icon: '📄', label: '201-File' },
    { page: 'payroll', icon: '💰', label: 'Payroll' },
    { page: 'salary-calculation', icon: '🧮', label: 'Salary Calc' },
    { page: 'onboarding', icon: '🚀', label: 'On-Boarding' },
    { page: 'blockchain', icon: '🔗', label: 'Blockchain' },
  ],
  hr_admin: [
    { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
    { page: 'employees', icon: '👥', label: 'Employees' },
    { page: 'leave', icon: '📅', label: 'Leave Management' },
    { page: 'requests', icon: '📋', label: 'Request' },
    { page: 'attendance', icon: '⏰', label: 'Attendance' },
    { page: '201file', icon: '📄', label: '201-File' },
    { page: 'payroll', icon: '💰', label: 'Payroll' },
    { page: 'salary-calculation', icon: '🧮', label: 'Salary Calc' },
    { page: 'onboarding', icon: '🚀', label: 'On-Boarding' },
    { page: 'blockchain', icon: '🔗', label: 'Blockchain' },
  ],
  system_admin: [
    { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
    { page: 'system-admin', icon: '🔐', label: 'System Admin' },
    { page: 'blockchain', icon: '🔗', label: 'Audit Log' },
  ],
  payroll_officer: [
    { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
    { page: 'attendance', icon: '⏰', label: 'Attendance' },
    { page: 'leave', icon: '📅', label: 'Leave Management' },
    { page: 'payroll', icon: '💰', label: 'Payroll' },
    { page: 'salary-calculation', icon: '🧮', label: 'Salary Calc' },
    { page: 'requests', icon: '📋', label: 'Request' },
  ],
  payroll_manager: [
    { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
    { page: 'attendance', icon: '⏰', label: 'Attendance' },
    { page: 'leave', icon: '📅', label: 'Leave Management' },
    { page: 'payroll', icon: '💰', label: 'Payroll' },
    { page: 'salary-calculation', icon: '🧮', label: 'Salary Calc' },
    { page: 'reports', icon: '📊', label: 'Reports' },
    { page: 'requests', icon: '📋', label: 'Request' },
  ],
  employee: [
    { page: 'dashboard', icon: '⊞', label: 'My Dashboard' },
    { page: 'requests', icon: '📋', label: 'My Requests' },
    { page: 'attendance', icon: '⏰', label: 'My Attendance' },
  ],
};

// ── Token helpers ─────────────────────────────────────────────
function saveAuth(token, user) {
  sessionStorage.setItem('vp_token', token);
  sessionStorage.setItem('vp_user', JSON.stringify(user));
}

function getToken() {
  return sessionStorage.getItem('vp_token');
}

function getUser() {
  const raw = sessionStorage.getItem('vp_user');
  return raw ? JSON.parse(raw) : null;
}

function clearAuth() {
  sessionStorage.removeItem('vp_token');
  sessionStorage.removeItem('vp_user');
}

function isLoggedIn() {
  return !!getToken();
}

// ── API helper — attaches Bearer token automatically ──────────
async function apiFetch(url, options = {}) {
  const token = getToken();

  // For FormData uploads, don't set Content-Type - let browser handle it
  const isFormData = options.body instanceof FormData;

  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  // Only set Content-Type if not FormData and not already set
  if (!isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    // Token expired or invalid → log it but return response so caller can handle
    console.warn('⚠️ 401 Unauthorized:', url);
    // Optional: show a reconnect prompt or auto-logout after a delay
    // For now, return the response so the caller can handle it
    return res;
  }
  return res;
}

// ── Sidebar builder ───────────────────────────────────────────
function buildSidebar(user) {
  const navItems = document.getElementById('nav-items');
  if (!navItems) return;

  const config = NAV_CONFIG[user.role] || NAV_CONFIG.employee;
  navItems.innerHTML = config.map((item, i) => `
    <div class="nav-item ${i === 0 ? 'active' : ''}"
         data-page="${item.page}"
         onclick="navigate('${item.page}', this)">
      <span class="nav-icon">${item.icon}</span> ${item.label}
    </div>
  `).join('');

  // Update user info in sidebar
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  if (nameEl) nameEl.textContent = user.username;
  if (roleEl) roleEl.textContent = user.roleLabel;

  // Show role badge
  const badgeEl = document.getElementById('role-badge');
  if (badgeEl) {
    badgeEl.textContent = user.roleLabel;
    badgeEl.className = `role-badge role-${user.role}`;
    badgeEl.style.display = 'inline-block';
  }
}

// ── Route guard ───────────────────────────────────────────────
function canAccess(pageId) {
  const user = getUser();
  if (!user) return false;
  const allowed = ROLE_PERMISSIONS[user.role] || [];
  return allowed.includes(pageId);
}

// ── Logout ────────────────────────────────────────────────────
function logout() {
  clearAuth();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

// ── On page load — restore session if token exists ───────────
document.addEventListener('DOMContentLoaded', () => {
  if (isLoggedIn()) {
    const user = getUser();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    buildSidebar(user);
  }

  // Wire logout button
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
});

// Expose globally
window.saveAuth = saveAuth;
window.getToken = getToken;
window.getUser = getUser;
window.clearAuth = clearAuth;
window.isLoggedIn = isLoggedIn;
window.apiFetch = apiFetch;
window.buildSidebar = buildSidebar;
window.canAccess = canAccess;
window.logout = logout;
