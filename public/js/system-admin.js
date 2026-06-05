/* ============================================================
   public/js/system-admin.js — System Administration Controller
   Account Registration, RBAC Management & Audit Trail
   ============================================================ */

// ── State ────────────────────────────────────────────────────
let sysAllUsers     = [];
let sysAllRoles     = [];
let sysAllEmployees = [];
let sysCurrentStep  = 1;

// ── Tab Switching ────────────────────────────────────────────
function switchSysAdminTab(tabId, el) {
  document.querySelectorAll('.sysadmin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sysadmin-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  const panel = document.getElementById('panel-' + tabId);
  if (panel) panel.classList.add('active');

  if (tabId === 'accounts') loadUsersTable();
  if (tabId === 'roles')    loadRolesGrid();
  if (tabId === 'audit')    loadAuditLog();
}

// ── Initialize on navigation ────────────────────────────────
function initSystemAdmin() {
  loadUsersTable();
  loadRolesList();
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
    sysAllUsers = await res.json();

    // Also load employees for the unlinked count
    const empRes = await apiFetch('/api/employees');
    if (empRes && empRes.ok) {
      sysAllEmployees = await empRes.json();
    }

    renderUsersTable(sysAllUsers);
    updateStats();
  } catch (err) {
    console.error('[SysAdmin] loadUsersTable error:', err);
  }
}

function updateStats() {
  const total    = sysAllUsers.length;
  const active   = sysAllUsers.filter(u => u.is_active).length;
  const inactive = total - active;
  const linkedIds = sysAllUsers.map(u => u.employee_id).filter(Boolean);
  const unlinked  = sysAllEmployees.filter(e => !linkedIds.includes(e.id)).length;

  document.getElementById('stat-total-users').textContent     = total;
  document.getElementById('stat-active-users').textContent    = active;
  document.getElementById('stat-inactive-users').textContent  = inactive;
  document.getElementById('stat-unlinked-employees').textContent = unlinked;
}

function renderUsersTable(users) {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No accounts found.</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const levelNum = u.access_level ? u.access_level.replace('Level ', '') : '1';
    const statusClass = u.is_active ? 'badge-active' : 'badge-inactive';
    const statusText  = u.is_active ? 'Active' : 'Inactive';
    const empName = (u.first_name && u.last_name) 
      ? `${u.first_name} ${u.last_name}` 
      : '<span style="color:var(--muted)">Unlinked</span>';
    const empCode = u.employee_code || '—';
    const lastLogin = u.last_login 
      ? new Date(u.last_login).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' })
      : '—';

    const currentUser = getUser();
    const isSelf = currentUser && currentUser.id === u.id;

    return `
      <tr>
        <td>${u.id}</td>
        <td><strong>${u.username}</strong></td>
        <td>${empName}<br><small style="color:var(--muted)">${empCode}</small></td>
        <td>${u.role_label || u.role_name}</td>
        <td><span class="badge-level badge-level-${levelNum}">${u.access_level || '—'}</span></td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td><small>${lastLogin}</small></td>
        <td>
          <div class="action-group">
            ${!isSelf ? `
              <button class="btn-sysadmin-sm" onclick="showRoleModal(${u.id}, '${u.username}', '${u.role_label || u.role_name}', ${u.role_id})" title="Change Role">🛡️</button>
              <button class="btn-sysadmin-sm" onclick="showCredentialsModal(${u.id}, '${u.username}')" title="Edit Credentials">🔑</button>
              ${u.is_active 
                ? `<button class="btn-sysadmin-danger" onclick="toggleUserStatus(${u.id}, false)" title="Deactivate">⏸</button>`
                : `<button class="btn-sysadmin-sm" onclick="toggleUserStatus(${u.id}, true)" title="Activate">▶</button>`
              }
            ` : '<small style="color:var(--muted)">You</small>'}
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
      statusFilter === 'active' ? u.is_active : !u.is_active
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
    'Level 1': 'Basic access. Can view own records, file leave, and submit requests.',
    'Level 2': 'Operational access. Can manage employees, leave, attendance, and 201 files.',
    'Level 3': 'Supervisory access. Can approve payroll and review financial reports.',
    'Level 4': 'Full system access. Can manage accounts, roles, and view all audit logs.',
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
    const url = module
      ? `/api/admin/audit-log?module=${encodeURIComponent(module)}&limit=100`
      : '/api/admin/audit-log?limit=100';

    const res = await apiFetch(url);
    if (!res) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Session expired. Please log in again.</td></tr>';
      return;
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error('Failed to load audit log:', errData);
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Error: ${errData.error || 'Failed to load audit log.'}</td></tr>`;
      return;
    }
    const logs = await res.json();
    renderAuditLog(logs);
  } catch (err) {
    console.error('[SysAdmin] loadAuditLog error:', err);
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Failed to load audit trail. Check console for details.</td></tr>';
  }
}

function renderAuditLog(logs) {
  const tbody = document.getElementById('audit-tbody');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No audit entries found.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const ts = log.timestamp
      ? new Date(log.timestamp).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'medium' })
      : '—';

    let details = '—';
    if (log.new_value) {
      try {
        const nv = JSON.parse(log.new_value);
        details = Object.entries(nv).map(([k, v]) => `${k}: ${v}`).join(', ');
        if (details.length > 80) details = details.substring(0, 80) + '…';
      } catch { details = log.new_value.substring(0, 80); }
    }

    return `
      <tr>
        <td><small>${ts}</small></td>
        <td>${log.admin_username || 'System'}</td>
        <td style="max-width:300px;word-break:break-word;"><small>${log.action_performed || '—'}</small></td>
        <td><span class="badge-level badge-level-${log.module === 'RBAC_SECURITY' ? '4' : '2'}">${log.module || '—'}</span></td>
        <td><small>${log.ip_address || '—'}</small></td>
        <td><small style="color:var(--muted)">${details}</small></td>
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
  if (!password || password.length < 8) { showSysToast('Password must be at least 8 characters.', 'error'); return false; }
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

  const payload = {
    employee_id: employeeId,
    username,
    password,
    role_id: roleId,
  };

  try {
    const submitBtn = document.getElementById('btn-reg-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';

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
      showSysToast(`❌ ${data.error}`, 'error');
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
  document.getElementById('role-modal-username').textContent = username;
  document.getElementById('role-modal-current').textContent = currentRole;
  document.getElementById('role-modal-user-id').value = userId;

  const roleSelect = document.getElementById('role-modal-new-role');
  roleSelect.innerHTML = sysAllRoles
    .map(r => `<option value="${r.id}" ${r.id === currentRoleId ? 'selected' : ''}>${r.label} (${r.access_level || '—'})</option>`)
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
  document.getElementById('credentials-modal').style.display = 'flex';
}

function closeCredentialsModal() {
  document.getElementById('credentials-modal').style.display = 'none';
}

async function submitCredentialsUpdate() {
  const userId = parseInt(document.getElementById('cred-modal-user-id').value);
  const username = document.getElementById('cred-modal-username').value.trim().toLowerCase();
  const password = document.getElementById('cred-modal-password').value;
  const confirm = document.getElementById('cred-modal-password-confirm').value;

  if (!username) { showSysToast('Username is required.', 'error'); return; }
  if (!password || password.length < 8) { showSysToast('Password must be at least 8 characters.', 'error'); return; }
  if (password !== confirm) { showSysToast('Passwords do not match.', 'error'); return; }

  try {
    const res = await apiFetch(`/api/admin/users/${userId}/credentials`, {
      method: 'PUT',
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (res.ok) {
      showSysToast(`✅ ${data.message}`, 'success');
      closeCredentialsModal();
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
window.toggleRoleUsers       = toggleRoleUsers;
