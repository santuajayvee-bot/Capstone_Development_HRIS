/* ============================================================
   Client-side auth: JWT, role guard, sidebar
   Server-side route guards remain authoritative.
   ============================================================ */

const ROLE_PERMISSIONS = {
  admin: ['dashboard', 'system-admin', 'blockchain'],
  system_admin: ['dashboard', 'system-admin', 'blockchain'],
  hr_admin: ['dashboard', 'employees', 'register', 'leave', 'attendance', 'onboarding', '201file', 'employee-profile'],
  hr_manager: ['dashboard', 'employees', 'register', 'leave', 'attendance', 'onboarding', '201file', 'employee-profile'],
  manager: ['dashboard', 'employees', 'register', 'leave', 'attendance', 'onboarding', '201file', 'employee-profile'],
  payroll_officer: ['dashboard', 'payroll', 'reports'],
  payroll_manager: ['dashboard', 'payroll', 'reports'],
  employee: ['dashboard', 'employee-dashboard', 'requests', 'attendance', 'leave', 'employee-profile'],
};

const NAV_CONFIG = {
  admin: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'system-admin', icon: 'SA', label: 'System Admin' },
    { page: 'blockchain', icon: 'BC', label: 'Audit Log' },
  ],
  system_admin: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'system-admin', icon: 'SA', label: 'System Admin' },
    { page: 'blockchain', icon: 'BC', label: 'Audit Log' },
  ],
  hr_admin: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'employees', icon: 'EM', label: 'Employees' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: '201file', icon: '20', label: '201-File' },
    { page: 'onboarding', icon: 'ON', label: 'On-Boarding' },
  ],
  hr_manager: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'employees', icon: 'EM', label: 'Employees' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: '201file', icon: '20', label: '201-File' },
    { page: 'onboarding', icon: 'ON', label: 'On-Boarding' },
  ],
  manager: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'employees', icon: 'EM', label: 'Employees' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: '201file', icon: '20', label: '201-File' },
    { page: 'onboarding', icon: 'ON', label: 'On-Boarding' },
  ],
  payroll_officer: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'payroll', icon: 'PR', label: 'Payroll' },
    { page: 'reports', icon: 'RP', label: 'Payroll Reports' },
  ],
  payroll_manager: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'payroll', icon: 'PR', label: 'Payroll' },
    { page: 'reports', icon: 'RP', label: 'Reports' },
  ],
  employee: [
    { page: 'dashboard', icon: 'DB', label: 'My Dashboard' },
    { page: 'attendance', icon: 'AT', label: 'My Attendance' },
    { page: 'leave', icon: 'LV', label: 'My Leave' },
    { page: 'employee-dashboard', icon: 'PS', label: 'Payslips' },
    { page: 'employee-profile', icon: 'PF', label: 'My Profile' },
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
  const role = normalizeClientRole(user.role);
  const config = NAV_CONFIG[role] || NAV_CONFIG.employee;
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
    badge.textContent = role === 'hr_manager' ? 'HR Manager (Level 2)' : user.roleLabel;
    badge.className = `role-badge role-${role}`;
    badge.style.display = 'inline-block';
  }
  buildEmployeeBottomNav(user);
}

function normalizeClientRole(role) {
  if (role === 'hr_admin' || role === 'manager') return 'hr_manager';
  if (role === 'admin') return 'system_admin';
  return role || 'employee';
}

function buildEmployeeBottomNav(user) {
  const bottomNav = document.getElementById('employee-bottom-nav');
  if (!bottomNav) return;
  if (user.role !== 'employee') {
    bottomNav.innerHTML = '';
    bottomNav.style.display = 'none';
    document.body.classList.remove('has-employee-bottom-nav');
    return;
  }

  const items = [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: 'leave', icon: 'LV', label: 'Leave' },
    { page: 'employee-dashboard', icon: 'PS', label: 'Payslips' },
    { page: 'employee-profile', icon: 'PF', label: 'Profile' },
  ].filter(item => item.page === 'employee-profile' || canAccess(item.page));

  bottomNav.innerHTML = items.map((item, index) => `
    <button type="button"
            class="employee-bottom-nav-item ${index === 0 ? 'active' : ''}"
            data-page="${item.page}"
            onclick="navigate('${item.page}', this)">
      <span>${item.icon}</span>
      <small>${item.label}</small>
    </button>
  `).join('');
  bottomNav.style.display = '';
  document.body.classList.add('has-employee-bottom-nav');
}

function canAccess(pageId) {
  const user = getUser();
  if (!user) return false;
  const role = normalizeClientRole(user.role);
  if (role === 'employee' && pageId === 'employee-profile') return true;
  const allowed = ROLE_PERMISSIONS[role] || [];
  if (allowed.includes(pageId)) return true;

  const permissionPageMap = {
    employees: ['employee.view', 'employee.manage'],
    register: ['employee.manage'],
    'employee-profile': ['employee.view'],
    attendance: ['attendance.view', 'attendance.manage'],
    leave: ['leave.request.create', 'leave.request.approve', 'leave.request.view_all', 'leave.request.view_own'],
    payroll: ['payroll.calculate', 'payroll.settings.manage', 'payroll.approve'],
    reports: ['report.view', 'payroll.report.view', 'leave.report.view'],
    '201file': ['employee.view', 'employee.manage'],
    onboarding: ['employee.manage'],
    'system-admin': ['settings.manage'],
    blockchain: ['settings.manage', 'blockchain.audit.view'],
    'employee-dashboard': ['payroll.view'],
  };
  if (Object.prototype.hasOwnProperty.call(permissionPageMap, pageId)) return false;

  const permissionKeys = permissionPageMap[pageId] || [];
  if (permissionKeys.length && Array.isArray(user.permissions)) {
    return user.permissions.some(permission => permissionKeys.includes(permission));
  }
  return false;
}

function logout() {
  clearAuth();
  closeMobileSidebar();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

function closeMobileSidebar() {
  document.body.classList.remove('mobile-sidebar-open');
  const toggle = document.getElementById('mobile-menu-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function toggleMobileSidebar() {
  const isOpen = document.body.classList.toggle('mobile-sidebar-open');
  const toggle = document.getElementById('mobile-menu-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(isOpen));
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
  document.getElementById('mobile-menu-toggle')?.addEventListener('click', toggleMobileSidebar);
  document.getElementById('mobile-sidebar-backdrop')?.addEventListener('click', closeMobileSidebar);
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
window.closeMobileSidebar = closeMobileSidebar;
window.toggleMobileSidebar = toggleMobileSidebar;
