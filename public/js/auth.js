/* ============================================================
   Client-side auth: JWT, role guard, sidebar
   Server-side route guards remain authoritative.
   ============================================================ */

const ROLE_PERMISSIONS = {
  admin: [
    'dashboard', 'employees', 'register', 'leave', 'requests',
    'attendance', 'payroll', 'onboarding', 'blockchain', '201file', 'employee-profile',
  ],
  hr_admin: [
    'dashboard', 'employees', 'register', 'leave', 'requests',
    'attendance', 'payroll', 'onboarding', 'blockchain', '201file', 'employee-profile',
  ],
  system_admin: [
    'dashboard', 'system-admin', 'attendance', 'blockchain',
  ],
  payroll_officer: [
    'dashboard', 'attendance', 'leave', 'payroll', 'requests', 'blockchain',
  ],
  payroll_manager: [
    'dashboard', 'attendance', 'leave', 'payroll', 'requests', 'reports', 'blockchain',
  ],
  manager: [
    'dashboard', 'attendance', 'leave', 'requests', 'reports',
  ],
  employee: [
    'dashboard', 'requests', 'attendance', 'leave', 'payroll', 'employee-profile',
  ],
};

const NAV_CONFIG = {
  admin: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'employees', icon: 'EM', label: 'Employees' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'requests', icon: 'RQ', label: 'Request' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: '201file', icon: '20', label: '201-File' },
    { page: 'payroll', icon: 'PR', label: 'Payroll' },
    { page: 'onboarding', icon: 'ON', label: 'On-Boarding' },
    { page: 'blockchain', icon: 'BC', label: 'Blockchain' },
  ],
  hr_admin: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'employees', icon: 'EM', label: 'Employees' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'requests', icon: 'RQ', label: 'Request' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: '201file', icon: '20', label: '201-File' },
    { page: 'payroll', icon: 'PR', label: 'Payroll' },
    { page: 'onboarding', icon: 'ON', label: 'On-Boarding' },
    { page: 'blockchain', icon: 'BC', label: 'Blockchain' },
  ],
  system_admin: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'system-admin', icon: 'SA', label: 'System Admin' },
    { page: 'attendance', icon: 'AT', label: 'Attendance Sync' },
    { page: 'blockchain', icon: 'BC', label: 'Audit Log' },
  ],
  payroll_officer: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'payroll', icon: 'PR', label: 'Payroll' },
    { page: 'requests', icon: 'RQ', label: 'Request' },
    { page: 'blockchain', icon: 'BC', label: 'Blockchain' },
  ],
  payroll_manager: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'payroll', icon: 'PR', label: 'Payroll' },
    { page: 'reports', icon: 'RP', label: 'Reports' },
    { page: 'requests', icon: 'RQ', label: 'Request' },
    { page: 'blockchain', icon: 'BC', label: 'Blockchain' },
  ],
  manager: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'attendance', icon: 'AT', label: 'Team Attendance' },
    { page: 'leave', icon: 'LV', label: 'Leave Approvals' },
    { page: 'reports', icon: 'RP', label: 'Reports' },
    { page: 'requests', icon: 'RQ', label: 'Request' },
  ],
  employee: [
    { page: 'dashboard', icon: 'DB', label: 'My Dashboard' },
    { page: 'requests', icon: 'RQ', label: 'My Requests' },
    { page: 'attendance', icon: 'AT', label: 'My Attendance' },
  ],
};

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

async function apiFetch(url, options = {}) {
  const token = getToken();
  const isFormData = options.body instanceof FormData;
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  if (!isFormData && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) console.warn('401 Unauthorized:', url);
  return response;
}

function buildSidebar(user) {
  const navItems = document.getElementById('nav-items');
  if (!navItems) return;
  const config = NAV_CONFIG[user.role] || NAV_CONFIG.employee;
  navItems.innerHTML = config.map((item, index) => `
    <div class="nav-item ${index === 0 ? 'active' : ''}"
         data-page="${item.page}"
         onclick="navigate('${item.page}', this)">
      <span class="nav-icon">${item.icon}</span> ${item.label}
    </div>
  `).join('');

  const name = document.getElementById('sidebar-user-name');
  if (name) name.textContent = user.username;
  const badge = document.getElementById('role-badge');
  if (badge) {
    badge.textContent = user.roleLabel;
    badge.className = `role-badge role-${user.role}`;
    badge.style.display = 'inline-block';
  }
}

function canAccess(pageId) {
  const user = getUser();
  if (!user) return false;
  const permissionPageMap = {
    employees: ['employee.view', 'employee.manage'],
    register: ['employee.manage'],
    'employee-profile': ['employee.view'],
    attendance: ['attendance.view', 'attendance.manage'],
    leave: ['leave.request.create', 'leave.request.approve', 'leave.request.view_all', 'leave.request.view_own'],
    payroll: ['payroll.view', 'payroll.calculate', 'payroll.approve'],
    reports: ['report.view', 'payroll.report.view', 'leave.report.view'],
    '201file': ['employee.view', 'employee.manage'],
    onboarding: ['employee.manage'],
    'system-admin': ['settings.manage'],
    blockchain: ['settings.manage', 'report.view'],
  };
  const permissionKeys = permissionPageMap[pageId] || [];
  if (permissionKeys.length && Array.isArray(user.permissions)) {
    return user.permissions.some(permission => permissionKeys.includes(permission));
  }
  const allowed = ROLE_PERMISSIONS[user.role] || [];
  return allowed.includes(pageId);
}

function logout() {
  clearAuth();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', () => {
  if (isLoggedIn()) {
    const user = getUser();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    buildSidebar(user);
    if (typeof loadDashboard === 'function') {
      loadDashboard();
    }
  }
  document.getElementById('btn-logout')?.addEventListener('click', logout);
});

window.saveAuth = saveAuth;
window.getToken = getToken;
window.getUser = getUser;
window.clearAuth = clearAuth;
window.isLoggedIn = isLoggedIn;
window.apiFetch = apiFetch;
window.buildSidebar = buildSidebar;
window.canAccess = canAccess;
window.logout = logout;
