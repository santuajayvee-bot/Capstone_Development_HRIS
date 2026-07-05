/* ============================================================
   public/js/system-admin.js — System Administration Controller
   Account Registration, RBAC Management & Audit Trail
   ============================================================ */

// ── State ────────────────────────────────────────────────────
let sysAllUsers     = [];
let sysAllRoles     = [];
let sysAllEmployees = [];
let sysSupportTickets = [];
let sysBackupLogs = [];
let sysHealthSnapshot = null;
let sysHealthModules = [];
let sysHealthSelectedModuleKey = null;
let sysCurrentStep  = 1;
let sysAccountRealtimeTimer = null;
let sysUsersDataSignature = '';
let sysEmployeesDataSignature = '';
let sysAuditRequestController = null;
let sysAuditRequestId = 0;

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
const SYS_ADMIN_TAB_TITLES = {
  accounts: 'Account Management',
  roles: 'Role and Access Control',
  audit: 'Audit Trail',
  health: 'System Health',
  support: 'Support Center',
  backups: 'Backup and Restore',
};

const SYS_HEALTH_FALLBACK_MODULES = [
  ['authentication', 'Authentication / Login', '/api/auth/login'],
  ['account_management', 'Account Management', '/api/admin/users'],
  ['rbac', 'Role and Access Control', '/api/admin/roles'],
  ['employee_201', 'Employee / 201-File Management', '/api/employees'],
  ['attendance', 'Attendance', '/api/attendance/all'],
  ['attendance_sync', 'Attendance Sync', '/api/biometric/status'],
  ['leave', 'Leave Management', '/api/leaves'],
  ['payroll', 'Payroll Computation', '/api/payroll'],
  ['payslip', 'Payslip Generation', '/api/payslips'],
  ['audit_trail', 'Audit Trail', '/api/admin/audit-log'],
  ['blockchain', 'Blockchain Support', '/api/admin/blockchain-support/status'],
  ['backup_restore', 'Backup and Restore', '/api/admin/backups'],
  ['database', 'Database', 'MySQL SELECT 1'],
];

function switchSysAdminTab(tabId, el, options = {}) {
  const targetTab = SYS_ADMIN_TAB_TITLES[tabId] ? tabId : 'accounts';
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
  loadRolesList();

  const activeTab =
    window.ROUTE_PARAMS?.sysAdminTab ||
    document.querySelector('.sysadmin-tab.active')?.dataset?.tab ||
    document.querySelector('.sysadmin-panel.active')?.id?.replace(/^panel-/, '') ||
    'accounts';

  if (activeTab === 'accounts') {
    loadUsersTable();
    startAccountRealtime();
  } else {
    stopAccountRealtime();
  }

  if (activeTab === 'roles') loadRolesGrid();
  if (activeTab === 'audit') loadAuditLog();
  if (activeTab === 'health') loadSystemHealth();
  if (activeTab === 'support') loadSupportTickets();
  if (activeTab === 'backups') loadBackupLogs();
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
  try {
    const res = await apiFetch('/api/admin/users');
    if (!res || !res.ok) {
      console.error('Failed to load users');
      return;
    }
    // Names are decrypted by the authorized server response. This is only a
    // display safeguard so an unexpected protected database value is never
    // rendered or retained in the screen's account-list state.
    const nextUsers = (await res.json()).map(sysProtectEmployeeIdentity);
    const nextUsersSignature = sysUserDataSignature(nextUsers);
    const usersChanged = nextUsersSignature !== sysUsersDataSignature;
    sysAllUsers = nextUsers;
    populateSupportUserSelect();

    // Also load employees for the unlinked count
    const empRes = await apiFetch('/api/employees');
    let employeesChanged = false;
    if (empRes && empRes.ok) {
      const nextEmployees = await empRes.json();
      const nextEmployeesSignature = sysEmployeeDataSignature(nextEmployees);
      employeesChanged = nextEmployeesSignature !== sysEmployeesDataSignature;
      sysAllEmployees = nextEmployees;
      sysEmployeesDataSignature = nextEmployeesSignature;
    }

    const needsInitialRender = document.getElementById('users-tbody')?.dataset.sysRendered !== 'true';
    if (usersChanged || employeesChanged || needsInitialRender) updateStats();
    if (usersChanged || needsInitialRender) {
      sysUsersDataSignature = nextUsersSignature;
      filterUserTable();
    }
  } catch (err) {
    console.error('[SysAdmin] loadUsersTable error:', err);
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
  }, 5000);
}

function stopAccountRealtime() {
  if (sysAccountRealtimeTimer) {
    clearInterval(sysAccountRealtimeTimer);
    sysAccountRealtimeTimer = null;
  }
}

function updateStats() {
  const total    = sysAllUsers.length;
  const active   = sysAllUsers.filter(u => u.is_active).length;
  const inactive = total - active;
  const locked   = sysAllUsers.filter(isUserLocked).length;
  const linkedIds = sysAllUsers.map(u => u.employee_id).filter(Boolean);
  const unlinked  = sysAllEmployees.filter(e => !linkedIds.includes(e.id)).length;

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
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Loading audit trail...</td></tr>';

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
    const search = document.getElementById('audit-search')?.value?.trim() || '';
    const params = new URLSearchParams({ limit: '100' });
    if (module) params.set('module', module);
    if (eventType) params.set('event_type', eventType);
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
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Session expired. Please log in again.</td></tr>';
      return;
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error('Failed to load audit log:', errData);
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Error: ${sysEsc(errData.error || 'Failed to load audit log.')}</td></tr>`;
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
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="table-empty">${sysEsc(message)}</td></tr>`;
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

function auditActionText(log) {
  const actionType = String(log?.action_type || '').trim().toUpperCase();
  const action = String(log?.action_performed || '').trim();
  const write = auditWriteMetadata(log);
  if (write.isEmployeeDelete) return 'Employee record deletion requested';
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
  if (/failed_unauthorized_access_attempt/i.test(action)) return 'Unauthorized access attempt blocked';
  if (/failed_permission_check/i.test(action)) return 'Permission check failed';
  if (/blocked_client_authority_field_tampering/i.test(action)) return 'Unauthorized request fields blocked';
  if (/blocked_rate_limit_exceeded/i.test(action)) return 'Rate limit exceeded';
  if (/invalid_or_tampered_jwt_attempt/i.test(action)) return 'Invalid session token attempt blocked';
  if (/expired_jwt_attempt/i.test(action)) return 'Expired session token rejected';
  if (/log_integrity_blocked/i.test(action)) return 'Audit log tampering attempt blocked';
  if (auditLooksBackendOnly(action)) return `${auditModuleLabel(log?.module)} activity recorded`;
  return action;
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
  if (log.action_type && !auditLooksBackendOnly(log.action_type)) parts.push(`Event: ${log.action_type}`);
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

function renderAuditLog(logs) {
  const tbody = sysAuditTbody();
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No audit entries found.</td></tr>';
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
        <td><small style="color:var(--muted)">${sysEsc(auditDetails(log))}</small></td>
      </tr>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// REGISTRATION MODAL
// ═══════════════════════════════════════════════════════════════

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
  if (!confirm(`Are you sure you want to ${action} this account?`)) return;

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
  if (!confirm('Clear this account lockout?')) return;
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
  const reason = prompt('Reason for session revocation:', 'support_request');
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
  const reason = prompt('Reason for MFA reset after identity verification:');
  if (reason === null) return;
  if (reason.trim().length < 8) {
    showSysToast('Reason must be at least 8 characters.', 'error');
    return;
  }
  if (!confirm('Confirm identity was verified before resetting MFA.')) return;
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
  const good = ['ACTIVE', 'COMPLETED', 'VERIFIED', 'RESOLVED', 'CLOSED', 'RECORDED'];
  const bad = ['FAILED', 'CRITICAL', 'VERIFICATION_FAILED', 'INACTIVE'];
  const warn = ['HIGH', 'OPEN', 'IN_PROGRESS', 'WAITING_FOR_OWNER', 'REQUESTED', 'RUNNING', 'PENDING', 'PENDING_ANCHOR'];
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

async function loadSystemHealth() {
  try {
    const res = await apiFetch('/api/admin/system-health');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load system health.');
    sysHealthSnapshot = data;
    sysHealthModules = Array.isArray(data.modules) && data.modules.length
      ? data.modules
      : buildSystemHealthFallbackModules();
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
    ].join(' ').toLowerCase();
    return (!statusFilter || status === statusFilter) && (!search || haystack.includes(search));
  });
  if (!modules.length) {
    grid.innerHTML = '<div class="table-empty">No modules match the selected filter.</div>';
    return;
  }
  grid.innerHTML = modules.map(module => {
    const keyArg = sysJsString(module.module_key);
    const status = String(module.status || 'WARNING').toLowerCase();
    return `
      <article class="health-module-card health-module-${sysEsc(status)}">
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
          <button class="btn-sysadmin-sm" onclick="openSystemHealthDetails(${keyArg})">View Details</button>
          <button class="btn-sysadmin-sm" onclick="runSystemModuleHealthCheck(${keyArg})">Check Module</button>
        </div>
      </article>
    `;
  }).join('');
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
  const checkButton = document.getElementById('health-detail-check-btn');
  if (checkButton) checkButton.setAttribute('onclick', `runSystemModuleHealthCheck(${sysJsString(moduleKey)})`);

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
  try {
    const res = await apiFetch('/api/admin/system-health/check', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to run system health check.');
    sysHealthSnapshot = { ...sysHealthSnapshot, ...data, generated_at: data.checked_at || data.generated_at };
    sysHealthModules = Array.isArray(data.modules) ? data.modules : sysHealthModules;
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
  }
}

async function runSystemModuleHealthCheck(moduleKey) {
  try {
    const res = await apiFetch(`/api/admin/system-health/check/${encodeURIComponent(moduleKey)}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to run module health check.');
    if (data.module) {
      const index = sysHealthModules.findIndex(module => module.module_key === data.module.module_key);
      if (index >= 0) sysHealthModules[index] = data.module;
      else sysHealthModules.push(data.module);
    }
    await loadSystemHealth();
    if (sysHealthSelectedModuleKey === moduleKey) openSystemHealthDetails(moduleKey);
    showSysToast(data.message || 'Module health check completed.', 'success');
  } catch (err) {
    showSysToast(systemHealthApiErrorMessage(err), 'error');
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
    const resolution = prompt('Resolution notes:');
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

async function loadBackupLogs() {
  try {
    const res = await apiFetch('/api/admin/backups');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load backup records.');
    sysBackupLogs = Array.isArray(data) ? data : [];
    renderBackupLogs();
  } catch (err) {
    const tbody = document.getElementById('backup-logs-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="table-empty">${sysEsc(err.message || 'Failed to load backup records.')}</td></tr>`;
  }
}

function renderBackupLogs() {
  const tbody = document.getElementById('backup-logs-tbody');
  if (!tbody) return;
  if (!sysBackupLogs.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No backup records found.</td></tr>';
    return;
  }
  tbody.innerHTML = sysBackupLogs.map(record => {
    const id = Number(record.backup_id);
    const actions = [
      `<button class="btn-sysadmin-sm" onclick="updateBackupStatus(${id}, 'RUNNING')">Run</button>`,
      `<button class="btn-sysadmin-sm" onclick="updateBackupStatus(${id}, 'COMPLETED')">Complete</button>`,
      `<button class="btn-sysadmin-sm" onclick="updateBackupStatus(${id}, 'VERIFIED')">Verify</button>`,
      `<button class="btn-sysadmin-sm" onclick="updateBackupStatus(${id}, 'FAILED')">Fail</button>`,
    ];
    return `
      <tr>
        <td><strong>${sysEsc(record.backup_reference)}</strong></td>
        <td>${sysEsc(record.backup_type)}</td>
        <td>${sysEsc(record.storage_target)}</td>
        <td>${sysStatusBadge(record.status)}</td>
        <td><small>${sysEsc(sysShortHash(record.manifest_hash))}</small></td>
        <td><small>${sysEsc(sysFormatDateTime(record.created_at))}</small></td>
        <td><div class="support-row-actions">${actions.join('')}</div></td>
      </tr>
    `;
  }).join('');
}

async function requestBackup() {
  const body = {
    backup_type: document.getElementById('backup-type')?.value || 'DATABASE',
    storage_target: document.getElementById('backup-target')?.value || 'EXTERNAL',
    notes: document.getElementById('backup-notes')?.value || '',
  };
  try {
    const res = await apiFetch('/api/admin/backups/request', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to request backup.');
    showSysToast(data.message || 'Backup request logged.', 'success');
    const notes = document.getElementById('backup-notes');
    if (notes) notes.value = '';
    loadBackupLogs();
    loadSystemHealth();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
}

async function updateBackupStatus(backupId, status) {
  const body = { status };
  if (['COMPLETED', 'VERIFIED'].includes(status)) {
    const manifestHash = prompt('SHA-256 manifest hash:', '');
    if (manifestHash === null) return;
    if (manifestHash.trim()) body.manifest_hash = manifestHash.trim();
    const location = prompt('Backup location/reference:', '');
    if (location === null) return;
    if (location.trim()) body.backup_location = location.trim();
  }
  if (status === 'FAILED') {
    const notes = prompt('Failure notes:', '');
    if (notes === null) return;
    body.notes = notes;
  }
  try {
    const res = await apiFetch(`/api/admin/backups/${backupId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update backup.');
    showSysToast(data.message || 'Backup record updated.', 'success');
    loadBackupLogs();
    loadSystemHealth();
  } catch (err) {
    showSysToast(err.message || 'Network error.', 'error');
  }
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
window.filterSystemHealthModules = filterSystemHealthModules;
window.openSystemHealthDetails = openSystemHealthDetails;
window.closeSystemHealthDetails = closeSystemHealthDetails;
window.runSystemHealthCheck  = runSystemHealthCheck;
window.runSystemModuleHealthCheck = runSystemModuleHealthCheck;
window.loadSupportTickets    = loadSupportTickets;
window.createSupportTicket   = createSupportTicket;
window.updateSupportTicket   = updateSupportTicket;
window.loadBackupLogs        = loadBackupLogs;
window.requestBackup         = requestBackup;
window.updateBackupStatus    = updateBackupStatus;

document.addEventListener('partialsLoaded', initSystemAdminIfActive);
document.addEventListener('DOMContentLoaded', () => setTimeout(initSystemAdminIfActive, 0));
