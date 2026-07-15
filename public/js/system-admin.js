/* ============================================================
   public/js/system-admin.js — System Administration Controller
   Account Registration, RBAC Management & Audit Trail
   ============================================================ */

// ── State ────────────────────────────────────────────────────
let sysAllUsers     = [];
let sysAllRoles     = [];
let sysAllEmployees = [];
let sysAccountStats = null;
let sysSupportTickets = [];
let sysBackupLogs = [];
let sysBackupDashboard = null;
let sysBackupCoverage = [];
let sysModuleRecoveryPoints = [];
let sysRestoreJobs = [];
let sysRollbackRequests = [];
let sysBackupSchedules = [];
let sysBackupRetentionPolicy = null;
let sysBackupNotifications = [];
let sysBackupRestoreDrills = [];
let sysBackupOperationalErrors = {};
const sysBackupPagination = {
  backups: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
  recovery: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
  restore: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
  rollback: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
};
const sysBackupFilterTimers = {};
let sysBackupActiveTab = 'overview';
let sysBackupStepUpContext = null;
let sysBackupModuleSelectionInitialized = false;
let sysBackupModulePickerQuery = '';
let sysBackupScheduleModuleQuery = '';
let sysBackupWorkspaceLoading = false;
let sysBackupRequestContext = null;
const sysBackupPendingMutations = new Set();
let sysHealthSnapshot = null;
let sysHealthModules = [];
let sysHealthHistory = [];
let sysHealthSelectedModuleKey = null;
let sysHealthCheckRunning = false;
let sysHealthRunningModuleKey = null;
let sysHealthButtonsBound = false;
let sysCurrentStep  = 1;
let sysAccountRealtimeTimer = null;
let sysUsersDataSignature = '';
let sysEmployeesDataSignature = '';
let sysAuditRequestController = null;
let sysAuditRequestId = 0;
let sysUsersLoading = false;

const SYS_ROLE_DISPLAY_OVERRIDES = {
  hr_admin: {
    label: 'HR Admin',
    description: 'Employee lifecycle, 201-file, attendance validation, leave management, and HR reports.',
  },
  hr_manager: {
    label: 'HR Manager',
    description: 'HR approvals, employee lifecycle oversight, leave review, and HR operational reports.',
  },
  payroll_officer: {
    label: 'Payroll Officer',
    description: 'Draft payroll computation, verified production and trip logs, statutory deductions, and pay dispute support.',
  },
  payroll_manager: {
    label: 'Payroll Manager',
    description: 'Payroll approval, finalized payroll records, official financial summaries, and payroll reports.',
  },
  employee: {
    label: 'Employee',
    description: 'Employee self-service, attendance view, leave request, and finalized payslip access.',
  },
  system_admin: {
    label: 'System Administrator',
    description: 'System accounts, role access control, audit logs, blockchain verification, backup, and security configuration.',
  },
  manager: {
    label: 'Legacy Manager',
    description: 'Legacy role retained only for existing records.',
    hideWhenEmpty: true,
  },
};

function sysEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function sysRoleName(role) {
  return String(role?.name || role?.role_name || '').trim().toLowerCase();
}

function sysRoleDisplay(role) {
  const override = SYS_ROLE_DISPLAY_OVERRIDES[sysRoleName(role)] || {};
  return {
    ...role,
    label: override.label || role.label || role.role_label || role.name || role.role_name || 'Role',
    description: override.description || null,
    hideWhenEmpty: Boolean(override.hideWhenEmpty),
  };
}

function sysAssignableRoles() {
  return sysAllRoles
    .filter(role => sysRoleName(role) !== 'manager')
    .map(sysRoleDisplay);
}

function sysRoleLabelForUser(user) {
  const role = sysRoleDisplay({ name: user.role_name, label: user.role_label });
  return role.label;
}

function sysLooksEncryptedPayload(value) {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split(':');
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

function sysProtectEmployeeIdentity(user) {
  const safeUser = { ...user };
  ['first_name', 'last_name'].forEach(field => {
    if (sysLooksEncryptedPayload(safeUser[field])) safeUser[field] = null;
  });
  return safeUser;
}

function sysFormatDateTime(value) {
  if (!value) return '—';
  if (typeof formatPhilippineDateTime === 'function') {
    return formatPhilippineDateTime(value, { fallback: '-', timeStyle: 'short' });
  }
  return `${new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })} PHT`;
}

function sysJsString(value) {
  return JSON.stringify(String(value ?? ''));
}

function sysFormatDuration(seconds) {
  const total = Math.max(Number(seconds || 0), 0);
  if (!Number.isFinite(total) || total <= 0) return '—';
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  if (minutes > 0 && remainingSeconds > 0) return `${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m`;
  return `${remainingSeconds}s`;
}

function isUserLocked(user) {
  return Boolean(Number(user?.is_locked || 0)) && Number(user?.lock_seconds_remaining || 0) > 0;
}

function sysStableJson(value) {
  return JSON.stringify(value);
}

function sysUserDataSignature(users) {
  return sysStableJson((users || []).map(user => [
    Number(user.id || 0),
    user.username || '',
    Number(user.employee_id || 0),
    user.employee_code || '',
    user.first_name || '',
    user.last_name || '',
    Number(user.role_id || 0),
    user.role_name || '',
    user.role_label || '',
    user.access_level || '',
    Number(user.is_active || 0),
    Number(user.is_locked || 0),
    Number(user.failed_login_attempts || 0),
    Number(user.lock_seconds_remaining || 0),
    user.last_login || '',
  ]));
}

function sysEmployeeDataSignature(employees) {
  return sysStableJson((employees || []).map(employee => [
    Number(employee.id || 0),
    employee.employee_code || '',
    employee.status || '',
  ]));
}

function sysPasswordErrors(password) {
  const errors = [];
  if (!String(password || '').trim()) errors.push('Temporary password is required.');
  if (typeof password === 'string' && password.length > 128) errors.push('Temporary password must be 128 characters or fewer.');
  return errors;
}

function sysActionIcon(icon) {
  const icons = {
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-2.8 8.5-7 10-4.2-1.5-7-5.5-7-10V6l7-3z"/><path d="M12 7v10"/></svg>',
    key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="3"/><path d="M10.5 12.5L20 3"/><path d="M15 8l2 2"/><path d="M17 6l2 2"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7v10"/><path d="M15 7v10"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7-11-7z"/></svg>',
    unlock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.4-2"/></svg>',
    revoke: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h12"/><path d="M11 8l4 4-4 4"/><path d="M21 5v14"/></svg>',
    mfa: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/><path d="M10 7h4"/></svg>',
  };
  return icons[icon] || '';
}

function sysAccountMenuAction(action, label, icon, userId) {
  return '<button type="button" class="account-menu-item account-action-' + action + '" ' +
    'data-account-action="' + action + '" data-user-id="' + Number(userId) + '" ' +
    'role="menuitem">' +
    '<span class="account-action-icon">' + sysActionIcon(icon) + '</span>' +
    '<span>' + label + '</span>' +
  '</button>';
}

function sysAccountActionMenu(user) {
  const statusAction = user.is_active
    ? sysAccountMenuAction('deactivate', 'Deactivate', 'pause', user.id)
    : sysAccountMenuAction('activate', 'Activate', 'play', user.id);

  return '<div class="account-menu">' +
    '<button type="button" class="account-menu-trigger" data-account-menu-toggle ' +
      'aria-label="Account actions for ' + sysEsc(user.username) + '" aria-haspopup="menu" aria-expanded="false">' +
      '<span>Actions</span>' +
    '</button>' +
    '<div class="account-menu-popover" role="menu" aria-label="Actions for ' + sysEsc(user.username) + '">' +
      sysAccountMenuAction('role', 'Change role', 'shield', user.id) +
      sysAccountMenuAction('credentials', 'Reset password', 'key', user.id) +
      sysAccountMenuAction('unlock', 'Unlock account', 'unlock', user.id) +
      sysAccountMenuAction('revoke-sessions', 'Revoke sessions', 'revoke', user.id) +
      sysAccountMenuAction('reset-mfa', 'Reset MFA', 'mfa', user.id) +
      statusAction +
    '</div>' +
  '</div>';
}

function closeAccountActionMenus(exceptMenu = null) {
  document.querySelectorAll('.account-menu.is-open').forEach(menu => {
    if (menu === exceptMenu) return;
    menu.classList.remove('is-open', 'is-open-up');
    const popover = menu.querySelector('.account-menu-popover');
    if (popover) {
      popover.style.top = '';
      popover.style.left = '';
      popover.style.right = '';
      popover.style.bottom = '';
    }
    const trigger = menu.querySelector('[data-account-menu-toggle]');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

function openAccountActionMenu(menu, trigger) {
  closeAccountActionMenus(menu);
  const popover = menu.querySelector('.account-menu-popover');
  if (!popover) return;
  const estimatedMenuHeight = 150;
  const estimatedMenuWidth = 180;
  const triggerBounds = trigger.getBoundingClientRect();
  const shouldOpenUpward = window.innerHeight - triggerBounds.bottom < estimatedMenuHeight
    && triggerBounds.top > estimatedMenuHeight;
  const top = shouldOpenUpward
    ? Math.max(8, triggerBounds.top - estimatedMenuHeight - 6)
    : Math.min(window.innerHeight - estimatedMenuHeight - 8, triggerBounds.bottom + 6);
  const left = Math.min(
    Math.max(8, triggerBounds.right - estimatedMenuWidth),
    window.innerWidth - estimatedMenuWidth - 8
  );
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
  popover.style.right = 'auto';
  popover.style.bottom = 'auto';
  menu.classList.toggle('is-open-up', shouldOpenUpward);
  menu.classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');
}

async function openRoleUpdateForUser(user) {
  if (!sysAllRoles.length) await loadRolesList();
  showRoleModal(Number(user.id), user.username, sysRoleLabelForUser(user), Number(user.role_id));
}

function bindAccountActionButtons() {
  const tableBody = document.getElementById('users-tbody');
  if (!tableBody || tableBody.dataset.actionsBound === 'true') return;
  tableBody.dataset.actionsBound = 'true';

  document.addEventListener('click', event => {
    if (!event.target.closest('.account-menu')) closeAccountActionMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAccountActionMenus();
  });

  tableBody.addEventListener('click', async event => {
    const menuToggle = event.target.closest('[data-account-menu-toggle]');
    if (menuToggle) {
      event.preventDefault();
      const menu = menuToggle.closest('.account-menu');
      if (!menu) return;
      if (menu.classList.contains('is-open')) {
        closeAccountActionMenus();
      } else {
        openAccountActionMenu(menu, menuToggle);
      }
      return;
    }

    const button = event.target.closest('[data-account-action]');
    if (!button) return;
    event.preventDefault();
    closeAccountActionMenus();

    const userId = Number(button.dataset.userId);
    const user = sysAllUsers.find(item => Number(item.id) === userId);
    if (!user) {
      showSysToast('This account is no longer available. Refreshing the list.', 'error');
      await loadUsersTable();
      return;
    }

    button.disabled = true;
    try {
      if (button.dataset.accountAction === 'role') {
        await openRoleUpdateForUser(user);
      } else if (button.dataset.accountAction === 'credentials') {
        showCredentialsModal(Number(user.id), user.username);
      } else if (button.dataset.accountAction === 'unlock') {
        await unlockUserAccount(Number(user.id));
      } else if (button.dataset.accountAction === 'revoke-sessions') {
        await revokeUserSessions(Number(user.id));
      } else if (button.dataset.accountAction === 'reset-mfa') {
        await resetUserMfa(Number(user.id));
      } else if (button.dataset.accountAction === 'deactivate') {
        await toggleUserStatus(Number(user.id), false);
      } else if (button.dataset.accountAction === 'activate') {
        await toggleUserStatus(Number(user.id), true);
      }
    } catch (error) {
      console.error('[SysAdmin] account action error:', error);
      showSysToast(error.message || 'Unable to open this account action.', 'error');
    } finally {
      button.disabled = false;
    }
  });
}

// ── Tab Switching ────────────────────────────────────────────
function bindSystemHealthButtons() {
  if (sysHealthButtonsBound) return;
  sysHealthButtonsBound = true;

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-health-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.healthAction;
    const moduleKey = button.dataset.moduleKey;

    if (action === 'run-all') {
      event.preventDefault();
      runSystemHealthCheck();
    } else if (action === 'refresh') {
      event.preventDefault();
      loadSystemHealth();
    } else if (action === 'details') {
      event.preventDefault();
      if (moduleKey) openSystemHealthDetails(moduleKey);
    } else if (action === 'check-module') {
      event.preventDefault();
      if (moduleKey) runSystemModuleHealthCheck(moduleKey);
    } else if (action === 'drilldown') {
      event.preventDefault();
      if (moduleKey) runSystemHealthDrilldownAction(moduleKey, button.dataset.actionId);
    }
  });
}

const SYS_ADMIN_TAB_TITLES = {
  accounts: 'Account Management',
  roles: 'Role and Access Control',
  audit: 'Audit Trail',
  health: 'System Health',
  support: 'Support Center',
  backups: 'Backup and Restore',
};

const SYS_HEALTH_FALLBACK_MODULES = [
  ['dashboard', 'Dashboard', '/api/dashboard'],
  ['authentication', 'Authentication / Login', '/api/auth/login'],
  ['dpa_privacy', 'Data Privacy Agreement', '/api/dpa/status'],
  ['account_management', 'Account Management', '/api/admin/users'],
  ['rbac', 'Role and Access Control', '/api/admin/roles'],
  ['employee_201', 'Employee / 201-File Management', '/api/employees'],
  ['organization_setup', 'Organization Setup', '/api/employee-setup/lookups'],
  ['onboarding', 'Onboarding / Recruitment', '/api/onboarding/dashboard'],
  ['attendance', 'Attendance', '/api/attendance/all'],
  ['attendance_sync', 'Attendance Sync', '/api/biometric/status'],
  ['leave', 'Leave Management', '/api/leave'],
  ['operational_logs', 'Operational Logs', '/api/payroll/piece-rate-config / /api/payroll/logistics/trips'],
  ['payroll_settings', 'Payroll Settings', '/api/payroll/deduction-settings'],
  ['payroll', 'Payroll Computation', '/api/payroll/salary-calculations'],
  ['payroll_approval', 'Payroll Approval', '/api/payroll/runs'],
  ['payslip', 'Payslip Generation', '/api/payroll/payslips'],
  ['reports', 'Reports', '/api/reports/library'],
  ['self_service', 'Employee Self-Service', '/api/self-service/profile'],
  ['audit_trail', 'Audit Trail', '/api/admin/audit-log'],
  ['blockchain', 'Blockchain Support', '/api/admin/blockchain-support/status'],
  ['support_center', 'Support Center', '/api/admin/support-tickets'],
  ['backup_restore', 'Backup and Restore', '/api/admin/backups'],
  ['aws_readiness', 'AWS Deployment Readiness', 'Environment / EC2-RDS-S3 readiness'],
  ['database', 'Database', 'MySQL SELECT 1'],
];

const SYS_HEALTH_AUDIT_MODULES = {
  dashboard: 'SYSTEM',
  authentication: 'AUTH',
  dpa_privacy: 'SYSTEM',
  account_management: 'ACCOUNT_LIFECYCLE',
  rbac: 'RBAC',
  employee_201: '201_FILE',
  organization_setup: 'EMPLOYEE',
  onboarding: 'ONBOARDING',
  attendance: 'ATTENDANCE',
  attendance_sync: 'ATTENDANCE',
  leave: 'LEAVE',
  operational_logs: 'PAYROLL',
  payroll_settings: 'PAYROLL',
  payroll: 'PAYROLL',
  payroll_approval: 'PAYROLL',
  payslip: 'PAYROLL',
  reports: 'REPORTS',
  self_service: 'SELF_SERVICE',
  audit_trail: 'SYSTEM_HEALTH',
  blockchain: 'BLOCKCHAIN',
  support_center: 'SYSTEM_HEALTH',
  backup_restore: 'SYSTEM',
  aws_readiness: 'SYSTEM_HEALTH',
  database: 'SYSTEM_HEALTH',
};

const SYS_HEALTH_SUPPORT_CATEGORIES = {
  authentication: 'AUTHENTICATION',
  dpa_privacy: 'SECURITY',
  account_management: 'ACCOUNT',
  rbac: 'SECURITY',
  attendance_sync: 'BIOMETRIC',
  payroll: 'PAYROLL_PROCESS',
  payroll_settings: 'PAYROLL_PROCESS',
  payroll_approval: 'PAYROLL_PROCESS',
  operational_logs: 'PAYROLL_PROCESS',
  payslip: 'PAYROLL_PROCESS',
  reports: 'REPORTING',
  blockchain: 'BLOCKCHAIN',
  aws_readiness: 'SYSTEM',
  database: 'SYSTEM',
};

const SYS_HEALTH_RELATED_NAV = {
  dashboard: [{ id: 'open-dashboard', label: 'Open Dashboard', icon: 'bi-speedometer2', page: 'dashboard' }],
  authentication: [{ id: 'open-accounts', label: 'Open Accounts', icon: 'bi-people', page: 'system-admin', params: { sysAdminTab: 'accounts' } }],
  dpa_privacy: [{ id: 'open-dpa-audit', label: 'Open DPA Audit', icon: 'bi-shield-lock', type: 'audit', auditModule: 'SYSTEM', search: 'DPA' }],
  account_management: [{ id: 'open-accounts', label: 'Open Accounts', icon: 'bi-people', page: 'system-admin', params: { sysAdminTab: 'accounts' } }],
  rbac: [{ id: 'open-rbac', label: 'Open RBAC', icon: 'bi-shield-check', page: 'system-admin', params: { sysAdminTab: 'roles' } }],
  employee_201: [{ id: 'open-employees', label: 'Open Employees', icon: 'bi-person-vcard', page: 'employees' }],
  organization_setup: [{ id: 'open-org-setup', label: 'Open Org Setup', icon: 'bi-diagram-3', page: 'organization-setup' }],
  onboarding: [{ id: 'open-onboarding', label: 'Open Onboarding', icon: 'bi-person-plus', page: 'onboarding' }],
  attendance: [{ id: 'open-attendance', label: 'Open Attendance', icon: 'bi-clock-history', page: 'attendance' }],
  attendance_sync: [{ id: 'open-attendance-sync', label: 'Open Attendance Sync', icon: 'bi-fingerprint', page: 'attendance', params: { attTab: 'biometric' } }],
  leave: [{ id: 'open-leave', label: 'Open Leave', icon: 'bi-calendar-check', page: 'leave' }],
  operational_logs: [
    { id: 'open-payroll-encoding', label: 'Open Payroll Encoding', icon: 'bi-pencil-square', page: 'payroll', params: { payrollTab: 'salary' } },
    { id: 'open-logistics-trips', label: 'Open Logistics Trips', icon: 'bi-truck', page: 'payroll', params: { payrollTab: 'logistics' } },
  ],
  payroll_settings: [
    { id: 'open-deductions', label: 'Open Deductions', icon: 'bi-sliders', page: 'payroll', params: { payrollTab: 'deductions' } },
    { id: 'open-piece-rate', label: 'Open Piece Rate', icon: 'bi-grid-3x3-gap', page: 'payroll', params: { payrollTab: 'piece-config' } },
  ],
  payroll: [{ id: 'open-payroll-run', label: 'Open Payroll Run', icon: 'bi-cash-stack', page: 'payroll', params: { payrollTab: 'run' } }],
  payroll_approval: [{ id: 'open-payroll-run', label: 'Open Payroll Run', icon: 'bi-check2-square', page: 'payroll', params: { payrollTab: 'run' } }],
  payslip: [{ id: 'open-payslips', label: 'Open Payslips', icon: 'bi-receipt', page: 'payroll', params: { payrollTab: 'records' } }],
  reports: [{ id: 'open-reports', label: 'Open Reports', icon: 'bi-file-earmark-bar-graph', page: 'reports' }],
  self_service: [{ id: 'open-self-service', label: 'Open Self-Service', icon: 'bi-person-circle', page: 'self-service' }],
  audit_trail: [{ id: 'open-audit', label: 'Open Audit Trail', icon: 'bi-journal-text', page: 'system-admin', params: { sysAdminTab: 'audit' } }],
  blockchain: [{ id: 'open-blockchain-support', label: 'Open Blockchain Support', icon: 'bi-shield-check', page: 'blockchain', params: { blockchainView: 'support' } }],
  support_center: [{ id: 'open-support', label: 'Open Support Center', icon: 'bi-inbox', page: 'system-admin', params: { sysAdminTab: 'support' } }],
  backup_restore: [{ id: 'open-backups', label: 'Open Backups', icon: 'bi-archive', page: 'system-admin', params: { sysAdminTab: 'backups' } }],
  aws_readiness: [{ id: 'open-support', label: 'Open Support Center', icon: 'bi-inbox', page: 'system-admin', params: { sysAdminTab: 'support' } }],
  database: [{ id: 'open-support', label: 'Open Support Center', icon: 'bi-database', page: 'system-admin', params: { sysAdminTab: 'support' } }],
};

function switchSysAdminTab(tabId, el, options = {}) {
  const targetTab = SYS_ADMIN_TAB_TITLES[tabId] ? tabId : 'accounts';
  const tabs = document.getElementById('sysadmin-tabs');
  if (tabs) tabs.hidden = false;
  document.querySelectorAll('.sysadmin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sysadmin-panel').forEach(p => p.classList.remove('active'));
  const tabButton = el || document.querySelector(`.sysadmin-tab[data-tab="${targetTab}"]`);
  if (tabButton) tabButton.classList.add('active');
  const panel = document.getElementById('panel-' + targetTab);
  if (panel) panel.classList.add('active');

  const title = document.getElementById('page-title');
  if (title && SYS_ADMIN_TAB_TITLES[targetTab]) title.textContent = SYS_ADMIN_TAB_TITLES[targetTab];

  if (!options.skipRouteUpdate && typeof syncRouteForPage === 'function') {
    syncRouteForPage('system-admin', { sysAdminTab: targetTab });
  }

  if (targetTab === 'accounts') {
    loadUsersTable();
    startAccountRealtime();
  } else {
    stopAccountRealtime();
  }
  if (targetTab === 'roles')    loadRolesGrid();
  if (targetTab === 'audit')    requestAnimationFrame(loadAuditLog);
  if (targetTab === 'health')   loadSystemHealth();
  if (targetTab === 'support')  loadSupportTickets();
  if (targetTab === 'backups')  loadBackupLogs();
}

// ── Initialize on navigation ────────────────────────────────
function initSystemAdmin() {
  bindAccountActionButtons();
  bindSystemHealthButtons();
  loadRolesList();
  const tabs = document.getElementById('sysadmin-tabs');
  if (tabs) tabs.hidden = false;

  const activeTab =
    window.ROUTE_PARAMS?.sysAdminTab ||
    document.querySelector('.sysadmin-tab.active')?.dataset?.tab ||
    document.querySelector('.sysadmin-panel.active')?.id?.replace(/^panel-/, '') ||
    'accounts';

  switchSysAdminTab(activeTab, null, { skipRouteUpdate: true });
}

function initSystemAdminIfActive() {
  const page = document.getElementById('page-system-admin');
  if (!page?.classList.contains('active')) return;
  initSystemAdmin();
}

// ═══════════════════════════════════════════════════════════════
// ACCOUNT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function loadUsersTable() {
  if (sysUsersLoading) return;
  sysUsersLoading = true;
  try {
    const res = await apiFetch('/api/admin/users?include_stats=1');
    if (!res || !res.ok) {
      console.error('Failed to load users');
      return;
    }
    // Names are decrypted by the authorized server response. This is only a
    // display safeguard so an unexpected protected database value is never
    // rendered or retained in the screen's account-list state.
    const payload = await res.json();
    const rawUsers = Array.isArray(payload) ? payload : (Array.isArray(payload?.users) ? payload.users : []);
    const nextUsers = rawUsers.map(sysProtectEmployeeIdentity);
    const nextUsersSignature = sysUserDataSignature(nextUsers);
    const usersChanged = nextUsersSignature !== sysUsersDataSignature;
    sysAllUsers = nextUsers;
    sysAccountStats = payload?.stats || null;
    populateSupportUserSelect();

    const needsInitialRender = document.getElementById('users-tbody')?.dataset.sysRendered !== 'true';
    if (usersChanged || needsInitialRender || sysAccountStats) updateStats();
    if (usersChanged || needsInitialRender) {
      sysUsersDataSignature = nextUsersSignature;
      filterUserTable();
    }
  } catch (err) {
    console.error('[SysAdmin] loadUsersTable error:', err);
  } finally {
    sysUsersLoading = false;
  }
}

function startAccountRealtime() {
  stopAccountRealtime();
  sysAccountRealtimeTimer = setInterval(() => {
    const panel = document.getElementById('panel-accounts');
    const modalOpen = document.querySelector('.sysadmin-modal-overlay[style*="flex"]');
    if (panel?.classList.contains('active') && !modalOpen) {
      loadUsersTable();
    }
  }, 30000);
}

function stopAccountRealtime() {
  if (sysAccountRealtimeTimer) {
    clearInterval(sysAccountRealtimeTimer);
    sysAccountRealtimeTimer = null;
  }
}

function updateStats() {
  const total    = Number(sysAccountStats?.total ?? sysAllUsers.length);
  const active   = Number(sysAccountStats?.active ?? sysAllUsers.filter(u => u.is_active).length);
  const inactive = Number(sysAccountStats?.inactive ?? (total - active));
  const locked   = Number(sysAccountStats?.locked ?? sysAllUsers.filter(isUserLocked).length);
  const linkedIds = sysAllUsers.map(u => u.employee_id).filter(Boolean);
  const unlinked  = Number(sysAccountStats?.unlinked_employees ?? sysAllEmployees.filter(e => !linkedIds.includes(e.id)).length);

  document.getElementById('stat-total-users').textContent     = total;
  document.getElementById('stat-active-users').textContent    = active;
  document.getElementById('stat-inactive-users').textContent  = inactive;
  document.getElementById('stat-locked-users').textContent    = locked;
  document.getElementById('stat-unlinked-employees').textContent = unlinked;
}

function renderUsersTable(users) {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  tbody.dataset.sysRendered = 'true';

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No accounts found.</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const levelNum = u.access_level ? u.access_level.replace('Level ', '') : '1';
    const statusClass = u.is_active ? 'badge-active' : 'badge-inactive';
    const statusText  = u.is_active ? 'Active' : 'Inactive';
    const locked = isUserLocked(u);
    const lockoutText = locked
      ? `Locked for ${sysFormatDuration(u.lock_seconds_remaining)}`
      : Number(u.failed_login_attempts || 0) > 0
        ? `${Number(u.failed_login_attempts)} failed attempt(s)`
        : 'Clear';
    const empName = (u.first_name && u.last_name) 
      ? `${sysEsc(u.first_name)} ${sysEsc(u.last_name)}` 
      : u.employee_id
        ? '<span style="color:var(--muted)">Employee record unavailable</span>'
        : '<span style="color:var(--muted)">Unlinked</span>';
    const empCode = sysEsc(u.employee_code || '—');
    const lastLogin = u.last_login 
      ? new Date(u.last_login).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' })
      : '—';

    const currentUser = getUser();
    const isSelf = currentUser && currentUser.id === u.id;

    return `
      <tr>
        <td>${Number(u.id)}</td>
        <td><strong>${sysEsc(u.username)}</strong></td>
        <td>${empName}<br><small style="color:var(--muted)">${empCode}</small></td>
        <td>${sysEsc(sysRoleLabelForUser(u))}</td>
        <td><span class="badge-level badge-level-${levelNum}">${u.access_level || '—'}</span></td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td><span class="${locked ? 'badge-locked' : 'badge-clear'}">${sysEsc(lockoutText)}</span></td>
        <td><small>${lastLogin}</small></td>
        <td>
          <div class="action-group">
            ${!isSelf ?
              sysAccountActionMenu(u)
              : '<small class="account-self-label">Your account</small>'}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterUserTable() {
  const search = (document.getElementById('user-search')?.value || '').toLowerCase();
  const roleFilter = document.getElementById('user-role-filter')?.value || '';
  const statusFilter = document.getElementById('user-status-filter')?.value || '';

  let filtered = sysAllUsers;

  if (search) {
    filtered = filtered.filter(u =>
      u.username.toLowerCase().includes(search) ||
      (u.first_name && u.first_name.toLowerCase().includes(search)) ||
      (u.last_name && u.last_name.toLowerCase().includes(search)) ||
      (u.employee_code && u.employee_code.toLowerCase().includes(search))
    );
  }

  if (roleFilter) {
    filtered = filtered.filter(u => u.role_name === roleFilter);
  }

  if (statusFilter) {
    filtered = filtered.filter(u => 
      statusFilter === 'locked' ? isUserLocked(u) : statusFilter === 'active' ? u.is_active : !u.is_active
    );
  }

  const table = document.getElementById('users-table');
  if (table) table.dataset.paginationPage = '1';
  renderUsersTable(filtered);
}

// ═══════════════════════════════════════════════════════════════
// ROLE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function loadRolesList() {
  try {
    const res = await apiFetch('/api/admin/roles');
    if (!res || !res.ok) return;
    sysAllRoles = await res.json();

    // Populate role filter dropdown
    const roleFilter = document.getElementById('user-role-filter');
    if (roleFilter) {
      roleFilter.innerHTML = '<option value="">All Roles</option>' +
        sysAssignableRoles().map(r => `<option value="${sysEsc(sysRoleName(r))}">${sysEsc(r.label)}</option>`).join('');
    }
  } catch (err) {
    console.error('[SysAdmin] loadRolesList error:', err);
  }
}

async function loadRolesGrid() {
  await loadRolesList();
  // Refresh user data for accurate counts
  try {
    const res = await apiFetch('/api/admin/users');
    if (res && res.ok) sysAllUsers = await res.json();
  } catch (e) {}

  const grid = document.getElementById('roles-grid');
  if (!grid) return;

  // Group users per role
  const usersPerRole = {};
  sysAllUsers.forEach(u => {
    if (!usersPerRole[u.role_id]) usersPerRole[u.role_id] = [];
    usersPerRole[u.role_id].push(u);
  });

  const levelDescriptions = {
    'Level 1': 'Employee self-service, attendance view, leave request, and payslip view.',
    'Level 2': 'Operational access for HR management or payroll processing, depending on role.',
    'Level 3': 'Payroll approval, final reports, and financial summary reporting.',
    'Level 4': 'System accounts, RBAC, audit logs, blockchain audit, backup, and health monitoring.',
  };

  const rolesForGrid = sysAllRoles
    .map(sysRoleDisplay)
    .filter(r => !r.hideWhenEmpty || (usersPerRole[r.id] || []).length > 0);

  grid.innerHTML = rolesForGrid.map(r => {
    const levelNum = r.access_level ? r.access_level.replace('Level ', '') : '1';
    const roleUsers = usersPerRole[r.id] || [];
    const count = roleUsers.length;
    const desc = r.description || levelDescriptions[r.access_level] || 'No description available.';

    // Build expandable user list
    let userListHTML = '';
    if (count > 0) {
      userListHTML = `
        <div class="role-card-user-list" id="role-users-${r.id}" style="display:none;">
          ${roleUsers.map(u => {
            const name = (u.first_name && u.last_name) ? `${u.first_name} ${u.last_name}` : 'Unlinked';
            const statusCls = u.is_active ? 'badge-active' : 'badge-inactive';
            const statusTxt = u.is_active ? 'Active' : 'Inactive';
            return `
              <div class="role-user-item">
                <div class="role-user-info">
                  <strong>${sysEsc(u.username)}</strong>
                  <small>${sysEsc(name)}</small>
                </div>
                <span class="${statusCls}">${statusTxt}</span>
              </div>`;
          }).join('')}
        </div>`;
    }

    return `
      <div class="role-card role-card-clickable" onclick="toggleRoleUsers(${r.id})">
        <div class="role-card-header">
          <div>
            <div class="role-card-title">${sysEsc(r.label)}</div>
            <div class="role-card-desc">${sysEsc(desc)}</div>
          </div>
          <span class="badge-level badge-level-${levelNum}">${r.access_level || '—'}</span>
        </div>
        <div class="role-card-users">
          <strong>${count}</strong> user${count !== 1 ? 's' : ''} assigned
          <span class="role-expand-hint" id="role-hint-${r.id}">${count > 0 ? 'View users' : ''}</span>
        </div>
        ${userListHTML}
      </div>
    `;
  }).join('');
}

function toggleRoleUsers(roleId) {
  const list = document.getElementById('role-users-' + roleId);
  const hint = document.getElementById('role-hint-' + roleId);
  if (!list) return;
  const isVisible = list.style.display !== 'none';
  list.style.display = isVisible ? 'none' : 'block';
  if (hint) hint.textContent = isVisible ? 'View users' : 'Hide users';
}

// ═══════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════

function sysAuditTbody() {
  return document.querySelector('#panel-audit #audit-tbody');
}

async function loadAuditLog() {
  const tbody = sysAuditTbody();
  const table = document.getElementById('audit-table');
  if (table) table.dataset.paginationPage = '1';
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="table-empty">Loading audit trail...</td></tr>';

  // Only the newest filter/refresh request may update the table. Aborting the
  // previous request also prevents overlapping audit downloads from leaving
  // the screen in a stale loading state.
  if (sysAuditRequestController) sysAuditRequestController.abort();
  const requestId = ++sysAuditRequestId;
  const controller = new AbortController();
  sysAuditRequestController = controller;
  let timeoutError = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutError = setTimeout(() => {
      controller.abort();
      const error = new Error('Audit trail request timed out.');
      error.name = 'TimeoutError';
      reject(error);
    }, 15000);
  });

  try {
    const module = document.getElementById('audit-module-filter')?.value || '';
    const eventType = document.getElementById('audit-action-filter')?.value || '';
    const anomalyType = document.getElementById('audit-anomaly-filter')?.value || '';
    const search = document.getElementById('audit-search')?.value?.trim() || '';
    const params = new URLSearchParams({ limit: '50' });
    if (module) params.set('module', module);
    if (eventType) params.set('event_type', eventType);
    if (anomalyType) {
      params.set('event_type', 'anomaly');
      params.set('anomaly_type', anomalyType);
    }
    if (search) params.set('search', search);
    const url = `/api/admin/audit-log?${params.toString()}`;

    // Keep the same timeout active through response-body parsing. Fetch can
    // resolve as soon as headers arrive while response.json() is still pending.
    const res = await Promise.race([
      apiFetch(url, { signal: controller.signal }),
      timeoutPromise,
    ]);
    if (requestId !== sysAuditRequestId) return;
    if (!res) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="table-empty">Session expired. Please log in again.</td></tr>';
      return;
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error('Failed to load audit log:', errData);
      if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Error: ${sysEsc(errData.error || 'Failed to load audit log.')}</td></tr>`;
      return;
    }

    const payload = await Promise.race([res.json(), timeoutPromise]);
    if (requestId !== sysAuditRequestId) return;
    const logs = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.logs)
        ? payload.logs
        : Array.isArray(payload?.audit_logs)
          ? payload.audit_logs
          : null;
    if (!Array.isArray(logs)) throw new Error('Invalid audit log response.');
    renderAuditLog(logs);
  } catch (err) {
    if (requestId !== sysAuditRequestId) return;
    console.error('[SysAdmin] loadAuditLog error:', err);
    const message = ['AbortError', 'TimeoutError'].includes(err?.name)
      ? 'Audit trail request timed out. Please press Refresh to try again.'
      : 'Failed to load audit trail. Check console for details.';
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="table-empty">${sysEsc(message)}</td></tr>`;
  } finally {
    clearTimeout(timeoutError);
    if (requestId === sysAuditRequestId) sysAuditRequestController = null;
  }
}

function auditModuleLevel(moduleName) {
  if (['AUTH', 'AUTH_SECURITY', 'RBAC_SECURITY', 'SYSTEM', 'BLOCKCHAIN'].includes(moduleName)) return 4;
  if (moduleName === 'PAYROLL') return 3;
  if (['EMPLOYEE', 'ATTENDANCE', 'LEAVE', '201_FILE', 'ONBOARDING'].includes(moduleName)) return 2;
  return 1;
}

function auditModuleLabel(moduleName) {
  const labels = {
    ACCOUNT_LIFECYCLE: 'Account lifecycle',
    AUTH: 'Authentication',
    AUTH_SECURITY: 'Authentication security',
    ATTENDANCE: 'Attendance',
    BLOCKCHAIN: 'Blockchain',
    EMPLOYEE: 'Employee records',
    LEAVE: 'Leave management',
    ONBOARDING: 'Onboarding',
    PAYROLL: 'Payroll',
    RBAC: 'Role access control',
    RBAC_SECURITY: 'Security',
    REPORTS: 'Reports',
    SELF_SERVICE: 'Self-service',
    SYSTEM: 'System',
  };
  const key = String(moduleName || '').trim().toUpperCase();
  return labels[key] || (key ? key.replaceAll('_', ' ').toLowerCase() : 'System');
}

function auditLooksBackendOnly(value) {
  const text = String(value ?? '');
  return /\/api\//i.test(text)
    || /\b(targetTable|targetRecord|required_roles|actual_role|statusCode|userAgent|user_agent)\b/i.test(text)
    || /\b(method|path|endpoint|route)\s*[:=]/i.test(text);
}

function auditPublicObjectValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'object') return '';
  const text = String(value);
  return auditLooksBackendOnly(text) ? '' : text;
}

function auditPublicObjectSummary(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const hiddenKeys = new Set([
    'actual_role',
    'method',
    'path',
    'required_permission',
    'required_roles',
    'role',
    'statuscode',
    'targetrecord',
    'targettable',
    'user_agent',
    'useragent',
  ]);

  return Object.entries(parsed)
    .filter(([key]) => !hiddenKeys.has(String(key).toLowerCase()))
    .map(([key, val]) => {
      const safeValue = auditPublicObjectValue(val);
      return safeValue ? `${key}: ${safeValue}` : '';
    })
    .filter(Boolean)
    .slice(0, 6)
    .join(', ');
}

function auditShortValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value === '[protected]') return 'Protected data';

  const text = String(value);
  if (['null', 'undefined'].includes(text.trim().toLowerCase())) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return auditPublicObjectSummary(parsed);
    }
  } catch {
    // Plain text audit values are valid.
  }

  return auditLooksBackendOnly(text) ? '' : text;
}

function auditJsonObject(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function auditWriteMetadata(log) {
  const action = String(log?.action_performed || '');
  const metadata = auditJsonObject(log?.new_value) || {};
  const path = String(metadata.path || metadata.targetTable || '');
  const method = String(metadata.method || '');
  const pathMatch = path.match(/^\/api\/employees\/(\d+)$/i);
  const actionMatch = action.match(/\bDELETE\s+\/api\/employees\/(\d+)/i);
  const targetId = log?.target_employee_id || metadata.targetRecord || pathMatch?.[1] || actionMatch?.[1] || null;
  return {
    action,
    metadata,
    method,
    path,
    statusCode: metadata.statusCode,
    employeeDeleteTargetId: targetId && (pathMatch || actionMatch || /EMPLOYEE_SOFT_DELETED/i.test(action)) ? targetId : null,
    isEmployeeDelete: Boolean(pathMatch || actionMatch || /EMPLOYEE_SOFT_DELETED/i.test(action)),
  };
}

function auditLeaveActionText(log) {
  if (String(log?.module || '').trim().toUpperCase() !== 'LEAVE') return '';
  const action = String(log?.action_performed || '').trim();
  const normalized = action.toLowerCase().replace(/[\s-]+/g, '_');
  const leaveLabels = {
    leave_created: 'Leave filed',
    leave_manual_encoded: 'Manual leave encoded',
    leave_payroll_approved: 'Leave payroll approved',
    leave_approved: 'Leave approved',
    leave_rejected: 'Leave rejected',
    leave_cancelled: 'Leave cancelled',
    leave_updated: 'Leave status updated',
    leave_balance_adjusted: 'Leave balance adjusted',
    leave_type_created: 'Leave type created',
    leave_type_updated: 'Leave type updated',
    leave_sensitive_details_revealed: 'Leave details revealed',
    leave_attachment_downloaded: 'Leave attachment downloaded',
  };
  if (leaveLabels[normalized]) return leaveLabels[normalized];
  if (/leave approved/i.test(action)) return 'Leave approved';
  if (/leave rejected/i.test(action)) return 'Leave rejected';
  if (/leave filed|leave created/i.test(action)) return 'Leave filed';

  const write = auditWriteMetadata(log);
  const path = String(write.path || '').toLowerCase();
  const method = String(write.method || '').toUpperCase();
  if (method === 'POST' && path === '/api/leave') return 'Leave filed';
  if (method === 'PATCH' && /^\/api\/leave\/\d+\/status$/.test(path)) return 'Leave status updated';
  if (method === 'PUT' && path === '/api/leave/balances') return 'Leave balance adjusted';
  if (method === 'POST' && path === '/api/leave/types') return 'Leave type saved';
  if (/^\/api\/leave\/\d+\/reveal-sensitive$/.test(path)) return 'Leave details revealed';
  if (/^\/api\/leave\/\d+\/attachment$/.test(path)) return 'Leave attachment downloaded';
  return '';
}

function auditRequestContext(log) {
  const write = auditWriteMetadata(log);
  const action = String(log?.action_performed || '');
  const methodPath = action.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s|]+)/i);
  return {
    method: String(write.method || methodPath?.[1] || '').toUpperCase(),
    path: String(write.path || methodPath?.[2] || '').split('?')[0].toLowerCase(),
  };
}

function auditStatusActionText(log, fallback) {
  const newValue = auditJsonObject(log?.new_value) || {};
  const status = String(newValue.status || newValue.approval_status || newValue.final_pay_status || newValue.payroll_clearance_status || '').trim();
  return status ? `${fallback}: ${status}` : fallback;
}

function auditSpecificActionText(log) {
  const { method, path } = auditRequestContext(log);
  if (!path) return '';

  if (path === '/api/admin/register-role' && method === 'POST') return 'User account created';
  if (/^\/api\/admin\/update-role\/\d+$/.test(path) && method === 'PUT') return 'User role updated';
  if (/^\/api\/admin\/users\/\d+\/reset-password$/.test(path)) return 'User password reset';
  if (/^\/api\/admin\/users\/\d+\/credentials$/.test(path)) return 'User credentials updated';
  if (/^\/api\/admin\/users\/\d+\/unlock$/.test(path)) return 'User account unlocked';
  if (/^\/api\/admin\/users\/\d+\/reset-mfa$/.test(path)) return 'User MFA reset';
  if (/^\/api\/admin\/users\/\d+\/revoke-sessions$/.test(path)) return 'User sessions revoked';
  if (/^\/api\/admin\/users\/\d+\/deactivate$/.test(path)) return 'User account deactivated';
  if (/^\/api\/admin\/users\/\d+\/activate$/.test(path)) return 'User account reactivated';
  if (path.startsWith('/api/admin/system-health/check')) return 'System health check run';
  if (path === '/api/admin/support-tickets' && method === 'POST') return 'Support ticket created';
  if (/^\/api\/admin\/support-tickets\/\d+$/.test(path)) return auditStatusActionText(log, 'Support ticket status updated');
  if (path === '/api/admin/backups/request') return 'Backup request created';
  if (/^\/api\/admin\/backups\/\d+$/.test(path)) return auditStatusActionText(log, 'Backup request status updated');

  if (path === '/api/form-drafts') return 'Form draft saved';
  if (path === '/api/form-drafts/status') return 'Form draft status updated';
  if (path === '/api/employees/id-config') return 'Employee ID format updated';
  if (path === '/api/employees' && method === 'POST') return 'Employee record created';
  if (/^\/api\/employees\/\d+$/.test(path) && method === 'PUT') return 'Employee profile updated';
  if (/^\/api\/employees\/\d+$/.test(path) && method === 'DELETE') return 'Employee record deletion requested';
  if (/^\/api\/employees\/\d+\/status$/.test(path)) return auditStatusActionText(log, 'Employee status updated');
  if (/^\/api\/employees\/\d+\/reveal-sensitive$/.test(path)) return 'Employee sensitive fields revealed';
  if (/^\/api\/employees\/\d+\/offboard$/.test(path)) return 'Employee offboarding requested';
  if (/^\/api\/employees\/\d+\/reonboard$/.test(path)) return 'Employee re-onboarding requested';
  if (/^\/api\/employees\/offboarding\/\d+$/.test(path)) return auditStatusActionText(log, 'Employee offboarding case updated');
  if (/^\/api\/employees\/offboarding\/\d+\/documents$/.test(path)) return 'Offboarding document uploaded';
  if (/^\/api\/employees\/\d+\/documents$/.test(path)) return 'Employee document uploaded';
  if (/^\/api\/employees\/\d+\/documents\/\d+$/.test(path)) return 'Employee document deleted';
  if (/^\/api\/employees\/\d+\/photo$/.test(path)) return method === 'DELETE' ? 'Employee profile photo removed' : 'Employee profile photo uploaded';
  const employeeNested = path.match(/^\/api\/employees\/\d+\/(family|work-experiences|certifications|trainings|skills)(?:\/\d+)?$/);
  if (employeeNested) {
    const label = employeeNested[1].replaceAll('-', ' ');
    return method === 'DELETE' ? `Employee ${label} deleted` : `Employee ${label} added`;
  }
  if (path === '/api/employee-setup/departments') return 'Department created';
  if (/^\/api\/employee-setup\/departments\/\d+$/.test(path)) return method === 'DELETE' ? 'Department deleted' : 'Department updated';
  if (path === '/api/employee-setup/positions') return 'Position created';
  if (/^\/api\/employee-setup\/positions\/\d+$/.test(path)) return method === 'DELETE' ? 'Position deleted' : 'Position updated';

  if (path === '/api/attendance/manual') return 'Manual attendance encoded';
  if (/^\/api\/attendance\/\d+\/override$/.test(path)) return 'Attendance time record corrected';
  if (/^\/api\/attendance\/\d+\/verify$/.test(path)) return auditStatusActionText(log, 'Attendance verification updated');
  if (/^\/api\/attendance\/\d+\/overtime$/.test(path)) return 'Attendance overtime encoded';
  if (/^\/api\/attendance\/\d+\/overtime-review$/.test(path)) return auditStatusActionText(log, 'Overtime review decision recorded');
  if (path === '/api/attendance/policies') return 'Attendance policy updated';
  if (path === '/api/attendance/biometric/devices') return 'Biometric device registered';
  if (/^\/api\/attendance\/biometric\/devices\/\d+$/.test(path)) return 'Biometric device updated';
  if (path === '/api/attendance/biometric/mappings') return 'Biometric employee mapping created';
  if (/^\/api\/attendance\/biometric\/mappings\/\d+$/.test(path)) return 'Biometric employee mapping deleted';
  if (/^\/api\/attendance\/biometric\/sync\/\d+$/.test(path)) return 'Biometric attendance sync started';
  if (path === '/api/attendance/integrity/anchor-pending') return 'Pending attendance hashes anchored';
  if (/^\/api\/attendance\/geofence\/\d+$/.test(path)) return 'Attendance geofence updated';
  if (path === '/api/biometric/attendance') return 'Biometric attendance event recorded';
  if (path === '/api/biometric/bridge-commands') return 'Biometric bridge command queued';

  if (path === '/api/requests') return 'Employee request submitted';
  if (/^\/api\/requests\/\d+\/status$/.test(path)) return auditStatusActionText(log, 'Employee request status updated');
  if (path === '/api/payroll/runs') return 'Payroll run created';
  if (/^\/api\/payroll\/runs\/\d+\/approve$/.test(path)) return 'Payroll run approved';
  if (path === '/api/payroll/salary-calculation') return 'Draft salary calculation created';
  if (path === '/api/payroll/generate/preview') return 'Payroll generation previewed';
  if (path === '/api/payroll/generate') return 'Payroll generated';
  if (/^\/api\/payroll\/salary-calculations\/\d+\/recalculate$/.test(path)) return 'Salary calculation recalculated';
  if (/^\/api\/payroll\/salary-calculations\/\d+\/status$/.test(path)) return auditStatusActionText(log, 'Salary calculation status updated');
  if (path === '/api/payroll/convert-calculations-to-payslips') return 'Payslips generated from salary calculations';
  if (path.includes('/government-contributions/reveal')) return 'Government contribution details revealed';
  if (path.includes('/reveal-remarks')) return 'Payroll remarks revealed';
  if (path === '/api/payroll/transactions/production') return 'Production payroll log encoded';
  if (path === '/api/payroll/transactions/logistics') return 'Logistics trip payroll log encoded';
  if (/^\/api\/payroll\/piece-rate-outputs\/\d+\/submit$/.test(path)) return 'Piece-rate output submitted for review';
  if (/^\/api\/payroll\/piece-rate-outputs\/\d+\/approve$/.test(path)) return 'Piece-rate output approved';
  if (/^\/api\/payroll\/piece-rate-outputs\/\d+\/reject$/.test(path)) return 'Piece-rate output rejected';
  if (/^\/api\/payroll\/piece-rate-outputs(?:\/\d+)?$/.test(path)) return method === 'DELETE' ? 'Piece-rate output deleted' : method === 'PATCH' ? 'Piece-rate output updated' : 'Piece-rate output encoded';
  if (/^\/api\/payroll\/logistics\/trips\/\d+\/submit$/.test(path)) return 'Logistics trip log submitted for review';
  if (/^\/api\/payroll\/logistics\/trips\/\d+\/approve$/.test(path)) return 'Logistics trip log approved';
  if (/^\/api\/payroll\/logistics\/trips\/\d+\/reject$/.test(path)) return 'Logistics trip log rejected';
  if (/^\/api\/payroll\/logistics\/trips(?:\/\d+)?$/.test(path)) return method === 'DELETE' ? 'Logistics trip log deleted' : method === 'PUT' ? 'Logistics trip log updated' : 'Logistics trip log encoded';
  if (path.includes('/deduction-settings')) return method === 'DELETE' ? 'Deduction setting deleted' : 'Deduction setting saved';
  if (path.includes('/sss-tables')) return path.endsWith('/preview') ? 'SSS table import previewed' : path.endsWith('/activate') ? 'SSS table activated' : 'SSS table imported';
  if (path.includes('/employee-cash-advances')) return 'Employee cash advance saved';
  if (path.includes('/employee-loans')) return 'Employee loan saved';
  if (path.includes('/employee-deductions')) return auditStatusActionText(log, 'Employee deduction status updated');
  if (path.includes('/policy-settings')) return 'Payroll policy setting saved';
  if (path.includes('/attendance-configurations')) return method === 'DELETE' ? 'Payroll attendance configuration deleted' : 'Payroll attendance configuration saved';
  if (/^\/api\/payroll\/employees\/\d+\/wage-config$/.test(path)) return 'Employee wage configuration saved';
  if (path.includes('/logistics/') || path.includes('/piece-') || path.includes('/sew-types') || path.includes('/size-ranges') || path.includes('/production-share')) {
    return method === 'DELETE' ? 'Payroll configuration deleted' : 'Payroll configuration saved';
  }
  if (/^\/api\/payroll\/offboarding-clearance\/\d+$/.test(path)) return auditStatusActionText(log, 'Payroll offboarding clearance updated');
  if (/^\/api\/payroll\/final-pay-approval\/\d+$/.test(path)) return auditStatusActionText(log, 'Final pay approval updated');

  if (path === '/api/onboarding/integrity/anchor-pending') return 'Pending onboarding hashes anchored';
  if (path === '/api/onboarding/positions') return 'Onboarding position created';
  if (/^\/api\/onboarding\/positions\/[^/]+$/.test(path)) return method === 'DELETE' ? 'Onboarding position deleted' : 'Onboarding position updated';
  if (path === '/api/onboarding/applicants') return 'Applicant record created';
  if (/^\/api\/onboarding\/applicants\/\d+\/progress$/.test(path)) return auditStatusActionText(log, 'Applicant progress updated');
  if (/^\/api\/onboarding\/applicants\/\d+\/decision$/.test(path)) return auditStatusActionText(log, 'Applicant hiring decision recorded');
  if (/^\/api\/onboarding\/applicants\/\d+\/transfer$/.test(path)) return 'Applicant transferred to employee directory';
  if (/^\/api\/onboarding\/applicants\/\d+\/reveal-sensitive$/.test(path)) return 'Applicant sensitive details revealed';
  if (/^\/api\/onboarding\/applicants\/\d+$/.test(path)) return 'Applicant removed from active onboarding';
  if (/^\/api\/onboarding\/applicants\/\d+\/documents$/.test(path)) return 'Applicant document uploaded';
  if (/^\/api\/onboarding\/applicants\/\d+\/documents\/\d+\/verify$/.test(path)) return 'Applicant document verification updated';

  if (path === '/api/self-service/profile') return 'Employee self-service profile updated';
  if (path === '/api/self-service/password') return 'Employee password changed';
  if (path === '/api/self-service/profile-picture') return 'Employee profile picture changed';
  if (/^\/api\/self-service\/restricted-fields\/[^/]+\/reveal$/.test(path)) return 'Self-service restricted field revealed';
  if (path === '/api/self-service/change-requests') return 'Profile change request submitted';
  if (/^\/api\/self-service\/change-requests\/\d+\/reveal$/.test(path)) return 'Profile change request details revealed';
  if (/^\/api\/hr\/profile-change-requests\/\d+\/approve$/.test(path)) return 'Profile change request approved';
  if (/^\/api\/hr\/profile-change-requests\/\d+\/reject$/.test(path)) return 'Profile change request rejected';
  if (path.startsWith('/api/reports')) return 'Report generated or exported';
  if (/^\/api\/blockchain\/payroll\/finalize\/\d+$/.test(path)) return 'Final payroll recorded on blockchain';
  if (/^\/api\/blockchain\/payroll\/adjustment\/\d+$/.test(path)) return 'Payroll blockchain adjustment recorded';
  if (/^\/api\/blockchain\/dtr\/generate\/\d+$/.test(path)) return 'DTR blockchain hash generated';
  if (/^\/api\/blockchain\/dtr\/anchor\/\d+$/.test(path)) return 'DTR record anchored on blockchain';
  if (/^\/api\/blockchain\/dtr\/adjustment\/\d+$/.test(path)) return 'DTR blockchain adjustment recorded';
  return '';
}

function auditActionText(log) {
  const actionType = String(log?.action_type || '').trim().toUpperCase();
  const action = String(log?.action_performed || '').trim();
  const write = auditWriteMetadata(log);
  if (write.isEmployeeDelete) return 'Employee record deletion requested';
  const leaveAction = auditLeaveActionText(log);
  if (leaveAction) return leaveAction;
  const specificAction = auditSpecificActionText(log);
  if (specificAction) return specificAction;
  const authLabels = {
    LOGIN_SUCCESS: 'Successful login recorded',
    LOGIN_FAILED: 'Failed login attempt recorded',
    LOGIN_BLOCKED_LOCKED_ACCOUNT: 'Locked-account login attempt blocked',
    LOGIN_CAPTCHA_FAILED: 'Login human verification failed',
    LOGIN_CAPTCHA_UNAVAILABLE: 'Login human verification unavailable',
    LOGOUT_SUCCESS: 'Successful logout recorded',
    MFA_NOT_REQUIRED: 'Non-privileged login did not require MFA',
    MFA_CHALLENGE_CREATED: 'MFA challenge created',
    MFA_CHALLENGE_EXPIRED: 'MFA challenge expired',
    MFA_VERIFICATION_FAILED: 'MFA verification failed',
    MFA_TOO_MANY_ATTEMPTS: 'MFA challenge locked after failed attempts',
    MFA_TOTP_ENROLLMENT_STARTED: 'TOTP MFA enrollment started',
  };
  if (authLabels[actionType]) return authLabels[actionType];
  if (!action) return '—';
  const displayAction = action.replace(/^(SUCCESS|FAILED|BLOCKED):\s*/i, '').trim();
  if (/failed_unauthorized_access_attempt/i.test(displayAction)) return 'Unauthorized access attempt blocked';
  if (/failed_permission_check/i.test(displayAction)) return 'Permission check failed';
  if (/blocked_client_authority_field_tampering/i.test(displayAction)) return 'Unauthorized request fields blocked';
  if (/blocked_rate_limit_exceeded/i.test(displayAction)) return 'Rate limit exceeded';
  if (/invalid_or_tampered_jwt_attempt/i.test(displayAction)) return 'Invalid session token attempt blocked';
  if (/expired_jwt_attempt/i.test(displayAction)) return 'Expired session token rejected';
  if (/log_integrity_blocked/i.test(displayAction)) return 'Audit log tampering attempt blocked';
  if (auditLooksBackendOnly(displayAction)) return `${auditModuleLabel(log?.module)} activity recorded`;
  return displayAction;
}

function auditSourceText(log) {
  const source = String(log?.source_table || '').trim();
  if (!source) return '—';
  if (/^[a-z0-9_]+$/i.test(source)) return 'Audit log';
  if (auditLooksBackendOnly(source)) return 'Audit log';
  return source;
}

function auditDetails(log) {
  const parts = [];
  const write = auditWriteMetadata(log);
  if (write.isEmployeeDelete && write.statusCode) parts.push(`Status: ${write.statusCode}`);
  const actionType = String(log.action_type || '').trim().toUpperCase();
  if (log.action_type && actionType !== 'SYSTEM_EVENT' && !auditLooksBackendOnly(log.action_type)) parts.push(`Event: ${log.action_type}`);
  if (log.field_changed && !auditLooksBackendOnly(log.field_changed)) parts.push(`Field: ${log.field_changed}`);
  if (log.details && !auditLooksBackendOnly(log.details)) parts.push(log.details);

  const oldValue = auditShortValue(log.old_value);
  const newValue = auditShortValue(log.new_value);
  if (oldValue || newValue) {
    if (oldValue && newValue) parts.push(`${oldValue} to ${newValue}`);
    else parts.push(oldValue || newValue);
  }

  const details = parts.filter(Boolean).join(' | ');
  return details ? (details.length > 140 ? `${details.slice(0, 140)}…` : details) : '—';
}

function auditTarget(log) {
  const write = auditWriteMetadata(log);
  if (write.employeeDeleteTargetId) return `Employee #${write.employeeDeleteTargetId}`;
  if (log.target_employee_id) return `Employee #${log.target_employee_id}`;
  if (log.employee_id) return `Employee #${log.employee_id}`;
  return '—';
}

function auditAnomalyLabel(log) {
  const label = String(log?.anomaly_label || '').trim();
  const type = String(log?.anomaly_type || '').trim().toUpperCase();
  if (label) return label;
  const labels = {
    SQL_INJECTION: 'SQLi Pattern',
    XSS: 'XSS Pattern',
    BRUTE_FORCE: 'Brute Force',
    SESSION_MANIPULATION: 'Session Manipulation',
  };
  return labels[type] || '';
}

function auditAnomalyClass(log) {
  const severity = String(log?.anomaly_severity || '').trim().toLowerCase();
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'none';
}

function auditThreatBadge(log) {
  const label = auditAnomalyLabel(log);
  if (!label) return '<span class="audit-threat-badge audit-threat-none">None</span>';
  const severity = String(log?.anomaly_severity || '').trim() || 'Medium';
  return `<span class="audit-threat-badge audit-threat-${sysEsc(auditAnomalyClass(log))}" title="${sysEsc(log?.anomaly_reason || label)}">${sysEsc(label)} · ${sysEsc(severity)}</span>`;
}

function renderAuditLog(logs) {
  const tbody = sysAuditTbody();
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No audit entries found.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const ts = sysFormatDateTime(log.timestamp);
    const moduleName = log.module || 'SYSTEM';
    const moduleLevel = auditModuleLevel(moduleName);
    const actor = log.admin_username || (log.user_id ? `User #${log.user_id}` : 'System');
    const resultOrIp = [log.result, log.ip_address].filter(Boolean).join(' / ') || '—';

    return `
      <tr>
        <td><small>${sysEsc(ts)}</small></td>
        <td><span class="badge-level badge-level-${moduleLevel}">${sysEsc(moduleName)}</span></td>
        <td style="max-width:260px;word-break:break-word;"><small>${sysEsc(auditActionText(log))}</small></td>
        <td>${sysEsc(actor)}</td>
        <td><small>${sysEsc(auditTarget(log))}</small></td>
        <td><small>${sysEsc(resultOrIp)}</small></td>
        <td><small>${sysEsc(auditSourceText(log))}</small></td>
        <td>${auditThreatBadge(log)}</td>
        <td><small style="color:var(--muted)">${sysEsc(auditDetails(log))}</small></td>
      </tr>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// REGISTRATION MODAL
// ═══════════════════════════════════════════════════════════════

async function ensureSysAdminEmployeesLoaded() {
  if (sysAllEmployees.length) return;
  const empRes = await apiFetch('/api/employees');
  if (!empRes || !empRes.ok) throw new Error('Failed to load employee directory.');
  const nextEmployees = await empRes.json();
  const nextEmployeesSignature = sysEmployeeDataSignature(nextEmployees);
  sysAllEmployees = nextEmployees;
  sysEmployeesDataSignature = nextEmployeesSignature;
}

async function showRegisterModal() {
  sysCurrentStep = 1;
  updateStepUI();

  // Clear form
  document.getElementById('reg-employee-id').value = '';
  document.getElementById('reg-username').value = '';
  document.getElementById('reg-password').value = '';
  document.getElementById('reg-password-confirm').value = '';
  document.getElementById('reg-role-id').value = '';
  document.getElementById('reg-employee-preview').style.display = 'none';
  document.getElementById('register-modal-title').textContent = 'Register New Account';

  // Populate employee dropdown (only unlinked employees)
  const empSelect = document.getElementById('reg-employee-id');
  empSelect.innerHTML = '<option value="">Loading employees...</option>';
  try {
    await ensureSysAdminEmployeesLoaded();
  } catch (error) {
    empSelect.innerHTML = '<option value="">Unable to load employee directory</option>';
    showSysToast(error.message || 'Failed to load employee directory.', 'error');
    return;
  }
  const linkedIds = sysAllUsers.map(u => u.employee_id).filter(Boolean);
  
  empSelect.innerHTML = '<option value="">— Choose an employee —</option>' +
    sysAllEmployees
      .filter(e => !linkedIds.includes(e.id))
      .map(e => `<option value="${e.id}">${e.employee_code} — ${e.first_name} ${e.last_name}</option>`)
      .join('');

  // Also add linked employees with a note
  const linkedOptions = sysAllEmployees
    .filter(e => linkedIds.includes(e.id))
    .map(e => `<option value="${e.id}">${e.employee_code} — ${e.first_name} ${e.last_name} (has account)</option>`)
    .join('');
  if (linkedOptions) {
    empSelect.innerHTML += '<optgroup label="── Already have account ──">' + linkedOptions + '</optgroup>';
  }

  // Populate role dropdown
  const roleSelect = document.getElementById('reg-role-id');
  roleSelect.innerHTML = '<option value="">— Select Role —</option>' +
    sysAssignableRoles().map(r => `<option value="${r.id}">${sysEsc(r.label)} (${sysEsc(r.access_level || '—')})</option>`).join('');

  document.getElementById('register-modal').style.display = 'flex';
}

function closeRegisterModal() {
  document.getElementById('register-modal').style.display = 'none';
}

function onEmployeeSelect() {
  const empId = parseInt(document.getElementById('reg-employee-id').value);
  const preview = document.getElementById('reg-employee-preview');

  if (!empId) {
    preview.style.display = 'none';
    return;
  }

  const emp = sysAllEmployees.find(e => e.id === empId);
  if (!emp) return;

  document.getElementById('preview-name').textContent = `${emp.first_name} ${emp.last_name}`;
  document.getElementById('preview-code').textContent = emp.employee_code || '—';
  document.getElementById('preview-dept').textContent = emp.department || '—';
  document.getElementById('preview-position').textContent = emp.position || '—';

  // Check if they already have an account
  const existingUser = sysAllUsers.find(u => u.employee_id === empId);
  if (existingUser) {
    document.getElementById('preview-account').innerHTML =
      `<span style="color:#fdcb6e">${sysEsc(existingUser.username)} (${sysEsc(sysRoleLabelForUser(existingUser))})</span>`;
    document.getElementById('register-modal-title').textContent = 'Update Existing Account';
    // Pre-fill username
    document.getElementById('reg-username').value = existingUser.username;
  } else {
    document.getElementById('preview-account').textContent = 'None — new account will be created';
    document.getElementById('register-modal-title').textContent = 'Register New Account';
    // Auto-generate username suggestion
    const suggested = `${emp.first_name.toLowerCase()}.${emp.last_name.toLowerCase()}`.replace(/[^a-z0-9.-]/g, '');
    document.getElementById('reg-username').value = suggested;
  }

  preview.style.display = 'block';
}

// ── Step Navigation ─────────────────────────────────────────
function validateRegistrationAccountSetup() {
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-password-confirm').value;
  const roleId   = document.getElementById('reg-role-id').value;

  if (!username) { showSysToast('Username is required.', 'error'); return false; }
  if (!/^[a-z0-9._-]+$/.test(username)) { showSysToast('Username can only contain lowercase letters, numbers, dots, hyphens.', 'error'); return false; }
  const passwordErrors = sysPasswordErrors(password);
  if (passwordErrors.length) { showSysToast(passwordErrors[0], 'error'); return false; }
  if (password !== confirm) { showSysToast('Passwords do not match.', 'error'); return false; }
  if (!roleId) { showSysToast('Please select a role.', 'error'); return false; }
  return true;
}

function regStepNext() {
  if (sysCurrentStep === 1) {
    if (!document.getElementById('reg-employee-id').value) {
      showSysToast('Please select an employee.', 'error');
      return;
    }
  }
  if (sysCurrentStep === 2) {
    if (!validateRegistrationAccountSetup()) return;
  }

  if (sysCurrentStep < 2) {
    sysCurrentStep++;
    updateStepUI();
  }
}

function regStepBack() {
  if (sysCurrentStep > 1) {
    sysCurrentStep--;
    updateStepUI();
  }
}

function updateStepUI() {
  // Update step indicators
  document.querySelectorAll('.modal-steps .step').forEach(s => {
    const stepNum = parseInt(s.getAttribute('data-step'));
    s.classList.remove('active', 'completed');
    if (stepNum === sysCurrentStep) s.classList.add('active');
    if (stepNum < sysCurrentStep) s.classList.add('completed');
  });

  // Show/hide step content
  document.querySelectorAll('#register-modal .modal-step-content').forEach(content => {
    content.classList.toggle('active', content.id === `reg-step-${sysCurrentStep}`);
  });

  // Show/hide buttons
  document.getElementById('btn-reg-back').style.display = sysCurrentStep > 1 ? 'inline-flex' : 'none';
  document.getElementById('btn-reg-next').style.display = sysCurrentStep < 2 ? 'inline-flex' : 'none';
  document.getElementById('btn-reg-submit').style.display = sysCurrentStep === 2 ? 'inline-flex' : 'none';
}

// ── Submit Registration ─────────────────────────────────────
async function submitRegistration() {
  const employeeId = parseInt(document.getElementById('reg-employee-id').value);
  const username   = document.getElementById('reg-username').value.trim().toLowerCase();
  const password   = document.getElementById('reg-password').value;
  const roleId     = parseInt(document.getElementById('reg-role-id').value);

  if (!employeeId) {
    showSysToast('Please select an employee.', 'error');
    return;
  }
  if (!validateRegistrationAccountSetup()) return;

  try {
    const submitBtn = document.getElementById('btn-reg-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';

    const payload = {
      employee_id: employeeId,
      username,
      password,
      role_id: roleId,
    };

    const res = await apiFetch('/api/admin/register-role', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.ok) {
      showSysToast(data.message, 'success');
      closeRegisterModal();
      loadUsersTable();
    } else {
      showSysToast(data.message || data.error || 'Account registration failed.', 'error');
    }
  } catch (err) {
    console.error('[SysAdmin] submitRegistration error:', err);
    showSysToast('Network error. Please try again.', 'error');
  } finally {
    const submitBtn = document.getElementById('btn-reg-submit');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Register Account';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ROLE UPDATE MODAL
// ═══════════════════════════════════════════════════════════════

function showRoleModal(userId, username, currentRole, currentRoleId) {
  if (!sysAllRoles.length) {
    showSysToast('Role data is still loading. Please try again.', 'error');
    return;
  }
  document.getElementById('role-modal-username').textContent = username;
  document.getElementById('role-modal-current').textContent = currentRole;
  document.getElementById('role-modal-user-id').value = userId;

  const roleSelect = document.getElementById('role-modal-new-role');
  roleSelect.innerHTML = sysAssignableRoles()
    .map(r => `<option value="${r.id}" ${Number(r.id) === Number(currentRoleId) ? 'selected' : ''}>${sysEsc(r.label)} (${sysEsc(r.access_level || '—')})</option>`)
    .join('');

  document.getElementById('role-modal').style.display = 'flex';
}

function closeRoleModal() {
  document.getElementById('role-modal').style.display = 'none';
}

async function submitRoleUpdate() {
  const userId = parseInt(document.getElementById('role-modal-user-id').value);
  const roleId = parseInt(document.getElementById('role-modal-new-role').value);

  try {
    const res = await apiFetch(`/api/admin/update-role/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ role_id: roleId }),
    });

    const data = await res.json();

    if (res.ok) {
      showSysToast(data.message, 'success');
      closeRoleModal();
      loadUsersTable();
    } else {
      showSysToast(data.error || 'Role update failed.', 'error');
    }
  } catch (err) {
    console.error('[SysAdmin] submitRoleUpdate error:', err);
    showSysToast('Network error.', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// ACCOUNT ACTIVATE / DEACTIVATE
// ═══════════════════════════════════════════════════════════════

async function toggleUserStatus(userId, activate) {
  const action = activate ? 'activate' : 'deactivate';
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm(`Are you sure you want to ${action} this account?`, 'Account Status', activate ? 'Activate' : 'Deactivate', 'Cancel')
    : confirm(`Are you sure you want to ${action} this account?`);
  if (!confirmed) return;

  try {
    const res = await apiFetch(`/api/admin/users/${userId}/${action}`, { method: 'PATCH' });
    const data = await res.json();

    if (res.ok) {
      showSysToast(`Account ${action}d.`, 'success');
      loadUsersTable();
    } else {
      showSysToast(data.error || 'Account status update failed.', 'error');
    }
  } catch (err) {
    showSysToast('Network error.', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// EDIT CREDENTIALS MODAL
// ═══════════════════════════════════════════════════════════════

async function unlockUserAccount(userId) {
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Clear this account lockout?', 'Clear Lockout', 'Clear', 'Cancel')
    : confirm('Clear this account lockout?');
  if (!confirmed) return;
  try {
    const res = await apiFetch(`/api/admin/users/${userId}/unlock`, { method: 'PATCH' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Account unlock failed.');
    showSysToast(data.message || 'Account lockout cleared.', 'success');
    loadUsersTable();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

async function revokeUserSessions(userId) {
  const reason = typeof showPrompt === 'function'
    ? await showPrompt('Reason for session revocation:', 'Revoke Sessions', 'support_request')
    : prompt('Reason for session revocation:', 'support_request');
  if (reason === null) return;
  try {
    const res = await apiFetch(`/api/admin/users/${userId}/revoke-sessions`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Session revocation failed.');
    showSysToast(`${data.message || 'Sessions revoked.'} (${Number(data.revoked_sessions || 0)})`, 'success');
    loadUsersTable();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

async function resetUserMfa(userId) {
  const reason = typeof showPrompt === 'function'
    ? await showPrompt('Reason for MFA reset after identity verification:', 'Reset MFA', '')
    : prompt('Reason for MFA reset after identity verification:');
  if (reason === null) return;
  if (reason.trim().length < 8) {
    showSysToast('Reason must be at least 8 characters.', 'error');
    return;
  }
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Confirm identity was verified before resetting MFA.', 'Identity Verification', 'Confirm', 'Cancel')
    : confirm('Confirm identity was verified before resetting MFA.');
  if (!confirmed) return;
  try {
    const res = await apiFetch(`/api/admin/users/${userId}/reset-mfa`, {
      method: 'PATCH',
      body: JSON.stringify({ identity_verified: true, reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'MFA reset failed.');
    showSysToast(data.message || 'MFA enrollment reset.', 'success');
    loadUsersTable();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

function showCredentialsModal(userId, username) {
  document.getElementById('cred-modal-user-id').value = userId;
  document.getElementById('cred-modal-username-display').textContent = username;
  document.getElementById('cred-modal-username').value = username;
  document.getElementById('cred-modal-password').value = '';
  document.getElementById('cred-modal-password-confirm').value = '';
  const generated = document.getElementById('cred-modal-generated');
  if (generated) {
    generated.textContent = '';
    generated.style.display = 'none';
  }
  document.getElementById('credentials-modal').style.display = 'flex';
}

function closeCredentialsModal() {
  document.getElementById('credentials-modal').style.display = 'none';
}

async function submitCredentialsUpdate() {
  const userId = parseInt(document.getElementById('cred-modal-user-id').value);
  const password = document.getElementById('cred-modal-password').value;
  const confirm = document.getElementById('cred-modal-password-confirm').value;
  const generated = document.getElementById('cred-modal-generated');

  if (password) {
    const passwordErrors = sysPasswordErrors(password);
    if (passwordErrors.length) { showSysToast(passwordErrors[0], 'error'); return; }
    if (password !== confirm) { showSysToast('Passwords do not match.', 'error'); return; }
  }

  try {
    const res = await apiFetch(`/api/admin/users/${userId}/reset-password`, {
      method: 'PUT',
      body: JSON.stringify(password ? { temporaryPassword: password } : {}),
    });

    const data = await res.json();

    if (res.ok) {
      showSysToast(data.message, 'success');
      if (data.temporaryPassword && generated) {
        generated.textContent = `Generated temporary password: ${data.temporaryPassword}`;
        generated.style.display = 'block';
      } else {
        closeCredentialsModal();
      }
      loadUsersTable();
    } else {
      showSysToast(data.error || 'Credentials update failed.', 'error');
    }
  } catch (err) {
    console.error('[SysAdmin] submitCredentialsUpdate error:', err);
    showSysToast('Network error.', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// PASSWORD VISIBILITY & STRENGTH
// ═══════════════════════════════════════════════════════════════

function togglePasswordVisibility() {
  const input = document.getElementById('reg-password');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function toggleCredPasswordVisibility() {
  const input = document.getElementById('cred-modal-password');
  input.type = input.type === 'password' ? 'text' : 'password';
}

// ═══════════════════════════════════════════════════════════════
// BIOMETRIC DEVICE SETTINGS
// ═══════════════════════════════════════════════════════════════

function sysSetText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value ?? '-';
}

function sysShortHash(value) {
  const text = String(value || '');
  return text.length > 16 ? `${text.slice(0, 10)}...${text.slice(-6)}` : (text || '-');
}

function sysStatusBadge(status) {
  const normalized = String(status || '').trim().toUpperCase();
  const good = ['ACTIVE', 'APPROVED', 'COMPLETED', 'DRY_RUN_PASSED', 'INTEGRITY_VERIFIED', 'PASSED', 'VERIFIED', 'RESOLVED', 'CLOSED', 'RECORDED', 'COVERED', 'YES', 'AVAILABLE', 'ONLINE', 'HEALTHY', 'RESTORED', 'USABLE'];
  const bad = ['FAILED', 'CRITICAL', 'DRY_RUN_FAILED', 'INTEGRITY_FAILED', 'REJECTED', 'VERIFICATION_FAILED', 'INACTIVE', 'NOT AVAILABLE', 'NOT COVERED', 'NOT RESTORABLE', 'NOT USABLE', 'NO', 'OFFLINE'];
  const warn = ['AWAITING_APPROVAL', 'HIGH', 'OPEN', 'IN_PROGRESS', 'VERIFYING', 'DRY_RUN_IN_PROGRESS', 'WAITING_FOR_OWNER', 'REQUESTED', 'RUNNING', 'PENDING', 'PENDING_ANCHOR', 'NOT CHECKED', 'NOT RUN', 'NOT VERIFIED', 'REQUIRED', 'WARNING', 'MAINTENANCE'];
  const cls = good.includes(normalized)
    ? 'badge-active'
    : bad.includes(normalized)
      ? 'badge-inactive'
      : warn.includes(normalized)
        ? 'badge-locked'
        : 'badge-clear';
  return `<span class="${cls}">${sysEsc(normalized || '-')}</span>`;
}

function renderSupportKvList(id, entries) {
  const target = document.getElementById(id);
  if (!target) return;
  target.innerHTML = entries.map(([label, value]) => `
    <div class="support-kv-row">
      <span>${sysEsc(label)}</span>
      <strong>${sysEsc(value ?? '-')}</strong>
    </div>
  `).join('');
}

function populateSupportUserSelect() {
  const select = document.getElementById('support-ticket-user');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="">None</option>' + sysAllUsers.map(user => {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
    return `<option value="${Number(user.id)}">${sysEsc(user.username)} - ${sysEsc(name)}</option>`;
  }).join('');
  if (currentValue) select.value = currentValue;
}

function buildSystemHealthFallbackModules(reason = '') {
  const remarks = reason || 'The running backend returned the old health snapshot. Restart the Node server to load the module diagnostics.';
  return SYS_HEALTH_FALLBACK_MODULES.map(([moduleKey, moduleName, endpoint]) => ({
    module_key: moduleKey,
    module_name: moduleName,
    status: 'WARNING',
    remarks,
    response_time_ms: null,
    endpoint_checked: endpoint,
    dependency_status: {
      backend_route: {
        label: 'Health-check API route',
        available: false,
        status: 'Server restart required',
      },
    },
    dependencies: [],
    error_message: 'Health-check API route is not loaded in the running server process.',
    last_checked_at: sysHealthSnapshot?.generated_at || null,
    last_success_at: null,
    last_failure_at: null,
    recommended_action: 'Stop the current npm start process, start it again, then press Run Health Check.',
    affected_area: 'System Health diagnostics endpoint and module detail loading.',
    probable_cause: 'The browser loaded updated static files, but the running Node process has not loaded the new backend routes.',
    admin_action: 'Restart npm start, run migrations if needed, then refresh the browser.',
    runbook_steps: [
      'Stop the current npm start process.',
      'Run npm run migrate.',
      'Start npm start again and hard refresh the browser.',
    ],
    recent_logs: [],
  }));
}

function summarizeHealthModules(modules) {
  const summary = { total: modules.length, online: 0, warning: 0, offline: 0, maintenance: 0 };
  modules.forEach(module => {
    const key = String(module.status || 'WARNING').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, key)) summary[key] += 1;
  });
  return summary;
}

function setSystemHealthRunning(isRunning, options = {}) {
  sysHealthCheckRunning = Boolean(isRunning);
  sysHealthRunningModuleKey = sysHealthCheckRunning ? (options.moduleKey || null) : null;
  renderSystemHealthRunningState(options);
}

function renderSystemHealthRunningState(options = {}) {
  const statusBox = document.getElementById('health-run-status');
  const title = document.getElementById('health-run-title');
  const detail = document.getElementById('health-run-detail');
  const runButton = document.getElementById('health-run-check-btn');
  const refreshButton = document.getElementById('health-refresh-btn');
  const grid = document.getElementById('health-module-grid');
  const runningModule = sysHealthRunningModuleKey
    ? sysHealthModules.find(module => module.module_key === sysHealthRunningModuleKey)
    : null;
  const titleText = options.title || (runningModule
    ? `Checking ${runningModule.module_name}...`
    : 'Running full system health check...');
  const detailText = options.detail || (runningModule
    ? 'Please wait while this module dependency check completes.'
    : 'Please wait while the system checks all module dependencies.');

  if (statusBox) statusBox.hidden = !sysHealthCheckRunning;
  if (title) title.textContent = titleText;
  if (detail) detail.textContent = detailText;
  if (runButton) {
    runButton.disabled = sysHealthCheckRunning;
    runButton.textContent = sysHealthCheckRunning ? 'Running...' : 'Run Health Check';
  }
  if (refreshButton) refreshButton.disabled = sysHealthCheckRunning;
  if (grid) grid.setAttribute('aria-busy', sysHealthCheckRunning ? 'true' : 'false');

  document.querySelectorAll('[data-health-action="check-module"]').forEach(button => {
    button.disabled = sysHealthCheckRunning;
    button.textContent = sysHealthCheckRunning && (!sysHealthRunningModuleKey || button.dataset.moduleKey === sysHealthRunningModuleKey)
      ? 'Checking...'
      : 'Check Module';
  });
  document.querySelectorAll('.health-module-card').forEach(card => {
    card.classList.toggle('is-checking', sysHealthCheckRunning && card.dataset.moduleKey === sysHealthRunningModuleKey);
  });
}

async function loadSystemHealth() {
  try {
    const res = await apiFetch('/api/admin/system-health');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load system health.');
    sysHealthSnapshot = data;
    sysHealthModules = Array.isArray(data.modules) && data.modules.length
      ? data.modules
      : buildSystemHealthFallbackModules();
    if (Array.isArray(data.history) && data.history.length) {
      sysHealthHistory = mergeSystemHealthHistory(data.history, sysHealthHistory);
    } else if (!sysHealthHistory.length) {
      sysHealthHistory = [];
    }
    if (!data.summary || !Array.isArray(data.modules) || !data.modules.length) {
      sysHealthSnapshot.summary = summarizeHealthModules(sysHealthModules);
    }
    renderSystemHealthDashboard();

    renderSupportKvList('health-runtime-list', [
      ['Generated', sysFormatDateTime(data.generated_at)],
      ['Node', data.runtime?.node_version || '-'],
      ['Uptime', sysFormatDuration(Number(data.runtime?.uptime_seconds || 0))],
      ['Memory', `${Number(data.runtime?.memory_mb || 0)} MB`],
      ['Biometric Devices', `${Number(data.biometric?.active_devices || 0)} / ${Number(data.biometric?.total_devices || 0)}`],
    ]);

    const backup = data.backups?.last_backup;
    renderSupportKvList('health-backup-list', backup ? [
      ['Reference', backup.backup_reference],
      ['Type', backup.backup_type],
      ['Target', backup.storage_target],
      ['Status', backup.status],
      ['Created', sysFormatDateTime(backup.created_at)],
    ] : [['Status', 'No backup record']]);
  } catch (err) {
    const grid = document.getElementById('health-module-grid');
    if (grid) grid.innerHTML = `<div class="table-empty">${sysEsc(err.message || 'Failed to load system health.')}</div>`;
    showSysToast(err.message || 'Failed to load system health.', 'error');
  }
}

function sysHealthStatusBadge(status) {
  const normalized = String(status || 'WARNING').toUpperCase();
  const cls = normalized === 'ONLINE'
    ? 'badge-active'
    : normalized === 'OFFLINE'
      ? 'badge-inactive'
      : normalized === 'MAINTENANCE'
        ? 'badge-clear'
        : 'badge-locked';
  return `<span class="${cls}">${sysEsc(normalized)}</span>`;
}

function healthDependencyValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  const parts = [];
  if (Object.prototype.hasOwnProperty.call(value, 'available')) parts.push(value.available ? 'Available' : 'Missing');
  if (Object.prototype.hasOwnProperty.call(value, 'count')) parts.push(`Count: ${value.count}`);
  if (Object.prototype.hasOwnProperty.call(value, 'total')) parts.push(`Total: ${value.total}`);
  if (Object.prototype.hasOwnProperty.call(value, 'latency_ms')) parts.push(`${value.latency_ms} ms`);
  if (value.table) parts.push(`Table: ${value.table}`);
  if (value.status) parts.push(`Status: ${value.status}`);
  if (value.source) parts.push(`Source: ${value.source}`);
  if (value.mode) parts.push(`Mode: ${value.mode}`);
  if (value.classification) parts.push(`Type: ${value.classification}`);
  if (value.reference) parts.push(`Ref: ${value.reference}`);
  if (value.target) parts.push(`Target: ${value.target}`);
  if (value.value) parts.push(sysFormatDateTime(value.value));
  if (value.created_at) parts.push(`Created: ${sysFormatDateTime(value.created_at)}`);
  if (value.completed_at) parts.push(`Completed: ${sysFormatDateTime(value.completed_at)}`);
  if (value.verified_at) parts.push(`Verified: ${sysFormatDateTime(value.verified_at)}`);
  return parts.length ? parts.join(' | ') : JSON.stringify(value);
}

function renderSystemHealthDashboard() {
  const summary = sysHealthSnapshot?.summary || {};
  sysSetText('health-count-online', Number(summary.online || 0));
  sysSetText('health-count-warning', Number(summary.warning || 0));
  sysSetText('health-count-offline', Number(summary.offline || 0));
  sysSetText('health-count-maintenance', Number(summary.maintenance || 0));
  sysSetText('health-last-updated', `Last checked: ${sysFormatDateTime(sysHealthSnapshot?.generated_at)}`);
  renderSystemHealthModules();
  renderSystemHealthHistory();
}

function systemHealthHistoryKey(row) {
  if (row?.run_id && row?.module_key) return `run:${row.run_id}|module:${row.module_key}`;
  if (row?.history_id) return `history:${row.history_id}`;
  return `fallback:${row?.module_key || ''}|${row?.checked_at || ''}|${row?.status || ''}`;
}

function mergeSystemHealthHistory(newRows = [], existingRows = []) {
  const seen = new Set();
  const rows = [...newRows, ...existingRows].filter(row => {
    if (!row) return false;
    const key = systemHealthHistoryKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  rows.sort((a, b) => {
    const bTime = new Date(b.checked_at || 0).getTime() || 0;
    const aTime = new Date(a.checked_at || 0).getTime() || 0;
    if (bTime !== aTime) return bTime - aTime;
    return Number(b.history_id || 0) - Number(a.history_id || 0);
  });
  return rows.slice(0, 30);
}

function healthHistoryRowsFromModules(modules = [], checkedAt = null) {
  const rows = Array.isArray(modules) ? modules : [modules].filter(Boolean);
  const runId = `client-${checkedAt || Date.now()}`;
  return rows.filter(Boolean).map(module => ({
    history_id: null,
    run_id: runId,
    module_key: module.module_key,
    module_name: module.module_name,
    status: module.status,
    remarks: module.remarks,
    response_time_ms: module.response_time_ms,
    endpoint_checked: module.endpoint_checked,
    error_message: module.error_message,
    trigger_type: 'MANUAL',
    checked_at: module.last_checked_at || checkedAt || new Date().toISOString(),
  }));
}

function applySystemHealthHistory(incomingHistory, fallbackModules = [], checkedAt = null) {
  const incomingRows = Array.isArray(incomingHistory) ? incomingHistory : [];
  const currentRows = incomingRows.length ? incomingRows : healthHistoryRowsFromModules(fallbackModules, checkedAt);
  if (!currentRows.length) return;
  sysHealthHistory = mergeSystemHealthHistory(currentRows, sysHealthHistory);
}

function filterSystemHealthModules() {
  renderSystemHealthModules();
}

function renderSystemHealthModules() {
  const grid = document.getElementById('health-module-grid');
  if (!grid) return;
  const search = String(document.getElementById('health-search')?.value || '').trim().toLowerCase();
  const statusFilter = String(document.getElementById('health-status-filter')?.value || '').trim().toUpperCase();
  const modules = sysHealthModules.filter(module => {
    const status = String(module.status || '').toUpperCase();
    const haystack = [
      module.module_name,
      module.module_key,
      module.remarks,
      module.endpoint_checked,
      module.recommended_action,
      module.affected_area,
      module.probable_cause,
      module.admin_action,
    ].join(' ').toLowerCase();
    return (!statusFilter || status === statusFilter) && (!search || haystack.includes(search));
  });
  if (!modules.length) {
    grid.innerHTML = '<div class="table-empty">No modules match the selected filter.</div>';
    return;
  }
  grid.innerHTML = modules.map(module => {
    const keyAttr = sysEsc(module.module_key);
    const status = String(module.status || 'WARNING').toLowerCase();
    const checkingClass = sysHealthCheckRunning && sysHealthRunningModuleKey === module.module_key ? ' is-checking' : '';
    const checkLabel = sysHealthCheckRunning && (!sysHealthRunningModuleKey || sysHealthRunningModuleKey === module.module_key) ? 'Checking...' : 'Check Module';
    return `
      <article class="health-module-card health-module-${sysEsc(status)}${checkingClass}" data-module-key="${keyAttr}">
        <div class="health-module-card-head">
          <div>
            <h4>${sysEsc(module.module_name)}</h4>
            <span>${sysEsc(module.endpoint_checked || '-')}</span>
          </div>
          ${sysHealthStatusBadge(module.status)}
        </div>
        <p>${sysEsc(module.remarks || 'No remarks available.')}</p>
        <div class="health-card-meta">
          <span>Last checked</span>
          <strong>${sysEsc(sysFormatDateTime(module.last_checked_at))}</strong>
          <span>Response</span>
          <strong>${module.response_time_ms === null || module.response_time_ms === undefined ? '-' : `${Number(module.response_time_ms)} ms`}</strong>
        </div>
        <div class="support-row-actions">
          <button type="button" class="btn-sysadmin-sm" data-health-action="details" data-module-key="${keyAttr}">View Details</button>
          <button type="button" class="btn-sysadmin-sm" data-health-action="check-module" data-module-key="${keyAttr}" ${sysHealthCheckRunning ? 'disabled' : ''}>${checkLabel}</button>
        </div>
      </article>
    `;
  }).join('');
  renderSystemHealthRunningState();
}

function renderSystemHealthHistory() {
  const tbody = document.getElementById('health-history-tbody');
  if (!tbody) return;
  if (!sysHealthHistory.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No health check history yet. Run a health check to create the first entries.</td></tr>';
    return;
  }
  tbody.innerHTML = sysHealthHistory.slice(0, 30).map(row => `
    <tr>
      <td><small>${sysEsc(sysFormatDateTime(row.checked_at))}</small></td>
      <td><strong>${sysEsc(row.module_name || row.module_key || '-')}</strong></td>
      <td>${sysHealthStatusBadge(row.status)}</td>
      <td><small>${sysEsc(row.trigger_type || 'MANUAL')}</small></td>
      <td><small>${row.response_time_ms === null || row.response_time_ms === undefined ? '-' : `${Number(row.response_time_ms)} ms`}</small></td>
      <td><small>${sysEsc(row.remarks || row.error_message || '-')}</small></td>
    </tr>
  `).join('');
}

function sysHealthCanNavigate(action) {
  if (!action?.page) return true;
  return typeof canAccess !== 'function' || canAccess(action.page);
}

function sysHealthModuleAuditSearch(module) {
  const key = String(module?.module_key || '').trim();
  if (['SYSTEM_HEALTH', 'SYSTEM'].includes(SYS_HEALTH_AUDIT_MODULES[key])) return key;
  return '';
}

function systemHealthDrilldownActions(module) {
  const moduleKey = String(module?.module_key || '');
  const relatedActions = (SYS_HEALTH_RELATED_NAV[moduleKey] || []).map(action => ({
    ...action,
    type: action.type || 'navigate',
    description: action.description || 'Open the related workspace.',
  }));
  const auditModule = SYS_HEALTH_AUDIT_MODULES[moduleKey] || 'SYSTEM_HEALTH';
  const actions = [
    ...relatedActions,
    {
      id: 'open-audit-filter',
      type: 'audit',
      icon: 'bi-journal-text',
      label: 'Open Audit Trail',
      description: 'Review related system activity and security events.',
      auditModule,
      search: sysHealthModuleAuditSearch(module),
    },
    {
      id: 'prefill-support-ticket',
      type: 'support-ticket',
      icon: 'bi-inbox',
      label: 'Prepare Support Ticket',
      description: 'Prefill a support case from this health result.',
    },
  ];

  return actions.map(action => {
    const disabled = action.type === 'navigate' && !sysHealthCanNavigate(action);
    return {
      ...action,
      disabled,
      description: disabled
        ? 'This destination is restricted by your current role.'
        : action.description,
    };
  });
}

function renderSystemHealthDrilldownActions(module) {
  const target = document.getElementById('health-detail-drilldowns');
  if (!target) return;
  const actions = systemHealthDrilldownActions(module);
  target.innerHTML = actions.length
    ? actions.map(action => `
        <button
          type="button"
          class="health-drilldown-btn"
          data-health-action="drilldown"
          data-module-key="${sysEsc(module.module_key)}"
          data-action-id="${sysEsc(action.id)}"
          ${action.disabled ? 'disabled aria-disabled="true"' : ''}
        >
          <i class="bi ${sysEsc(action.icon || 'bi-arrow-right-circle')}" aria-hidden="true"></i>
          <span>
            <strong>${sysEsc(action.label)}</strong>
            <small>${sysEsc(action.description || '')}</small>
          </span>
        </button>
      `).join('')
    : '<div class="table-empty">No drilldown actions configured.</div>';
}

function sysHealthNavigate(action) {
  if (!action?.page || !sysHealthCanNavigate(action)) {
    showSysToast('This destination is restricted by your current role.', 'error');
    return;
  }
  closeSystemHealthDetails();
  if (typeof navigate === 'function') {
    navigate(action.page, null, action.params || null);
    return;
  }
  if (action.page === 'system-admin' && action.params?.sysAdminTab) {
    switchSysAdminTab(action.params.sysAdminTab, null);
  }
}

function optionExists(select, value) {
  return Boolean(select && [...select.options].some(option => option.value === value));
}

function openSystemHealthAuditDrilldown(module, action = {}) {
  closeSystemHealthDetails();
  if (typeof navigate === 'function') {
    navigate('system-admin', null, { sysAdminTab: 'audit' });
  } else {
    switchSysAdminTab('audit', null);
  }
  requestAnimationFrame(() => {
    const moduleFilter = document.getElementById('audit-module-filter');
    const actionFilter = document.getElementById('audit-action-filter');
    const searchInput = document.getElementById('audit-search');
    const auditModule = action.auditModule || SYS_HEALTH_AUDIT_MODULES[module?.module_key] || '';
    if (moduleFilter && optionExists(moduleFilter, auditModule)) moduleFilter.value = auditModule;
    if (actionFilter) actionFilter.value = action.eventType || '';
    if (searchInput) searchInput.value = action.search || '';
    loadAuditLog();
  });
}

function supportPriorityForHealth(module) {
  const status = String(module?.status || '').toUpperCase();
  if (status === 'OFFLINE') return 'HIGH';
  if (status === 'WARNING') return 'MEDIUM';
  return 'LOW';
}

function supportCategoryForHealth(module) {
  return SYS_HEALTH_SUPPORT_CATEGORIES[module?.module_key] || 'SYSTEM';
}

function prefillSystemHealthSupportTicket(module) {
  closeSystemHealthDetails();
  if (typeof navigate === 'function') {
    navigate('system-admin', null, { sysAdminTab: 'support' });
  } else {
    switchSysAdminTab('support', null);
  }
  requestAnimationFrame(() => {
    const title = document.getElementById('support-ticket-title');
    const category = document.getElementById('support-ticket-category');
    const priority = document.getElementById('support-ticket-priority');
    const description = document.getElementById('support-ticket-description');
    const status = String(module?.status || 'UNKNOWN').toUpperCase();
    if (title) title.value = `System Health: ${module?.module_name || module?.module_key || 'Module'} ${status}`;
    if (category) category.value = supportCategoryForHealth(module);
    if (priority) priority.value = supportPriorityForHealth(module);
    if (description) {
      description.value = [
        `Module: ${module?.module_name || module?.module_key || '-'}`,
        `Status: ${status}`,
        `Endpoint / Check: ${module?.endpoint_checked || '-'}`,
        `Remarks: ${module?.remarks || '-'}`,
        module?.error_message ? `Error: ${module.error_message}` : '',
        module?.recommended_action ? `Recommended action: ${module.recommended_action}` : '',
      ].filter(Boolean).join('\n');
      description.focus();
    }
    showSysToast('Support ticket details prepared. Review before creating the ticket.', 'success');
  });
}

function runSystemHealthDrilldownAction(moduleKey, actionId) {
  const module = sysHealthModules.find(item => item.module_key === moduleKey);
  if (!module || !actionId) return;
  const action = systemHealthDrilldownActions(module).find(item => item.id === actionId);
  if (!action || action.disabled) {
    showSysToast('This action is not available for your current role.', 'error');
    return;
  }
  if (action.type === 'navigate') {
    sysHealthNavigate(action);
  } else if (action.type === 'audit') {
    openSystemHealthAuditDrilldown(module, action);
  } else if (action.type === 'support-ticket') {
    prefillSystemHealthSupportTicket(module);
  }
}

async function loadSystemHealthHistory() {
  try {
    const res = await apiFetch('/api/admin/system-health/history?limit=30');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load health history.');
    if (Array.isArray(data.history) && data.history.length) {
      sysHealthHistory = mergeSystemHealthHistory(data.history, sysHealthHistory);
    } else if (!sysHealthHistory.length) {
      sysHealthHistory = [];
    }
    renderSystemHealthHistory();
  } catch (err) {
    const tbody = document.getElementById('health-history-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="table-empty">${sysEsc(err.message || 'Failed to load health history.')}</td></tr>`;
  }
}

function openSystemHealthDetails(moduleKey) {
  const module = sysHealthModules.find(item => item.module_key === moduleKey);
  if (!module) return;
  sysHealthSelectedModuleKey = moduleKey;
  sysSetText('health-detail-title', module.module_name || 'Module Health');
  const statusTarget = document.getElementById('health-detail-status');
  if (statusTarget) {
    statusTarget.className = sysHealthStatusBadge(module.status).match(/class="([^"]+)"/)?.[1] || 'badge-clear';
    statusTarget.textContent = String(module.status || '-').toUpperCase();
  }
  sysSetText('health-detail-remarks', module.remarks || '-');
  sysSetText('health-detail-last-checked', sysFormatDateTime(module.last_checked_at));
  sysSetText('health-detail-last-success', sysFormatDateTime(module.last_success_at));
  sysSetText('health-detail-last-failure', sysFormatDateTime(module.last_failure_at));
  sysSetText('health-detail-response', module.response_time_ms === null || module.response_time_ms === undefined ? '-' : `${Number(module.response_time_ms)} ms`);
  sysSetText('health-detail-endpoint', module.endpoint_checked || '-');
  sysSetText('health-detail-error', module.error_message || '-');
  sysSetText('health-detail-action', module.recommended_action || '-');
  sysSetText('health-detail-affected-area', module.affected_area || '-');
  sysSetText('health-detail-probable-cause', module.probable_cause || '-');
  sysSetText('health-detail-admin-action', module.admin_action || '-');
  const checkButton = document.getElementById('health-detail-check-btn');
  if (checkButton) checkButton.dataset.moduleKey = moduleKey;
  renderSystemHealthDrilldownActions(module);

  const dependencies = module.dependency_status || {};
  const depTarget = document.getElementById('health-detail-dependencies');
  if (depTarget) {
    const entries = Object.entries(dependencies);
    depTarget.innerHTML = entries.length
      ? entries.map(([key, value]) => `
          <div class="health-dependency-row">
            <span>${sysEsc(value?.label || key.replace(/_/g, ' '))}</span>
            <strong>${sysEsc(healthDependencyValue(value))}</strong>
          </div>
        `).join('')
      : '<div class="table-empty">No dependency details available.</div>';
  }

  const runbookTarget = document.getElementById('health-detail-runbook');
  if (runbookTarget) {
    const steps = Array.isArray(module.runbook_steps) ? module.runbook_steps : [];
    runbookTarget.innerHTML = steps.length
      ? steps.map(step => `<li>${sysEsc(step)}</li>`).join('')
      : '<li>No runbook steps configured.</li>';
  }

  const logsTarget = document.getElementById('health-detail-logs');
  if (logsTarget) {
    const logs = Array.isArray(module.recent_logs) ? module.recent_logs : [];
    logsTarget.innerHTML = logs.length
      ? logs.map(log => `
          <div class="health-log-row">
            <strong>${sysEsc(log.action || 'SYSTEM_HEALTH_CHECK')}</strong>
            <span>${sysEsc(sysFormatDateTime(log.timestamp))}</span>
            <small>${sysEsc(log.details || '-')}</small>
          </div>
        `).join('')
      : '<div class="table-empty">No recent health-check audit entries.</div>';
  }

  const modal = document.getElementById('health-detail-modal');
  if (modal) modal.style.display = 'flex';
  renderSystemHealthRunningState();
}

function closeSystemHealthDetails() {
  const modal = document.getElementById('health-detail-modal');
  if (modal) modal.style.display = 'none';
}

function systemHealthApiErrorMessage(error) {
  const message = String(error?.message || error || '').trim();
  if (/endpoint not found|not found/i.test(message)) {
    return 'Health-check API is not loaded in the running server. Restart npm start, then run the check again.';
  }
  return message || 'Failed to run system health check.';
}

async function runSystemHealthCheck() {
  if (sysHealthCheckRunning) return;
  setSystemHealthRunning(true, {
    title: 'Running full system health check...',
    detail: 'Checking authentication, accounts, RBAC, payroll, audit, database, AWS readiness, and related modules.',
  });
  try {
    const res = await apiFetch('/api/admin/system-health/check', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to run system health check.');
    sysHealthSnapshot = { ...sysHealthSnapshot, ...data, generated_at: data.checked_at || data.generated_at };
    sysHealthModules = Array.isArray(data.modules) ? data.modules : sysHealthModules;
    applySystemHealthHistory(data.history, data.modules, data.checked_at || data.generated_at);
    renderSystemHealthDashboard();
    showSysToast(data.message || 'System health check completed.', 'success');
  } catch (err) {
    if (!sysHealthModules.length) {
      sysHealthModules = buildSystemHealthFallbackModules(systemHealthApiErrorMessage(err));
      sysHealthSnapshot = {
        ...(sysHealthSnapshot || {}),
        generated_at: sysHealthSnapshot?.generated_at || new Date().toISOString(),
        summary: summarizeHealthModules(sysHealthModules),
      };
      renderSystemHealthDashboard();
    }
    showSysToast(systemHealthApiErrorMessage(err), 'error');
  } finally {
    setSystemHealthRunning(false);
  }
}

async function runSystemModuleHealthCheck(moduleKey) {
  if (sysHealthCheckRunning) return;
  const module = sysHealthModules.find(item => item.module_key === moduleKey);
  setSystemHealthRunning(true, {
    moduleKey,
    title: `Checking ${module?.module_name || moduleKey}...`,
    detail: 'Running this module check and refreshing its status, details, and history.',
  });
  try {
    const res = await apiFetch(`/api/admin/system-health/check/${encodeURIComponent(moduleKey)}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to run module health check.');
    if (data.module) {
      const index = sysHealthModules.findIndex(module => module.module_key === data.module.module_key);
      if (index >= 0) sysHealthModules[index] = data.module;
      else sysHealthModules.push(data.module);
    }
    applySystemHealthHistory(data.history, data.module ? [data.module] : [], data.checked_at);
    await loadSystemHealth();
    if (sysHealthSelectedModuleKey === moduleKey) openSystemHealthDetails(moduleKey);
    showSysToast(data.message || 'Module health check completed.', 'success');
  } catch (err) {
    showSysToast(systemHealthApiErrorMessage(err), 'error');
  } finally {
    setSystemHealthRunning(false);
  }
}

async function loadSupportTickets() {
  try {
    if (!sysAllUsers.length) await loadUsersTable();
    populateSupportUserSelect();
    const params = new URLSearchParams();
    const status = document.getElementById('support-status-filter')?.value || '';
    const category = document.getElementById('support-category-filter')?.value || '';
    if (status) params.set('status', status);
    if (category) params.set('category', category);
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await apiFetch(`/api/admin/support-tickets${query}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load support tickets.');
    sysSupportTickets = Array.isArray(data) ? data : [];
    renderSupportTickets();
  } catch (err) {
    const tbody = document.getElementById('support-tickets-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="table-empty">${sysEsc(err.message || 'Failed to load support tickets.')}</td></tr>`;
  }
}

function renderSupportTickets() {
  const tbody = document.getElementById('support-tickets-tbody');
  if (!tbody) return;
  if (!sysSupportTickets.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No support tickets found.</td></tr>';
    return;
  }
  tbody.innerHTML = sysSupportTickets.map(ticket => {
    const actions = [];
    if (ticket.status === 'OPEN') actions.push(`<button class="btn-sysadmin-sm" onclick="updateSupportTicket(${Number(ticket.ticket_id)}, 'IN_PROGRESS')">Start</button>`);
    if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) actions.push(`<button class="btn-sysadmin-sm" onclick="updateSupportTicket(${Number(ticket.ticket_id)}, 'RESOLVED')">Resolve</button>`);
    if (ticket.status === 'RESOLVED') actions.push(`<button class="btn-sysadmin-sm" onclick="updateSupportTicket(${Number(ticket.ticket_id)}, 'CLOSED')">Close</button>`);
    return `
      <tr>
        <td><strong>${sysEsc(ticket.ticket_number)}</strong><br><small>${sysEsc(ticket.title)}</small></td>
        <td>${sysEsc(ticket.category)}</td>
        <td>${sysStatusBadge(ticket.priority)}</td>
        <td>${sysStatusBadge(ticket.status)}</td>
        <td>${ticket.related_user_id ? `User #${Number(ticket.related_user_id)}` : '-'}</td>
        <td><small>${sysEsc(sysFormatDateTime(ticket.created_at))}</small></td>
        <td><div class="support-row-actions">${actions.join('')}</div></td>
      </tr>
    `;
  }).join('');
}

async function createSupportTicket() {
  const title = document.getElementById('support-ticket-title')?.value.trim();
  const description = document.getElementById('support-ticket-description')?.value.trim();
  if (!title || !description) {
    showSysToast('Ticket title and description are required.', 'error');
    return;
  }
  const body = {
    title,
    description,
    category: document.getElementById('support-ticket-category')?.value || 'SYSTEM',
    priority: document.getElementById('support-ticket-priority')?.value || 'MEDIUM',
  };
  const userId = document.getElementById('support-ticket-user')?.value;
  if (userId) body.related_user_id = Number(userId);
  try {
    const res = await apiFetch('/api/admin/support-tickets', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create support ticket.');
    showSysToast(data.message || 'Support ticket created.', 'success');
    ['support-ticket-title', 'support-ticket-description'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    loadSupportTickets();
    loadSystemHealth();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

async function updateSupportTicket(ticketId, status) {
  const body = { status };
  if (status === 'RESOLVED') {
    const resolution = typeof showPrompt === 'function'
      ? await showPrompt('Resolution notes:', 'Resolve Support Ticket', '')
      : prompt('Resolution notes:');
    if (resolution === null) return;
    body.resolution_notes = resolution;
  }
  try {
    const res = await apiFetch(`/api/admin/support-tickets/${ticketId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update ticket.');
    showSysToast(data.message || 'Support ticket updated.', 'success');
    loadSupportTickets();
    loadSystemHealth();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

function backupPaginatedUrl(path, key) {
  const state = sysBackupPagination[key];
  if (!state) return path;
  const params = new URLSearchParams({ page: String(state.page), page_size: String(state.pageSize) });
  if (key === 'backups') {
    const search = document.getElementById('backup-history-search')?.value.trim();
    const type = document.getElementById('backup-history-type-filter')?.value || 'ALL';
    const status = document.getElementById('backup-history-status-filter')?.value || 'ALL';
    if (search) params.set('search', search);
    if (type !== 'ALL') params.set('type', type);
    if (status !== 'ALL') params.set('status', status);
  }
  if (key === 'recovery') {
    const search = document.getElementById('backup-recovery-search')?.value.trim();
    const status = document.getElementById('backup-recovery-readiness-filter')?.value || 'ALL';
    if (search) params.set('search', search);
    if (status !== 'ALL') params.set('status', status);
  }
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${params.toString()}`;
}

function normalizeBackupPagedResponse(payload, key) {
  const state = sysBackupPagination[key];
  const items = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.items) ? payload.items
      : (Array.isArray(payload?.data) ? payload.data : []));
  if (!state) return items;
  const meta = (!Array.isArray(payload) && (payload?.pagination || payload?.meta)) || {};
  const page = Math.max(1, Number(meta.page || meta.current_page || state.page) || 1);
  const pageSize = Math.max(1, Number(meta.page_size || meta.pageSize || meta.per_page || state.pageSize) || 25);
  const total = Math.max(0, Number(meta.total || meta.total_items || meta.totalItems || items.length) || 0);
  const totalPages = Math.max(1, Number(meta.total_pages || meta.totalPages || Math.ceil(total / pageSize)) || 1);
  state.page = Math.min(page, totalPages);
  state.pageSize = pageSize;
  state.total = total;
  state.totalPages = totalPages;
  state.hasPrevious = meta.has_previous !== undefined ? Boolean(meta.has_previous)
    : (meta.hasPrevious !== undefined ? Boolean(meta.hasPrevious) : state.page > 1);
  state.hasNext = meta.has_next !== undefined ? Boolean(meta.has_next)
    : (meta.hasNext !== undefined ? Boolean(meta.hasNext) : state.page < totalPages);
  return items;
}

function normalizeBackupCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.schedules)) return payload.schedules;
  if (Array.isArray(payload?.notifications)) return payload.notifications;
  if (Array.isArray(payload?.drills)) return payload.drills;
  return [];
}

async function backupApiFetch(path, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch(path, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The backup service did not respond in time. Refresh the workspace and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBackupOperationalResource(path, key) {
  try {
    const response = await backupApiFetch(path);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || `Failed to load ${key}.`);
    delete sysBackupOperationalErrors[key];
    return payload;
  } catch (error) {
    sysBackupOperationalErrors[key] = error.message || `Failed to load ${key}.`;
    return null;
  }
}

// Each core resource has an independent failure state. A slow dashboard or
// backup-history request must never keep the Restore or Rollback tables on a
// generic loading row after those specific endpoints have already responded.
const BACKUP_CORE_RESOURCE_FAILURES = Object.freeze({
  overview: ['backup-coverage-tbody', 9, 'Backup overview could not be loaded.'],
  backups: ['backup-logs-tbody', 9, 'Backup history could not be loaded.'],
  recovery: ['module-recovery-tbody', 10, 'Recovery points could not be loaded.'],
  restore: ['restore-jobs-tbody', 11, 'Restore jobs could not be loaded.'],
  rollback: ['rollback-requests-tbody', 9, 'Rollback requests could not be loaded.'],
});

function renderBackupCoreResourceFailure(key, error) {
  const failure = BACKUP_CORE_RESOURCE_FAILURES[key];
  if (!failure) return;
  const [tbodyId, colspan, title] = failure;
  const tbody = document.getElementById(tbodyId);
  if (tbody) {
    tbody.innerHTML = backupEmptyFilterRow(
      colspan,
      title,
      error?.message || 'Refresh the workspace and try again.'
    );
  }
  if (key !== 'overview') return;
  const readiness = document.getElementById('backup-readiness-card');
  if (readiness) {
    readiness.innerHTML = '<span class="backup-readiness-label">Recovery readiness</span><strong>Status unavailable</strong><small>Restore and rollback records will continue loading independently.</small>';
  }
  const nextActions = document.getElementById('backup-next-actions');
  if (nextActions) {
    nextActions.innerHTML = '<div class="backup-next-action backup-next-action-neutral"><strong>Backup overview is unavailable.</strong><small>Restore and rollback records remain available when their own requests succeed.</small></div>';
  }
}

function applyBackupCoreResource(key, payload) {
  if (key === 'overview') {
    sysBackupDashboard = payload || {};
    sysBackupCoverage = Array.isArray(payload?.coverage) ? payload.coverage : [];
    return;
  }
  if (key === 'backups') {
    sysBackupLogs = normalizeBackupPagedResponse(payload, 'backups');
    return;
  }
  if (key === 'recovery') {
    sysModuleRecoveryPoints = normalizeBackupPagedResponse(payload, 'recovery');
    return;
  }
  if (key === 'restore') {
    sysRestoreJobs = normalizeBackupPagedResponse(payload, 'restore');
    return;
  }
  if (key === 'rollback') {
    sysRollbackRequests = normalizeBackupPagedResponse(payload, 'rollback');
  }
}

function renderBackupCoreResource(key) {
  if (key === 'overview') {
    renderBackupModuleOptions();
    renderBackupOperationalModuleOptions();
    renderBackupApprovalMode();
    renderBackupReadiness();
    renderBackupNextActions();
    renderBackupSummaryCards();
    renderBackupCoverage();
    renderBackupSettings();
    return;
  }
  if (key === 'backups') {
    renderBackupLogs();
    renderBackupPagination('backups');
    return;
  }
  if (key === 'recovery') {
    renderModuleRecoveryPoints();
    renderBackupPagination('recovery');
    return;
  }
  if (key === 'restore') {
    renderRestoreJobs();
    renderBackupPagination('restore');
    return;
  }
  if (key === 'rollback') {
    renderRollbackRequests();
    renderBackupPagination('rollback');
  }
}

async function fetchAndRenderBackupCoreResource(key, path) {
  try {
    const response = await backupApiFetch(path);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || `Failed to load ${key}.`);
    applyBackupCoreResource(key, payload);
    renderBackupCoreResource(key);
    return true;
  } catch (error) {
    renderBackupCoreResourceFailure(key, error);
    return false;
  }
}

function setBackupTableLoadingState() {
  const loadingRows = {
    'backup-logs-tbody': [9, 'Loading backup history...'],
    'module-recovery-tbody': [10, 'Loading recovery points...'],
    'restore-jobs-tbody': [11, 'Loading restore jobs...'],
    'rollback-requests-tbody': [9, 'Loading rollback requests...'],
    'backup-schedules-tbody': [7, 'Loading backup schedules...'],
    'backup-drills-tbody': [7, 'Loading restore drills...'],
  };
  Object.entries(loadingRows).forEach(([id, [colspan, message]]) => {
    const tbody = document.getElementById(id);
    if (tbody) tbody.innerHTML = `<tr><td colspan="${colspan}" class="table-empty">${sysEsc(message)}</td></tr>`;
  });
}

async function loadBackupLogs() {
  if (sysBackupWorkspaceLoading) return;
  sysBackupWorkspaceLoading = true;
  setBackupTableLoadingState();
  const refreshButton = document.getElementById('backup-refresh-button');
  const updatedLabel = document.getElementById('backup-last-updated');
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.classList.add('is-loading');
    refreshButton.innerHTML = '<span aria-hidden="true">&#8635;</span> Refreshing...';
  }
  if (updatedLabel) updatedLabel.textContent = 'Refreshing recovery data...';
  try {
    // Do not aggregate these with Promise.all before rendering. Restore and
    // Rollback must paint as soon as their own endpoints return; an unrelated
    // slow overview/history request used to leave both tables stuck on
    // "Loading" until the 15-second fetch timeout elapsed.
    const coreResults = await Promise.all([
      fetchAndRenderBackupCoreResource('overview', '/api/admin/backups/overview'),
      fetchAndRenderBackupCoreResource('backups', backupPaginatedUrl('/api/admin/backups', 'backups')),
      fetchAndRenderBackupCoreResource('recovery', backupPaginatedUrl('/api/admin/backups/recovery-points', 'recovery')),
      fetchAndRenderBackupCoreResource('restore', backupPaginatedUrl('/api/admin/backups/restore-jobs', 'restore')),
      fetchAndRenderBackupCoreResource('rollback', backupPaginatedUrl('/api/admin/backups/rollback-requests', 'rollback')),
    ]);
    const loadedCoreCount = coreResults.filter(Boolean).length;
    if (updatedLabel) {
      updatedLabel.textContent = loadedCoreCount
        ? 'Core recovery data loaded. Loading operational details...'
        : 'Core recovery data could not be loaded. Review the table messages below.';
    }

    const [schedulePayload, retentionPayload, notificationPayload, drillPayload] = await Promise.all([
      fetchBackupOperationalResource('/api/admin/backups/schedules', 'backup schedules'),
      fetchBackupOperationalResource('/api/admin/backups/retention-policy', 'retention policy'),
      fetchBackupOperationalResource('/api/admin/backups/notifications', 'action notifications'),
      fetchBackupOperationalResource('/api/admin/backups/restore-drills', 'restore drills'),
    ]);
    sysBackupSchedules = schedulePayload === null ? [] : normalizeBackupCollection(schedulePayload);
    sysBackupRetentionPolicy = retentionPayload?.policy || retentionPayload?.item || retentionPayload || null;
    sysBackupNotifications = notificationPayload === null ? [] : normalizeBackupCollection(notificationPayload);
    sysBackupRestoreDrills = drillPayload === null ? [] : normalizeBackupCollection(drillPayload);
    // Render only operational sections here. Re-rendering the entire workspace
    // would overwrite a successfully rendered Restore/Rollback table when an
    // unrelated core resource failed.
    renderBackupSchedules();
    populateBackupRetentionForm();
    renderBackupNotifications();
    renderBackupRestoreDrills();
    renderBackupSettings();
    switchBackupRecoveryTab(sysBackupActiveTab);
    if (updatedLabel) updatedLabel.textContent = `Updated ${sysFormatDateTime(new Date())}`;
  } catch (err) {
    // Individual core fetches have already rendered a table-specific result.
    // Do not replace successful Restore/Rollback rows with a global error.
    if (updatedLabel) updatedLabel.textContent = 'Refresh failed — try again';
    showSysToast(err.message || 'Failed to load backup recovery data.', 'error');
  } finally {
    sysBackupWorkspaceLoading = false;
    Object.keys(sysBackupPagination).forEach(renderBackupPagination);
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.classList.remove('is-loading');
      refreshButton.innerHTML = '<span aria-hidden="true">&#8635;</span> Refresh Status';
    }
  }
}

function switchBackupRecoveryTab(tab) {
  sysBackupActiveTab = tab || 'overview';
  document.querySelectorAll('[data-backup-tab]').forEach(button => {
    const selected = button.dataset.backupTab === sysBackupActiveTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('[data-backup-panel]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.backupPanel === sysBackupActiveTab);
  });
}

function focusBackupArea(tab, targetId = '') {
  switchBackupRecoveryTab(tab);
  requestAnimationFrame(() => {
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;
    target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const focusTarget = target.matches?.('button, input, select, textarea')
      ? target
      : target.querySelector?.('button, input, select, textarea');
    focusTarget?.focus?.({ preventScroll: true });
  });
}

function backupTypeLabel(value) {
  return String(value || '-').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function backupExplicitBoolean(record, keys) {
  if (!record || typeof record !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value === true || value === 1 || String(value).trim().toLowerCase() === 'true') return true;
    if (value === false || value === 0 || String(value).trim().toLowerCase() === 'false') return false;
  }
  return null;
}

function backupAdminApprovalPolicy(source = sysBackupDashboard || {}) {
  void source;
  return {
    singleAdminMode: true,
    mode: 'SINGLE_ADMIN_STEP_UP',
  };
}

function backupApprovalInstruction(policy = backupAdminApprovalPolicy()) {
  void policy;
  return 'The same System Administrator completes this step using a fresh MFA challenge.';
}

function backupApprovalUnavailableMessage(subject = 'request') {
  return `This ${subject} is not ready for approval. Refresh the workspace and review its current status.`;
}

function backupStatusValue(record, keys, fallback = '-') {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim().toUpperCase();
  }
  return fallback;
}

function isVerifiedBackupArtifact(record) {
  const available = backupExplicitBoolean(record, ['artifact_available']);
  const verified = backupExplicitBoolean(record, ['artifact_verified']);
  return available === true && verified === true;
}

function isRestorableBackupArtifact(record) {
  const restorable = backupExplicitBoolean(record, ['is_restorable']);
  return isVerifiedBackupArtifact(record) && restorable === true;
}

function isVerifiedRollbackPoint(record) {
  const available = backupExplicitBoolean(record, ['artifact_available']);
  const verified = backupExplicitBoolean(record, ['artifact_verified']);
  const rollbackAvailable = backupExplicitBoolean(record, ['rollback_available']);
  const artifactReferencePresent = Boolean(record?.artifact_location && (record?.artifact_checksum || record?.checksum));
  return verified === true
    && rollbackAvailable === true
    && available !== false
    && (available === true || artifactReferencePresent);
}

function isVerifiedRollbackRequestArtifact(record) {
  const available = backupExplicitBoolean(record, ['artifact_available']);
  const verified = backupExplicitBoolean(record, ['artifact_verified']);
  const artifactReferencePresent = Boolean(record?.artifact_location && (record?.artifact_checksum || record?.checksum));
  const verificationMatches = backupStatusValue(record, ['verification_status'], '') === 'MATCH';
  const integrityPasses = backupStatusValue(record, ['integrity_status'], '') === 'PASSED';
  const verificationReported = verified === true || (verificationMatches && integrityPasses);
  return verificationReported && available !== false && (available === true || artifactReferencePresent);
}

function backupArtifactReadiness(record) {
  const available = backupExplicitBoolean(record, ['artifact_available']);
  const verified = backupExplicitBoolean(record, ['artifact_verified']);
  const restorable = backupExplicitBoolean(record, ['is_restorable']);
  if (isVerifiedRollbackPoint(record)) return 'VERIFIED';
  if (available !== true) return 'NOT AVAILABLE';
  if (verified !== true) return 'NOT VERIFIED';
  if (restorable === true) return 'USABLE';
  if (String(record?.backup_type || '').toUpperCase() === 'DEPLOYMENT_VERSION' || backupExplicitBoolean(record, ['rollback_available']) === true) {
    return 'VERIFIED';
  }
  return 'NOT RESTORABLE';
}

function backupCoverageStatus(module, area) {
  const raw = backupStatusValue(module, [`${area}_backup_coverage`], 'NOT COVERED');
  if (raw === 'NOT APPLICABLE') return raw;
  const areaAvailable = backupExplicitBoolean(module, [`${area}_artifact_available`]);
  const areaVerified = backupExplicitBoolean(module, [`${area}_artifact_verified`]);
  const explicitlyUsable = areaAvailable === true && areaVerified === true;
  const moduleUsable = isRestorableBackupArtifact(module) || isVerifiedRollbackPoint(module);
  const backendCallsCovered = ['COVERED', 'VERIFIED', 'AVAILABLE', 'YES', 'USABLE'].includes(raw);
  return backendCallsCovered && (explicitlyUsable || moduleUsable) ? 'COVERED' : 'NOT COVERED';
}

function backupAvailableActions(record) {
  const raw = record?.allowed_actions || record?.available_actions || record?.actions;
  if (!Array.isArray(raw)) return [];
  return raw.map(action => String(action || '').trim().toUpperCase()).filter(Boolean);
}

function backupActionAllowed(record, action, fallback = false) {
  const normalized = String(action || '').trim().toUpperCase();
  const available = backupAvailableActions(record);
  if (available.length) return available.includes(normalized);
  const flag = `can_${normalized.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const explicit = backupExplicitBoolean(record, [flag]);
  return explicit === null ? Boolean(fallback) : explicit;
}

function backupActionAllowedAny(record, actions, fallback = false) {
  const available = backupAvailableActions(record);
  const normalized = actions.map(action => String(action || '').trim().toUpperCase());
  if (available.length) return normalized.some(action => available.includes(action));
  for (const action of normalized) {
    const flag = `can_${action.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const explicit = backupExplicitBoolean(record, [flag]);
    if (explicit !== null) return explicit;
  }
  return Boolean(fallback);
}

function backupStatusStack(entries) {
  return entries.map(([label, status, meta]) => `
    <div><small class="sysadmin-muted">${sysEsc(label)}</small><br>${sysStatusBadge(status)}${meta ? `<br><small>${sysEsc(meta)}</small>` : ''}</div>
  `).join('');
}

function backupLifecycleGuide(status, workflow = 'backup') {
  const normalized = String(status || 'UNKNOWN').trim().toUpperCase();
  const guides = {
    backup: {
      PENDING: ['Request queued', 'Run the backup worker.', false],
      RUNNING: ['Creating encrypted artifact', 'Wait for the worker to finish.', false],
      COMPLETED: ['Artifact created', 'Verify checksum and integrity.', false],
      VERIFICATION_FAILED: ['Verification failed', 'Review the result and verify again.', false],
      VERIFIED: ['Verified and usable', 'Request a restore when recovery is needed.', true],
      FAILED: ['Backup failed', 'Review the error, then retry the worker.', false],
      CANCELLED: ['Request cancelled', 'Create a new request if a backup is still needed.', true],
    },
    restore: {
      PENDING: ['Restore requested', 'Wait for the protected workflow to start.', false],
      AWAITING_APPROVAL: ['Waiting for admin approval', backupApprovalInstruction(), false],
      APPROVED: ['Admin approval complete', 'Run the isolated dry-run with fresh MFA.', false],
      DRY_RUN_RUNNING: ['Dry-run in progress', 'Wait for isolated validation to finish.', false],
      DRY_RUN_PASSED: ['Dry-run passed', 'Execute the restore with fresh MFA.', false],
      DRY_RUN_FAILED: ['Dry-run blocked restore', 'Resolve the validation failure before a new attempt.', false],
      EXECUTING: ['Restore in progress', 'Wait; do not start a competing recovery action.', false],
      VERIFYING: ['Validating restored target', 'Run or wait for post-restore integrity checks.', false],
      COMPLETED: ['Restore completed', 'Review the integrity result and system health.', true],
      FAILED: ['Restore failed safely', 'Review the result; production changes remain controlled.', false],
      REJECTED: ['Request rejected', 'Create a new request only after resolving the concern.', true],
      CANCELLED: ['Request cancelled', 'No further restore action is required.', true],
    },
    rollback: {
      PENDING: ['Rollback requested', 'Wait for the protected workflow to start.', false],
      AWAITING_APPROVAL: ['Waiting for admin approval', backupApprovalInstruction(), false],
      APPROVED: ['Admin approval complete', 'Execute rollback with fresh MFA.', false],
      EXECUTING: ['Rollback in progress', 'Wait for integrity validation to finish.', false],
      VERIFYING: ['Validating module version', 'Wait for integrity and health checks.', false],
      COMPLETED: ['Rollback completed', 'Review the integrity result and module health.', true],
      FAILED: ['Rollback failed safely', 'Review the result before requesting another rollback.', false],
      REJECTED: ['Request rejected', 'Resolve the review concern before a new request.', true],
      CANCELLED: ['Request cancelled', 'No further rollback action is required.', true],
    },
  };
  const [stage, next, complete] = guides[workflow]?.[normalized]
    || [backupTypeLabel(normalized), 'Open the record and review its latest result.', false];
  return { status: normalized, stage, next, complete };
}

function backupLifecycleCell(status, workflow = 'backup') {
  const guide = backupLifecycleGuide(status, workflow);
  return `<div class="backup-lifecycle-cell">
    ${sysStatusBadge(guide.status)}
    <span class="backup-lifecycle-stage">${sysEsc(guide.stage)}</span>
    <small class="backup-lifecycle-next${guide.complete ? ' is-complete' : ''}">${sysEsc(guide.next)}</small>
  </div>`;
}

function backupApprovalMfaStatus(record) {
  const approval = backupStatusValue(record, ['approval_status', 'checker_status'], 'NOT REQUESTED');
  const mfa = record?.step_up_verified_at
    ? 'VERIFIED'
    : backupStatusValue(record, ['step_up_mfa_status', 'mfa_status'], 'REQUIRED');
  return backupStatusStack([
    ['Approval', approval, record?.approved_by_username || ''],
    ['Last MFA step-up', mfa, record?.step_up_verified_at ? sysFormatDateTime(record.step_up_verified_at) : 'Fresh challenge required for protected actions'],
  ]);
}

function backupIdempotencyKey(prefix, id = '') {
  const storageKey = `lgsv:backup-idempotency:${String(prefix || 'backup').toLowerCase()}:${id || 'new'}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
  } catch (_) {
    // Session storage can be unavailable in hardened/private browser modes.
  }
  const uuid = globalThis.crypto?.randomUUID?.();
  const suffix = uuid || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const value = `${String(prefix || 'backup').toLowerCase()}-${id || 'new'}-${suffix}`;
  try { sessionStorage.setItem(storageKey, value); } catch (_) {}
  return value;
}

function clearBackupIdempotencyKey(prefix, id = '') {
  const storageKey = `lgsv:backup-idempotency:${String(prefix || 'backup').toLowerCase()}:${id || 'new'}`;
  try { sessionStorage.removeItem(storageKey); } catch (_) {}
}

async function runBackupMutation(key, operation) {
  if (sysBackupPendingMutations.has(key)) {
    showSysToast('This recovery action is already being processed.', 'error');
    return null;
  }
  sysBackupPendingMutations.add(key);
  try {
    return await operation();
  } finally {
    sysBackupPendingMutations.delete(key);
  }
}

function isRestorableBackupType(type) {
  return ['DATABASE', 'FILES', 'CONFIGURATION', 'MODULE_STATE', 'FULL_BACKUP'].includes(String(type || '').toUpperCase());
}

function backupRestoreType(type) {
  const normalized = String(type || 'DATABASE').toUpperCase();
  return isRestorableBackupType(normalized) ? normalized : 'DATABASE';
}

function backupModuleName(moduleKey) {
  const match = sysBackupCoverage.find(item => item.module_key === moduleKey)
    || sysModuleRecoveryPoints.find(item => item.module_key === moduleKey);
  return match?.module_name || backupTypeLabel(moduleKey);
}

function backupSearchText(...values) {
  return values
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).toLowerCase())
    .join(' ');
}

function backupMatchesQuery(query, ...values) {
  const normalized = String(query || '').trim().toLowerCase();
  return !normalized || backupSearchText(...values).includes(normalized);
}

function setBackupResultCount(targetId, visible, total, label) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const noun = Number(visible) === 1 ? label : `${label}s`;
  target.textContent = visible === total
    ? `${visible} ${noun}`
    : `${visible} of ${total} ${label}s`;
}

function renderBackupPagination(key) {
  const state = sysBackupPagination[key];
  const ids = {
    backups: ['backup-history-page-summary', 'backup-history-prev', 'backup-history-next'],
    recovery: ['backup-recovery-page-summary', 'backup-recovery-prev', 'backup-recovery-next'],
    restore: ['backup-restore-page-summary', 'backup-restore-prev', 'backup-restore-next'],
    rollback: ['backup-rollback-page-summary', 'backup-rollback-prev', 'backup-rollback-next'],
  }[key];
  if (!state || !ids) return;
  const [summaryId, previousId, nextId] = ids;
  const summary = document.getElementById(summaryId);
  const previous = document.getElementById(previousId);
  const next = document.getElementById(nextId);
  if (summary) {
    const start = state.total ? ((state.page - 1) * state.pageSize) + 1 : 0;
    const end = state.total ? Math.min(start + state.pageSize - 1, state.total) : 0;
    summary.textContent = `${start}-${end} of ${state.total} records (Page ${state.page} of ${state.totalPages})`;
  }
  if (previous) previous.disabled = !state.hasPrevious || sysBackupWorkspaceLoading;
  if (next) next.disabled = !state.hasNext || sysBackupWorkspaceLoading;
}

async function changeBackupPage(key, direction) {
  const state = sysBackupPagination[key];
  if (!state || sysBackupWorkspaceLoading) return;
  const targetPage = Math.max(1, Math.min(state.totalPages, state.page + Number(direction || 0)));
  if (targetPage === state.page) return;
  state.page = targetPage;
  await loadBackupLogs();
}

async function changeBackupPageSize(key, value) {
  const state = sysBackupPagination[key];
  if (!state || sysBackupWorkspaceLoading) return;
  state.pageSize = [10, 25, 50].includes(Number(value)) ? Number(value) : 25;
  state.page = 1;
  await loadBackupLogs();
}

function reloadBackupFilteredPage(key, delay = 280) {
  const state = sysBackupPagination[key];
  if (!state) return;
  state.page = 1;
  if (sysBackupFilterTimers[key]) clearTimeout(sysBackupFilterTimers[key]);
  sysBackupFilterTimers[key] = setTimeout(() => {
    sysBackupFilterTimers[key] = null;
    if (sysBackupWorkspaceLoading) reloadBackupFilteredPage(key, 180);
    else loadBackupLogs();
  }, delay);
}

function backupEmptyFilterRow(colspan, title, detail) {
  return `<tr><td colspan="${Number(colspan)}" class="table-empty">
    <div class="backup-table-empty-state"><strong>${sysEsc(title)}</strong><small>${sysEsc(detail)}</small></div>
  </td></tr>`;
}

function backupSelectModules() {
  const select = document.getElementById('backup-modules');
  if (!select) return [];
  return Array.from(select.selectedOptions || []).map(option => option.value).filter(Boolean);
}

function renderBackupModuleOptions() {
  const select = document.getElementById('backup-modules');
  if (!select || !sysBackupCoverage.length) return;
  const selected = new Set(Array.from(select.selectedOptions || []).map(option => option.value));
  select.innerHTML = sysBackupCoverage.map(module => {
    const shouldSelect = sysBackupModuleSelectionInitialized ? selected.has(module.module_key) : true;
    return `<option value="${sysEsc(module.module_key)}" ${shouldSelect ? 'selected' : ''}>${sysEsc(module.module_name)}</option>`;
  }).join('');
  sysBackupModuleSelectionInitialized = true;
  renderBackupModulePicker();
}

function renderBackupModulePicker() {
  const picker = document.getElementById('backup-module-picker');
  const select = document.getElementById('backup-modules');
  const count = document.getElementById('backup-module-selection-count');
  if (!picker || !select) return;
  const selected = new Set(Array.from(select.selectedOptions || []).map(option => option.value));
  const visibleModules = sysBackupCoverage.filter(module => backupMatchesQuery(
    sysBackupModulePickerQuery,
    module.module_name,
    module.module_key
  ));
  if (count) {
    const selectedCount = selected.size;
    count.textContent = `${selectedCount} module${selectedCount === 1 ? '' : 's'} selected`;
  }
  if (!visibleModules.length) {
    picker.innerHTML = '<div class="backup-module-picker-empty"><strong>No modules found.</strong><br>Try a different search term.</div>';
    return;
  }
  picker.innerHTML = visibleModules.map(module => {
    const checked = selected.has(module.module_key);
    return `
      <label class="backup-module-option${checked ? ' is-selected' : ''}">
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleBackupModule(${sysJsString(module.module_key)}, this.checked)" />
        <span class="backup-module-option-copy">
          <strong>${sysEsc(module.module_name)}</strong>
          <small>${sysEsc(module.module_key)}</small>
        </span>
      </label>
    `;
  }).join('');
}

function toggleBackupModule(moduleKey, selected) {
  const select = document.getElementById('backup-modules');
  if (!select) return;
  const option = Array.from(select.options || []).find(item => item.value === moduleKey);
  if (option) option.selected = Boolean(selected);
  renderBackupModulePicker();
}

function selectAllBackupModules(selected = true) {
  const select = document.getElementById('backup-modules');
  if (!select) return;
  Array.from(select.options || []).forEach(option => { option.selected = Boolean(selected); });
  renderBackupModulePicker();
}

function filterBackupModulePicker(query = '') {
  sysBackupModulePickerQuery = String(query || '');
  renderBackupModulePicker();
}

function backupSummaryValue(record, fallback = '-') {
  if (!record) return fallback;
  if (typeof record === 'string') return record;
  return record.backup_reference || record.module_name || record.status || fallback;
}

function backupSummaryMeta(record) {
  if (!record || typeof record === 'string') return '';
  const parts = [
    record.status,
    record.verification_status,
    record.integrity_status,
    record.storage_provider,
    record.created_at ? sysFormatDateTime(record.created_at) : record.created_at,
  ].filter(Boolean);
  return parts.join(' | ');
}

function backupVerifiedSummary(record, options = {}) {
  if (!record) return null;
  return options.rollback
    ? ((isVerifiedRollbackPoint(record) || (
      String(record.backup_type || '').toUpperCase() === 'DEPLOYMENT_VERSION'
      && isVerifiedBackupArtifact(record)
    )) ? record : null)
    : (isRestorableBackupArtifact(record) ? record : null);
}

function renderBackupSummaryCards() {
  const target = document.getElementById('backup-summary-grid');
  if (!target) return;
  const cards = sysBackupDashboard?.cards || {};
  const databaseBackup = backupVerifiedSummary(cards.latest_database_backup);
  const fileBackup = backupVerifiedSummary(cards.latest_file_backup);
  const configurationBackup = backupVerifiedSummary(cards.latest_configuration_backup);
  const recoveryPoint = backupVerifiedSummary(cards.latest_module_recovery_point, { rollback: true });
  const deploymentVersion = backupVerifiedSummary(cards.latest_deployment_version, { rollback: true });
  const usableArtifacts = sysBackupLogs.filter(record => (
    isRestorableBackupArtifact(record) || backupVerifiedSummary(record, { rollback: true })
  )).length;
  const items = [
    ['Latest Verified Database Backup', backupSummaryValue(databaseBackup, 'No usable artifact'), backupSummaryMeta(databaseBackup)],
    ['Latest Verified File Backup', backupSummaryValue(fileBackup, 'No usable artifact'), backupSummaryMeta(fileBackup)],
    ['Latest Verified Configuration Backup', backupSummaryValue(configurationBackup, 'No usable artifact'), backupSummaryMeta(configurationBackup)],
    ['Latest Verified Recovery Point', backupSummaryValue(recoveryPoint, 'No verified recovery point'), backupSummaryMeta(recoveryPoint)],
    ['Latest Verified Deployment Version', backupSummaryValue(deploymentVersion, 'No verified rollback artifact'), backupSummaryMeta(deploymentVersion)],
    ['Recovery Readiness', usableArtifacts > 0 ? (cards.backup_status || sysBackupDashboard?.status || 'WARNING') : 'NOT READY', `${usableArtifacts} verified usable artifact(s)`],
    ['Total Backup Sets', Number(cards.total_backup_sets || 0), 'Recorded backup sets'],
    ['Failed Backup Jobs', Number(cards.failed_backup_jobs || 0), 'Needs admin review'],
    ['Last Restore Attempt', backupSummaryValue(cards.last_restore_attempt, 'No restore job'), backupSummaryMeta(cards.last_restore_attempt)],
  ];
  target.innerHTML = items.map(([label, value, meta]) => `
    <article class="backup-summary-card">
      <span>${sysEsc(label)}</span>
      <strong>${sysEsc(value)}</strong>
      <small>${sysEsc(meta || '-')}</small>
    </article>
  `).join('');
}

function backupModuleHasVerifiedCoverage(module) {
  return ['data', 'file', 'config'].some(area => backupCoverageStatus(module, area) === 'COVERED')
    || isVerifiedRollbackPoint(module);
}

function renderBackupReadiness() {
  const target = document.getElementById('backup-readiness-card');
  if (!target) return;
  const settings = sysBackupDashboard?.settings || {};
  const usableArtifacts = sysBackupLogs.filter(record => (
    isRestorableBackupArtifact(record) || backupVerifiedSummary(record, { rollback: true })
  )).length;
  const coveredModules = sysBackupCoverage.filter(backupModuleHasVerifiedCoverage).length;
  const totalModules = sysBackupCoverage.length;
  const activeRestoreWork = sysRestoreJobs.filter(job => ![
    'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED',
  ].includes(backupStatusValue(job, ['lifecycle_status', 'status'], 'UNKNOWN'))).length;
  const workerReady = backupExplicitBoolean(settings, ['backup_worker_enabled']) !== false;
  const isolatedTargetReady = backupExplicitBoolean(settings, ['isolated_restore_configured']) !== false;

  let tone = 'is-ready';
  let title = 'Ready for controlled recovery';
  let detail = `${usableArtifacts} verified artifact(s); ${coveredModules} of ${totalModules} module(s) have verified coverage.`;
  if (!workerReady) {
    tone = 'is-blocked';
    title = 'Backup worker needs configuration';
    detail = 'New requests cannot produce usable artifacts until the backup worker is enabled.';
  } else if (!usableArtifacts) {
    tone = 'is-blocked';
    title = 'No verified recovery artifact';
    detail = 'Create a backup, run its worker, then verify the server-generated checksum.';
  } else if ((totalModules && coveredModules < totalModules) || !isolatedTargetReady) {
    tone = 'is-warning';
    title = 'Recovery readiness needs attention';
    detail = `${coveredModules} of ${totalModules} module(s) have verified coverage${isolatedTargetReady ? '.' : '; isolated restore validation is not configured.'}`;
  } else if (activeRestoreWork) {
    tone = 'is-warning';
    title = `${activeRestoreWork} protected restore step(s) active`;
    detail = 'Continue only the next permitted step shown in the action center.';
  }

  target.classList.remove('is-ready', 'is-warning', 'is-blocked');
  target.classList.add(tone);
  target.innerHTML = `
    <span class="backup-readiness-label">Recovery readiness</span>
    <strong>${sysEsc(title)}</strong>
    <small>${sysEsc(detail)}</small>
  `;
}

function collectBackupNextActions() {
  const actions = [];
  const add = action => actions.push(action);
  const usableArtifacts = sysBackupLogs.filter(record => (
    isRestorableBackupArtifact(record) || backupVerifiedSummary(record, { rollback: true })
  )).length;

  if (!usableArtifacts) {
    add({
      priority: 1,
      tone: 'is-critical',
      label: 'Recovery gap',
      title: 'Create the first verified recovery artifact',
      detail: 'Recovery coverage remains not ready until a backup worker finishes and the artifact passes verification.',
      button: 'Create Backup',
      onclick: "focusBackupArea('sets', 'backup-request-panel')",
    });
  }

  sysRestoreJobs.forEach(job => {
    const id = Number(job.restore_job_id || job.id);
    const status = backupStatusValue(job, ['lifecycle_status', 'status'], 'UNKNOWN');
    const reference = job.backup_reference || job.backup_set_id || `Job #${id}`;
    if (status === 'AWAITING_APPROVAL') {
      add({
        priority: 5,
        label: 'Restore step B2',
        title: `Approve restore ${reference}`,
        detail: 'Review the request and approve or reject it with fresh MFA.',
        button: 'Review and Approve',
        onclick: `approveRestoreJob(${id})`,
      });
    } else if (status === 'APPROVED') {
      const canDryRun = backupActionAllowedAny(job, ['RESTORE_DRY_RUN', 'DRY_RUN'], true);
      add({
        priority: 6,
        label: 'Restore step B3',
        title: `Run isolated dry-run for ${reference}`,
        detail: 'The production restore stays blocked until isolated validation passes.',
        button: canDryRun ? 'Run Dry-run' : 'Open Restore Jobs',
        onclick: canDryRun ? `runRestoreDryRun(${id})` : "focusBackupArea('restore', 'restore-jobs-table')",
      });
    } else if (status === 'DRY_RUN_PASSED') {
      const canExecute = backupActionAllowedAny(job, ['RESTORE_EXECUTE', 'EXECUTE'], true);
      add({
        priority: 7,
        label: 'Restore step B4',
        title: `Dry-run passed for ${reference}`,
        detail: 'Execute only after reviewing the dry-run result; fresh MFA and confirmation are required.',
        button: canExecute ? 'Execute Restore' : 'Open Restore Jobs',
        onclick: canExecute ? `executeRestoreJob(${id})` : "focusBackupArea('restore', 'restore-jobs-table')",
      });
    } else if (status === 'VERIFYING') {
      const canVerify = backupActionAllowedAny(job, ['VERIFY_TARGET', 'RESTORE_VERIFY'], true);
      add({
        priority: 4,
        label: 'Restore step B5',
        title: `Validate restored target for ${reference}`,
        detail: 'Confirm the restored target checksum, schema, integrity, and health before completion.',
        button: canVerify ? 'Verify Restored Target' : 'Open Restore Jobs',
        onclick: canVerify ? `verifyRestoreTarget(${id})` : "focusBackupArea('restore', 'restore-jobs-table')",
      });
    } else if (['FAILED', 'DRY_RUN_FAILED'].includes(status)) {
      add({
        priority: 2,
        tone: 'is-critical',
        label: 'Restore stopped safely',
        title: `Review failed restore ${reference}`,
        detail: job.result_message || 'A validation or execution check failed. Review the protected workflow before starting another attempt.',
        button: 'Review Restore',
        onclick: "focusBackupArea('restore', 'restore-jobs-table')",
      });
    }
  });

  sysRollbackRequests.forEach(request => {
    const id = Number(request.rollback_request_id || request.id);
    const status = backupStatusValue(request, ['lifecycle_status', 'status'], 'UNKNOWN');
    const moduleName = backupModuleName(request.affected_module) || `Request #${id}`;
    if (status === 'AWAITING_APPROVAL') {
      const canApprove = isVerifiedRollbackRequestArtifact(request);
      add({
        priority: 8,
        label: 'Rollback approval',
        title: canApprove ? `Review ${moduleName} rollback` : `${moduleName} rollback is waiting for approval`,
        detail: 'The target artifact must stay verified and approval requires fresh MFA.',
        button: canApprove ? 'Review and Approve' : 'Open Rollback',
        onclick: canApprove ? `approveRollbackRequest(${id})` : "focusBackupArea('rollback')",
      });
    } else if (status === 'APPROVED') {
      const canExecute = isVerifiedRollbackRequestArtifact(request)
        && backupActionAllowedAny(request, ['ROLLBACK_EXECUTE', 'EXECUTE'], true);
      add({
        priority: 9,
        label: 'Rollback execution',
        title: `Approved rollback for ${moduleName}`,
        detail: 'Execute with fresh MFA, then verify module integrity and health.',
        button: canExecute ? 'Execute Rollback' : 'Open Rollback',
        onclick: canExecute ? `executeRollbackRequest(${id})` : "focusBackupArea('rollback')",
      });
    } else if (status === 'FAILED') {
      add({
        priority: 3,
        tone: 'is-critical',
        label: 'Rollback stopped safely',
        title: `Review failed ${moduleName} rollback`,
        detail: request.result_message || 'Review the integrity result before another protected rollback request.',
        button: 'Review Rollback',
        onclick: "focusBackupArea('rollback')",
      });
    }
  });

  sysBackupLogs.forEach(record => {
    const id = Number(record.backup_set_id || record.backup_id || record.id);
    const status = backupStatusValue(record, ['lifecycle_status', 'status'], 'UNKNOWN');
    const reference = record.backup_reference || `Backup #${id}`;
    if (['PENDING', 'FAILED'].includes(status)) {
      const canRun = backupActionAllowedAny(record, ['BACKUP_RUN', 'RUN'], true);
      add({
        priority: status === 'FAILED' ? 3 : 12,
        tone: status === 'FAILED' ? 'is-critical' : '',
        label: status === 'FAILED' ? 'Backup needs review' : 'Backup step A2',
        title: `${status === 'FAILED' ? 'Retry' : 'Run'} worker for ${reference}`,
        detail: status === 'FAILED' ? (record.error_message || record.result_message || 'Review the failure before retrying the backup worker.') : 'The request is queued but no usable artifact exists yet.',
        button: canRun ? 'Run Backup Worker' : 'Open Backups',
        onclick: canRun ? `runBackup(${id})` : "focusBackupArea('sets')",
      });
    } else if (['COMPLETED', 'VERIFICATION_FAILED'].includes(status)) {
      const canVerify = backupActionAllowedAny(record, ['BACKUP_VERIFY', 'VERIFY'], true);
      add({
        priority: status === 'VERIFICATION_FAILED' ? 2 : 11,
        tone: status === 'VERIFICATION_FAILED' ? 'is-critical' : '',
        label: 'Backup step A3',
        title: `${status === 'VERIFICATION_FAILED' ? 'Re-check' : 'Verify'} ${reference}`,
        detail: 'The backend must verify artifact availability, server-generated checksum, and integrity before recovery use.',
        button: canVerify ? 'Verify Artifact' : 'Open Backups',
        onclick: canVerify ? `verifyBackup(${id})` : "focusBackupArea('sets')",
      });
    }
  });

  if (!actions.length) {
    add({
      priority: 100,
      tone: 'is-success',
      label: 'No pending workflow',
      title: 'Current protected actions are complete',
      detail: 'Verified artifacts remain available. Create a new backup when the next recovery point is due.',
      button: 'View Coverage',
      onclick: "focusBackupArea('overview', 'backup-coverage-table')",
    });
  }
  return actions.sort((left, right) => left.priority - right.priority);
}

function renderBackupNextActions() {
  const target = document.getElementById('backup-next-actions');
  if (!target) return;
  const actions = collectBackupNextActions();
  const visible = actions.slice(0, 6);
  target.innerHTML = visible.map(action => `
    <article class="backup-next-action ${sysEsc(action.tone || '')}">
      <span class="backup-next-action-label">${sysEsc(action.label)}</span>
      <strong>${sysEsc(action.title)}</strong>
      <small>${sysEsc(action.detail)}</small>
      <button type="button" class="btn-sysadmin-sm" onclick="${action.onclick}">${sysEsc(action.button)}</button>
    </article>
  `).join('') + (actions.length > visible.length ? `
    <article class="backup-next-action backup-next-action-neutral">
      <span class="backup-next-action-label">More work</span>
      <strong>${actions.length - visible.length} additional action(s)</strong>
      <small>Open the workflow tables to review all pending records.</small>
      <button type="button" class="btn-sysadmin-sm" onclick="focusBackupArea('sets')">Open Backups</button>
    </article>
  ` : '');
}

function backupCoverageRecoveryReady(module) {
  const deploymentBackup = String(module?.last_backup_type || '').toUpperCase() === 'DEPLOYMENT_VERSION';
  return (!deploymentBackup && isRestorableBackupArtifact(module)) || isVerifiedRollbackPoint(module);
}

function filteredBackupCoverage() {
  const query = document.getElementById('backup-coverage-search')?.value || '';
  const readiness = document.getElementById('backup-coverage-readiness-filter')?.value || 'ALL';
  return sysBackupCoverage.filter(module => {
    if (!backupMatchesQuery(query, module.module_name, module.module_key, module.last_backup_type, module.last_health_status)) return false;
    const ready = backupCoverageRecoveryReady(module);
    const maintenance = module.under_maintenance || String(module.last_health_status || '').toUpperCase() === 'MAINTENANCE';
    if (readiness === 'READY') return ready;
    if (readiness === 'NEEDS_BACKUP') return !ready;
    if (readiness === 'MAINTENANCE') return maintenance;
    return true;
  });
}

function filterBackupCoverage() {
  renderBackupCoverage();
}

function clearBackupCoverageFilters() {
  const search = document.getElementById('backup-coverage-search');
  const readiness = document.getElementById('backup-coverage-readiness-filter');
  if (search) search.value = '';
  if (readiness) readiness.value = 'ALL';
  renderBackupCoverage();
  search?.focus?.();
}

function renderBackupCoverage() {
  const tbody = document.getElementById('backup-coverage-tbody');
  if (!tbody) return;
  if (!sysBackupCoverage.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No module coverage loaded.</td></tr>';
    setBackupResultCount('backup-coverage-results', 0, 0, 'module');
    return;
  }
  const visibleModules = filteredBackupCoverage();
  setBackupResultCount('backup-coverage-results', visibleModules.length, sysBackupCoverage.length, 'module');
  if (!visibleModules.length) {
    tbody.innerHTML = backupEmptyFilterRow(9, 'No modules match these filters.', 'Clear the filters or search using a module name or key.');
    return;
  }
  tbody.innerHTML = visibleModules.map(module => {
    const isDeploymentBackup = String(module.last_backup_type || '').toUpperCase() === 'DEPLOYMENT_VERSION';
    const restorable = !isDeploymentBackup && isRestorableBackupArtifact(module);
    const rollbackReady = isVerifiedRollbackPoint(module);
    const restoreDisabled = module.backup_set_id && restorable ? '' : 'disabled';
    const rollbackDisabled = rollbackReady ? '' : 'disabled';
    const maintenanceNote = module.under_maintenance || String(module.last_health_status || '').toUpperCase() === 'MAINTENANCE'
      ? '<small class="backup-maintenance-note">Under maintenance for controlled restore</small>'
      : '';
    const readinessNote = restorable
      ? '<small class="sysadmin-muted">Verified artifact ready for restore</small>'
      : rollbackReady
        ? '<small class="sysadmin-muted">Verified recovery point ready for rollback</small>'
        : '<small class="sysadmin-muted">No verified usable artifact</small>';
    const recoveryAction = isDeploymentBackup
      ? `<button class="btn-sysadmin-sm backup-action-primary" onclick="requestModuleRollback(${sysJsString(module.module_key)})" ${rollbackDisabled} title="Requires a verified recovery artifact">Request Rollback</button>`
      : `<button class="btn-sysadmin-sm backup-action-primary" onclick="requestRestoreJob(${Number(module.backup_set_id || 0)}, ${sysJsString(module.module_key)}, ${sysJsString(backupRestoreType(module.last_backup_type || 'DATABASE'))})" ${restoreDisabled}>Restore Data</button>`;
    return `
      <tr>
        <td><strong>${sysEsc(module.module_name)}</strong><br><small>${sysEsc(module.module_key)}</small><br>${readinessNote}</td>
        <td>${sysStatusBadge(backupCoverageStatus(module, 'data'))}</td>
        <td>${sysStatusBadge(backupCoverageStatus(module, 'file'))}</td>
        <td>${sysStatusBadge(backupCoverageStatus(module, 'config'))}</td>
        <td>${rollbackReady ? sysStatusBadge('VERIFIED') : sysStatusBadge('NOT AVAILABLE')}</td>
        <td><small>Current: ${sysEsc(module.current_version || '-')}<br>Stable: ${sysEsc(module.stable_version || '-')}</small></td>
        <td><small>${sysEsc(sysFormatDateTime(module.last_backup_timestamp))}</small></td>
        <td>${sysStatusBadge(module.last_health_status)}${maintenanceNote}</td>
        <td>
          <div class="support-row-actions">
            <button class="btn-sysadmin-sm" onclick="switchBackupRecoveryTab('sets')">View Backups</button>
            ${recoveryAction}
            ${isDeploymentBackup ? '' : `<button class="btn-sysadmin-sm backup-action-safe" onclick="requestModuleRollback(${sysJsString(module.module_key)})" ${rollbackDisabled} title="Requires a verified recovery artifact">Rollback Version</button>`}
            <button class="btn-sysadmin-sm" onclick="createBackupIncident(${sysJsString(module.module_key)}, ${sysJsString(module.module_name)})">Create Incident</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filteredBackupLogs() {
  const query = document.getElementById('backup-history-search')?.value || '';
  const type = document.getElementById('backup-history-type-filter')?.value || 'ALL';
  const status = document.getElementById('backup-history-status-filter')?.value || 'ALL';
  return sysBackupLogs.filter(record => {
    const recordType = String(record.backup_type || '').toUpperCase();
    const recordStatus = backupStatusValue(record, ['lifecycle_status', 'status'], 'UNKNOWN');
    if (type !== 'ALL' && recordType !== type) return false;
    if (status !== 'ALL' && recordStatus !== status) return false;
    return backupMatchesQuery(
      query,
      record.backup_reference,
      record.backup_name,
      record.backup_type,
      record.storage_provider,
      record.storage_target,
      record.included_modules,
      record.created_by_username,
      record.status
    );
  });
}

function filterBackupHistory() {
  renderBackupLogs();
  reloadBackupFilteredPage('backups');
}

function clearBackupHistoryFilters() {
  const search = document.getElementById('backup-history-search');
  const type = document.getElementById('backup-history-type-filter');
  const status = document.getElementById('backup-history-status-filter');
  if (search) search.value = '';
  if (type) type.value = 'ALL';
  if (status) status.value = 'ALL';
  renderBackupLogs();
  reloadBackupFilteredPage('backups', 0);
  search?.focus?.();
}

function renderBackupLogs() {
  const tbody = document.getElementById('backup-logs-tbody');
  if (!tbody) return;
  if (!sysBackupLogs.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No backup records found.</td></tr>';
    setBackupResultCount('backup-history-results', 0, 0, 'backup');
    return;
  }
  const visibleBackups = filteredBackupLogs();
  setBackupResultCount('backup-history-results', visibleBackups.length, sysBackupLogs.length, 'backup');
  if (!visibleBackups.length) {
    tbody.innerHTML = backupEmptyFilterRow(9, 'No backups match these filters.', 'Try another reference, module, status, or backup type.');
    return;
  }
  tbody.innerHTML = visibleBackups.map(record => {
    const id = Number(record.backup_set_id || record.backup_id || record.id);
    const backupType = String(record.backup_type || '').toUpperCase();
    const status = backupStatusValue(record, ['lifecycle_status', 'status'], 'UNKNOWN');
    const artifactVerified = isVerifiedBackupArtifact(record);
    const restorable = isRestorableBackupArtifact(record);
    const rollbackReady = artifactVerified && (
      backupExplicitBoolean(record, ['rollback_available']) === true
      || sysModuleRecoveryPoints.some(point => (
        Number(point.backup_set_id) === id && isVerifiedRollbackPoint(point)
      ))
    );
    const canRun = ['PENDING', 'FAILED'].includes(status) && backupActionAllowedAny(record, ['BACKUP_RUN', 'RUN'], true);
    const canVerify = ['COMPLETED', 'VERIFICATION_FAILED'].includes(status)
      && backupActionAllowedAny(record, ['BACKUP_VERIFY', 'VERIFY'], true);
    const recoveryAction = backupType === 'DEPLOYMENT_VERSION'
      ? `<button class="btn-sysadmin-sm backup-action-safe" onclick="requestBackupSetRollback(${id})" ${rollbackReady ? '' : 'disabled'} title="Requires a verified module recovery point">Request Rollback</button>`
      : `<button class="btn-sysadmin-sm backup-action-safe" onclick="requestRestoreJob(${id}, '', ${sysJsString(backupRestoreType(record.backup_type || 'DATABASE'))})" ${restorable && isRestorableBackupType(record.backup_type) ? '' : 'disabled'} title="Requires a verified usable artifact">Request Restore</button>`;
    const actions = [
      `<button class="btn-sysadmin-sm" onclick="openBackupDetails('backup', ${id})">View details</button>`,
      canRun ? `<button class="btn-sysadmin-sm backup-action-primary" onclick="runBackup(${id})">Run backup</button>` : '',
      canVerify ? `<button class="btn-sysadmin-sm backup-action-primary" onclick="verifyBackup(${id})">Verify artifact</button>` : '',
      recoveryAction,
    ].filter(Boolean);
    const verification = backupStatusValue(record, ['verification_status'], backupExplicitBoolean(record, ['artifact_verified']) === true ? 'VERIFIED' : 'NOT VERIFIED');
    const integrity = backupStatusValue(record, ['integrity_status'], 'NOT CHECKED');
    const stepUpMfa = record.step_up_verified_at ? 'VERIFIED' : backupStatusValue(record, ['step_up_mfa_status', 'mfa_status'], 'REQUIRED');
    return `
      <tr>
        <td><strong>${sysEsc(record.backup_reference)}</strong>${record.backup_name ? `<br><small>${sysEsc(record.backup_name)}</small>` : ''}</td>
        <td>${sysEsc(backupTypeLabel(record.backup_type))}</td>
        <td>${sysEsc(record.storage_provider || record.storage_target || '-')}</td>
        <td>${backupLifecycleCell(status, 'backup')}<small>${sysEsc(record.completed_at ? `Updated ${sysFormatDateTime(record.completed_at)}` : '')}</small></td>
        <td>${backupStatusStack([
          ['Artifact', backupArtifactReadiness(record), record.storage_location || record.backup_location || ''],
          ['Verification', verification, record.verified_at ? sysFormatDateTime(record.verified_at) : ''],
          ['Integrity', integrity, ''],
        ])}</td>
        <td><small>${sysEsc(sysShortHash(record.checksum || record.manifest_hash))}</small></td>
        <td>${backupStatusStack([
          ['Approval', backupStatusValue(record, ['approval_status'], 'NOT REQUIRED'), record.approved_by_username || ''],
          ['Last MFA step-up', stepUpMfa, record.step_up_verified_at ? sysFormatDateTime(record.step_up_verified_at) : 'Fresh challenge required to verify'],
        ])}</td>
        <td><small>${sysEsc(sysFormatDateTime(record.created_at))}</small></td>
        <td><div class="support-row-actions">${actions.join('')}</div></td>
      </tr>
    `;
  }).join('');
}

function filteredModuleRecoveryPoints() {
  const query = document.getElementById('backup-recovery-search')?.value || '';
  const readiness = document.getElementById('backup-recovery-readiness-filter')?.value || 'ALL';
  return sysModuleRecoveryPoints.filter(point => {
    const ready = isVerifiedRollbackPoint(point);
    if (readiness === 'READY' && !ready) return false;
    if (readiness === 'NOT_READY' && ready) return false;
    return backupMatchesQuery(
      query,
      point.module_name,
      point.module_key,
      point.backup_reference,
      point.current_version,
      point.stable_version,
      point.health_status_at_backup
    );
  });
}

function filterModuleRecoveryPoints() {
  renderModuleRecoveryPoints();
  reloadBackupFilteredPage('recovery');
}

function clearModuleRecoveryFilters() {
  const search = document.getElementById('backup-recovery-search');
  const readiness = document.getElementById('backup-recovery-readiness-filter');
  if (search) search.value = '';
  if (readiness) readiness.value = 'ALL';
  renderModuleRecoveryPoints();
  reloadBackupFilteredPage('recovery', 0);
  search?.focus?.();
}

function renderModuleRecoveryPoints() {
  const tbody = document.getElementById('module-recovery-tbody');
  if (!tbody) return;
  if (!sysModuleRecoveryPoints.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="table-empty">No module recovery points found.</td></tr>';
    setBackupResultCount('backup-recovery-results', 0, 0, 'recovery point');
    return;
  }
  const visiblePoints = filteredModuleRecoveryPoints();
  setBackupResultCount('backup-recovery-results', visiblePoints.length, sysModuleRecoveryPoints.length, 'recovery point');
  if (!visiblePoints.length) {
    tbody.innerHTML = backupEmptyFilterRow(10, 'No recovery points match these filters.', 'Clear the filter or search using a module or backup reference.');
    return;
  }
  tbody.innerHTML = visiblePoints.map(point => {
    const rollbackReady = isVerifiedRollbackPoint(point);
    return `
      <tr>
        <td><strong>${sysEsc(point.module_name)}</strong><br><small>${sysEsc(point.backup_reference || point.module_key)}</small></td>
        <td>${sysEsc(point.current_version || '-')}</td>
        <td>${sysEsc(point.stable_version || '-')}</td>
        <td>${sysStatusBadge(point.health_status_at_backup)}</td>
        <td>${backupStatusStack([
          ['Artifact', backupArtifactReadiness(point), point.artifact_location || ''],
          ['Verification', backupStatusValue(point, ['verification_status'], backupExplicitBoolean(point, ['artifact_verified']) === true ? 'VERIFIED' : 'NOT VERIFIED'), point.verified_at ? sysFormatDateTime(point.verified_at) : ''],
        ])}</td>
        <td>${sysStatusBadge(backupStatusValue(point, ['integrity_status'], 'NOT CHECKED'))}</td>
        <td>${rollbackReady ? sysStatusBadge('AVAILABLE') : sysStatusBadge('NOT AVAILABLE')}</td>
        <td>${backupApprovalMfaStatus(point)}</td>
        <td><small>${sysEsc(sysFormatDateTime(point.created_at))}</small></td>
        <td>
          <div class="support-row-actions">
            <button class="btn-sysadmin-sm" onclick="openBackupDetails('recovery', ${Number(point.id)})">View details</button>
            <button class="btn-sysadmin-sm backup-action-primary" onclick="requestModuleRollback(${sysJsString(point.module_key)})" ${rollbackReady ? '' : 'disabled'} title="Requires a verified recovery artifact">Request Rollback</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderRestoreJobs() {
  const tbody = document.getElementById('restore-jobs-tbody');
  if (!tbody) return;
  if (!sysRestoreJobs.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="table-empty">No restore jobs found.</td></tr>';
    return;
  }
  tbody.innerHTML = sysRestoreJobs.map(job => {
    const id = Number(job.restore_job_id || job.id);
    const status = backupStatusValue(job, ['lifecycle_status', 'status'], 'UNKNOWN');
    const dryRunStatus = backupStatusValue(job, ['dry_run_status'], status.startsWith('DRY_RUN_') ? status : 'NOT RUN');
    const integrityStatus = backupStatusValue(job, ['integrity_status'], 'NOT CHECKED');
    const dryRunPassed = status === 'DRY_RUN_PASSED' || ['PASSED', 'DRY_RUN_PASSED'].includes(dryRunStatus);
    const actions = [];
    if (status === 'AWAITING_APPROVAL') {
      actions.push(`<button class="btn-sysadmin-sm backup-action-primary" onclick="approveRestoreJob(${id})" title="Review and approve with fresh MFA">Approve with MFA</button>`);
      actions.push(`<button class="btn-sysadmin-sm backup-action-danger" onclick="rejectRestoreJob(${id})">Reject</button>`);
    }
    if (status === 'APPROVED' && !dryRunPassed) {
      const canDryRun = backupActionAllowedAny(job, ['RESTORE_DRY_RUN', 'DRY_RUN'], true);
      actions.push(`<button class="btn-sysadmin-sm backup-action-primary" onclick="runRestoreDryRun(${id})" ${canDryRun ? '' : 'disabled'}>Run isolated dry-run</button>`);
    }
    if (dryRunPassed) {
      const canExecute = backupActionAllowedAny(job, ['RESTORE_EXECUTE', 'EXECUTE'], true);
      actions.push(`<button class="btn-sysadmin-sm backup-action-primary" onclick="executeRestoreJob(${id})" ${canExecute ? '' : 'disabled'}>Execute restore</button>`);
    }
    if (status === 'VERIFYING') {
      const canVerifyTarget = backupActionAllowedAny(job, ['VERIFY_TARGET', 'RESTORE_VERIFY'], true);
      actions.push(`<button class="btn-sysadmin-sm backup-action-safe" onclick="verifyRestoreTarget(${id})" ${canVerifyTarget ? '' : 'disabled'}>Validate restored target</button>`);
    }
    if (['AWAITING_APPROVAL', 'APPROVED', 'DRY_RUN_PASSED', 'PENDING'].includes(status)) {
      const canCancel = backupActionAllowedAny(job, ['RESTORE_CANCEL', 'CANCEL'], true);
      actions.push(`<button class="btn-sysadmin-sm backup-action-danger" onclick="updateRestoreJobStatus(${id}, 'CANCELLED')" ${canCancel ? '' : 'disabled'}>Cancel</button>`);
    }
    return `
      <tr>
        <td><strong>#${id}</strong><br><small>${sysEsc(sysFormatDateTime(job.created_at))}</small></td>
        <td>${sysEsc(job.backup_reference || job.backup_set_id || '-')}</td>
        <td>${sysEsc(backupTypeLabel(job.restore_type))}</td>
        <td>${sysEsc(job.affected_module ? backupModuleName(job.affected_module) : '-')}</td>
        <td>${backupLifecycleCell(status, 'restore')}</td>
        <td>${sysStatusBadge(dryRunStatus)}<br><small>${sysEsc(job.dry_run_completed_at ? sysFormatDateTime(job.dry_run_completed_at) : '-')}</small></td>
        <td>${sysStatusBadge(integrityStatus)}<br><small>${sysEsc(job.integrity_verified_at ? sysFormatDateTime(job.integrity_verified_at) : '-')}</small></td>
        <td>${backupApprovalMfaStatus(job)}</td>
        <td>${sysEsc(job.requested_by_username || job.requested_by || '-')}</td>
        <td><small>${sysEsc(job.result_message || '-')}</small></td>
        <td><div class="support-row-actions">${actions.join('') || '<span class="sysadmin-muted">No actions</span>'}</div></td>
      </tr>
    `;
  }).join('');
}

function renderRollbackRequests() {
  const tbody = document.getElementById('rollback-requests-tbody');
  if (!tbody) return;
  if (!sysRollbackRequests.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No rollback requests found.</td></tr>';
    return;
  }
  tbody.innerHTML = sysRollbackRequests.map(request => {
    const id = Number(request.rollback_request_id || request.id);
    const status = backupStatusValue(request, ['lifecycle_status', 'status'], 'UNKNOWN');
    const artifactReady = isVerifiedRollbackRequestArtifact(request);
    const actions = [];
    if (status === 'AWAITING_APPROVAL') {
      const canApprove = artifactReady;
      const approvalTitle = canApprove ? 'Verified artifact; approve with fresh MFA' : backupApprovalUnavailableMessage('rollback request');
      actions.push(`<button class="btn-sysadmin-sm backup-action-primary" onclick="approveRollbackRequest(${id})" ${canApprove ? '' : 'disabled'} title="${sysEsc(approvalTitle)}">Approve with MFA</button>`);
      actions.push(`<button class="btn-sysadmin-sm backup-action-danger" onclick="rejectRollbackRequest(${id})">Reject</button>`);
    }
    if (status === 'APPROVED') {
      const canExecute = artifactReady && backupActionAllowedAny(request, ['ROLLBACK_EXECUTE', 'EXECUTE'], true);
      actions.push(`<button class="btn-sysadmin-sm backup-action-primary" onclick="executeRollbackRequest(${id})" ${canExecute ? '' : 'disabled'}>Execute rollback</button>`);
    }
    if (['AWAITING_APPROVAL', 'APPROVED', 'PENDING'].includes(status)) {
      const canCancel = backupActionAllowedAny(request, ['ROLLBACK_CANCEL', 'CANCEL'], true);
      actions.push(`<button class="btn-sysadmin-sm backup-action-danger" onclick="updateRollbackRequestStatus(${id}, 'CANCELLED')" ${canCancel ? '' : 'disabled'}>Cancel</button>`);
    }
    return `
      <tr>
        <td><strong>${sysEsc(backupModuleName(request.affected_module))}</strong></td>
        <td>${sysEsc(request.current_version || '-')}</td>
        <td>${sysEsc(request.target_version || '-')}</td>
        <td>${backupLifecycleCell(status, 'rollback')}</td>
        <td>${backupStatusStack([
          ['Artifact', artifactReady ? 'VERIFIED' : 'NOT VERIFIED', request.artifact_location || ''],
          ['Integrity', backupStatusValue(request, ['integrity_status'], 'NOT CHECKED'), request.integrity_verified_at ? sysFormatDateTime(request.integrity_verified_at) : ''],
        ])}</td>
        <td>${backupApprovalMfaStatus(request)}</td>
        <td>${sysEsc(request.requested_by_username || request.requested_by || '-')}</td>
        <td><small>${sysEsc(request.result_message || request.reason || '-')}</small></td>
        <td><div class="support-row-actions">${actions.join('') || '<span class="sysadmin-muted">No actions</span>'}</div></td>
      </tr>
    `;
  }).join('');
}

function backupArrayValue(value) {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(item => String(item)).filter(Boolean);
    } catch (_) {
      return value.split(',').map(item => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function backupEnabled(record, fallback = true) {
  const value = backupExplicitBoolean(record, ['enabled', 'is_enabled']);
  return value === null ? fallback : value;
}

function backupRecordId(record, candidates = []) {
  for (const key of [...candidates, 'id']) {
    const value = Number(record?.[key] || 0);
    if (value > 0) return value;
  }
  return 0;
}

function backupFrequencyLabel(record) {
  const frequency = String(record?.frequency || 'DAILY').toUpperCase();
  const time = String(record?.run_time || '').slice(0, 5);
  const weekDays = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  if (frequency === 'HOURLY') return 'Every hour';
  if (frequency === 'WEEKLY') return `${weekDays[Number(record?.day_of_week)] || 'Weekly'}${time ? ` at ${time}` : ''}`;
  if (frequency === 'MONTHLY') return `Day ${Number(record?.day_of_month || 1)}${time ? ` at ${time}` : ''}`;
  return `Daily${time ? ` at ${time}` : ''}`;
}

function renderBackupOperationalModuleOptions() {
  const scheduleSelect = document.getElementById('backup-schedule-modules');
  const drillSelect = document.getElementById('backup-drill-module');
  if (scheduleSelect && sysBackupCoverage.length) {
    const existing = new Set(Array.from(scheduleSelect.selectedOptions || []).map(option => option.value));
    const initialized = scheduleSelect.dataset.initialized === 'true';
    scheduleSelect.innerHTML = sysBackupCoverage.map(module => `
      <option value="${sysEsc(module.module_key)}" ${initialized ? (existing.has(module.module_key) ? 'selected' : '') : 'selected'}>${sysEsc(module.module_name)}</option>
    `).join('');
    scheduleSelect.dataset.initialized = 'true';
    renderBackupScheduleModulePicker(sysBackupScheduleModuleQuery);
  }
  if (drillSelect && sysBackupCoverage.length) {
    const selected = drillSelect.value;
    drillSelect.innerHTML = '<option value="">All covered modules</option>' + sysBackupCoverage.map(module => `
      <option value="${sysEsc(module.module_key)}">${sysEsc(module.module_name)}</option>
    `).join('');
    drillSelect.value = selected;
  }
}

function renderBackupScheduleModulePicker(query = sysBackupScheduleModuleQuery) {
  sysBackupScheduleModuleQuery = String(query || '');
  const picker = document.getElementById('backup-schedule-module-picker');
  const select = document.getElementById('backup-schedule-modules');
  const help = document.getElementById('backup-schedule-modules-help');
  if (!picker || !select) return;
  const selected = new Set(Array.from(select.selectedOptions || []).map(option => option.value));
  const visible = sysBackupCoverage.filter(module => backupMatchesQuery(
    sysBackupScheduleModuleQuery,
    module.module_name,
    module.module_key
  ));
  if (help) help.textContent = `${selected.size} module${selected.size === 1 ? '' : 's'} selected. Selection stays while searching.`;
  if (!visible.length) {
    picker.innerHTML = '<div class="backup-operation-module-empty">No matching modules.</div>';
    return;
  }
  picker.innerHTML = visible.map(module => {
    const checked = selected.has(module.module_key);
    return `<label class="backup-operation-module-chip${checked ? ' is-selected' : ''}"><input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleBackupScheduleModule(${sysJsString(module.module_key)}, this.checked)" /><span>${sysEsc(module.module_name)}</span></label>`;
  }).join('');
}

function toggleBackupScheduleModule(moduleKey, selected) {
  const select = document.getElementById('backup-schedule-modules');
  if (!select) return;
  const option = Array.from(select.options || []).find(item => item.value === moduleKey);
  if (option) option.selected = Boolean(selected);
  renderBackupScheduleModulePicker();
}

function selectAllBackupScheduleModules(selected = true) {
  const select = document.getElementById('backup-schedule-modules');
  if (!select) return;
  Array.from(select.options || []).forEach(option => { option.selected = Boolean(selected); });
  renderBackupScheduleModulePicker();
}

function updateScheduleFrequencyFields(prefix) {
  const frequency = String(document.getElementById(`${prefix}-frequency`)?.value || 'DAILY').toUpperCase();
  const timeField = document.getElementById(`${prefix}-time-field`);
  const weekdayField = document.getElementById(`${prefix}-weekday-field`);
  const monthdayField = document.getElementById(`${prefix}-monthday-field`);
  if (timeField) timeField.hidden = frequency === 'HOURLY';
  if (weekdayField) weekdayField.hidden = frequency !== 'WEEKLY';
  if (monthdayField) monthdayField.hidden = frequency !== 'MONTHLY';
}

function backupSchedulePayload(prefix, options = {}) {
  const frequency = String(document.getElementById(`${prefix}-frequency`)?.value || 'DAILY').toUpperCase();
  const payload = {
    frequency,
    run_time: document.getElementById(`${prefix}-time`)?.value || '02:00',
    timezone: document.getElementById(`${prefix}-timezone`)?.value || 'Asia/Manila',
    enabled: Boolean(document.getElementById(`${prefix}-enabled`)?.checked),
  };
  if (frequency === 'WEEKLY') payload.day_of_week = Number(document.getElementById(`${prefix}-weekday`)?.value || 1);
  if (frequency === 'MONTHLY') payload.day_of_month = Number(document.getElementById(`${prefix}-monthday`)?.value || 1);
  return { ...payload, ...options };
}

function resetBackupScheduleForm() {
  const form = document.getElementById('backup-schedule-form');
  form?.reset?.();
  const id = document.getElementById('backup-schedule-id');
  const title = document.getElementById('backup-schedule-form-title');
  const modules = document.getElementById('backup-schedule-modules');
  if (id) id.value = '';
  if (title) title.textContent = 'Create backup schedule';
  if (modules) Array.from(modules.options || []).forEach(option => { option.selected = true; });
  const moduleSearch = document.getElementById('backup-schedule-module-search');
  if (moduleSearch) moduleSearch.value = '';
  sysBackupScheduleModuleQuery = '';
  const time = document.getElementById('backup-schedule-time');
  const timezone = document.getElementById('backup-schedule-timezone');
  const enabled = document.getElementById('backup-schedule-enabled');
  if (time) time.value = '02:00';
  if (timezone) timezone.value = 'Asia/Manila';
  if (enabled) enabled.checked = true;
  updateScheduleFrequencyFields('backup-schedule');
  renderBackupScheduleModulePicker();
}

function editBackupSchedule(scheduleId) {
  const schedule = sysBackupSchedules.find(item => backupRecordId(item, ['schedule_id']) === Number(scheduleId));
  if (!schedule) return;
  const set = (id, value) => { const element = document.getElementById(id); if (element) element.value = value ?? ''; };
  set('backup-schedule-id', backupRecordId(schedule, ['schedule_id']));
  set('backup-schedule-name', schedule.schedule_name || schedule.name || '');
  set('backup-schedule-type', schedule.backup_type || 'DATABASE');
  set('backup-schedule-provider', schedule.storage_provider || 'LOCAL');
  set('backup-schedule-frequency', schedule.frequency || 'DAILY');
  set('backup-schedule-time', String(schedule.run_time || '02:00').slice(0, 5));
  set('backup-schedule-weekday', schedule.day_of_week || 1);
  set('backup-schedule-monthday', schedule.day_of_month || 1);
  set('backup-schedule-timezone', schedule.timezone || 'Asia/Manila');
  const enabled = document.getElementById('backup-schedule-enabled');
  if (enabled) enabled.checked = backupEnabled(schedule);
  const selectedModules = new Set(backupArrayValue(schedule.included_modules));
  const modules = document.getElementById('backup-schedule-modules');
  if (modules) Array.from(modules.options || []).forEach(option => { option.selected = selectedModules.has(option.value); });
  const title = document.getElementById('backup-schedule-form-title');
  if (title) title.textContent = 'Edit backup schedule';
  updateScheduleFrequencyFields('backup-schedule');
  renderBackupScheduleModulePicker();
  focusBackupArea('automation', 'backup-schedule-form');
}

async function saveBackupSchedule() {
  const id = Number(document.getElementById('backup-schedule-id')?.value || 0);
  const name = document.getElementById('backup-schedule-name')?.value.trim();
  const moduleSelect = document.getElementById('backup-schedule-modules');
  const includedModules = Array.from(moduleSelect?.selectedOptions || []).map(option => option.value).filter(Boolean);
  if (!name) return showSysToast('Enter a schedule name.', 'error');
  if (!includedModules.length) return showSysToast('Select at least one module for the backup schedule.', 'error');
  const body = backupSchedulePayload('backup-schedule', {
    schedule_name: name,
    backup_type: document.getElementById('backup-schedule-type')?.value || 'DATABASE',
    storage_provider: document.getElementById('backup-schedule-provider')?.value || 'LOCAL',
    included_modules: includedModules,
  });
  const idempotencyKey = backupIdempotencyKey(id ? 'schedule-update' : 'schedule-create', id || 'new');
  return runBackupMutation(`schedule-save:${id || 'new'}`, async () => {
    try {
      const response = await apiFetch(id ? `/api/admin/backups/schedules/${id}` : '/api/admin/backups/schedules', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save backup schedule.');
      clearBackupIdempotencyKey(id ? 'schedule-update' : 'schedule-create', id || 'new');
      showSysToast(data.message || 'Backup schedule saved.', 'success');
      resetBackupScheduleForm();
      await loadBackupLogs();
      return data;
    } catch (error) {
      showSysToast(error.message || 'Failed to save backup schedule.', 'error');
      return null;
    }
  });
}

async function toggleBackupSchedule(scheduleId, enabled) {
  const id = Number(scheduleId);
  const idempotencyKey = backupIdempotencyKey('schedule-toggle', id);
  return runBackupMutation(`schedule-toggle:${id}`, async () => {
    try {
      const response = await apiFetch(`/api/admin/backups/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ enabled: Boolean(enabled) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update backup schedule.');
      clearBackupIdempotencyKey('schedule-toggle', id);
      showSysToast(data.message || `Backup schedule ${enabled ? 'enabled' : 'disabled'}.`, 'success');
      await loadBackupLogs();
      return data;
    } catch (error) {
      showSysToast(error.message || 'Failed to update backup schedule.', 'error');
      return null;
    }
  });
}

function runBackupScheduleNow(scheduleId) {
  const id = Number(scheduleId);
  return backupProtectedMutation({
    lockKey: `schedule-run:${id}`,
    purpose: 'SCHEDULE_RUN',
    resourceType: 'BACKUP_SCHEDULE',
    resourceId: id,
    endpoint: `/api/admin/backups/schedules/${id}/run-now`,
  });
}

function renderBackupSchedules() {
  const tbody = document.getElementById('backup-schedules-tbody');
  if (!tbody) return;
  const error = sysBackupOperationalErrors['backup schedules'];
  if (error) {
    tbody.innerHTML = backupEmptyFilterRow(7, 'Backup schedules could not be loaded.', error);
    return;
  }
  if (!sysBackupSchedules.length) {
    tbody.innerHTML = backupEmptyFilterRow(7, 'No automated backup schedules yet.', 'Create a schedule above to keep recovery points current.');
    return;
  }
  tbody.innerHTML = sysBackupSchedules.map(schedule => {
    const id = backupRecordId(schedule, ['schedule_id']);
    const enabled = backupEnabled(schedule);
    const status = backupStatusValue(schedule, ['last_status', 'status'], 'NOT RUN');
    return `<tr>
      <td><strong>${sysEsc(schedule.schedule_name || schedule.name || `Schedule #${id}`)}</strong><br><small>${sysEsc(schedule.schedule_reference || '')}</small></td>
      <td>${sysEsc(backupTypeLabel(schedule.backup_type))}<br><small>${sysEsc(schedule.storage_provider || '-')} &middot; ${backupArrayValue(schedule.included_modules).length} module(s)</small></td>
      <td>${sysEsc(backupFrequencyLabel(schedule))}<br><small>${sysEsc(schedule.timezone || 'Asia/Manila')}</small></td>
      <td><small>${sysEsc(schedule.next_run_at ? sysFormatDateTime(schedule.next_run_at) : (enabled ? 'Pending scheduler calculation' : 'Disabled'))}</small></td>
      <td><small>${sysEsc(schedule.last_run_at ? sysFormatDateTime(schedule.last_run_at) : 'Never')}</small></td>
      <td>${sysStatusBadge(enabled ? 'ENABLED' : 'DISABLED')}<br>${sysStatusBadge(status)}</td>
      <td><div class="support-row-actions"><button class="btn-sysadmin-sm" onclick="editBackupSchedule(${id})">Edit</button><button class="btn-sysadmin-sm" onclick="toggleBackupSchedule(${id}, ${enabled ? 'false' : 'true'})">${enabled ? 'Disable' : 'Enable'}</button><button class="btn-sysadmin-sm backup-action-primary" onclick="runBackupScheduleNow(${id})">Run now with MFA</button></div></td>
    </tr>`;
  }).join('');
}

function populateBackupRetentionForm() {
  const form = document.getElementById('backup-retention-form');
  if (!form) return;
  const policy = sysBackupRetentionPolicy;
  if (!policy || Array.isArray(policy)) {
    form.dataset.policyId = '';
    const error = sysBackupOperationalErrors['retention policy'];
    const result = document.getElementById('backup-retention-result');
    if (error && result) result.textContent = error;
    return;
  }
  form.dataset.policyId = String(backupRecordId(policy, ['policy_id']));
  const set = (id, value) => { const element = document.getElementById(id); if (element) element.value = value ?? ''; };
  set('backup-retention-name', policy.policy_name || 'Default backup retention');
  set('backup-retention-type', policy.backup_type || 'ALL');
  set('backup-retention-provider', policy.storage_provider || 'ALL');
  set('backup-retention-keep-last', policy.keep_last ?? 7);
  set('backup-retention-age', policy.max_age_days ?? 90);
  const deleteArtifacts = document.getElementById('backup-retention-delete-artifacts');
  const enabled = document.getElementById('backup-retention-enabled');
  if (deleteArtifacts) deleteArtifacts.checked = backupExplicitBoolean(policy, ['delete_expired_artifacts']) === true;
  if (enabled) enabled.checked = backupEnabled(policy);
}

function backupRetentionPayload(forceEnabled) {
  return {
    policy_name: document.getElementById('backup-retention-name')?.value.trim() || 'Default backup retention',
    backup_type: document.getElementById('backup-retention-type')?.value || 'ALL',
    storage_provider: document.getElementById('backup-retention-provider')?.value || 'ALL',
    keep_last: Number(document.getElementById('backup-retention-keep-last')?.value || 7),
    max_age_days: Number(document.getElementById('backup-retention-age')?.value || 90),
    delete_expired_artifacts: Boolean(document.getElementById('backup-retention-delete-artifacts')?.checked),
    enabled: forceEnabled === undefined ? Boolean(document.getElementById('backup-retention-enabled')?.checked) : Boolean(forceEnabled),
  };
}

async function saveBackupRetentionPolicy() {
  const form = document.getElementById('backup-retention-form');
  let policyId = Number(form?.dataset.policyId || 0);
  const body = backupRetentionPayload();
  if (body.keep_last < 1 || body.max_age_days < 1) return showSysToast('Retention values must be at least 1.', 'error');

  if (!policyId) {
    try {
      const draftResponse = await apiFetch('/api/admin/backups/retention-policy', {
        method: 'PUT',
        headers: { 'Idempotency-Key': backupIdempotencyKey('retention-draft') },
        body: JSON.stringify({ ...body, enabled: false }),
      });
      const draft = await draftResponse.json();
      if (!draftResponse.ok) throw new Error(draft.error || 'Failed to create a disabled retention-policy draft.');
      clearBackupIdempotencyKey('retention-draft');
      policyId = backupRecordId(draft.policy || draft.item || draft, ['policy_id']);
      if (!policyId) throw new Error('The retention policy response did not include its identifier.');
      if (form) form.dataset.policyId = String(policyId);
      if (!body.enabled) {
        showSysToast(draft.message || 'Disabled retention policy saved.', 'success');
        await loadBackupLogs();
        return draft;
      }
    } catch (error) {
      showSysToast(error.message || 'Failed to save retention policy.', 'error');
      return null;
    }
  }

  return backupProtectedMutation({
    lockKey: `retention-save:${policyId}`,
    purpose: 'RETENTION_EXECUTE',
    resourceType: 'RETENTION_POLICY',
    resourceId: policyId,
    endpoint: '/api/admin/backups/retention-policy',
    method: 'PUT',
    payload: { ...body, policy_id: policyId },
  });
}

async function runBackupRetentionCleanup() {
  const policyId = Number(document.getElementById('backup-retention-form')?.dataset.policyId || backupRecordId(sysBackupRetentionPolicy, ['policy_id']));
  if (!policyId) return showSysToast('Save the retention policy before running cleanup.', 'error');
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Run retention cleanup now? The newest verified copies are preserved, and every expired artifact action is audit-logged.', 'Backup Retention Cleanup', 'Run Cleanup', 'Cancel')
    : confirm('Run retention cleanup now? Expired artifacts may be permanently deleted according to the saved policy.');
  if (!confirmed) return null;
  const data = await backupProtectedMutation({
    lockKey: `retention-run:${policyId}`,
    purpose: 'RETENTION_EXECUTE',
    resourceType: 'RETENTION_POLICY',
    resourceId: policyId,
    endpoint: '/api/admin/backups/retention/run',
    payload: { policy_id: policyId },
  });
  const result = document.getElementById('backup-retention-result');
  if (data && result) {
    const rows = Array.isArray(data) ? data
      : (Array.isArray(data.results) ? data.results
        : (Array.isArray(data.result) ? data.result : []));
    if (rows.length) {
      const count = status => rows.filter(item => String(item.status || '').toUpperCase() === status).length;
      result.textContent = `Cleanup complete: ${rows.length} artifact(s) evaluated; ${count('EXPIRED')} expired, ${count('DELETED')} deleted, ${count('DELETE_PENDING')} pending provider deletion, ${count('ERROR')} error(s).`;
    } else {
      const summary = data.result || data.summary || data;
    result.textContent = `Cleanup complete: ${Number(summary.expired_count || summary.expired || 0)} expired, ${Number(summary.deleted_artifacts || summary.deleted || 0)} artifact(s) deleted, ${Number(summary.deletion_pending || 0)} pending provider deletion, ${Number(summary.preserved_verified || summary.preserved || 0)} verified copy/copies preserved.`;
    }
  }
  return data;
}

function backupNotificationRead(notification) {
  const explicit = backupExplicitBoolean(notification, ['is_read']);
  if (explicit !== null) return explicit;
  return Boolean(notification?.read_at) || ['READ', 'RESOLVED'].includes(String(notification?.status || '').toUpperCase());
}

function backupNotificationTarget(resourceType) {
  const type = String(resourceType || '').toUpperCase();
  if (type.includes('DRILL')) return ['drills', 'backup-drills-tbody'];
  if (type.includes('RESTORE')) return ['restore', 'restore-jobs-table'];
  if (type.includes('ROLLBACK')) return ['rollback', 'rollback-requests-tbody'];
  if (type.includes('SCHEDULE')) return ['automation', 'backup-schedules-tbody'];
  return ['sets', 'backup-logs-tbody'];
}

async function markBackupNotificationRead(notificationId, options = {}) {
  const id = Number(notificationId);
  const notification = sysBackupNotifications.find(item => backupRecordId(item, ['notification_id']) === id);
  if (!notification || backupNotificationRead(notification)) return notification;
  try {
    const response = await apiFetch(`/api/admin/backups/notifications/${id}/read`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': backupIdempotencyKey('notification-read', id) },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to mark notification as read.');
    clearBackupIdempotencyKey('notification-read', id);
    notification.status = 'READ';
    notification.read_at = data.read_at || new Date().toISOString();
    renderBackupNotifications();
    if (!options.silent) showSysToast(data.message || 'Notification marked as read.', 'success');
    return notification;
  } catch (error) {
    showSysToast(error.message || 'Failed to mark notification as read.', 'error');
    return null;
  }
}

async function openBackupNotification(notificationId) {
  const id = Number(notificationId);
  const notification = sysBackupNotifications.find(item => backupRecordId(item, ['notification_id']) === id);
  if (!notification) return;
  await markBackupNotificationRead(id, { silent: true });
  const [tab, target] = backupNotificationTarget(notification.resource_type || notification.entity_type || notification.category);
  focusBackupArea(tab, target);
}

function clearBackupNotificationFilters() {
  const search = document.getElementById('backup-notification-search');
  const filter = document.getElementById('backup-notification-filter');
  if (search) search.value = '';
  if (filter) filter.value = 'ALL';
  renderBackupNotifications();
  search?.focus?.();
}

function renderBackupNotifications() {
  const target = document.getElementById('backup-notification-inbox');
  const badge = document.getElementById('backup-notification-count');
  if (!target) return;
  const unreadCount = sysBackupNotifications.filter(item => !backupNotificationRead(item)).length;
  if (badge) {
    badge.textContent = String(unreadCount > 99 ? '99+' : unreadCount);
    badge.hidden = unreadCount === 0;
  }
  const error = sysBackupOperationalErrors['action notifications'];
  if (error) {
    target.innerHTML = `<div class="backup-notification-empty"><strong>Action inbox could not be loaded.</strong><small>${sysEsc(error)}</small></div>`;
    setBackupResultCount('backup-notification-results', 0, 0, 'notification');
    return;
  }
  const query = document.getElementById('backup-notification-search')?.value || '';
  const filter = document.getElementById('backup-notification-filter')?.value || 'ALL';
  const visible = sysBackupNotifications.filter(notification => {
    const read = backupNotificationRead(notification);
    if (filter === 'UNREAD' && read) return false;
    if (filter === 'READ' && !read) return false;
    return backupMatchesQuery(query, notification.title, notification.message, notification.category, notification.resource_type, notification.resource_id);
  });
  setBackupResultCount('backup-notification-results', visible.length, sysBackupNotifications.length, 'notification');
  if (!visible.length) {
    target.innerHTML = `<div class="backup-notification-empty"><strong>No notifications match this view.</strong><small>${sysEsc(backupApprovalInstruction())} Pending protected actions will appear here.</small></div>`;
    return;
  }
  target.innerHTML = visible.map(notification => {
    const id = backupRecordId(notification, ['notification_id']);
    const read = backupNotificationRead(notification);
    const actionRequired = backupExplicitBoolean(notification, ['action_required']) === true;
    return `<article class="backup-notification-item${read ? ' is-read' : ' is-unread'}">
      <span class="backup-notification-dot" aria-hidden="true"></span>
      <div class="backup-notification-copy"><div class="backup-notification-heading"><strong>${sysEsc(notification.title || 'Backup and restore notification')}</strong>${actionRequired ? '<span class="backup-notification-action-label">Action required</span>' : ''}</div><p>${sysEsc(notification.message || 'Open the related protected workflow for details.')}</p><small>${sysEsc(backupTypeLabel(notification.category || notification.resource_type || 'SYSTEM'))} &middot; ${sysEsc(sysFormatDateTime(notification.created_at))}</small></div>
      <div class="backup-notification-actions"><button type="button" class="btn-sysadmin-sm backup-action-primary" onclick="openBackupNotification(${id})">Open workflow</button>${read ? '' : `<button type="button" class="btn-sysadmin-sm" onclick="markBackupNotificationRead(${id})">Mark read</button>`}</div>
    </article>`;
  }).join('');
}

function resetBackupRestoreDrillForm() {
  const form = document.getElementById('backup-drill-form');
  form?.reset?.();
  const id = document.getElementById('backup-drill-id');
  const title = document.getElementById('backup-drill-form-title');
  if (id) id.value = '';
  if (title) title.textContent = 'Create restore drill';
  const time = document.getElementById('backup-drill-time');
  const timezone = document.getElementById('backup-drill-timezone');
  const enabled = document.getElementById('backup-drill-enabled');
  if (time) time.value = '03:00';
  if (timezone) timezone.value = 'Asia/Manila';
  if (enabled) enabled.checked = true;
  updateScheduleFrequencyFields('backup-drill');
}

function editBackupRestoreDrill(drillId) {
  const drill = sysBackupRestoreDrills.find(item => backupRecordId(item, ['drill_id', 'schedule_id']) === Number(drillId));
  if (!drill) return;
  const set = (id, value) => { const element = document.getElementById(id); if (element) element.value = value ?? ''; };
  set('backup-drill-id', backupRecordId(drill, ['drill_id', 'schedule_id']));
  set('backup-drill-name', drill.drill_name || drill.name || '');
  set('backup-drill-type', drill.backup_type || drill.backup_type_filter || 'DATABASE');
  set('backup-drill-provider', drill.storage_provider || drill.storage_provider_filter || 'ALL');
  set('backup-drill-module', drill.affected_module || drill.module_key_filter || '');
  set('backup-drill-frequency', drill.frequency || 'WEEKLY');
  set('backup-drill-time', String(drill.run_time || '03:00').slice(0, 5));
  set('backup-drill-weekday', drill.day_of_week || 7);
  set('backup-drill-monthday', drill.day_of_month || 1);
  set('backup-drill-timezone', drill.timezone || 'Asia/Manila');
  const enabled = document.getElementById('backup-drill-enabled');
  if (enabled) enabled.checked = backupEnabled(drill);
  const title = document.getElementById('backup-drill-form-title');
  if (title) title.textContent = 'Edit restore drill';
  updateScheduleFrequencyFields('backup-drill');
  focusBackupArea('drills', 'backup-drill-form');
}

async function saveBackupRestoreDrill() {
  const id = Number(document.getElementById('backup-drill-id')?.value || 0);
  const drillName = document.getElementById('backup-drill-name')?.value.trim();
  if (!drillName) return showSysToast('Enter a restore drill name.', 'error');
  const body = backupSchedulePayload('backup-drill', {
    drill_name: drillName,
    backup_type: document.getElementById('backup-drill-type')?.value || 'DATABASE',
    storage_provider: document.getElementById('backup-drill-provider')?.value || 'ALL',
    affected_module: document.getElementById('backup-drill-module')?.value || null,
  });
  const prefix = id ? 'drill-update' : 'drill-create';
  const idempotencyKey = backupIdempotencyKey(prefix, id || 'new');
  return runBackupMutation(`drill-save:${id || 'new'}`, async () => {
    try {
      const response = await apiFetch(id ? `/api/admin/backups/restore-drills/${id}` : '/api/admin/backups/restore-drills', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save restore drill.');
      clearBackupIdempotencyKey(prefix, id || 'new');
      showSysToast(data.message || 'Restore drill saved.', 'success');
      resetBackupRestoreDrillForm();
      await loadBackupLogs();
      return data;
    } catch (error) {
      showSysToast(error.message || 'Failed to save restore drill.', 'error');
      return null;
    }
  });
}

async function toggleBackupRestoreDrill(drillId, enabled) {
  const id = Number(drillId);
  const idempotencyKey = backupIdempotencyKey('drill-toggle', id);
  return runBackupMutation(`drill-toggle:${id}`, async () => {
    try {
      const response = await apiFetch(`/api/admin/backups/restore-drills/${id}`, {
        method: 'PATCH',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ enabled: Boolean(enabled) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update restore drill.');
      clearBackupIdempotencyKey('drill-toggle', id);
      showSysToast(data.message || `Restore drill ${enabled ? 'enabled' : 'disabled'}.`, 'success');
      await loadBackupLogs();
      return data;
    } catch (error) {
      showSysToast(error.message || 'Failed to update restore drill.', 'error');
      return null;
    }
  });
}

function runBackupRestoreDrillNow(drillId) {
  const id = Number(drillId);
  return backupProtectedMutation({
    lockKey: `drill-run:${id}`,
    purpose: 'DRILL_RUN',
    resourceType: 'RESTORE_DRILL',
    resourceId: id,
    endpoint: `/api/admin/backups/restore-drills/${id}/run-now`,
  });
}

function renderBackupRestoreDrills() {
  const tbody = document.getElementById('backup-drills-tbody');
  if (!tbody) return;
  const error = sysBackupOperationalErrors['restore drills'];
  if (error) {
    tbody.innerHTML = backupEmptyFilterRow(7, 'Restore drills could not be loaded.', error);
    return;
  }
  if (!sysBackupRestoreDrills.length) {
    tbody.innerHTML = backupEmptyFilterRow(7, 'No scheduled restore drills yet.', 'Create a drill above to test verified artifacts in isolation.');
    return;
  }
  tbody.innerHTML = sysBackupRestoreDrills.map(drill => {
    const id = backupRecordId(drill, ['drill_id', 'schedule_id']);
    const enabled = backupEnabled(drill);
    const latest = drill.latest_run || drill.last_run || drill;
    const status = backupStatusValue(latest, ['status', 'latest_status', 'last_status'], 'NOT RUN');
    const integrity = backupStatusValue(latest, ['integrity_status', 'latest_integrity_status'], 'NOT CHECKED');
    const backupType = drill.backup_type || drill.backup_type_filter;
    const provider = drill.storage_provider || drill.storage_provider_filter || 'Any provider';
    const moduleKey = drill.affected_module || drill.module_key_filter;
    const rawResult = latest.result_message || latest.latest_result_message || latest.failure_message || latest.result;
    const resultText = rawResult && typeof rawResult === 'object'
      ? (rawResult.safeToRestore === true
        ? (rawResult.disposableRestore ? 'Disposable restore and integrity checks passed; target cleaned up.' : 'Isolated restore and integrity checks passed.')
        : (rawResult.reason || 'Review the isolated drill result.'))
      : (rawResult || 'Isolated target only');
    return `<tr>
      <td><strong>${sysEsc(drill.drill_name || drill.name || `Drill #${id}`)}</strong><br>${sysStatusBadge(enabled ? 'ENABLED' : 'DISABLED')}</td>
      <td>${sysEsc(backupTypeLabel(backupType))}<br><small>${sysEsc(provider)} &middot; ${sysEsc(moduleKey ? backupModuleName(moduleKey) : 'Latest verified eligible artifact')}</small></td>
      <td>${sysEsc(backupFrequencyLabel(drill))}<br><small>${sysEsc(drill.timezone || 'Asia/Manila')}</small></td>
      <td><small>${sysEsc(drill.next_run_at ? sysFormatDateTime(drill.next_run_at) : (enabled ? 'Pending scheduler calculation' : 'Disabled'))}</small></td>
      <td>${sysStatusBadge(status)}<br><small>${sysEsc(latest.completed_at || drill.latest_completed_at || drill.last_run_at ? sysFormatDateTime(latest.completed_at || drill.latest_completed_at || drill.last_run_at) : 'Never')}</small></td>
      <td>${sysStatusBadge(integrity)}<br><small>${sysEsc(resultText)}</small></td>
      <td><div class="support-row-actions"><button class="btn-sysadmin-sm" onclick="editBackupRestoreDrill(${id})">Edit</button><button class="btn-sysadmin-sm" onclick="toggleBackupRestoreDrill(${id}, ${enabled ? 'false' : 'true'})">${enabled ? 'Disable' : 'Enable'}</button><button class="btn-sysadmin-sm backup-action-primary" onclick="runBackupRestoreDrillNow(${id})">Run drill with MFA</button></div></td>
    </tr>`;
  }).join('');
}

function renderBackupApprovalMode() {
  const target = document.getElementById('backup-approval-mode');
  const inboxHelp = document.getElementById('backup-approval-inbox-help');
  if (target) {
    target.classList.add('is-single-admin');
    target.innerHTML = '<span class="backup-approval-mode-icon" aria-hidden="true">&#128274;</span><div><strong>Single-admin + fresh MFA</strong><small>The same System Administrator creates, verifies, approves, dry-runs, and executes. Every protected step still requires fresh MFA, confirmation, idempotency, and audit logging.</small></div>';
  }
  if (inboxHelp) inboxHelp.textContent = 'This is your protected action queue. Open an item, review it, then use a fresh MFA code to complete the step.';
}

function renderBackupSettings() {
  const target = document.getElementById('backup-settings-grid');
  if (!target) return;
  const settings = sysBackupDashboard?.settings || {};
  const providerReadiness = settings.provider_readiness || settings.providerReadiness || sysBackupDashboard?.provider_readiness || {};
  const s3Readiness = providerReadiness.s3 || {};
  const rdsSnapshotReadiness = providerReadiness.rdsSnapshot || providerReadiness.rds_snapshot || {};
  const rdsRestoreReadiness = providerReadiness.rdsIsolatedRestore || providerReadiness.rds_isolated_restore || {};
  const databaseDryRunReadiness = providerReadiness.databaseDryRun || providerReadiness.database_dry_run || {};
  const workerStatus = backupExplicitBoolean(settings, ['backup_worker_enabled']);
  const localAdapterStatus = backupExplicitBoolean(settings, ['local_adapter_configured']);
  const isolatedRestoreStatus = backupExplicitBoolean(settings, ['isolated_restore_configured']);
  const stepUpStatus = backupExplicitBoolean(settings, ['step_up_mfa_required']);
  const sourceCodeStatus = backupExplicitBoolean(settings, ['source_code_backup_configured']);
  const codeCutoverStatus = backupExplicitBoolean(settings, ['module_code_cutover_enabled']);
  const schedulerStatus = backupExplicitBoolean(settings, ['backup_scheduler_enabled', 'automation_scheduler_enabled']);
  const retentionWorkerStatus = backupExplicitBoolean(settings, ['retention_cleanup_enabled', 'retention_worker_enabled']);
  const drillWorkerStatus = backupExplicitBoolean(settings, ['restore_drill_worker_enabled', 'scheduled_restore_drills_enabled']);
  const s3EncryptionStatus = backupExplicitBoolean(settings, ['s3_encryption_configured', 's3_kms_configured'])
    ?? (s3Readiness.encryption ? true : null);
  const rdsEncryptionStatus = backupExplicitBoolean(settings, ['rds_encrypted_snapshots_required', 'rds_encryption_configured'])
    ?? backupExplicitBoolean(rdsSnapshotReadiness, ['encryptedSnapshotsRequired']);
  const configurationLabel = value => value === true ? 'Configured' : value === false ? 'Missing' : 'Status unavailable';
  const enforcementLabel = value => value === true ? 'Enforced' : value === false ? 'Not enforced' : 'Status unavailable';
  const items = [
    ['Backup Worker', workerStatus === true ? 'Enabled' : workerStatus === false ? 'Not ready' : 'Status unavailable'],
    ['Automated Schedule Worker', schedulerStatus === true ? 'Enabled' : schedulerStatus === false ? 'Disabled' : 'Status unavailable'],
    ['Retention Cleanup Worker', retentionWorkerStatus === true ? 'Enabled' : retentionWorkerStatus === false ? 'Disabled' : 'Status unavailable'],
    ['Scheduled Restore Drills', drillWorkerStatus === true ? 'Enabled' : drillWorkerStatus === false ? 'Disabled' : 'Status unavailable'],
    ['Database Backups', settings.database_provider || 'Not configured'],
    ['File Backups', settings.file_provider || 'Not configured'],
    ['Configuration Backups', settings.config_provider || 'Not configured'],
    ['Local Development Adapter', configurationLabel(localAdapterStatus)],
    ['Isolated Restore Validation', configurationLabel(isolatedRestoreStatus)],
    ['Admin Approval Mode', 'Single admin + fresh MFA'],
    ['Step-up MFA', enforcementLabel(stepUpStatus)],
    ['Deployment Rollback', settings.deployment_provider || 'Not configured'],
    ['Module Source-code Capture', configurationLabel(sourceCodeStatus)],
    ['Transactional Code Cutover', codeCutoverStatus === true ? 'Enabled' : codeCutoverStatus === false ? 'Disabled (fail-closed)' : 'Status unavailable'],
    ['AWS Region', settings.aws_region_configured ? 'Configured' : 'Missing'],
    ['S3 Bucket', settings.s3_bucket_configured || s3Readiness.configured ? (s3Readiness.ready === false ? 'Configured; needs attention' : 'Configured') : 'Missing'],
    ['S3 Artifact Encryption', s3Readiness.encryption || configurationLabel(s3EncryptionStatus)],
    ['RDS Snapshot', settings.rds_snapshot_configured || rdsSnapshotReadiness.configured ? (rdsSnapshotReadiness.ready === false ? 'Configured; needs attention' : 'Configured') : 'Missing'],
    ['RDS Encrypted Snapshots', configurationLabel(rdsEncryptionStatus)],
    ['RDS Isolated Restore', rdsRestoreReadiness.ready === true ? 'Ready; in-place restore blocked' : rdsRestoreReadiness.ready === false ? 'Missing configuration' : 'Status unavailable'],
    ['Database Dry-run Target', databaseDryRunReadiness.ready === true ? 'Ready; isolated database required' : databaseDryRunReadiness.ready === false ? 'Missing configuration' : 'Status unavailable'],
    ['RDS Post-restore Verification', settings.rds_restore_verification_configured ? 'Configured' : 'Missing'],
  ];
  target.innerHTML = items.map(([label, value]) => `
    <article class="backup-setting-card">
      <span>${sysEsc(label)}</span>
      <strong>${sysEsc(value)}</strong>
    </article>
  `).join('');
}

function renderBackupRecoveryWorkspace() {
  renderBackupModuleOptions();
  renderBackupOperationalModuleOptions();
  renderBackupApprovalMode();
  renderBackupReadiness();
  renderBackupNextActions();
  renderBackupSummaryCards();
  renderBackupCoverage();
  renderBackupLogs();
  renderModuleRecoveryPoints();
  renderRestoreJobs();
  renderRollbackRequests();
  renderBackupSchedules();
  populateBackupRetentionForm();
  renderBackupNotifications();
  renderBackupRestoreDrills();
  Object.keys(sysBackupPagination).forEach(renderBackupPagination);
  renderBackupSettings();
  switchBackupRecoveryTab(sysBackupActiveTab);
}

async function requestBackup() {
  const includedModules = backupSelectModules();
  if (!includedModules.length) {
    showSysToast('Select at least one module to include in the backup.', 'error');
    document.getElementById('backup-module-picker-search')?.focus?.();
    return null;
  }
  const body = {
    backup_name: document.getElementById('backup-name')?.value || '',
    backup_type: document.getElementById('backup-type')?.value || 'DATABASE',
    storage_provider: document.getElementById('backup-target')?.value || 'LOCAL',
    included_modules: includedModules,
    notes: document.getElementById('backup-notes')?.value || '',
  };
  const idempotencyKey = backupIdempotencyKey('backup-request');
  return runBackupMutation('backup-request', async () => {
    try {
      const res = await apiFetch('/api/admin/backups/request', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'IDEMPOTENCY_CONFLICT') clearBackupIdempotencyKey('backup-request');
        throw new Error(data.error || 'Failed to request backup.');
      }
      clearBackupIdempotencyKey('backup-request');
      showSysToast(data.message || 'Backup request queued for the backup worker.', 'success');
      const notes = document.getElementById('backup-notes');
      const name = document.getElementById('backup-name');
      if (notes) notes.value = '';
      if (name) name.value = '';
      loadBackupLogs();
      loadSystemHealth();
      return data;
    } catch (err) {
      showSysToast(err.message || 'Network error.', 'error');
      return null;
    }
  });
}

async function runBackup(backupId) {
  const id = Number(backupId || 0);
  const record = sysBackupLogs.find(item => Number(item.backup_set_id || item.backup_id || item.id) === id);
  if (!record || !['PENDING', 'FAILED'].includes(backupStatusValue(record, ['lifecycle_status', 'status']))) {
    showSysToast('Only a pending or failed backup request can start the backup worker.', 'error');
    return null;
  }
  const idempotencyKey = backupIdempotencyKey('backup-run', id);
  return runBackupMutation(`backup-run:${id}`, async () => {
    try {
      const res = await apiFetch(`/api/admin/backups/${id}/run`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start the backup worker.');
      clearBackupIdempotencyKey('backup-run', id);
      showSysToast(data.message || 'Backup worker started.', 'success');
      loadBackupLogs();
      loadSystemHealth();
      return data;
    } catch (err) {
      showSysToast(err.message || 'Network error.', 'error');
      return null;
    }
  });
}

function backupStepUpLabel(purpose) {
  return ({
    BACKUP_VERIFY: 'verify this backup artifact',
    RESTORE_APPROVE: 'approve this restore request',
    RESTORE_DRY_RUN: 'run isolated restore validation',
    RESTORE_EXECUTE: 'execute this approved restore',
    RESTORE_VERIFY: 'verify this isolated RDS restore target',
    ROLLBACK_APPROVE: 'approve this rollback request',
    ROLLBACK_EXECUTE: 'execute this approved rollback',
    SCHEDULE_RUN: 'run this backup schedule now',
    RETENTION_EXECUTE: 'change retention or clean expired artifacts',
    DRILL_RUN: 'run this isolated restore drill now',
  })[purpose] || 'continue this recovery action';
}

async function requestBackupStepUp(purpose, resourceType, resourceId) {
  if (sysBackupStepUpContext) {
    showSysToast('Complete or cancel the current MFA challenge first.', 'error');
    return null;
  }
  try {
    const res = await apiFetch('/api/admin/backups/step-up/challenges', {
      method: 'POST',
      body: JSON.stringify({
        purpose,
        resource_type: resourceType,
        resource_id: Number(resourceId),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start MFA verification.');
    const challengeId = Number(data.challenge_id || 0);
    const challengeToken = String(data.challenge_token || '');
    if (!challengeId || !challengeToken) throw new Error('The MFA challenge response is incomplete.');

    const modal = document.getElementById('backup-step-up-modal');
    const title = document.getElementById('backup-step-up-title');
    const description = document.getElementById('backup-step-up-description');
    const codeInput = document.getElementById('backup-step-up-code');
    const expiry = document.getElementById('backup-step-up-expiry');
    if (!modal || !codeInput) throw new Error('The MFA verification form is unavailable.');

    if (title) title.textContent = 'Confirm Recovery Action';
    if (description) description.textContent = `Enter the code from your authenticator app to ${backupStepUpLabel(purpose)}.`;
    if (expiry) expiry.textContent = data.expires_in ? `Challenge expires in ${Number(data.expires_in)} seconds.` : 'This challenge expires shortly.';
    codeInput.value = '';
    codeInput.onkeydown = event => {
      if (event.key === 'Escape') closeBackupStepUp();
      if (event.key === 'Enter') {
        event.preventDefault();
        completeBackupStepUp();
      }
    };
    modal.style.display = 'flex';

    return await new Promise(resolve => {
      sysBackupStepUpContext = {
        purpose,
        resourceType,
        resourceId: Number(resourceId),
        challengeId,
        challengeToken,
        resolve,
      };
      requestAnimationFrame(() => codeInput.focus());
    });
  } catch (err) {
    showSysToast(err.message || 'Failed to start MFA verification.', 'error');
    return null;
  }
}

function closeBackupStepUp(result = null) {
  const context = sysBackupStepUpContext;
  const modal = document.getElementById('backup-step-up-modal');
  const codeInput = document.getElementById('backup-step-up-code');
  if (modal) modal.style.display = 'none';
  if (codeInput) {
    codeInput.value = '';
    codeInput.onkeydown = null;
  }
  sysBackupStepUpContext = null;
  if (context?.resolve) context.resolve(result);
}

async function completeBackupStepUp() {
  const context = sysBackupStepUpContext;
  const codeInput = document.getElementById('backup-step-up-code');
  const code = String(codeInput?.value || '').trim();
  if (!context) return;
  if (context.verifying) return;
  if (!/^\d{6,8}$/.test(code)) {
    showSysToast('Enter the 6- to 8-digit code from your authenticator app.', 'error');
    codeInput?.focus();
    return;
  }
  context.verifying = true;
  try {
    const res = await apiFetch(`/api/admin/backups/step-up/challenges/${context.challengeId}/verify`, {
      method: 'POST',
      body: JSON.stringify({ challenge_token: context.challengeToken, code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'MFA verification failed.');
    if (sysBackupStepUpContext !== context) return;
    const stepUpChallengeId = Number(data.step_up_challenge_id || context.challengeId);
    const stepUpToken = String(data.step_up_token || '');
    if (!stepUpChallengeId || !stepUpToken) throw new Error('MFA verification did not return an authorization token.');
    closeBackupStepUp({ step_up_challenge_id: stepUpChallengeId, step_up_token: stepUpToken });
  } catch (err) {
    if (sysBackupStepUpContext !== context) return;
    context.verifying = false;
    showSysToast(err.message || 'MFA verification failed.', 'error');
    if (codeInput) {
      codeInput.value = '';
      codeInput.focus();
    }
  }
}

async function backupProtectedMutation({ lockKey, purpose, resourceType, resourceId, endpoint, method = 'POST', payload = {} }) {
  return runBackupMutation(lockKey, async () => {
    const stepUp = await requestBackupStepUp(purpose, resourceType, resourceId);
    if (!stepUp) return null;
    const idempotencyKey = backupIdempotencyKey(purpose, resourceId);
    try {
      const res = await apiFetch(endpoint, {
        method,
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ ...payload, ...stepUp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Recovery action failed.');
      clearBackupIdempotencyKey(purpose, resourceId);
      showSysToast(data.message || 'Recovery action accepted.', 'success');
      loadBackupLogs();
      loadSystemHealth();
      return data;
    } catch (err) {
      showSysToast(err.message || 'Network error.', 'error');
      return null;
    }
  });
}

async function verifyBackup(backupId) {
  const id = Number(backupId || 0);
  const record = sysBackupLogs.find(item => Number(item.backup_set_id || item.backup_id || item.id) === id);
  const status = backupStatusValue(record, ['lifecycle_status', 'status'], 'UNKNOWN');
  if (!record || !['COMPLETED', 'VERIFICATION_FAILED'].includes(status)) {
    showSysToast('Only a completed backup artifact can be verified.', 'error');
    return null;
  }
  return backupProtectedMutation({
    lockKey: `backup-verify:${id}`,
    purpose: 'BACKUP_VERIFY',
    resourceType: 'BACKUP_SET',
    resourceId: id,
    endpoint: `/api/admin/backups/${id}/verify`,
  });
}

async function updateBackupStatus(backupId, status, extra = {}) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'RUNNING') return runBackup(backupId);
  if (normalized === 'VERIFIED') return verifyBackup(backupId);
  void extra;
  showSysToast('Backup lifecycle status is controlled by the backup worker and artifact verifier.', 'error');
  return null;
}

function backupRequestField(id) {
  return document.getElementById(id);
}

function setBackupRequestError(message = '') {
  const target = backupRequestField('backup-request-error');
  if (target) target.textContent = message;
}

function setBackupRequestSubmitting(submitting) {
  const submit = backupRequestField('backup-request-submit');
  if (!submit) return;
  submit.disabled = Boolean(submitting);
  submit.textContent = submitting ? 'Submitting…' : 'Create Request';
}

function closeBackupRequestModal() {
  const modal = backupRequestField('backup-request-modal');
  if (modal) modal.style.display = 'none';
  sysBackupRequestContext = null;
  setBackupRequestError('');
  setBackupRequestSubmitting(false);
}

function openBackupRequestModal(context) {
  const modal = backupRequestField('backup-request-modal');
  if (!modal) {
    showSysToast('The recovery request form is unavailable. Refresh the page and try again.', 'error');
    return false;
  }
  const isRestore = context.kind === 'restore';
  const title = backupRequestField('backup-request-title');
  const description = backupRequestField('backup-request-description');
  const scope = backupRequestField('backup-request-scope');
  const confirmationWrap = backupRequestField('backup-request-confirmation-wrap');
  const confirmation = backupRequestField('backup-request-confirmation');
  const maintenanceWrap = backupRequestField('backup-request-maintenance-wrap');
  const maintenance = backupRequestField('backup-request-maintenance');
  const moduleWrap = backupRequestField('backup-request-module-wrap');
  const moduleSelect = backupRequestField('backup-request-module');
  const reason = backupRequestField('backup-request-reason');

  sysBackupRequestContext = context;
  if (title) title.textContent = isRestore ? 'Request Restore' : 'Request Rollback';
  if (description) {
    description.textContent = isRestore
      ? 'Create a protected restore request. The same System Administrator approves it with fresh MFA, then an isolated dry-run must pass before execution.'
      : 'Create a protected code rollback request. The same System Administrator approves it with fresh MFA before controlled execution.';
  }
  if (scope) scope.textContent = context.scopeText || 'Review the selected recovery artifact before continuing.';
  if (confirmationWrap) confirmationWrap.hidden = !isRestore;
  if (confirmation) {
    confirmation.value = '';
    confirmation.placeholder = isRestore ? 'Type RESTORE' : '';
  }
  if (maintenanceWrap) maintenanceWrap.hidden = !isRestore;
  if (maintenance) maintenance.checked = false;
  if (reason) reason.value = context.defaultReason || '';

  const moduleOptions = Array.isArray(context.moduleOptions) ? context.moduleOptions : [];
  if (moduleWrap) moduleWrap.hidden = moduleOptions.length <= 1;
  if (moduleSelect) {
    moduleSelect.innerHTML = moduleOptions.map(moduleKey => (
      `<option value="${sysEsc(moduleKey)}">${sysEsc(backupModuleName(moduleKey))} (${sysEsc(moduleKey)})</option>`
    )).join('');
    moduleSelect.value = context.moduleKey || moduleOptions[0] || '';
  }

  setBackupRequestError('');
  setBackupRequestSubmitting(false);
  modal.style.display = 'flex';
  requestAnimationFrame(() => (isRestore ? confirmation : reason)?.focus?.());
  return true;
}

function requestRestoreJob(backupId, moduleKey = '', restoreType = 'DATABASE') {
  const normalizedBackupId = Number(backupId || 0);
  if (!normalizedBackupId) {
    showSysToast('Select a completed backup before requesting restore.', 'error');
    return null;
  }
  if (!isRestorableBackupType(restoreType)) {
    showSysToast('Deployment version backups use rollback requests, not restore jobs.', 'error');
    return null;
  }
  const record = sysBackupLogs.find(item => Number(item.backup_set_id || item.backup_id || item.id) === normalizedBackupId);
  if (!record || !isRestorableBackupArtifact(record)) {
    showSysToast('Restore requires an artifact that the backend reports as available, verified, and restorable.', 'error');
    return null;
  }
  const includedModules = Array.isArray(record.included_modules) ? record.included_modules.filter(Boolean) : [];
  const scopeText = moduleKey
    ? `Backup ${record.backup_reference || `#${normalizedBackupId}`} · Module: ${backupModuleName(moduleKey)}`
    : `Backup ${record.backup_reference || `#${normalizedBackupId}`} · Scope: ${includedModules.length ? `all ${includedModules.length} included module(s)` : 'all included backup contents'}`;
  return openBackupRequestModal({
    kind: 'restore',
    backupId: normalizedBackupId,
    moduleKey,
    restoreType,
    scopeText,
    defaultReason: moduleKey ? `Restore ${backupModuleName(moduleKey)} from selected backup.` : `Restore ${record.backup_reference || `backup #${normalizedBackupId}`}.`,
  });
}

async function submitBackupRecoveryRequest() {
  const context = sysBackupRequestContext;
  if (!context) {
    showSysToast('Open a restore or rollback request first.', 'error');
    return null;
  }
  const reason = String(backupRequestField('backup-request-reason')?.value || '').trim();
  if (reason.length < 5) {
    setBackupRequestError('Enter a reason with at least 5 characters.');
    backupRequestField('backup-request-reason')?.focus?.();
    return null;
  }

  if (context.kind === 'restore') {
    const confirmation = String(backupRequestField('backup-request-confirmation')?.value || '').trim();
    if (confirmation !== 'RESTORE') {
      setBackupRequestError('Type RESTORE exactly to confirm this request.');
      backupRequestField('backup-request-confirmation')?.focus?.();
      return null;
    }
    const maintenance = Boolean(backupRequestField('backup-request-maintenance')?.checked);
    const idempotencyKey = backupIdempotencyKey('restore-request', context.backupId);
    setBackupRequestSubmitting(true);
    return runBackupMutation(`restore-request:${context.backupId}:${context.moduleKey || ''}`, async () => {
      try {
        const res = await backupApiFetch(`/api/admin/backups/${context.backupId}/restore`, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({
            restore_type: context.restoreType === 'FULL_BACKUP' ? 'FULL_BACKUP' : (context.restoreType || 'DATABASE'),
            affected_module: context.moduleKey || '',
            reason,
            confirmation_phrase: confirmation,
            place_under_maintenance: maintenance,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.code === 'IDEMPOTENCY_CONFLICT') clearBackupIdempotencyKey('restore-request', context.backupId);
          throw new Error(data.error || 'Failed to queue restore request.');
        }
        clearBackupIdempotencyKey('restore-request', context.backupId);
        closeBackupRequestModal();
        switchBackupRecoveryTab('restore');
        showSysToast(data.message || 'Restore request queued for approval.', 'success');
        void loadBackupLogs();
        void loadSystemHealth();
        return data;
      } catch (error) {
        setBackupRequestError(error.message || 'Failed to submit the restore request.');
        return null;
      } finally {
        setBackupRequestSubmitting(false);
      }
    });
  }

  const selectedModule = String(backupRequestField('backup-request-module')?.value || context.moduleKey || '').trim();
  const module = sysBackupCoverage.find(item => item.module_key === selectedModule);
  const point = sysModuleRecoveryPoints.find(item => (
    item.module_key === selectedModule
    && isVerifiedRollbackPoint(item)
    && (!context.backupSetId || Number(item.backup_set_id) === Number(context.backupSetId))
  ));
  if (!point) {
    setBackupRequestError('The selected module no longer has a verified rollback artifact. Refresh and try again.');
    return null;
  }
  const idempotencyKey = backupIdempotencyKey('rollback-request', point.id || selectedModule);
  setBackupRequestSubmitting(true);
  return runBackupMutation(`rollback-request:${selectedModule}`, async () => {
    try {
      const res = await backupApiFetch('/api/admin/backups/rollback-requests', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          affected_module: selectedModule,
          recovery_point_id: Number(point.id),
          current_version: point.current_version || module?.current_version || '',
          target_version: point.stable_version || module?.stable_version || '',
          artifact_location: point.artifact_location || '',
          reason,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'IDEMPOTENCY_CONFLICT') clearBackupIdempotencyKey('rollback-request', point.id || selectedModule);
        throw new Error(data.error || 'Failed to request rollback.');
      }
      clearBackupIdempotencyKey('rollback-request', point.id || selectedModule);
      closeBackupRequestModal();
      switchBackupRecoveryTab('rollback');
      showSysToast(data.message || 'Rollback request queued for approval.', 'success');
      void loadBackupLogs();
      return data;
    } catch (error) {
      setBackupRequestError(error.message || 'Failed to submit the rollback request.');
      return null;
    } finally {
      setBackupRequestSubmitting(false);
    }
  });
}

function findRestoreJob(jobId) {
  return sysRestoreJobs.find(item => Number(item.restore_job_id || item.id) === Number(jobId)) || null;
}

async function approveRestoreJob(jobId) {
  const id = Number(jobId || 0);
  const job = findRestoreJob(id);
  if (!job || backupStatusValue(job, ['lifecycle_status', 'status']) !== 'AWAITING_APPROVAL') {
    showSysToast('This restore request is not awaiting approval.', 'error');
    return null;
  }
  const notes = prompt('Approval notes:', 'Approved for isolated dry-run validation.');
  if (notes === null) return null;
  return backupProtectedMutation({
    lockKey: `restore-approve:${id}`,
    purpose: 'RESTORE_APPROVE',
    resourceType: 'RESTORE_JOB',
    resourceId: id,
    endpoint: `/api/admin/backups/restore-jobs/${id}/approve`,
    payload: { approval_notes: notes },
  });
}

async function rejectRestoreJob(jobId) {
  const id = Number(jobId || 0);
  const job = findRestoreJob(id);
  if (!job || backupStatusValue(job, ['lifecycle_status', 'status']) !== 'AWAITING_APPROVAL') {
    showSysToast('This restore request is not awaiting approval.', 'error');
    return null;
  }
  const notes = prompt('Rejection reason:', 'Restore request rejected after protected review.');
  if (notes === null) return null;
  return backupProtectedMutation({
    lockKey: `restore-reject:${id}`,
    purpose: 'RESTORE_APPROVE',
    resourceType: 'RESTORE_JOB',
    resourceId: id,
    endpoint: `/api/admin/backups/restore-jobs/${id}`,
    method: 'PATCH',
    payload: { status: 'REJECTED', result_message: notes },
  });
}

async function runRestoreDryRun(jobId) {
  const id = Number(jobId || 0);
  const job = findRestoreJob(id);
  const status = backupStatusValue(job, ['lifecycle_status', 'status'], 'UNKNOWN');
  if (!job || !['APPROVED', 'DRY_RUN_PASSED'].includes(status)) {
    showSysToast('The restore must be approved before dry-run validation.', 'error');
    return null;
  }
  return backupProtectedMutation({
    lockKey: `restore-dry-run:${id}`,
    purpose: 'RESTORE_DRY_RUN',
    resourceType: 'RESTORE_JOB',
    resourceId: id,
    endpoint: `/api/admin/backups/restore-jobs/${id}/dry-run`,
  });
}

async function executeRestoreJob(jobId) {
  const id = Number(jobId || 0);
  const job = findRestoreJob(id);
  const status = backupStatusValue(job, ['lifecycle_status', 'status'], 'UNKNOWN');
  const dryRun = backupStatusValue(job, ['dry_run_status'], status);
  const dryRunPassed = status === 'DRY_RUN_PASSED' || ['PASSED', 'DRY_RUN_PASSED'].includes(dryRun);
  if (!job || !dryRunPassed) {
    showSysToast('A successful isolated dry-run is required before restore execution.', 'error');
    return null;
  }
  const confirmationPhrase = prompt('Type EXECUTE RESTORE to apply this approved recovery:', '');
  if (confirmationPhrase === null) return null;
  if (confirmationPhrase.trim() !== 'EXECUTE RESTORE') {
    showSysToast('Type EXECUTE RESTORE exactly to continue.', 'error');
    return null;
  }
  return backupProtectedMutation({
    lockKey: `restore-execute:${id}`,
    purpose: 'RESTORE_EXECUTE',
    resourceType: 'RESTORE_JOB',
    resourceId: id,
    endpoint: `/api/admin/backups/restore-jobs/${id}/execute`,
    payload: { confirmation_phrase: confirmationPhrase.trim() },
  });
}

async function verifyRestoreTarget(jobId) {
  const id = Number(jobId || 0);
  const job = findRestoreJob(id);
  if (!job || backupStatusValue(job, ['lifecycle_status', 'status']) !== 'VERIFYING') {
    showSysToast('Only a pending isolated RDS restore target can be verified.', 'error');
    return null;
  }
  return backupProtectedMutation({
    lockKey: `restore-verify-target:${id}`,
    purpose: 'RESTORE_VERIFY',
    resourceType: 'RESTORE_JOB',
    resourceId: id,
    endpoint: `/api/admin/backups/restore-jobs/${id}/verify-target`,
  });
}

async function updateRestoreJobStatus(jobId, status) {
  const normalized = String(status || '').toUpperCase();
  if (normalized !== 'CANCELLED') {
    showSysToast('Restore progress is controlled by the approval, dry-run, execution, and integrity workers.', 'error');
    return null;
  }
  const resultMessage = prompt(`${backupTypeLabel(status)} notes:`, '');
  if (resultMessage === null) return;
  try {
    const res = await apiFetch(`/api/admin/backups/restore-jobs/${Number(jobId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: normalized, result_message: resultMessage }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update restore job.');
    showSysToast(data.message || 'Restore job updated.', 'success');
    loadBackupLogs();
    loadSystemHealth();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

function requestBackupSetRollback(backupId) {
  const record = sysBackupLogs.find(item => Number(item.backup_set_id || item.backup_id || item.id) === Number(backupId));
  if (!record) {
    showSysToast('Backup set not found.', 'error');
    return null;
  }
  if (!isVerifiedBackupArtifact(record)) {
    showSysToast('Rollback requires a deployment artifact that the backend reports as available and verified.', 'error');
    return null;
  }
  const modules = Array.isArray(record.included_modules) ? record.included_modules.filter(Boolean) : [];
  if (!modules.length) {
    showSysToast('This deployment backup has no module recovery list.', 'error');
    return null;
  }
  const availableModules = modules.filter(moduleKey => sysModuleRecoveryPoints.some(point => (
    point.module_key === moduleKey
    && Number(point.backup_set_id) === Number(backupId)
    && isVerifiedRollbackPoint(point)
  )));
  if (!availableModules.length) {
    showSysToast('This backup has no verified module artifact available for rollback.', 'error');
    return null;
  }
  return openBackupRequestModal({
    kind: 'rollback',
    backupSetId: Number(backupId),
    moduleKey: availableModules[0],
    moduleOptions: availableModules,
    scopeText: `Backup ${record.backup_reference || `#${backupId}`} · Choose one verified module to roll back.`,
    defaultReason: `Rollback request from ${record.backup_reference || `backup #${backupId}`}.`,
  });
}

function requestModuleRollback(moduleKey, backupSetId = null) {
  const point = sysModuleRecoveryPoints.find(item => (
    item.module_key === moduleKey
    && isVerifiedRollbackPoint(item)
    && (!backupSetId || Number(item.backup_set_id) === Number(backupSetId))
  ));
  if (!point) {
    showSysToast('Rollback requires a verified, available module recovery artifact.', 'error');
    return null;
  }
  return openBackupRequestModal({
    kind: 'rollback',
    backupSetId: backupSetId ? Number(backupSetId) : Number(point.backup_set_id),
    moduleKey,
    moduleOptions: [moduleKey],
    scopeText: `Module: ${backupModuleName(moduleKey)} · Recovery point: ${point.backup_reference || point.recovery_reference || `#${point.id}`}`,
    defaultReason: `Rollback request for ${backupModuleName(moduleKey)}.`,
  });
}

function findRollbackRequest(requestId) {
  return sysRollbackRequests.find(item => Number(item.rollback_request_id || item.id) === Number(requestId)) || null;
}

async function approveRollbackRequest(requestId) {
  const id = Number(requestId || 0);
  const request = findRollbackRequest(id);
  if (!request || backupStatusValue(request, ['lifecycle_status', 'status']) !== 'AWAITING_APPROVAL') {
    showSysToast('This rollback request is not awaiting approval.', 'error');
    return null;
  }
  if (!isVerifiedRollbackRequestArtifact(request)) {
    showSysToast('The rollback artifact is not verified and cannot be approved.', 'error');
    return null;
  }
  const notes = prompt('Approval notes:', 'Approved for controlled rollback execution.');
  if (notes === null) return null;
  return backupProtectedMutation({
    lockKey: `rollback-approve:${id}`,
    purpose: 'ROLLBACK_APPROVE',
    resourceType: 'ROLLBACK_REQUEST',
    resourceId: id,
    endpoint: `/api/admin/backups/rollback-requests/${id}/approve`,
    payload: { approval_notes: notes },
  });
}

async function rejectRollbackRequest(requestId) {
  const id = Number(requestId || 0);
  const request = findRollbackRequest(id);
  if (!request || backupStatusValue(request, ['lifecycle_status', 'status']) !== 'AWAITING_APPROVAL') {
    showSysToast('This rollback request is not awaiting approval.', 'error');
    return null;
  }
  const notes = prompt('Rejection reason:', 'Rollback request rejected after protected review.');
  if (notes === null) return null;
  return backupProtectedMutation({
    lockKey: `rollback-reject:${id}`,
    purpose: 'ROLLBACK_APPROVE',
    resourceType: 'ROLLBACK_REQUEST',
    resourceId: id,
    endpoint: `/api/admin/backups/rollback-requests/${id}`,
    method: 'PATCH',
    payload: { status: 'REJECTED', result_message: notes },
  });
}

async function executeRollbackRequest(requestId) {
  const id = Number(requestId || 0);
  const request = findRollbackRequest(id);
  if (!request || backupStatusValue(request, ['lifecycle_status', 'status']) !== 'APPROVED') {
    showSysToast('The rollback request must be approved before execution.', 'error');
    return null;
  }
  if (!isVerifiedRollbackRequestArtifact(request)) {
    showSysToast('The rollback artifact is no longer verified or available.', 'error');
    return null;
  }
  const confirmationPhrase = prompt('Type EXECUTE ROLLBACK to apply this approved recovery point:', '');
  if (confirmationPhrase === null) return null;
  if (confirmationPhrase.trim() !== 'EXECUTE ROLLBACK') {
    showSysToast('Type EXECUTE ROLLBACK exactly to continue.', 'error');
    return null;
  }
  return backupProtectedMutation({
    lockKey: `rollback-execute:${id}`,
    purpose: 'ROLLBACK_EXECUTE',
    resourceType: 'ROLLBACK_REQUEST',
    resourceId: id,
    endpoint: `/api/admin/backups/rollback-requests/${id}/execute`,
    payload: { confirmation_phrase: confirmationPhrase.trim() },
  });
}

async function updateRollbackRequestStatus(requestId, status) {
  const normalized = String(status || '').toUpperCase();
  if (normalized !== 'CANCELLED') {
    showSysToast('Rollback progress is controlled by the approval, execution, and integrity workers.', 'error');
    return null;
  }
  const resultMessage = prompt(`${backupTypeLabel(status)} notes:`, '');
  if (resultMessage === null) return;
  try {
    const res = await apiFetch(`/api/admin/backups/rollback-requests/${Number(requestId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: normalized, result_message: resultMessage }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update rollback request.');
    showSysToast(data.message || 'Rollback request updated.', 'success');
    loadBackupLogs();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

async function createBackupIncident(moduleKey, moduleName) {
  try {
    const res = await apiFetch('/api/admin/support-tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: `Recovery review: ${moduleName}`,
        category: 'SYSTEM',
        priority: 'HIGH',
        description: `Backup and Recovery review requested for ${moduleName} (${moduleKey}). Check latest backup, recovery point, health status, and rollback readiness.`,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create incident.');
    showSysToast(data.message || 'Incident created.', 'success');
    loadSupportTickets();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

function openBackupDetails(kind, id) {
  const modal = document.getElementById('backup-detail-modal');
  const title = document.getElementById('backup-detail-title');
  const body = document.getElementById('backup-detail-body');
  if (!modal || !title || !body) return;
  const source = kind === 'recovery'
    ? sysModuleRecoveryPoints.find(item => Number(item.id) === Number(id))
    : sysBackupLogs.find(item => Number(item.backup_set_id || item.backup_id || item.id) === Number(id));
  if (!source) return;
  title.textContent = kind === 'recovery' ? 'Module Recovery Point' : 'Backup Set Details';
  const entries = Object.entries(source)
    .filter(([key]) => !['notes_encrypted', 'remarks_encrypted'].includes(key))
    .map(([key, value]) => [backupTypeLabel(key), Array.isArray(value) ? value.join(', ') : value]);
  body.innerHTML = entries.map(([label, value]) => `
    <div class="support-kv-row">
      <span>${sysEsc(label)}</span>
      <strong>${sysEsc(value ?? '-')}</strong>
    </div>
  `).join('');
  modal.style.display = 'flex';
}

function closeBackupDetails() {
  const modal = document.getElementById('backup-detail-modal');
  if (modal) modal.style.display = 'none';
}

// TOAST NOTIFICATION
// ═══════════════════════════════════════════════════════════════

function showSysToast(message, type = 'info') {
  const toast = document.getElementById('sysadmin-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `sysadmin-toast ${type}`;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

// ── Expose globally ─────────────────────────────────────────
window.switchSysAdminTab     = switchSysAdminTab;
window.initSystemAdmin       = initSystemAdmin;
window.initSystemAdminIfActive = initSystemAdminIfActive;
window.showRegisterModal     = showRegisterModal;
window.closeRegisterModal    = closeRegisterModal;
window.onEmployeeSelect     = onEmployeeSelect;
window.regStepNext           = regStepNext;
window.regStepBack           = regStepBack;
window.submitRegistration    = submitRegistration;
window.showRoleModal         = showRoleModal;
window.closeRoleModal        = closeRoleModal;
window.submitRoleUpdate      = submitRoleUpdate;
window.showCredentialsModal  = showCredentialsModal;
window.closeCredentialsModal = closeCredentialsModal;
window.submitCredentialsUpdate = submitCredentialsUpdate;
window.toggleUserStatus      = toggleUserStatus;
window.togglePasswordVisibility = togglePasswordVisibility;
window.toggleCredPasswordVisibility = toggleCredPasswordVisibility;
window.filterUserTable       = filterUserTable;
window.loadAuditLog          = loadAuditLog;
window.toggleRoleUsers       = toggleRoleUsers;
window.unlockUserAccount     = unlockUserAccount;
window.revokeUserSessions    = revokeUserSessions;
window.resetUserMfa          = resetUserMfa;
window.loadSystemHealth      = loadSystemHealth;
window.loadSystemHealthHistory = loadSystemHealthHistory;
window.filterSystemHealthModules = filterSystemHealthModules;
window.openSystemHealthDetails = openSystemHealthDetails;
window.closeSystemHealthDetails = closeSystemHealthDetails;
window.runSystemHealthCheck  = runSystemHealthCheck;
window.runSystemModuleHealthCheck = runSystemModuleHealthCheck;
window.runSystemHealthDrilldownAction = runSystemHealthDrilldownAction;
window.prefillSystemHealthSupportTicket = prefillSystemHealthSupportTicket;
window.loadSupportTickets    = loadSupportTickets;
window.createSupportTicket   = createSupportTicket;
window.updateSupportTicket   = updateSupportTicket;
window.loadBackupLogs        = loadBackupLogs;
window.switchBackupRecoveryTab = switchBackupRecoveryTab;
window.focusBackupArea       = focusBackupArea;
window.filterBackupCoverage  = filterBackupCoverage;
window.clearBackupCoverageFilters = clearBackupCoverageFilters;
window.filterBackupHistory   = filterBackupHistory;
window.clearBackupHistoryFilters = clearBackupHistoryFilters;
window.filterModuleRecoveryPoints = filterModuleRecoveryPoints;
window.clearModuleRecoveryFilters = clearModuleRecoveryFilters;
window.changeBackupPage     = changeBackupPage;
window.changeBackupPageSize = changeBackupPageSize;
window.filterBackupModulePicker = filterBackupModulePicker;
window.toggleBackupModule    = toggleBackupModule;
window.selectAllBackupModules = selectAllBackupModules;
window.updateScheduleFrequencyFields = updateScheduleFrequencyFields;
window.renderBackupScheduleModulePicker = renderBackupScheduleModulePicker;
window.toggleBackupScheduleModule = toggleBackupScheduleModule;
window.selectAllBackupScheduleModules = selectAllBackupScheduleModules;
window.saveBackupSchedule   = saveBackupSchedule;
window.editBackupSchedule   = editBackupSchedule;
window.resetBackupScheduleForm = resetBackupScheduleForm;
window.toggleBackupSchedule = toggleBackupSchedule;
window.runBackupScheduleNow = runBackupScheduleNow;
window.saveBackupRetentionPolicy = saveBackupRetentionPolicy;
window.runBackupRetentionCleanup = runBackupRetentionCleanup;
window.renderBackupNotifications = renderBackupNotifications;
window.clearBackupNotificationFilters = clearBackupNotificationFilters;
window.markBackupNotificationRead = markBackupNotificationRead;
window.openBackupNotification = openBackupNotification;
window.saveBackupRestoreDrill = saveBackupRestoreDrill;
window.editBackupRestoreDrill = editBackupRestoreDrill;
window.resetBackupRestoreDrillForm = resetBackupRestoreDrillForm;
window.toggleBackupRestoreDrill = toggleBackupRestoreDrill;
window.runBackupRestoreDrillNow = runBackupRestoreDrillNow;
window.requestBackup         = requestBackup;
window.runBackup             = runBackup;
window.updateBackupStatus    = updateBackupStatus;
window.verifyBackup          = verifyBackup;
window.requestRestoreJob     = requestRestoreJob;
window.submitBackupRecoveryRequest = submitBackupRecoveryRequest;
window.closeBackupRequestModal = closeBackupRequestModal;
window.approveRestoreJob     = approveRestoreJob;
window.rejectRestoreJob      = rejectRestoreJob;
window.runRestoreDryRun      = runRestoreDryRun;
window.executeRestoreJob     = executeRestoreJob;
window.verifyRestoreTarget   = verifyRestoreTarget;
window.updateRestoreJobStatus = updateRestoreJobStatus;
window.requestBackupSetRollback = requestBackupSetRollback;
window.requestModuleRollback = requestModuleRollback;
window.approveRollbackRequest = approveRollbackRequest;
window.rejectRollbackRequest = rejectRollbackRequest;
window.executeRollbackRequest = executeRollbackRequest;
window.updateRollbackRequestStatus = updateRollbackRequestStatus;
window.createBackupIncident  = createBackupIncident;
window.openBackupDetails     = openBackupDetails;
window.closeBackupDetails    = closeBackupDetails;
window.completeBackupStepUp  = completeBackupStepUp;
window.closeBackupStepUp     = closeBackupStepUp;
window.__backupRecoveryUiTestHooks = Object.freeze({
  backupExplicitBoolean,
  backupAdminApprovalPolicy,
  backupApprovalInstruction,
  isVerifiedBackupArtifact,
  isRestorableBackupArtifact,
  isVerifiedRollbackPoint,
  isVerifiedRollbackRequestArtifact,
  backupArtifactReadiness,
  backupCoverageStatus,
  backupActionAllowed,
  backupActionAllowedAny,
  backupLifecycleGuide,
  backupMatchesQuery,
  backupCoverageRecoveryReady,
  normalizeBackupPagedResponse,
  backupFrequencyLabel,
  backupNotificationRead,
  backupNotificationTarget,
});

document.addEventListener('partialsLoaded', initSystemAdminIfActive);
document.addEventListener('DOMContentLoaded', () => setTimeout(initSystemAdminIfActive, 0));
