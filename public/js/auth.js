/* ============================================================
   public/js/auth.js — Client-side auth: JWT, role guard, sidebar
   ============================================================ */

// ── Role → permitted pages ────────────────────────────────────
// These keys must match the 'name' column in the 'roles' table.
const ROLE_PERMISSIONS = {
  admin: [
    'dashboard', 'employees', 'leave', 'requests', 'onboarding',
    'attendance', 'payroll', 'salary-calculation', 'blockchain', '201file',
  ],
  payroll_officer: [ // This is the 'HR Admin' in the database (role_id 2)
    'dashboard', 'employees', 'leave', 'requests', 'onboarding',
    'attendance', 'payroll', 'salary-calculation', 'blockchain', '201file',
  ],
  payroll_manager: [
    'dashboard', 'attendance', 'leave', 'payroll', 'salary-calculation', 'requests', 'reports',
  ],
  employee: [
    'dashboard', 'leave', 'requests', 'attendance',
  ],
};

// ── Sidebar nav items per role ────────────────────────────────
const NAV_CONFIG = {
  admin: [
    { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
    { page: 'employees', icon: '👥', label: 'Employees' },
    { page: 'leave', icon: '📅', label: 'Leave Management' },
    { page: 'requests', icon: '📋', label: 'Request' },
    { page: 'onboarding', icon: '🚀', label: 'Onboarding' },
    { page: 'attendance', icon: '⏰', label: 'Attendance' },
    { page: '201file', icon: '📄', label: '201-File' },
    { page: 'payroll', icon: '💰', label: 'Payroll' },
    { page: 'salary-calculation', icon: '🧮', label: 'Salary Calc' },
    { page: 'blockchain', icon: '🔗', label: 'Blockchain' },
  ],
  payroll_officer: [ // This is the 'HR Admin' in the database (role_id 2)
    { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
    { page: 'employees', icon: '👥', label: 'Employees' },
    { page: 'leave', icon: '📅', label: 'Leave Management' },
    { page: 'requests', icon: '📋', label: 'Request' },
    { page: 'onboarding', icon: '🚀', label: 'Onboarding' },
    { page: 'attendance', icon: '⏰', label: 'Attendance' },
    { page: '201file', icon: '📄', label: '201-File' },
    { page: 'payroll', icon: '💰', label: 'Payroll' },
    { page: 'salary-calculation', icon: '🧮', label: 'Salary Calc' },
    { page: 'blockchain', icon: '🔗', label: 'Blockchain' },
  ],
  payroll_manager: [
    { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
    { page: 'attendance', icon: '⏰', label: 'Attendance' },
    { page: 'leave', icon: '📅', label: 'Leave Management' },
    { page: 'payroll', icon: '💰', label: 'Payroll' },
    { page: 'salary-calculation', icon: '🧮', label: 'Salary Calc' },
    { page: 'requests', icon: '📋', label: 'Request' },
    { page: 'reports', icon: '📊', label: 'Generate Reports' },
  ],
  employee: [
    { page: 'dashboard', icon: '⊞', label: 'My Dashboard' },
    { page: 'leave', icon: '📅', label: 'My Leave' },
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
    // Token expired or invalid → force logout
    logout();
    return null;
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
