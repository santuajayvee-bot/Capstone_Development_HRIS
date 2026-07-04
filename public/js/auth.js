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
    { page: 'dashboard', icon: 'bi-speedometer2', label: 'Dashboard' },
    { page: 'system-admin', icon: 'bi-gear', label: 'System Admin' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'Attendance' },
    { page: 'blockchain', icon: 'bi-shield-check', label: 'Blockchain' },
  ],
  hr_admin: [
    { page: 'dashboard', icon: 'bi-speedometer2', label: 'Dashboard' },
    { page: 'employees', icon: 'bi-people', label: 'Employees' },
    { page: 'organization-setup', icon: 'bi-diagram-3', label: 'Organization Setup' },
    { page: 'leave', icon: 'bi-calendar-check', label: 'Leave Management' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'Attendance' },
    { page: 'reports', icon: 'bi-file-earmark-bar-graph', label: 'Reports' },
    { page: 'onboarding', icon: 'bi-person-plus', label: 'On-Boarding' },
    { page: 'blockchain', icon: 'bi-shield-check', label: 'Blockchain' },
  ],
  hr_manager: [
    { page: 'dashboard', icon: 'bi-speedometer2', label: 'Dashboard' },
    { page: 'employees', icon: 'bi-people', label: 'Employees' },
    { page: 'organization-setup', icon: 'bi-diagram-3', label: 'Organization Setup' },
    { page: 'leave', icon: 'bi-calendar-check', label: 'Leave Management' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'Attendance' },
    { page: 'reports', icon: 'bi-file-earmark-bar-graph', label: 'Reports' },
    { page: 'onboarding', icon: 'bi-person-plus', label: 'On-Boarding' },
    { page: 'blockchain', icon: 'bi-shield-check', label: 'Blockchain' },
  ],
  system_admin: [
    { page: 'dashboard', icon: 'bi-speedometer2', label: 'Dashboard' },
    { page: 'system-admin', icon: 'bi-gear', label: 'System Admin' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'Attendance Sync' },
    { page: 'blockchain', icon: 'bi-shield-check', label: 'Blockchain' },
  ],
  payroll_officer: [
    { page: 'dashboard', icon: 'bi-speedometer2', label: 'Dashboard' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'Attendance' },
    { page: 'leave', icon: 'bi-calendar-check', label: 'Leave Management' },
    { page: 'payroll', icon: 'bi-cash-stack', label: 'Payroll' },
    { page: 'blockchain', icon: 'bi-shield-check', label: 'Blockchain' },
  ],
  payroll_manager: [
    { page: 'dashboard', icon: 'bi-speedometer2', label: 'Dashboard' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'Attendance' },
    { page: 'leave', icon: 'bi-calendar-check', label: 'Leave Management' },
    { page: 'payroll', icon: 'bi-cash-stack', label: 'Payroll' },
    { page: 'reports', icon: 'bi-file-earmark-bar-graph', label: 'Reports' },
    { page: 'blockchain', icon: 'bi-shield-check', label: 'Blockchain' },
  ],
  manager: [
    { page: 'dashboard', icon: 'bi-speedometer2', label: 'Dashboard' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'Team Attendance' },
    { page: 'leave', icon: 'bi-calendar-check', label: 'Leave Approvals' },
    { page: 'reports', icon: 'bi-file-earmark-bar-graph', label: 'Reports' },
  ],
  employee: [
    { page: 'employee-dashboard', tab: 'overview', icon: 'bi-house', label: 'My Dashboard' },
    { page: 'employee-dashboard', tab: 'payslips', icon: 'bi-receipt', label: 'My Payslips' },
    { page: 'requests', icon: 'bi-inbox', label: 'My Requests' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'My Attendance' },
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

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'lgsv_sidebar_collapsed';

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

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sidebarTextIconForItem(item = {}) {
  return String(item.label || item.page || 'NAV')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase() || 'NA';
}

const BOOTSTRAP_ICON_SVG_PATHS = {
  'bi-speedometer2': '<path d="M8 4a.5.5 0 0 1 .5.5V6a.5.5 0 0 1-1 0V4.5A.5.5 0 0 1 8 4z"/><path d="M3.732 5.732a.5.5 0 0 1 .707 0l.915.914a.5.5 0 1 1-.708.708l-.914-.915a.5.5 0 0 1 0-.707z"/><path d="M2 10a.5.5 0 0 1 .5-.5h1.586a.5.5 0 0 1 0 1H2.5A.5.5 0 0 1 2 10z"/><path d="M11.5 10a.5.5 0 0 1 .5-.5h1.5a.5.5 0 0 1 0 1H12a.5.5 0 0 1-.5-.5z"/><path d="M11.354 5.646a.5.5 0 0 1 0 .708l-2.172 2.172a1.5 1.5 0 1 1-.708-.708l2.172-2.172a.5.5 0 0 1 .708 0z"/><path d="M8 2a8 8 0 0 0-7.468 10.875A2.5 2.5 0 0 0 2.885 14h10.23a2.5 2.5 0 0 0 2.353-1.125A8 8 0 0 0 8 2zm0 1a7 7 0 0 1 6.545 9.49 1.5 1.5 0 0 1-1.43.51H2.885a1.5 1.5 0 0 1-1.43-.51A7 7 0 0 1 8 3z"/>',
  'bi-gear': '<path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.902 3.433 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.892 3.433-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.892-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.318.094a1.873 1.873 0 0 0-1.116 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.318a1.873 1.873 0 0 0-2.692-1.116l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>',
  'bi-clock-history': '<path d="M8.515 1.019A7 7 0 1 1 1.02 8.515a.5.5 0 0 1 .998-.07A6 6 0 1 0 8.445 2.02a.5.5 0 0 1 .07-.998z"/><path d="M7.5 3a.5.5 0 0 1 .5.5v4.21l2.248 1.348a.5.5 0 0 1-.496.868l-2.5-1.5A.5.5 0 0 1 7 8V3.5a.5.5 0 0 1 .5-.5z"/><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L4 3.293V1.5a.5.5 0 0 1 1 0v3A.5.5 0 0 1 4.5 5h-3a.5.5 0 0 1 0-1h1.793L2.146 2.854z"/>',
  'bi-shield-check': '<path d="M5.338 1.59 8 .5l2.662 1.09c1.02.417 1.945.683 2.838.768.23.022.4.22.4.452v4.08c0 3.334-2.01 6.266-5.734 8.07a.5.5 0 0 1-.432 0C4.01 13.156 2 10.224 2 6.89V2.81c0-.232.17-.43.4-.452.893-.085 1.818-.35 2.938-.768zM8 1.582 5.717 2.52c-.92.376-1.766.637-2.717.756V6.89c0 2.856 1.663 5.38 5 6.983 3.337-1.603 5-4.127 5-6.983V3.276c-.951-.119-1.797-.38-2.717-.756L8 1.582z"/><path d="M10.854 5.146a.5.5 0 0 1 0 .708l-3.5 3.5a.5.5 0 0 1-.708 0l-1.5-1.5a.5.5 0 1 1 .708-.708L7 8.293l3.146-3.147a.5.5 0 0 1 .708 0z"/>',
  'bi-people': '<path d="M15 14s1 0 1-1-1-4-5-4-5 3-5 4 1 1 1 1h8zm-7.978-1A.261.261 0 0 1 7 12.996c.001-.264.167-1.03.76-1.72C8.312 10.629 9.282 10 11 10c1.717 0 2.687.63 3.24 1.276.593.69.758 1.457.76 1.72l-.008.002A.274.274 0 0 1 14.982 13H7.022z"/><path d="M11 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 1a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/><path d="M6.936 9.28a5.88 5.88 0 0 0-1.23-.247A7.35 7.35 0 0 0 5 9c-4 0-5 3-5 4 0 .667.333 1 1 1h4.216A2.238 2.238 0 0 1 5 13c0-1.01.377-2.042 1.09-2.904.243-.294.526-.569.846-.816z"/><path d="M4.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/>',
  'bi-diagram-3': '<path fill-rule="evenodd" d="M6 3.5A1.5 1.5 0 0 1 7.5 2h1A1.5 1.5 0 0 1 10 3.5v1A1.5 1.5 0 0 1 8.5 6h-1A1.5 1.5 0 0 1 6 4.5v-1zM7.5 3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-1z"/><path d="M8.5 6.5v1h4a1 1 0 0 1 1 1V10h.5A1.5 1.5 0 0 1 15.5 11.5v1A1.5 1.5 0 0 1 14 14h-1a1.5 1.5 0 0 1-1.5-1.5v-1A1.5 1.5 0 0 1 13 10h-.5V8.5h-4V10H9A1.5 1.5 0 0 1 10.5 11.5v1A1.5 1.5 0 0 1 9 14H7a1.5 1.5 0 0 1-1.5-1.5v-1A1.5 1.5 0 0 1 7 10h.5V8.5h-4V10H4A1.5 1.5 0 0 1 5.5 11.5v1A1.5 1.5 0 0 1 4 14H2.5A1.5 1.5 0 0 1 1 12.5v-1A1.5 1.5 0 0 1 2.5 10H3V8.5a1 1 0 0 1 1-1h4v-1h.5z"/>',
  'bi-calendar-check': '<path d="M10.854 7.146a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708 0l-1.5-1.5a.5.5 0 1 1 .708-.708L7.5 9.793l2.646-2.647a.5.5 0 0 1 .708 0z"/><path d="M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5zM1 4v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4H1z"/>',
  'bi-file-earmark-bar-graph': '<path d="M10 13.5a.5.5 0 0 0 .5-.5V8a.5.5 0 0 0-1 0v5a.5.5 0 0 0 .5.5zm-2.5 0A.5.5 0 0 0 8 13v-3a.5.5 0 0 0-1 0v3a.5.5 0 0 0 .5.5zm-2.5 0a.5.5 0 0 0 .5-.5v-1.5a.5.5 0 0 0-1 0V13a.5.5 0 0 0 .5.5z"/><path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z"/>',
  'bi-person-plus': '<path d="M6 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/><path d="M8 9a5 5 0 0 0-5 5 .5.5 0 0 0 1 0 4 4 0 0 1 8 0 .5.5 0 0 0 1 0 5 5 0 0 0-5-5z"/><path d="M13.5 5a.5.5 0 0 1 .5.5V7h1.5a.5.5 0 0 1 0 1H14v1.5a.5.5 0 0 1-1 0V8h-1.5a.5.5 0 0 1 0-1H13V5.5a.5.5 0 0 1 .5-.5z"/>',
  'bi-journal-check': '<path fill-rule="evenodd" d="M10.854 6.146a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708 0l-1.5-1.5a.5.5 0 1 1 .708-.708L7.5 8.793l2.646-2.647a.5.5 0 0 1 .708 0z"/><path d="M3 0h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm0 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10V1H3z"/><path d="M5 2.5a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-1 0V3a.5.5 0 0 1 .5-.5z"/>',
  'bi-cash-stack': '<path d="M1 3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1H1zM0 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V5zm3 0a2 2 0 0 1-2 2v2a2 2 0 0 1 2 2h10a2 2 0 0 1 2-2V7a2 2 0 0 1-2-2H3z"/><path d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
  'bi-house': '<path d="M8.707 1.5a1 1 0 0 0-1.414 0L.646 8.146a.5.5 0 0 0 .708.708L2 8.207V13.5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V8.207l.646.647a.5.5 0 0 0 .708-.708L8.707 1.5zM13 7.207V13.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V7.207l5-5 5 5z"/>',
  'bi-receipt': '<path d="M1.92.506a.5.5 0 0 1 .434.14L3 1.293 3.646.646a.5.5 0 0 1 .708 0L5 1.293 5.646.646a.5.5 0 0 1 .708 0L7 1.293 7.646.646a.5.5 0 0 1 .708 0L9 1.293 9.646.646a.5.5 0 0 1 .708 0L11 1.293l.646-.647A.5.5 0 0 1 12.5 1v14a.5.5 0 0 1-.854.354L11 14.707l-.646.647a.5.5 0 0 1-.708 0L9 14.707l-.646.647a.5.5 0 0 1-.708 0L7 14.707l-.646.647a.5.5 0 0 1-.708 0L5 14.707l-.646.647a.5.5 0 0 1-.708 0L3 14.707l-.646.647A.5.5 0 0 1 1.5 15V1a.5.5 0 0 1 .42-.494z"/><path d="M3 4.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5A.5.5 0 0 1 3 4.5zM3 7a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5A.5.5 0 0 1 3 7zm0 2.5A.5.5 0 0 1 3.5 9h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5z"/>',
  'bi-inbox': '<path d="M4.98 4a.5.5 0 0 0-.39.188L1.54 8H6a.5.5 0 0 1 .5.5 1.5 1.5 0 1 0 3 0A.5.5 0 0 1 10 8h4.46l-3.05-3.812A.5.5 0 0 0 11.02 4H4.98zM3.809 3.563A1.5 1.5 0 0 1 4.981 3h6.038a1.5 1.5 0 0 1 1.172.563l3.7 4.625A.5.5 0 0 1 16 8.5V13a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5a.5.5 0 0 1 .109-.312l3.7-4.625z"/>',
};

function sidebarIconMarkup(item = {}) {
  const icon = String(item.icon || '').trim();
  if (BOOTSTRAP_ICON_SVG_PATHS[icon]) {
    return `<svg class="nav-svg-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">${BOOTSTRAP_ICON_SVG_PATHS[icon]}</svg>`;
  }
  return `<span aria-hidden="true">${escapeHtml(icon || sidebarTextIconForItem(item))}</span>`;
}

function readSidebarCollapsedPreference() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch (_error) {
    return false;
  }
}

function setSidebarCollapsed(collapsed, options = {}) {
  const isCollapsed = Boolean(collapsed);
  document.body.classList.toggle('sidebar-collapsed', isCollapsed);

  if (options.persist !== false) {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
    } catch (_error) {}
  }

  const toggle = document.getElementById('sidebar-collapse-toggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.setAttribute('aria-label', isCollapsed ? 'Open sidebar' : 'Collapse sidebar');
    toggle.title = isCollapsed ? 'Open sidebar' : 'Collapse sidebar';
  }
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
}

function initSidebarPreference() {
  setSidebarCollapsed(readSidebarCollapsedPreference(), { persist: false });
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
    if (data.code === 'DPA_REQUIRED') {
      const user = getUser() || {};
      user.dpaAccepted = false;
      user.dpaRequired = true;
      user.dpaAgreementVersion = data.agreement_version || user.dpaAgreementVersion || null;
      sessionStorage.setItem('vp_user', JSON.stringify(user));
      if (typeof showDpaAgreementGate === 'function') {
        showDpaAgreementGate({
          afterAccept: () => {
            if (typeof handleAppRoute === 'function') handleAppRoute({ replace: true });
          },
        });
      }
    }
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
         title="${escapeHtml(item.label)}"
         onclick="event.preventDefault(); navigate('${item.page}', this, ${item.tab ? `{ employeeTab: '${item.tab}' }` : 'null'})">
      <span class="nav-icon">${sidebarIconMarkup(item)}</span>
      <span class="nav-label">${escapeHtml(item.label)}</span>
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
    { page: 'employee-dashboard', tab: 'overview', icon: 'bi-house', label: 'Dashboard' },
    { page: 'employee-dashboard', tab: 'payslips', icon: 'bi-receipt', label: 'Payslips' },
    { page: 'requests', icon: 'bi-inbox', label: 'Request' },
    { page: 'attendance', icon: 'bi-clock-history', label: 'Attendance' },
    { page: 'leave', icon: 'bi-calendar-check', label: 'Leave' },
  ].filter(item => canAccess(item.page));

  bottomNav.innerHTML = items.map((item, index) => `
    <a href="${typeof routeForPage === 'function' ? routeForPage(item.page, item.tab ? { employeeTab: item.tab } : null) : '#'}"
            class="employee-bottom-nav-item ${index === 0 ? 'active' : ''}"
            data-page="${item.page}"
            data-nav-key="${item.tab ? `${item.page}:${item.tab}` : item.page}"
            onclick="event.preventDefault(); navigate('${item.page}', this, ${item.tab ? `{ employeeTab: '${item.tab}' }` : 'null'})">
      <span>${sidebarIconMarkup(item)}</span>
      <small>${escapeHtml(item.label)}</small>
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

async function logout() {
  if (typeof stopAttendanceAjaxRefresh === 'function') stopAttendanceAjaxRefresh();
  const token = getToken();
  if (token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (_) {
      // Local logout must still finish if the server is unavailable.
    } finally {
      clearTimeout(timeout);
    }
  }

  clearAuth();
  closeMobileSidebar();
  if (typeof showLoginRoute === 'function') {
    showLoginRoute(true);
  } else {
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }
  if (typeof window.resetLoginCaptcha === 'function') window.resetLoginCaptcha();
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
  initSidebarPreference();
  if (isLoggedIn()) {
    const user = getUser();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    if (typeof requiresDpaGate === 'function' && requiresDpaGate(user)) {
      if (typeof showDpaAgreementGate === 'function') {
        showDpaAgreementGate({
          afterAccept: () => {
            const acceptedUser = getUser();
            buildSidebar(acceptedUser);
            if (typeof initAttendanceRealtime === 'function') {
              initAttendanceRealtime();
            }
            if (typeof handleAppRoute === 'function') handleAppRoute({ replace: true });
          },
        });
      }
      return;
    }
    buildSidebar(user);
    if (typeof initAttendanceRealtime === 'function') {
      initAttendanceRealtime();
    }
  }
  document.getElementById('btn-logout')?.addEventListener('click', logout);
  document.getElementById('mobile-menu-toggle')?.addEventListener('click', toggleMobileSidebar);
  document.getElementById('mobile-sidebar-backdrop')?.addEventListener('click', closeMobileSidebar);
  document.getElementById('sidebar-collapse-toggle')?.addEventListener('click', toggleSidebarCollapsed);
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
window.setSidebarCollapsed = setSidebarCollapsed;
window.toggleSidebarCollapsed = toggleSidebarCollapsed;
window.applyUserRoleToDocument = applyUserRoleToDocument;
window.normalizeClientRole = normalizeClientRole;
window.isEmployeeRole = isEmployeeRole;
