/* ============================================================
   Client-side auth: JWT, role guard, sidebar
   Server-side route guards remain authoritative.
   ============================================================ */

const ROLE_PERMISSIONS = {
  admin: [
    'dashboard', 'system-admin', 'attendance', 'blockchain', 'self-service',
  ],
  hr_admin: [
    'dashboard', 'employees', 'organization-setup', 'register', 'leave',
    'attendance', 'reports', 'onboarding', 'blockchain', 'employee-profile', 'self-service',
  ],
  hr_manager: [
    'dashboard', 'employees', 'organization-setup', 'register', 'leave',
    'attendance', 'reports', 'onboarding', 'blockchain', 'employee-profile', 'self-service',
  ],
  system_admin: [
    'dashboard', 'system-admin', 'attendance', 'blockchain', 'self-service',
  ],
  payroll_officer: [
    'dashboard', 'attendance', 'leave', 'payroll', 'blockchain', 'self-service',
  ],
  payroll_manager: [
    'dashboard', 'attendance', 'leave', 'payroll', 'reports', 'blockchain', 'self-service',
  ],
  manager: [
    'dashboard', 'attendance', 'leave', 'reports', 'self-service',
  ],
  employee: [
    'employee-dashboard', 'requests', 'attendance', 'leave', 'employee-profile', 'self-service',
  ],
};

const NAV_CONFIG = {
  admin: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'system-admin', icon: 'SA', label: 'System Admin' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: 'blockchain', icon: 'BC', label: 'Blockchain' },
  ],
  hr_admin: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'employees', icon: 'EM', label: 'Employees' },
    { page: 'organization-setup', icon: 'OS', label: 'Organization Setup' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: 'reports', icon: 'RP', label: 'Reports' },
    { page: 'onboarding', icon: 'ON', label: 'On-Boarding' },
    { page: 'blockchain', icon: 'BC', label: 'Blockchain' },
  ],
  hr_manager: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'employees', icon: 'EM', label: 'Employees' },
    { page: 'organization-setup', icon: 'OS', label: 'Organization Setup' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: 'reports', icon: 'RP', label: 'Reports' },
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
    { page: 'blockchain', icon: 'BC', label: 'Blockchain' },
  ],
  payroll_manager: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: 'leave', icon: 'LV', label: 'Leave Management' },
    { page: 'payroll', icon: 'PR', label: 'Payroll' },
    { page: 'reports', icon: 'RP', label: 'Reports' },
    { page: 'blockchain', icon: 'BC', label: 'Blockchain' },
  ],
  manager: [
    { page: 'dashboard', icon: 'DB', label: 'Dashboard' },
    { page: 'attendance', icon: 'AT', label: 'Team Attendance' },
    { page: 'leave', icon: 'LV', label: 'Leave Approvals' },
    { page: 'reports', icon: 'RP', label: 'Reports' },
  ],
  employee: [
    { page: 'employee-dashboard', tab: 'overview', icon: 'DB', label: 'My Dashboard' },
    { page: 'employee-dashboard', tab: 'payslips', icon: 'PS', label: 'My Payslips' },
    { page: 'requests', icon: 'RQ', label: 'My Requests' },
    { page: 'attendance', icon: 'AT', label: 'My Attendance' },
  ],
};

const EMPLOYEE_ALLOWED_PAGES = new Set([
  'employee-dashboard',
  'requests',
  'attendance',
  'leave',
  'self-service',
]);

const PAGE_ROLE_ALLOWLIST = {
  employees: new Set(['hr_admin', 'hr_manager']),
  'employee-profile': new Set(['hr_admin', 'hr_manager']),
  'organization-setup': new Set(['hr_admin', 'hr_manager']),
  register: new Set(['hr_admin', 'hr_manager']),
  onboarding: new Set(['hr_admin', 'hr_manager']),
  attendance: new Set(['admin', 'hr_admin', 'hr_manager', 'system_admin', 'payroll_officer', 'payroll_manager', 'manager', 'employee']),
  payroll: new Set(['payroll_officer', 'payroll_manager']),
  reports: new Set(['hr_admin', 'hr_manager', 'payroll_officer', 'payroll_manager']),
  'system-admin': new Set(['system_admin', 'admin']),
  blockchain: new Set(['system_admin', 'admin', 'hr_admin', 'hr_manager', 'payroll_officer', 'payroll_manager']),
};

const ROLE_ALIASES = {
  administrator: 'system_admin',
  admin: 'admin',
  employee: 'employee',
  regular_employee: 'employee',
  regular: 'employee',
  worker: 'employee',
  hr: 'hr_admin',
  hradmin: 'hr_admin',
  hr_admin: 'hr_admin',
  hr_manager: 'hr_manager',
  manager: 'manager',
  payroll: 'payroll_officer',
  payroll_officer: 'payroll_officer',
  payroll_manager: 'payroll_manager',
  system_admin: 'system_admin',
  sys_admin: 'system_admin',
  it_staff: 'it_staff',
};

function normalizeClientRole(role) {
  const key = String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return ROLE_ALIASES[key] || key || 'employee';
}

function normalizeClientUser(user = null) {
  if (!user) return null;
  return { ...user, role: normalizeClientRole(user.role || user.roleName || user.role_label || user.roleLabel) };
}

function isEmployeeRole(role) {
  return normalizeClientRole(role) === 'employee';
}

function applyUserRoleToDocument(user = null) {
  const role = user ? normalizeClientRole(user.role || user.roleName || user.role_label || user.roleLabel) : '';
  document.body.dataset.userRole = role || '';
  document.body.classList.forEach(className => {
    if (className.startsWith('role-')) document.body.classList.remove(className);
  });
  if (role) document.body.classList.add(`role-${role}`);
}

function saveAuth(token, user) {
  if (typeof resetEmployeeDashboardState === 'function') resetEmployeeDashboardState();
  const normalizedUser = normalizeClientUser(user);
  sessionStorage.setItem('vp_token', token);
  sessionStorage.setItem('vp_user', JSON.stringify(normalizedUser));
  applyUserRoleToDocument(normalizedUser);
}

function getToken() {
  return sessionStorage.getItem('vp_token');
}

function getUser() {
  const raw = sessionStorage.getItem('vp_user');
  if (!raw) return null;
  const user = normalizeClientUser(JSON.parse(raw));
  if (user && raw !== JSON.stringify(user)) {
    sessionStorage.setItem('vp_user', JSON.stringify(user));
  }
  return user;
}

let sidebarAvatarObjectUrl = null;

function userAvatarInitials(user = null) {
  const normalized = normalizeClientUser(user || getUser());
  const profile = normalized?.employeeProfile || {};
  const source = [profile.first_name, profile.last_name].filter(Boolean).join(' ')
    || normalized?.username
    || 'User';
  return source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('') || 'U';
}

async function refreshSidebarAvatar(user = null) {
  const normalized = normalizeClientUser(user || getUser());
  const avatar = document.getElementById('sidebar-user-avatar');
  if (!avatar) return;
  avatar.textContent = userAvatarInitials(normalized);
  const employeeId = Number(normalized?.employeeId || normalized?.Employee_ID || 0);
  if (!employeeId || typeof apiFetch !== 'function') return;

  try {
    const response = await apiFetch(`/api/employees/${employeeId}/photo`);
    if (!response?.ok) return;
    const blob = await response.blob();
    if (sidebarAvatarObjectUrl) URL.revokeObjectURL(sidebarAvatarObjectUrl);
    sidebarAvatarObjectUrl = URL.createObjectURL(blob);
    const image = document.createElement('img');
    image.src = sidebarAvatarObjectUrl;
    image.alt = `${normalized?.username || 'User'} profile picture`;
    avatar.replaceChildren(image);
  } catch (_error) {
    avatar.textContent = userAvatarInitials(normalized);
  }
}

function clearAuth() {
  if (typeof resetEmployeeDashboardState === 'function') resetEmployeeDashboardState();
  if (sidebarAvatarObjectUrl) {
    URL.revokeObjectURL(sidebarAvatarObjectUrl);
    sidebarAvatarObjectUrl = null;
  }
  sessionStorage.removeItem('vp_token');
  sessionStorage.removeItem('vp_user');
  applyUserRoleToDocument(null);
  document.body.classList.remove('has-employee-bottom-nav');
}

function isLoggedIn() {
  return !!getToken();
}

function markPasswordChangeRequired() {
  const user = getUser() || {};
  user.mustChangePassword = true;
  user.forcePasswordChange = true;
  sessionStorage.setItem('vp_user', JSON.stringify(user));
  if (typeof showToast === 'function') {
    showToast('Please change your temporary password before continuing.', 'error');
  }
  if (typeof navigate === 'function') {
    navigate('self-service', null, { forcePasswordChange: true });
  }
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
  if (response.status === 401) {
    console.warn('401 Unauthorized:', url);
    clearAuth();
    if (typeof showLoginRoute === 'function') {
      showLoginRoute(true);
    } else {
      const app = document.getElementById('app');
      const login = document.getElementById('login-screen');
      if (app && login) {
        app.style.display = 'none';
        login.style.display = 'flex';
      }
    }
  }
  if (response.status === 403) {
    const data = await response.clone().json().catch(() => ({}));
    if (data.code === 'PASSWORD_CHANGE_REQUIRED') {
      markPasswordChangeRequired();
    }
  }
  return response;
}

function buildSidebar(user) {
  user = normalizeClientUser(user);
  applyUserRoleToDocument(user);
  const navItems = document.getElementById('nav-items');
  if (!navItems) return;
  const config = NAV_CONFIG[user.role] || NAV_CONFIG.employee;
  navItems.innerHTML = config.map((item, index) => `
    <a href="${typeof routeForPage === 'function' ? routeForPage(item.page, item.tab ? { employeeTab: item.tab } : null) : '#'}"
         class="nav-item ${index === 0 ? 'active' : ''}"
         data-page="${item.page}"
         data-nav-key="${item.tab ? `${item.page}:${item.tab}` : item.page}"
         title="${item.label}"
         onclick="event.preventDefault(); navigate('${item.page}', this, ${item.tab ? `{ employeeTab: '${item.tab}' }` : 'null'})">
      <span class="nav-label">${item.label}</span>
    </a>
  `).join('');

  const name = document.getElementById('sidebar-user-name');
  if (name) name.textContent = user.username;
  const badge = document.getElementById('role-badge');
  if (badge) {
    badge.textContent = user.roleLabel;
    badge.className = `role-badge role-${user.role}`;
    badge.style.display = 'inline-block';
  }
  const profileBtn = document.getElementById('btn-self-profile');
  if (profileBtn) {
    profileBtn.style.display = canAccess('self-service') ? 'inline-flex' : 'none';
  }
  refreshSidebarAvatar(user);
  buildEmployeeBottomNav(user);
}

function buildEmployeeBottomNav(user) {
  user = normalizeClientUser(user);
  const bottomNav = document.getElementById('employee-bottom-nav');
  if (!bottomNav) return;
  if (!isEmployeeRole(user?.role)) {
    bottomNav.innerHTML = '';
    bottomNav.style.display = 'none';
    document.body.classList.remove('has-employee-bottom-nav');
    return;
  }

  const items = [
    { page: 'employee-dashboard', tab: 'overview', icon: 'DB', label: 'Dashboard' },
    { page: 'employee-dashboard', tab: 'payslips', icon: 'PS', label: 'Payslips' },
    { page: 'requests', icon: 'RQ', label: 'Request' },
    { page: 'attendance', icon: 'AT', label: 'Attendance' },
    { page: 'leave', icon: 'LV', label: 'Leave' },
  ].filter(item => canAccess(item.page));

  bottomNav.innerHTML = items.map((item, index) => `
    <a href="${typeof routeForPage === 'function' ? routeForPage(item.page, item.tab ? { employeeTab: item.tab } : null) : '#'}"
            class="employee-bottom-nav-item ${index === 0 ? 'active' : ''}"
            data-page="${item.page}"
            data-nav-key="${item.tab ? `${item.page}:${item.tab}` : item.page}"
            onclick="event.preventDefault(); navigate('${item.page}', this, ${item.tab ? `{ employeeTab: '${item.tab}' }` : 'null'})">
      <span>${item.icon}</span>
      <small>${item.label}</small>
    </a>
  `).join('');
  bottomNav.style.display = '';
  document.body.classList.add('has-employee-bottom-nav');
}

function canAccess(pageId) {
  const user = normalizeClientUser(getUser());
  if (!user) return false;
  if (isEmployeeRole(user.role)) {
    return EMPLOYEE_ALLOWED_PAGES.has(pageId);
  }
  if (PAGE_ROLE_ALLOWLIST[pageId]) {
    return PAGE_ROLE_ALLOWLIST[pageId].has(user.role);
  }
  if (pageId === 'blockchain') {
    return ['system_admin', 'admin', 'payroll_officer', 'payroll_manager'].includes(user.role);
  }
  if (pageId === 'self-service') return true;
  if (pageId === 'requests') return isEmployeeRole(user.role);
  if (pageId === '201file') return false;
  const permissionPageMap = {
    employees: ['employee.view', 'employee.manage'],
    'organization-setup': ['employee.manage', 'settings.manage'],
    register: ['employee.manage'],
    'employee-profile': ['employee.view'],
    'self-service': [],
    attendance: ['attendance.view', 'attendance.manage'],
    leave: ['leave.request.create', 'leave.request.approve', 'leave.request.view_all', 'leave.request.view_own'],
    payroll: ['payroll.view', 'payroll.calculate', 'payroll.settings.manage', 'payroll.approve'],
    reports: ['report.view', 'payroll.report.view', 'leave.report.view'],
    onboarding: ['employee.manage'],
    'system-admin': ['settings.manage'],
    blockchain: ['settings.manage', 'report.view'],
  };
  const permissionKeys = permissionPageMap[pageId] || [];
  const allowed = ROLE_PERMISSIONS[user.role] || [];
  const roleAllowsPage = allowed.includes(pageId);
  if (permissionKeys.length && Array.isArray(user.permissions)) {
    return roleAllowsPage || user.permissions.some(permission => permissionKeys.includes(permission));
  }
  return roleAllowsPage;
}

function logout() {
  if (typeof stopAttendanceAjaxRefresh === 'function') stopAttendanceAjaxRefresh();
  clearAuth();
  closeMobileSidebar();
  if (typeof showLoginRoute === 'function') {
    showLoginRoute(true);
  } else {
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }
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
    if (typeof initAttendanceRealtime === 'function') {
      initAttendanceRealtime();
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
window.markPasswordChangeRequired = markPasswordChangeRequired;
window.apiFetch = apiFetch;
window.buildSidebar = buildSidebar;
window.refreshSidebarAvatar = refreshSidebarAvatar;
window.canAccess = canAccess;
window.logout = logout;
window.closeMobileSidebar = closeMobileSidebar;
window.toggleMobileSidebar = toggleMobileSidebar;
window.applyUserRoleToDocument = applyUserRoleToDocument;
window.normalizeClientRole = normalizeClientRole;
window.isEmployeeRole = isEmployeeRole;
