/* ============================================================
   public/js/system-admin.js — System Administration Controller
   Account Registration, RBAC Management & Audit Trail
   ============================================================ */

// ── State ────────────────────────────────────────────────────
let sysAllUsers     = [];
let sysAllRoles     = [];
let sysAllEmployees = [];
let sysBiometricDevices = [];
let sysAccountRequests = [];
let sysCurrentStep  = 1;
let sysAccountRealtimeTimer = null;
let sysUsersDataSignature = '';
let sysEmployeesDataSignature = '';

function sysEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
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
  return new Date(value).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
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
      '<span aria-hidden="true">&#8942;</span>' +
    '</button>' +
    '<div class="account-menu-popover" role="menu" aria-label="Actions for ' + sysEsc(user.username) + '">' +
      sysAccountMenuAction('role', 'Change role', 'shield', user.id) +
      sysAccountMenuAction('credentials', 'Reset password', 'key', user.id) +
      statusAction +
    '</div>' +
  '</div>';
}

function closeAccountActionMenus(exceptMenu = null) {
  document.querySelectorAll('.account-menu.is-open').forEach(menu => {
    if (menu === exceptMenu) return;
    menu.classList.remove('is-open', 'is-open-up');
    const trigger = menu.querySelector('[data-account-menu-toggle]');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

function openAccountActionMenu(menu, trigger) {
  closeAccountActionMenus(menu);
  const estimatedMenuHeight = 150;
  const triggerBounds = trigger.getBoundingClientRect();
  const shouldOpenUpward = window.innerHeight - triggerBounds.bottom < estimatedMenuHeight
    && triggerBounds.top > estimatedMenuHeight;
  menu.classList.toggle('is-open-up', shouldOpenUpward);
  menu.classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');
}

async function openRoleUpdateForUser(user) {
  if (!sysAllRoles.length) await loadRolesList();
  showRoleModal(Number(user.id), user.username, user.role_label || user.role_name, Number(user.role_id));
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
function switchSysAdminTab(tabId, el) {
  document.querySelectorAll('.sysadmin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sysadmin-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  const panel = document.getElementById('panel-' + tabId);
  if (panel) panel.classList.add('active');

  if (tabId === 'accounts') {
    loadUsersTable();
    startAccountRealtime();
  } else {
    stopAccountRealtime();
  }
  if (tabId === 'roles')    loadRolesGrid();
  if (tabId === 'account-requests') loadAccountCreationRequests();
  if (tabId === 'audit')    loadAuditLog();
  if (tabId === 'biometric-settings') loadBiometricSettings();
}

// ── Initialize on navigation ────────────────────────────────
function initSystemAdmin() {
  bindAccountActionButtons();
  loadUsersTable();
  loadRolesList();
  startAccountRealtime();
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
        <td>${sysEsc(u.role_label || u.role_name)}</td>
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
        sysAllRoles.map(r => `<option value="${r.name}">${r.label}</option>`).join('');
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

  grid.innerHTML = sysAllRoles.map(r => {
    const levelNum = r.access_level ? r.access_level.replace('Level ', '') : '1';
    const roleUsers = usersPerRole[r.id] || [];
    const count = roleUsers.length;
    const desc = levelDescriptions[r.access_level] || 'No description available.';

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
                  <strong>${u.username}</strong>
                  <small>${name}</small>
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
            <div class="role-card-title">${r.label}</div>
            <div class="role-card-desc">${desc}</div>
          </div>
          <span class="badge-level badge-level-${levelNum}">${r.access_level || '—'}</span>
        </div>
        <div class="role-card-users">
          <strong>${count}</strong> user${count !== 1 ? 's' : ''} assigned
          <span class="role-expand-hint" id="role-hint-${r.id}">${count > 0 ? '▼ Click to view' : ''}</span>
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
  if (hint) hint.textContent = isVisible ? '▼ Click to view' : '▲ Hide';
}

// ═══════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════

async function loadAuditLog() {
  const tbody = document.getElementById('audit-tbody');
  try {
    const module = document.getElementById('audit-module-filter')?.value || '';
    const eventType = document.getElementById('audit-action-filter')?.value || '';
    const search = document.getElementById('audit-search')?.value?.trim() || '';
    const params = new URLSearchParams({ limit: '200' });
    if (module) params.set('module', module);
    if (eventType) params.set('event_type', eventType);
    if (search) params.set('search', search);
    const url = `/api/admin/audit-log?${params.toString()}`;

    const res = await apiFetch(url);
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
    const logs = await res.json();
    renderAuditLog(logs);
  } catch (err) {
    console.error('[SysAdmin] loadAuditLog error:', err);
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Failed to load audit trail. Check console for details.</td></tr>';
  }
}

function auditModuleLevel(moduleName) {
  if (moduleName === 'RBAC_SECURITY' || moduleName === 'SYSTEM' || moduleName === 'BLOCKCHAIN') return 4;
  if (moduleName === 'PAYROLL') return 3;
  if (['EMPLOYEE', 'ATTENDANCE', 'LEAVE', '201_FILE', 'ONBOARDING'].includes(moduleName)) return 2;
  return 1;
}

function auditShortValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value === '[protected]') return 'Protected data';

  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed)
        .slice(0, 6)
        .map(([key, val]) => `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`)
        .join(', ');
    }
  } catch {
    // Plain text audit values are valid.
  }

  return text;
}

function auditDetails(log) {
  const parts = [];
  if (log.field_changed) parts.push(`Field: ${log.field_changed}`);
  if (log.details) parts.push(log.details);

  const oldValue = auditShortValue(log.old_value);
  const newValue = auditShortValue(log.new_value);
  if (oldValue || newValue) {
    if (oldValue && newValue) parts.push(`${oldValue} → ${newValue}`);
    else parts.push(oldValue || newValue);
  }

  const details = parts.filter(Boolean).join(' | ');
  return details ? (details.length > 140 ? `${details.slice(0, 140)}…` : details) : '—';
}

function auditTarget(log) {
  if (log.target_employee_id) return `Employee #${log.target_employee_id}`;
  if (log.employee_id) return `Employee #${log.employee_id}`;
  return '—';
}

function renderAuditLog(logs) {
  const tbody = document.getElementById('audit-tbody');
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
        <td style="max-width:260px;word-break:break-word;"><small>${sysEsc(log.action_performed || '—')}</small></td>
        <td>${sysEsc(actor)}</td>
        <td><small>${sysEsc(auditTarget(log))}</small></td>
        <td><small>${sysEsc(resultOrIp)}</small></td>
        <td><small>${sysEsc(log.source_table || '—')}</small></td>
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
    sysAllRoles.map(r => `<option value="${r.id}">${r.label} (${r.access_level || '—'})</option>`).join('');

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
      `<span style="color:#fdcb6e">⚠ ${existingUser.username} (${existingUser.role_label || existingUser.role_name})</span>`;
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
      showSysToast(`✅ ${data.message}`, 'success');
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
      submitBtn.textContent = '🔒 Register Account';
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
  roleSelect.innerHTML = sysAllRoles
    .map(r => `<option value="${r.id}" ${Number(r.id) === Number(currentRoleId) ? 'selected' : ''}>${r.label} (${r.access_level || '—'})</option>`)
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
      showSysToast(`✅ ${data.message}`, 'success');
      closeRoleModal();
      loadUsersTable();
    } else {
      showSysToast(`❌ ${data.error}`, 'error');
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
      showSysToast(`✅ Account ${action}d.`, 'success');
      loadUsersTable();
    } else {
      showSysToast(`❌ ${data.error}`, 'error');
    }
  } catch (err) {
    showSysToast('Network error.', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// EDIT CREDENTIALS MODAL
// ═══════════════════════════════════════════════════════════════

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
      showSysToast(`✅ ${data.message}`, 'success');
      if (data.temporaryPassword && generated) {
        generated.textContent = `Generated temporary password: ${data.temporaryPassword}`;
        generated.style.display = 'block';
      } else {
        closeCredentialsModal();
      }
      loadUsersTable();
    } else {
      showSysToast(`❌ ${data.error}`, 'error');
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

async function loadBiometricSettings() {
  const tbody = document.getElementById('sys-bio-devices-tbody');
  try {
    const res = await apiFetch('/api/attendance/biometric/devices');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load biometric devices.');
    sysBiometricDevices = data;
    if (!tbody) return;
    tbody.innerHTML = data.length ? data.map(device => `
      <tr>
        <td>${sysEsc(device.device_name)}<br><small style="color:var(--muted)">${sysEsc(device.device_reference)}</small></td>
        <td>${sysEsc(device.vendor || '—')}</td>
        <td><span class="${device.is_active ? 'badge-active' : 'badge-inactive'}">${device.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>${sysEsc(sysFormatDateTime(device.last_success_at))}</td>
        <td>${sysEsc(device.last_error_message || '—')}</td>
        <td><button class="btn-sysadmin-sm" onclick="editBiometricSettings(${Number(device.device_id)})">Edit</button></td>
      </tr>
    `).join('') : '<tr><td colspan="6" class="table-empty">No biometric devices configured.</td></tr>';
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="table-empty">${sysEsc(err.message)}</td></tr>`;
    showSysToast(err.message, 'error');
  }
}

function clearBiometricSettingsForm() {
  [
    'sys-bio-device-id',
    'sys-bio-reference',
    'sys-bio-name',
    'sys-bio-vendor',
    'sys-bio-url',
    'sys-bio-endpoint',
    'sys-bio-secret',
  ].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.value = '';
  });
  const auth = document.getElementById('sys-bio-auth');
  const active = document.getElementById('sys-bio-active');
  if (auth) auth.value = 'NONE';
  if (active) active.value = '1';
}

async function loadAccountCreationRequests() {
  const tbody = document.getElementById('account-request-tbody');
  if (!tbody) return;
  try {
    const response = await apiFetch('/api/account-requests');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load account requests.');
    sysAccountRequests = Array.isArray(data.requests) ? data.requests : [];
    renderAccountCreationRequests(sysAccountRequests);
  } catch (error) {
    console.error('[SysAdmin] account request load error:', error);
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Unable to load account requests.</td></tr>';
    showSysToast(error.message || 'Unable to load account requests.', 'error');
  }
}

function renderAccountCreationRequests(requests) {
  const tbody = document.getElementById('account-request-tbody');
  if (!tbody) return;
  if (!requests.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No account creation requests found.</td></tr>';
    return;
  }
  tbody.innerHTML = requests.map(request => {
    const employeeLabel = request.employee_name
      ? request.employee_code + ' - ' + request.employee_name
      : request.employee_code || ('Employee ' + request.employee_id);
    const requestedAt = sysFormatDateTime(request.created_at);
    const action = request.status === 'PENDING'
      ? '<button class="btn-sysadmin-sm" type="button" onclick="openAccountRequestModal(' + Number(request.request_id) + ')">Review</button>'
      : '<small style="color:var(--muted)">Reviewed</small>';
    return '<tr>' +
      '<td><strong>' + sysEsc(employeeLabel) + '</strong></td>' +
      '<td>' + sysEsc(request.suggested_username) + '</td>' +
      '<td>' + sysEsc(request.default_role?.label || 'Regular Employee') + '</td>' +
      '<td>' + sysEsc(request.requested_by_username || 'System') + '</td>' +
      '<td><small>' + sysEsc(requestedAt) + '</small></td>' +
      '<td><span class="badge-level badge-level-2">' + sysEsc(request.status) + '</span></td>' +
      '<td><span class="badge-level badge-level-1">' + sysEsc(request.account_status) + '</span></td>' +
      '<td>' + action + '</td>' +
    '</tr>';
  }).join('');
}

async function openAccountRequestModal(requestId) {
  if (!sysAllRoles.length) await loadRolesList();
  const request = sysAccountRequests.find(item => Number(item.request_id) === Number(requestId));
  if (!request) {
    showSysToast('Account request not found.', 'error');
    return;
  }
  const employeeLabel = request.employee_name
    ? request.employee_code + ' - ' + request.employee_name
    : request.employee_code || ('Employee ' + request.employee_id);
  document.getElementById('account-request-id').value = request.request_id;
  document.getElementById('account-request-employee').textContent = employeeLabel;
  document.getElementById('account-request-requested-by').textContent = request.requested_by_username || 'System';
  document.getElementById('account-request-username').value = request.suggested_username || '';
  document.getElementById('account-request-password').value = '';
  document.getElementById('account-request-reason').value = '';
  const generated = document.getElementById('account-request-generated');
  generated.style.display = 'none';
  generated.textContent = '';

  const roleSelect = document.getElementById('account-request-role');
  roleSelect.innerHTML = sysAllRoles.map(role => {
    const selected = Number(role.id) === Number(request.default_role?.id) ? ' selected' : '';
    return '<option value="' + Number(role.id) + '"' + selected + '>' +
      sysEsc(role.label + ' (' + (role.access_level || 'Level 1') + ')') +
      '</option>';
  }).join('');
  document.getElementById('account-request-modal').style.display = 'flex';
}

function closeAccountRequestModal() {
  document.getElementById('account-request-modal').style.display = 'none';
}

async function approveAccountCreationRequest() {
  const requestId = Number(document.getElementById('account-request-id').value);
  const username = document.getElementById('account-request-username').value.trim();
  const roleId = Number(document.getElementById('account-request-role').value);
  const temporaryPassword = document.getElementById('account-request-password').value;
  if (!requestId || !username || !roleId) {
    showSysToast('Username and role assignment are required.', 'error');
    return;
  }
  const body = { username, assigned_role_id: roleId };
  if (temporaryPassword) body.temporary_password = temporaryPassword;

  try {
    const response = await apiFetch('/api/account-requests/' + requestId + '/approve', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to create employee account.');

    const generated = document.getElementById('account-request-generated');
    if (data.generatedTemporaryPassword) {
      generated.textContent = 'Temporary password (show once): ' + data.generatedTemporaryPassword;
      generated.style.display = 'block';
    } else {
      closeAccountRequestModal();
    }
    showSysToast(data.message || 'Employee account created.', 'success');
    await Promise.all([loadAccountCreationRequests(), loadUsersTable()]);
  } catch (error) {
    showSysToast(error.message || 'Unable to create employee account.', 'error');
  }
}

async function rejectAccountCreationRequest() {
  const requestId = Number(document.getElementById('account-request-id').value);
  const reason = document.getElementById('account-request-reason').value.trim();
  if (reason.length < 8) {
    showSysToast('Enter a rejection reason of at least 8 characters.', 'error');
    return;
  }
  try {
    const response = await apiFetch('/api/account-requests/' + requestId + '/reject', {
      method: 'PATCH',
      body: JSON.stringify({ reason }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to reject account request.');
    closeAccountRequestModal();
    showSysToast(data.message || 'Account request rejected.', 'success');
    await loadAccountCreationRequests();
  } catch (error) {
    showSysToast(error.message || 'Unable to reject account request.', 'error');
  }
}

function editBiometricSettings(deviceId) {
  const device = sysBiometricDevices.find(item => Number(item.device_id) === Number(deviceId));
  if (!device) return;
  document.getElementById('sys-bio-device-id').value = device.device_id;
  document.getElementById('sys-bio-reference').value = device.device_reference || '';
  document.getElementById('sys-bio-name').value = device.device_name || '';
  document.getElementById('sys-bio-vendor').value = device.vendor || '';
  document.getElementById('sys-bio-url').value = device.api_base_url || '';
  document.getElementById('sys-bio-endpoint').value = device.logs_endpoint || '';
  document.getElementById('sys-bio-auth').value = device.auth_type || 'NONE';
  document.getElementById('sys-bio-active').value = device.is_active ? '1' : '0';
  document.getElementById('sys-bio-secret').value = '';
}

async function saveBiometricSettings() {
  const deviceId = document.getElementById('sys-bio-device-id')?.value;
  const body = {
    device_reference: document.getElementById('sys-bio-reference')?.value.trim(),
    device_name: document.getElementById('sys-bio-name')?.value.trim(),
    vendor: document.getElementById('sys-bio-vendor')?.value.trim(),
    api_base_url: document.getElementById('sys-bio-url')?.value.trim(),
    logs_endpoint: document.getElementById('sys-bio-endpoint')?.value.trim(),
    auth_type: document.getElementById('sys-bio-auth')?.value,
    auth_secret: document.getElementById('sys-bio-secret')?.value,
    is_active: document.getElementById('sys-bio-active')?.value === '1',
  };
  if (!body.device_reference || !body.device_name) {
    showSysToast('Device reference and device name are required.', 'error');
    return;
  }
  if (!body.auth_secret) delete body.auth_secret;

  try {
    const res = await apiFetch(
      deviceId ? `/api/attendance/biometric/devices/${deviceId}` : '/api/attendance/biometric/devices',
      { method: deviceId ? 'PUT' : 'POST', body: JSON.stringify(body) }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save biometric device.');
    showSysToast(data.message || 'Biometric device saved.', 'success');
    clearBiometricSettingsForm();
    loadBiometricSettings();
  } catch (err) {
    showSysToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
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
window.loadAccountCreationRequests = loadAccountCreationRequests;
window.openAccountRequestModal = openAccountRequestModal;
window.closeAccountRequestModal = closeAccountRequestModal;
window.approveAccountCreationRequest = approveAccountCreationRequest;
window.rejectAccountCreationRequest = rejectAccountCreationRequest;
window.toggleRoleUsers       = toggleRoleUsers;
window.loadBiometricSettings = loadBiometricSettings;
window.clearBiometricSettingsForm = clearBiometricSettingsForm;
window.editBiometricSettings = editBiometricSettings;
window.saveBiometricSettings = saveBiometricSettings;
