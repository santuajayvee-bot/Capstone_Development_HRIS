/* ============================================================
   LEAVE.JS — Leave management & request form
   ============================================================ */

let CURRENT_USER = null;
let LEAVE_TYPES = [];
const LEAVE_MANAGER_ROLES = new Set(['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager']);
const LEAVE_APPROVER_ROLES = new Set(['hr_admin', 'hr_manager', 'payroll_officer', 'payroll_manager']);

function normalizeLeaveRole(role) {
  if (typeof normalizeClientRole === 'function') return normalizeClientRole(role);
  return String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_') || 'employee';
}

function currentLeaveRole() {
  return normalizeLeaveRole(CURRENT_USER?.role || CURRENT_USER?.roleName || CURRENT_USER?.role_label || CURRENT_USER?.roleLabel);
}

function isLeaveManager() {
  return LEAVE_MANAGER_ROLES.has(currentLeaveRole());
}

function isLeaveApprover() {
  return LEAVE_APPROVER_ROLES.has(currentLeaveRole());
}

function isLeaveEmployee() {
  return !isLeaveManager();
}

async function leaveNotice(message, title = 'Notice', type = 'info') {
  if (typeof showAlert === 'function') return showAlert(message, title, type);
  return alert(message);
}

async function leaveConfirm(message, title = 'Confirm', confirmText = 'Continue', cancelText = 'Cancel') {
  if (typeof showConfirm === 'function') return showConfirm(message, title, confirmText, cancelText);
  return confirm(message);
}

function closeLeaveRemarksPrompt(value = null) {
  const modal = document.getElementById('leave-remarks-prompt-modal');
  const resolver = modal?._leaveResolve;
  if (modal) {
    modal._leaveResolve = null;
    modal.remove();
  }
  if (resolver) resolver(value);
}

function leaveRemarksPrompt({
  title = 'Reject Leave Request',
  message = 'Enter rejection remarks before rejecting this leave request.',
  confirmText = 'Reject Leave',
  placeholder = 'Write rejection remarks...',
} = {}) {
  document.getElementById('leave-remarks-prompt-modal')?.remove();
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.id = 'leave-remarks-prompt-modal';
    modal.className = 'leave-modal';
    modal.style.display = 'flex';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'leave-remarks-prompt-title');
    modal._leaveResolve = resolve;
    modal.innerHTML = `
      <div class="leave-modal-card" style="width:min(520px,94vw);">
        <div class="leave-modal-head">
          <h3 class="leave-section-title" id="leave-remarks-prompt-title">${escapeLeaveText(title)}</h3>
          <button class="btn btn-outline" type="button" data-leave-remarks-cancel>Close</button>
        </div>
        <div class="leave-modal-body">
          <p style="margin:0 0 12px;color:var(--muted);font-size:13px;">${escapeLeaveText(message)}</p>
          <textarea id="leave-remarks-prompt-input" rows="4" maxlength="500" placeholder="${escapeLeaveText(placeholder)}" style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);padding:10px;resize:vertical;"></textarea>
          <div id="leave-remarks-prompt-error" style="display:none;margin-top:8px;color:var(--red);font-size:12px;">Remarks are required when rejecting.</div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button class="btn btn-outline" type="button" data-leave-remarks-cancel>Cancel</button>
            <button class="btn btn-primary" type="button" data-leave-remarks-submit>${escapeLeaveText(confirmText)}</button>
          </div>
        </div>
      </div>
    `;
    modal.addEventListener('click', event => {
      if (event.target === modal || event.target.closest('[data-leave-remarks-cancel]')) {
        closeLeaveRemarksPrompt(null);
      }
    });
    modal.querySelector('[data-leave-remarks-submit]')?.addEventListener('click', () => {
      const input = modal.querySelector('#leave-remarks-prompt-input');
      const error = modal.querySelector('#leave-remarks-prompt-error');
      const remarks = String(input?.value || '').trim();
      if (!remarks) {
        if (error) error.style.display = 'block';
        input?.focus();
        return;
      }
      closeLeaveRemarksPrompt(remarks);
    });
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeLeaveRemarksPrompt(null);
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        modal.querySelector('[data-leave-remarks-submit]')?.click();
      }
    });
    document.body.appendChild(modal);
    setTimeout(() => modal.querySelector('#leave-remarks-prompt-input')?.focus(), 30);
  });
}

async function revealLeaveSensitiveDetails(leaveId) {
  const response = await apiFetch(`/api/leave/${encodeURIComponent(leaveId)}/reveal-sensitive`, {
    method: 'POST',
    body: '{}',
  });
  const data = await response?.json().catch(() => ({}));
  if (!response?.ok) return alert(data.error || 'Failed to reveal leave details.');
  const lines = [
    `Reason: ${data.reason || '-'}`,
    `Remarks: ${data.remarks || '-'}`,
    `Rejection remarks: ${data.rejection_remarks || '-'}`,
    `Approval remarks: ${data.approval_remarks || '-'}`,
  ];
  alert(lines.join('\n'));
}

async function downloadLeaveAttachment(leaveId) {
  const response = await apiFetch(`/api/leave/${encodeURIComponent(leaveId)}/attachment`);
  if (!response?.ok) return alert('Failed to download leave attachment.');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'leave-attachment';
  link.click();
  URL.revokeObjectURL(url);
}

// ── Load current user (works on both leave and requests pages) ──
async function fetchCurrentUser(callback) {
  if (CURRENT_USER) { if (callback) callback(); return; }
  try {
    const response = await apiFetch('/api/auth/me');
    if (response && response.ok) {
      const data = await response.json();
      CURRENT_USER = data.user ? { ...data.user, role: normalizeLeaveRole(data.user.role || data.user.roleName || data.user.role_label || data.user.roleLabel) } : null;
      console.log('Current user loaded:', CURRENT_USER);
      
      // Check wage type eligibility for leave requests
      checkLeaveRequestEligibility();
    }
  } catch (error) {
    console.error('Error fetching current user:', error);
  }
  if (callback) callback();
}

async function loadLeaveTypes(includeInactive = false) {
  try {
    const res = await apiFetch(`/api/leave/types${includeInactive ? '?include_inactive=1' : ''}`);
    if (!res || !res.ok) return [];
    LEAVE_TYPES = await res.json();
    populateLeaveTypeSelects();
    renderLeaveTypes();
    return LEAVE_TYPES;
  } catch (error) {
    console.error('Error loading leave types:', error);
    return [];
  }
}

function populateLeaveTypeSelects() {
  const activeTypes = LEAVE_TYPES.filter(type => Number(type.is_active) === 1);
  const options = activeTypes.map(type => `<option value="${type.id}" data-name="${type.name}" data-category="${type.category}">${type.name}</option>`).join('');

  ['manual-leave-type', 'req-leave-type', 'balance-leave-type'].forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Select leave type</option>' + options;
    if ([...select.options].some(option => option.value === current)) select.value = current;
  });

  const filter = document.getElementById('leave-filter-type');
  if (filter) {
    const current = filter.value;
    filter.innerHTML = '<option value="">All Leave Types</option>' + activeTypes.map(type => `<option>${type.name}</option>`).join('');
    filter.value = current;
  }
}

// Check if employee is eligible to file leave requests based on wage type
async function checkLeaveRequestEligibility() {
  try {
    if (!CURRENT_USER || !CURRENT_USER.employeeId) return;
    
    const empRes = await apiFetch(`/api/employees`);
    if (!empRes || !empRes.ok) return;
    
    const employees = await empRes.json();
    const currentEmp = employees.find(e => e.id === CURRENT_USER.employeeId);
    
    if (currentEmp) {
      const wageType = (currentEmp.wage_type || '').toLowerCase();
      const isBlockedWageType = wageType.includes('per-piece') || wageType.includes('per-trip');
      
      if (isBlockedWageType) {
        // Disable Leave Request button
        const leaveReqCard = document.querySelector('[data-type="Leave Request"]');
        if (leaveReqCard) {
          leaveReqCard.style.opacity = '0.5';
          leaveReqCard.style.cursor = 'not-allowed';
          leaveReqCard.style.pointerEvents = 'none';
          
          // Add warning text
          const subtext = leaveReqCard.querySelector('.req-type-sub');
          if (subtext) {
            subtext.innerHTML += '<br><span style="font-size:11px;color:#d32f2f;margin-top:4px;display:block;">❌ Not available for your wage type</span>';
          }
        }
      }
    }
  } catch (err) {
    console.error('Error checking leave request eligibility:', err);
  }
}

// ── Request type selector ─────────────────────────────────────
function selectReq(el) {
  document.querySelectorAll('.req-type').forEach(r => r.classList.remove('selected'));
  el.classList.add('selected');
  // Show date/leave-type fields only for Leave Request
  const leaveFields = document.getElementById('req-leave-fields');
  if (leaveFields) {
    const type = el.getAttribute('data-type') || el.querySelector('.req-type-title')?.textContent;
    leaveFields.style.display = (type === 'Leave Request') ? 'grid' : 'none';
  }
}

// ── LEAVE PAGE ────────────────────────────────────────────────
async function loadLeaveRequests() {
  try {
    const response = await apiFetch('/api/leave');
    if (!response || !response.ok) { console.error('Failed to fetch leave requests'); return; }
    const leaves = await response.json();
    
    // Also fetch and sort employees for dropdown
    try {
      const empRes = await apiFetch('/api/employees');
      if (empRes && empRes.ok) {
        let employees = await empRes.json();
        // Sort by ID for sequential order
        employees = employees.sort((a, b) => a.id - b.id);
        EMPLOYEES_LIST = employees;
        
        // Update dropdown
        const select = document.getElementById('manual-employee');
        if (select) {
          select.innerHTML = '<option value="">-- Select Employee --</option>';
          employees.forEach(emp => {
            const option = document.createElement('option');
            option.value = emp.id;
            option.textContent = `${emp.first_name} ${emp.last_name} (${emp.employee_code})`;
            select.appendChild(option);
          });
        }
      }
    } catch (err) {
      console.error('Error fetching employees:', err);
    }
    
    renderLeaveRequests(leaves);
  } catch (error) {
    console.error('Error loading leave requests:', error);
  }
}

let ALL_LEAVES_DATA = [];
let CURRENT_LEAVE_TAB = 'pending';
let LEAVE_PAGE = 1;
const LEAVE_PAGE_SIZE = 20;

window.switchLeaveTab = function(tab) {
  CURRENT_LEAVE_TAB = tab;
  LEAVE_PAGE = 1; // reset page on tab switch
  
  // Update UI buttons
  const btnPending = document.getElementById('leave-tab-pending');
  const btnHistory = document.getElementById('leave-tab-history');
  if (btnPending && btnHistory) {
    if (tab === 'pending') {
      btnPending.style.background = 'var(--bg)';
      btnPending.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
      btnPending.style.color = 'var(--text)';
      btnHistory.style.background = 'transparent';
      btnHistory.style.boxShadow = 'none';
      btnHistory.style.color = 'var(--muted)';
      document.getElementById('leave-history-controls').style.display = 'none';
    } else {
      btnHistory.style.background = 'var(--bg)';
      btnHistory.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
      btnHistory.style.color = 'var(--text)';
      btnPending.style.background = 'transparent';
      btnPending.style.boxShadow = 'none';
      btnPending.style.color = 'var(--muted)';
      document.getElementById('leave-history-controls').style.display = 'flex';
    }
  }
  
  window.renderLeaveTable();
};

window.prevLeavePage = function() {
  if (LEAVE_PAGE > 1) { LEAVE_PAGE--; window.renderLeaveTable(); }
};

window.nextLeavePage = function() {
  LEAVE_PAGE++; window.renderLeaveTable();
};

function renderLeaveRequests(leaves) {
  const isAdmin = isLeaveManager();

  const manualCard = document.getElementById('manual-encoding-card');
  if (manualCard) {
    manualCard.style.display = isAdmin ? 'block' : 'none';
  }

  // If employee, just show their own data without tabs
  if (!isAdmin) {
     document.getElementById('leave-history-controls').style.display = 'none';
     const tabs = document.getElementById('leave-tabs-container');
     if(tabs) tabs.style.display = 'none';
  }

  let filteredLeaves = leaves;
  if (!isAdmin) {
    filteredLeaves = leaves.filter(l => l.employee_id === CURRENT_USER.employeeId);
  }

  // Format data for filtering
  ALL_LEAVES_DATA = filteredLeaves.map(l => ({
    ...l,
    parsedDate: new Date(l.created_at || l.date_from)
  })).sort((a, b) => b.parsedDate - a.parsedDate);

  window.renderLeaveTable();
}

window.renderLeaveTable = function() {
  const tbody = document.getElementById('leave-tbody');
  const emptyState = document.getElementById('leave-empty-state');
  const actionColHead = document.getElementById('leave-dynamic-col-head');
  if (!tbody) return;

  const isAdmin = isLeaveManager();
  const canApprove = isLeaveApprover();

  let filtered = ALL_LEAVES_DATA;
  
  // 1. Filter by Tab (Pending vs History) for Admins
  if (CURRENT_LEAVE_TAB === 'pending') {
    filtered = filtered.filter(r => r.status === 'Pending');
    if (actionColHead) {
      actionColHead.textContent = canApprove ? 'Actions' : 'Status';
      actionColHead.style.textAlign = canApprove ? 'right' : 'left';
    }
  } else {
    filtered = filtered.filter(r => r.status !== 'Pending');
    if (actionColHead) {
      actionColHead.textContent = 'Status';
      actionColHead.style.textAlign = 'left';
    }
  }

  // 2. Filter by History Controls (Search & Date Range)
  if (CURRENT_LEAVE_TAB === 'history') {
    const searchVal = (document.getElementById('leave-search')?.value || '').toLowerCase();
    if (searchVal) {
      filtered = filtered.filter(r => (r.employee_name || '').toLowerCase().includes(searchVal));
    }
    
    const dateVal = document.getElementById('leave-date-filter')?.value || '30';
    if (dateVal !== 'all') {
      const daysFilter = parseInt(dateVal);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysFilter);
      filtered = filtered.filter(r => r.parsedDate >= cutoffDate);
    }
  }

  // 3. Empty State check
  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    if (CURRENT_LEAVE_TAB === 'history') {
      emptyState.innerHTML = `<div style="font-size:32px;margin-bottom:12px;">📂</div><h3 style="margin:0;font-size:16px;font-weight:600;color:var(--text);">No history records found</h3><div style="font-size:13px;color:var(--muted);margin-top:4px;">Try adjusting your search or date filters.</div>`;
    } else {
      emptyState.innerHTML = `<div style="font-size:48px;margin-bottom:16px;">🎉</div><h3 style="margin:0;font-size:18px;font-weight:600;color:var(--text);">You're all caught up!</h3><div style="font-size:14px;color:var(--muted);margin-top:8px;">No pending leave requests require your attention.</div>`;
    }
    document.getElementById('leave-page-info').textContent = `Showing 0 results`;
    return;
  } else {
    emptyState.style.display = 'none';
  }

  // 4. Pagination
  const totalItems = filtered.length;
  const maxPage = Math.ceil(totalItems / LEAVE_PAGE_SIZE);
  if (LEAVE_PAGE > maxPage) LEAVE_PAGE = maxPage;
  if (LEAVE_PAGE < 1) LEAVE_PAGE = 1;
  
  const startIndex = (LEAVE_PAGE - 1) * LEAVE_PAGE_SIZE;
  const endIndex = Math.min(startIndex + LEAVE_PAGE_SIZE, totalItems);
  const pageData = filtered.slice(startIndex, endIndex);

  document.getElementById('leave-page-info').textContent = `Showing ${startIndex + 1}-${endIndex} of ${totalItems} results`;

  // 5. Render rows
  tbody.innerHTML = pageData.map(leave => `
    <tr data-leave-id="${leave.id}" style="border-bottom:1px solid rgba(0,0,0,0.05);">
      <td style="padding:16px 24px;">
        <div style="font-weight:600;color:var(--text);">${leave.employee_name}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">Submitted ${leave.parsedDate.toLocaleDateString()}</div>
      </td>
      <td style="padding:16px 24px;font-weight:500;">${leave.type}</td>
      <td style="padding:16px 24px;font-size:13px;color:var(--text);">${new Date(leave.date_from).toLocaleDateString()} – ${new Date(leave.date_to).toLocaleDateString()} (${leave.days || 1}d)</td>
      <td style="padding:16px 24px;font-size:13px;color:var(--muted);max-width:200px;">
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button type="button" class="btn btn-outline" onclick="revealLeaveSensitiveDetails(${Number(leave.id)})">Show details</button>
          ${leave.attachment_available ? `<button type="button" class="btn btn-outline" onclick="downloadLeaveAttachment(${Number(leave.id)})">Download attachment</button>` : ''}
        </div>
      </td>
      <td style="padding:16px 24px;text-align:${(CURRENT_LEAVE_TAB === 'pending' && canApprove) ? 'right' : 'left'};">
        ${CURRENT_LEAVE_TAB === 'pending' ? (canApprove ? `
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn" style="background:var(--green);color:white;border:none;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;" onclick="approveLeave(this)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Approve
            </button>
            <button class="btn btn-outline" style="color:var(--red);border-color:rgba(244,67,54,0.3);padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;" onclick="denyLeave(this)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Reject
            </button>
          </div>
        ` : `<span class="badge badge-yellow" style="padding:4px 8px;border-radius:20px;">Pending</span>`) : `
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="badge badge-${leave.status === 'Approved' ? 'green' : leave.status === 'Cancelled' ? 'yellow' : 'red'}" style="padding:4px 8px;border-radius:20px;font-weight:600;">${leave.status}</span>
            ${(canApprove && leave.status === 'Approved') ? `<button class="btn" style="background:none;border:1px solid rgba(244,67,54,0.3);color:var(--red);padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;" onclick="cancelLeave(this)">Cancel</button>` : ''}
          </div>
        `}
      </td>
    </tr>
  `).join('');
};

// ── Leave approve / deny ──────────────────────────────────────
async function approveLeave(btn) {
  const row = btn.closest('tr');
  const leaveId = row?.dataset.leaveId;
  if (!leaveId) { await leaveNotice('Error: Could not find leave request', 'Leave Request', 'error'); return; }
  if (!(await leaveConfirm('Approve this leave request?', 'Approve Leave Request', 'Approve', 'Cancel'))) return;
  try {
    const res = await apiFetch(`/api/leave/${leaveId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'Approved' })
    });
    if (!res || !res.ok) throw new Error('Failed to approve');
    await leaveNotice('Leave approved successfully', 'Leave Request', 'success');
    loadLeaveRequests();
  } catch (err) { await leaveNotice('Failed to approve leave: ' + err.message, 'Leave Request', 'error'); }
}

async function denyLeave(btn) {
  const row = btn.closest('tr');
  const leaveId = row?.dataset.leaveId;
  if (!leaveId) { await leaveNotice('Error: Could not find leave request', 'Leave Request', 'error'); return; }
  if (!(await leaveConfirm('Reject this leave request?', 'Reject Leave Request', 'Reject', 'Cancel'))) return;
  const remarks = await leaveRemarksPrompt();
  if (!remarks) return;
  try {
    const res = await apiFetch(`/api/leave/${leaveId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'Rejected', remarks })
    });
    if (!res || !res.ok) throw new Error('Failed to deny');
    await leaveNotice('Leave rejected successfully', 'Leave Request', 'success');
    loadLeaveRequests();
  } catch (err) { await leaveNotice('Failed to reject leave: ' + err.message, 'Leave Request', 'error'); }
}

// ── REQUESTS PAGE ─────────────────────────────────────────────
async function loadAllRequests() {
  try {
    const [leaveRes, reqRes] = await Promise.all([
      apiFetch('/api/leave'),
      apiFetch('/api/requests')
    ]);
    const leaves  = (leaveRes && leaveRes.ok) ? await leaveRes.json() : [];
    const genReqs = (reqRes   && reqRes.ok)   ? await reqRes.json()   : [];
    renderAllRequests(leaves, genReqs);
  } catch (error) {
    console.error('Error loading requests:', error);
  }
}

function renderAllRequests(leaves, genReqs) {
  const tbody = document.getElementById('req-all-tbody');
  if (!tbody) return;

  // The Request tab is for personal requests only. Always hide the Action column.
  const actionCol = document.getElementById('req-action-col');
  if (actionCol) actionCol.style.display = 'none';

  let myLeaves = leaves;
  let myGenReqs = genReqs;
  
  if (CURRENT_USER) {
    // Filter strictly to the current user's personal requests
    myLeaves = leaves.filter(l => l.employee_id === CURRENT_USER.employeeId);
    myGenReqs = genReqs.filter(r => r.employee_id === CURRENT_USER.employeeId);
  }

  const leaveRows = myLeaves.map(l => ({
    id: l.id, source: 'leave',
    employee: l.employee_name,
    type: 'Leave Request',
    details: `${l.type} · ${new Date(l.date_from).toLocaleDateString()} – ${new Date(l.date_to).toLocaleDateString()} (${l.days || 1}d)`,
    reason: `<button type="button" class="btn btn-outline" onclick="revealLeaveSensitiveDetails(${Number(l.id)})">Show details</button>`,
    date: new Date(l.created_at),
    status: leaveStatusValue(l.status),
  }));

  const genRows = myGenReqs.map(r => ({
    id: r.id, source: 'general',
    employee: r.employee_name,
    type: r.type,
    details: '—',
    reason: r.reason || '-',
    date: new Date(r.created_at),
    status: leaveStatusValue(r.status),
  }));

  const all = [...leaveRows, ...genRows].sort((a, b) => b.date - a.date);

  if (all.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">No personal requests found.</td></tr>';
    return;
  }

  tbody.innerHTML = all.map(r => `
    <tr data-req-id="${r.id}" data-req-source="${r.source}">
      <td>${r.employee}</td>
      <td>${r.type}</td>
      <td style="font-size:12px;color:var(--muted);">${r.details}</td>
      <td>${r.reason}</td>
      <td style="font-size:12px;color:var(--muted);">${r.date.toLocaleDateString()}</td>
      <td><span class="badge badge-${r.status === 'Approved' ? 'green' : r.status === 'Rejected' ? 'red' : 'yellow'}">${r.status}</span></td>
      <td style="display:none"></td>
    </tr>
  `).join('');

  const countEl = document.getElementById('req-count');
  if (countEl) {
    const pending = all.filter(r => r.status === 'Pending').length;
    countEl.textContent = `${pending} pending · ${all.length} total`;
  }
}

async function approveRequest(btn) {
  const row = btn.closest('tr');
  const id = row?.dataset.reqId;
  const source = row?.dataset.reqSource;
  if (!id) { alert('Error: Could not find request'); return; }
  if (!confirm('Approve this request?')) return;
  try {
    const url = source === 'leave' ? `/api/leave/${id}/status` : `/api/requests/${id}/status`;
    const res = await apiFetch(url, { method: 'PATCH', body: JSON.stringify({ status: 'Approved' }) });
    if (!res || !res.ok) throw new Error('Failed to approve');
    alert('Request approved successfully');
    loadAllRequests();
  } catch (err) { alert('Failed to approve: ' + err.message); }
}

async function denyRequest(btn) {
  const row = btn.closest('tr');
  const id = row?.dataset.reqId;
  const source = row?.dataset.reqSource;
  if (!id) { alert('Error: Could not find request'); return; }
  if (!confirm('Deny this request?')) return;
  try {
    const url = source === 'leave' ? `/api/leave/${id}/status` : `/api/requests/${id}/status`;
    const res = await apiFetch(url, { method: 'PATCH', body: JSON.stringify({ status: 'Rejected' }) });
    if (!res || !res.ok) throw new Error('Failed to deny');
    alert('Request denied successfully');
    loadAllRequests();
  } catch (err) { alert('Failed to deny: ' + err.message); }
}

// ── Save request ──────────────────────────────────────────────
async function saveRequest() {
  if (!CURRENT_USER) {
    await fetchCurrentUser();
    if (!CURRENT_USER) { alert('Error: Not authenticated. Please log in again.'); return; }
  }

  // Check if the current user has a linked employee record (required for personal requests)
  if (!CURRENT_USER.employeeId) {
    alert('Your account is not linked to an employee record.\n\nTo file personal requests, ask the system administrator to create your employee profile and link it to your user account.');
    return;
  }

  const selectedEl = document.querySelector('.req-type.selected');
  const type = selectedEl
    ? (selectedEl.getAttribute('data-type') || selectedEl.querySelector('.req-type-title')?.textContent?.trim())
    : 'Leave Request';

  // For Leave Requests, check if employee is eligible based on wage type
  if (type === 'Leave Request') {
    try {
      const empRes = await apiFetch(`/api/employees`);
      if (empRes && empRes.ok) {
        const employees = await empRes.json();
        const currentEmp = employees.find(e => e.id === CURRENT_USER.employeeId);
        if (currentEmp) {
          const wageType = (currentEmp.wage_type || '').toLowerCase();
          // Only Base Salary and Hourly are allowed. Block Per-Piece and Per-Trip
          if (wageType.includes('per-piece') || wageType.includes('per-trip')) {
            alert('You are not authorized to file leave requests.\n\nOnly employees with Base Salary or Hourly wage types can file leave requests. Your wage type is: ' + currentEmp.wage_type);
            return;
          }
        }
      }
    } catch (err) {
      console.error('Error checking employee wage type:', err);
      // Continue anyway if check fails - backend will validate
    }
  }

  const reason = document.getElementById('req-reason')?.value?.trim();
  if (!reason) { alert('Please enter a reason.'); return; }

  if (type === 'Leave Request') {
    if (!LEAVE_TYPES.length) await loadLeaveTypes();
    const leaveSelect = document.getElementById('req-leave-type');
    const selectedType = leaveSelect?.selectedOptions?.[0];
    const leaveTypeId = leaveSelect?.value || '';
    const leaveType = selectedType?.dataset?.name || selectedType?.textContent || '';
    const startDate = document.getElementById('req-start')?.value;
    const endDate   = document.getElementById('req-end')?.value;
    const attachment = document.getElementById('req-attachment')?.files[0];
    
    // Validate start date
    if (!startDate) { alert('❌ Please select a start date.'); return; }
    
    // Validate dates are valid
    const start = new Date(startDate);
    if (isNaN(start.getTime())) { alert('❌ Start date is invalid.'); return; }
    
    if (endDate) {
      const end = new Date(endDate);
      if (isNaN(end.getTime())) { alert('❌ End date is invalid.'); return; }
      if (end < start) { alert('❌ End date must be on or after start date.'); return; }
    }
    
    const days = Math.max(Math.ceil((new Date(endDate || startDate) - new Date(startDate)) / 86400000) + 1, 1);
    
    
    try {
      const payload = { leave_type_id: leaveTypeId, type: leaveType, date_from: startDate, date_to: endDate || startDate, days, reason, employee_id: CURRENT_USER.employeeId };
      
      let res;
      
      if (attachment) {
        const uploadData = new FormData();
        Object.keys(payload).forEach(key => uploadData.append(key, payload[key]));
        uploadData.append('attachment', attachment);
        res = await apiFetch('/api/leave', { method: 'POST', body: uploadData });
      } else {
        res = await apiFetch('/api/leave', { 
          method: 'POST', 
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!res || !res.ok) { 
        console.error('Leave request failed:', res?.status, res?.statusText);
        const eData = await res?.json().catch(() => null);
        const eText = eData ? eData.error : await res?.text().catch(() => 'Unknown error');
        console.error('Error details:', eText);
        throw new Error(eText || 'Failed to submit'); 
      }
      
      const result = await res.json();
      console.log('Leave request success:', result);
      alert('✅ Leave request submitted! Status: Pending approval');
      clearRequestForm();
      loadAllRequests();
    } catch (err) { 
      console.error('Exception in saveRequest:', err);
      alert('❌ Failed to submit leave request:\n\n' + err.message); 
    }
  } else {
    try {
      const res = await apiFetch('/api/requests', {
        method: 'POST',
        body: JSON.stringify({ type, reason, employee_id: CURRENT_USER.employeeId })
      });
      if (!res || !res.ok) { const e = await res?.text(); throw new Error(e || 'Failed'); }
      alert(`${type} request submitted! Status: Pending approval`);
      clearRequestForm();
      loadAllRequests();
    } catch (err) { alert('Failed to submit request: ' + err.message); }
  }
}

function clearRequestForm() {
  ['req-start', 'req-end', 'req-reason', 'req-attachment'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.querySelectorAll('.req-type').forEach((el, i) => el.classList.toggle('selected', i === 0));
  const leaveFields = document.getElementById('req-leave-fields');
  if (leaveFields) leaveFields.style.display = 'grid';
}

// ───────────────────────────────────────────────────────────────
// ── MANUAL LEAVE ENCODING (HR Admin) ──────────────────────────
// ───────────────────────────────────────────────────────────────

let EMPLOYEES_LIST = [];

// Load employees and populate dropdown
async function loadEmployeesForDropdown() {
  try {
    console.log('Fetching employees for dropdown...');
    const response = await apiFetch('/api/employees');
    
    if (!response) {
      console.error('No response from /api/employees');
      return;
    }
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Error ${response.status}:`, errorText);
      return;
    }
    
    let employees = await response.json();
    console.log('Employees loaded:', employees);
    
    // Sort by ID to ensure sequential order (1, 2, 3, 4, 5)
    employees = employees.sort((a, b) => a.id - b.id);
    
    EMPLOYEES_LIST = employees;

    // Populate the dropdown
    const select = document.getElementById('manual-employee');
    if (select) {
      select.innerHTML = '<option value="">-- Select Employee --</option>';
      if (employees.length === 0) {
        const option = document.createElement('option');
        option.disabled = true;
        option.textContent = 'No employees found';
        select.appendChild(option);
      } else {
        employees.forEach(emp => {
          const option = document.createElement('option');
          option.value = emp.id;
          option.textContent = `${emp.first_name} ${emp.last_name} (${emp.employee_code})`;
          select.appendChild(option);
        });
      }
    }
  } catch (error) {
    console.error('Error loading employees:', error);
    const select = document.getElementById('manual-employee');
    if (select) {
      select.innerHTML = '<option value="">-- Error loading employees --</option>';
    }
  }
}

function toggleLeaveForm() {
  const manualForm = document.getElementById('manual-leave-form');
  if (manualForm) manualForm.style.display = 'block';
  return;
  const container = document.getElementById('leave-form-container');
  const btn = document.getElementById('toggle-form-btn');
  if (container && btn) {
    const wasHidden = container.style.display === 'none';
    
    // Toggle display
    container.style.display = wasHidden ? 'block' : 'none';
    btn.textContent = wasHidden ? '🔽 Collapse Form' : '+ Expand Form';
    
    // Load employees when form is expanded (wasHidden was true)
    if (wasHidden && EMPLOYEES_LIST.length === 0) {
      console.log('Form expanded, loading employees...');
      loadEmployeesForDropdown();
    }
  }
}

async function submitManualLeave(event) {
  event.preventDefault();

  if (!CURRENT_USER) {
    await fetchCurrentUser();
    if (!CURRENT_USER) { alert('Error: Not authenticated.'); return; }
  }

  if (!isLeaveManager()) {
    alert('Error: You do not have permission to manually encode leaves.');
    return;
  }

  const form = document.getElementById('manual-leave-form');
  const formData = new FormData(form);

  const employeeId = document.getElementById('manual-employee').value;
  const leaveType = document.getElementById('manual-leave-type').value;
  const startDate = document.getElementById('manual-start-date').value;
  const endDate = document.getElementById('manual-end-date').value;
  const reason = document.getElementById('manual-reason').value.trim();
  const attachment = document.getElementById('manual-attachment').files[0];

  // Validation
  if (!employeeId || !leaveType || !startDate || !endDate) {
    alert('Please fill in all required fields.');
    return;
  }

  if (new Date(endDate) < new Date(startDate)) {
    alert('End date cannot be before start date.');
    return;
  }

  // Check for policy violations
  const daysBetween = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
  const daysUntilLeave = Math.ceil((new Date(startDate) - new Date()) / 86400000);

  const warningEl = document.getElementById('policy-warning');
  const warningTextEl = document.getElementById('warning-text');
  let hasWarning = false;

  if (leaveType === 'Vacation' && daysUntilLeave < 2) {
    warningTextEl.textContent = `Vacation Leave filed less than 2 days in advance. Filed on ${new Date().toLocaleDateString()} for ${new Date(startDate).toLocaleDateString()}.`;
    warningEl.style.display = 'block';
    hasWarning = true;
  } else if (leaveType === 'Sick' && !reason) {
    warningTextEl.textContent = 'Sick Leave without reason noted. Consider adding reason or medical documentation.';
    warningEl.style.display = 'block';
    hasWarning = true;
  } else {
    warningEl.style.display = 'none';
  }

  // Prepare payload
  const payload = {
    employee_id: parseInt(employeeId),
    type: leaveType,
    date_from: startDate,
    date_to: endDate,
    days: daysBetween,
    reason: reason || null,
    status: 'Approved',
    encoded_by: CURRENT_USER.id,
    encoded_at: new Date().toISOString(),
  };

  console.log('File attached:', attachment?.name);

  try {
    let res;
    
    // If there's an attachment, send as FormData
    if (attachment) {
      const uploadData = new FormData();
      // Add all fields to FormData
      Object.keys(payload).forEach(key => {
        uploadData.append(key, payload[key]);
      });
      uploadData.append('attachment', attachment);

      console.log('Sending with FormData (includes file)');
      res = await apiFetch('/api/leave', {
        method: 'POST',
        body: uploadData,
        // Don't manually set Content-Type - browser will set it with boundary
      });
    } else {
      // No file, send as JSON
      console.log('Sending as JSON (no file)');
      res = await apiFetch('/api/leave', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!res || !res.ok) {
      const errorData = await res?.json();
      throw new Error(errorData?.error || 'Failed to encode leave');
    }

    const result = await res.json();
    alert(`✅ Leave successfully encoded for employee.\n\nLeave ID: ${result.id}\nType: ${leaveType}\nDuration: ${daysBetween} day(s)\nStatus: Approved`);
    clearLeaveForm();
    loadLeaveRequests(); // Refresh table
  } catch (err) {
    alert(`❌ Error encoding leave: ${err.message}`);
    console.error('Leave encoding error:', err);
  }
}

function clearLeaveForm() {
  const form = document.getElementById('manual-leave-form');
  if (form) form.reset();
  document.getElementById('policy-warning').style.display = 'none';
}

function calculateDaysBetweenDates(startDate, endDate) {
  if (!startDate || !endDate) return 1;
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.ceil((end - start) / 86400000) + 1;
}

// ─────────────────────────────────────────────────────────────
// ── GENERAL REQUESTS MANAGEMENT (COE, COS, Request Exit) ─────
// ─────────────────────────────────────────────────────────────

let ALL_GEN_REQUESTS = [];
let CURRENT_GEN_TAB = 'pending';

async function loadGeneralRequests() {
  try {
    const res = await apiFetch('/api/requests');
    if (!res || !res.ok) { console.error('Failed to fetch general requests'); return; }
    const requests = await res.json();
    ALL_GEN_REQUESTS = requests.map(r => ({
      ...r,
      parsedDate: new Date(r.created_at)
    })).sort((a, b) => b.parsedDate - a.parsedDate);

    // Show the card for admin users
    const isAdmin = isLeaveManager();
    const card = document.getElementById('general-requests-card');
    if (card) card.style.display = isAdmin ? 'block' : 'none';

    renderGenTable();
  } catch (err) {
    console.error('Error loading general requests:', err);
  }
}

window.switchGenTab = function(tab) {
  CURRENT_GEN_TAB = tab;
  const btnPending = document.getElementById('gen-tab-pending');
  const btnHistory = document.getElementById('gen-tab-history');
  if (btnPending && btnHistory) {
    if (tab === 'pending') {
      btnPending.style.background = 'var(--bg)';
      btnPending.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
      btnPending.style.color = 'var(--text)';
      btnHistory.style.background = 'transparent';
      btnHistory.style.boxShadow = 'none';
      btnHistory.style.color = 'var(--muted)';
    } else {
      btnHistory.style.background = 'var(--bg)';
      btnHistory.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
      btnHistory.style.color = 'var(--text)';
      btnPending.style.background = 'transparent';
      btnPending.style.boxShadow = 'none';
      btnPending.style.color = 'var(--muted)';
    }
  }
  renderGenTable();
};

function renderGenTable() {
  const tbody = document.getElementById('gen-tbody');
  const emptyState = document.getElementById('gen-empty-state');
  const colHead = document.getElementById('gen-dynamic-col');
  if (!tbody) return;

  const canApprove = isLeaveApprover();
  let filtered = ALL_GEN_REQUESTS;

  if (CURRENT_GEN_TAB === 'pending') {
    filtered = filtered.filter(r => r.status === 'Pending');
    if (colHead) { colHead.textContent = canApprove ? 'Actions' : 'Status'; colHead.style.textAlign = canApprove ? 'right' : 'left'; }
  } else {
    filtered = filtered.filter(r => r.status !== 'Pending');
    if (colHead) { colHead.textContent = 'Status'; colHead.style.textAlign = 'left'; }
  }

  // Update pending count badge
  const pendingCount = ALL_GEN_REQUESTS.filter(r => r.status === 'Pending').length;
  const countBadge = document.getElementById('gen-pending-count');
  if (countBadge) {
    countBadge.textContent = pendingCount > 0 ? pendingCount : '';
    countBadge.style.display = pendingCount > 0 ? 'inline' : 'none';
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    if (CURRENT_GEN_TAB === 'history') {
      emptyState.innerHTML = `<div style="font-size:32px;margin-bottom:12px;">📂</div><h3 style="margin:0;font-size:16px;font-weight:600;color:var(--text);">No history records</h3><div style="font-size:13px;color:var(--muted);margin-top:4px;">No processed general requests yet.</div>`;
    } else {
      emptyState.innerHTML = `<div style="font-size:48px;margin-bottom:16px;">🎉</div><h3 style="margin:0;font-size:18px;font-weight:600;color:var(--text);">All caught up!</h3><div style="font-size:14px;color:var(--muted);margin-top:8px;">No pending general requests require your attention.</div>`;
    }
    document.getElementById('gen-page-info').textContent = 'Showing 0 results';
    return;
  } else {
    emptyState.style.display = 'none';
  }

  document.getElementById('gen-page-info').textContent = `Showing ${filtered.length} result${filtered.length !== 1 ? 's' : ''}`;

  // Type icon mapping
  const typeIcons = { 'COE': '📄', 'COS': '📋', 'Request Exit': '🚪' };

  tbody.innerHTML = filtered.map(req => `
    <tr data-gen-id="${req.id}" style="border-bottom:1px solid rgba(0,0,0,0.05);">
      <td style="padding:16px 24px;">
        <div style="font-weight:600;color:var(--text);">${req.employee_name}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">Submitted ${req.parsedDate.toLocaleDateString()}</div>
      </td>
      <td style="padding:16px 24px;">
        <span style="display:inline-flex;align-items:center;gap:6px;font-weight:500;">
          ${typeIcons[req.type] || '📝'} ${req.type}
        </span>
      </td>
      <td style="padding:16px 24px;font-size:13px;color:var(--muted);max-width:250px;">
        <span style="text-overflow:ellipsis;overflow:hidden;white-space:nowrap;display:block;" title="${req.reason || '-'}">${req.reason || '-'}</span>
      </td>
      <td style="padding:16px 24px;font-size:13px;color:var(--muted);">${req.parsedDate.toLocaleDateString()}</td>
      <td style="padding:16px 24px;text-align:${(CURRENT_GEN_TAB === 'pending' && canApprove) ? 'right' : 'left'};">
        ${CURRENT_GEN_TAB === 'pending' ? (canApprove ? `
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn" style="background:var(--green);color:white;border:none;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;" onclick="approveGenRequest(this)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Approve
            </button>
            <button class="btn btn-outline" style="color:var(--red);border-color:rgba(244,67,54,0.3);padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;" onclick="denyGenRequest(this)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Reject
            </button>
          </div>
        ` : `<span class="badge badge-yellow" style="padding:4px 8px;border-radius:20px;">Pending</span>`) : `
          <span class="badge badge-${req.status === 'Approved' ? 'green' : 'red'}" style="padding:4px 8px;border-radius:20px;font-weight:600;">${req.status}</span>
        `}
      </td>
    </tr>
  `).join('');
}

async function approveGenRequest(btn) {
  const row = btn.closest('tr');
  const id = row?.dataset.genId;
  if (!id) { alert('Error: Could not find request'); return; }
  if (!confirm('Approve this request?')) return;
  try {
    const res = await apiFetch(`/api/requests/${id}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'Approved' })
    });
    if (!res || !res.ok) throw new Error('Failed to approve');
    alert('Request approved successfully.');
    loadGeneralRequests();
  } catch (err) { alert('Failed to approve: ' + err.message); }
}

async function denyGenRequest(btn) {
  const row = btn.closest('tr');
  const id = row?.dataset.genId;
  if (!id) { alert('Error: Could not find request'); return; }
  if (!confirm('Deny this request?')) return;
  try {
    const res = await apiFetch(`/api/requests/${id}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'Rejected' })
    });
    if (!res || !res.ok) throw new Error('Failed to deny');
    alert('Request denied.');
    loadGeneralRequests();
  } catch (err) { alert('Failed to deny: ' + err.message); }
}

// Enhanced Leave Management module
let LEAVE_EMPLOYEES = [];
let LEAVE_AUDIT = [];
let LEAVE_BALANCES = [];

function leaveStatusValue(status) {
  return status === 'Denied' ? 'Rejected' : (status || 'Pending');
}

function leavePayType(wageType) {
  const value = String(wageType || '').toLowerCase();
  if (value.includes('hour')) return 'Per Hour';
  if (value.includes('trip')) return 'Per Trip';
  if (value.includes('piece')) return 'Per Piece';
  return 'Per Day';
}

function leaveBadge(value, kind = '') {
  return `<span class="leave-badge ${(kind || value || '').toLowerCase()}">${value || '-'}</span>`;
}

function leaveEmployeeLabel(emp) {
  const name = [emp.first_name, emp.middle_name, emp.last_name, emp.suffix]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${emp.employee_code || emp.id} - ${name || emp.employee_name || 'Employee'}`;
}

function leaveEmployeeMatchesFilter(emp, filterText) {
  const needle = String(filterText || '').trim().toLowerCase();
  if (!needle) return true;
  return [
    emp.employee_code,
    emp.first_name,
    emp.middle_name,
    emp.last_name,
    emp.suffix,
    emp.employee_name,
    emp.department,
  ].filter(Boolean).join(' ').toLowerCase().includes(needle);
}

function leaveEmployeeOptions(employees, placeholder = 'Select employee') {
  return `<option value="">${placeholder}</option>` + employees
    .map(emp => `<option value="${emp.id}">${leaveEmployeeLabel(emp)}</option>`)
    .join('');
}

const EMPLOYEE_LEAVE_TABS = new Set(['overview', 'requests', 'balances']);

async function loadLeaveRequests() {
  try {
    await fetchCurrentUser();
    const [leaveRes, empRes, typeRes, auditRes] = await Promise.all([
      apiFetch('/api/leave'),
      isLeaveManager() ? apiFetch('/api/employees') : Promise.resolve(null),
      apiFetch(`/api/leave/types${isLeaveManager() ? '?include_inactive=1' : ''}`),
      isLeaveManager() ? apiFetch('/api/leave/audit') : Promise.resolve(null)
    ]);

    ALL_LEAVES_DATA = leaveRes && leaveRes.ok ? await leaveRes.json() : [];
    LEAVE_EMPLOYEES = empRes && empRes.ok ? await empRes.json() : [];
    LEAVE_TYPES = typeRes && typeRes.ok ? await typeRes.json() : [];
    LEAVE_AUDIT = auditRes && auditRes.ok ? await auditRes.json() : [];

    ALL_LEAVES_DATA = ALL_LEAVES_DATA.map(row => ({
      ...row,
      status: leaveStatusValue(row.status),
      filing_source: row.filing_source || 'Portal',
      pay_type: row.pay_type || leavePayType(row.wage_type),
      parsedDate: new Date(row.created_at || row.date_from)
    }));

    setupLeaveUi();
    populateLeaveTypeSelects();
    renderLeaveSummary();
    renderLeaveTable();
    window.renderLeaveCalendar();
    renderLeaveAudit();
    renderLeaveTypes();
    loadLeaveBalancesForSelection();
    initializeLeaveBalancePreviews();
    renderLeaveBalanceConfigTable();
  } catch (error) {
    console.error('Error loading leave management:', error);
  }
}

function setupLeaveUi() {
  document.getElementById('page-leave')?.classList.toggle('leave-employee-mode', isLeaveEmployee());

  document.querySelectorAll('#page-leave .page-header-right .btn').forEach(button => {
    button.style.display = isLeaveManager() ? '' : 'none';
  });

  document.querySelectorAll('[data-leave-tab]').forEach(tab => {
    const visible = isLeaveManager() || EMPLOYEE_LEAVE_TABS.has(tab.dataset.leaveTab);
    tab.style.display = visible ? '' : 'none';
  });
  const activeTab = document.querySelector('[data-leave-tab].active')?.dataset.leaveTab;
  if (isLeaveEmployee() && !EMPLOYEE_LEAVE_TABS.has(activeTab)) {
    switchLeaveModuleTab('overview');
  }

  const manualCard = document.getElementById('manual-encoding-card');
  if (manualCard) manualCard.style.display = isLeaveManager() ? 'block' : 'none';

  const employeeSelect = document.getElementById('manual-employee');
  if (employeeSelect) {
    employeeSelect.innerHTML = leaveEmployeeOptions(LEAVE_EMPLOYEES);
  }

  const balanceCard = document.getElementById('leave-balance-config-card');
  if (balanceCard) balanceCard.style.display = isLeaveManager() ? 'block' : 'none';
  const balanceEmployee = document.getElementById('balance-employee');
  if (balanceEmployee) {
    const current = balanceEmployee.value;
    balanceEmployee.innerHTML = leaveEmployeeOptions(LEAVE_EMPLOYEES);
    balanceEmployee.value = current;
  }
  const balanceYear = document.getElementById('balance-year');
  if (balanceYear && !balanceYear.value) balanceYear.value = new Date().getFullYear();

  const balanceViewerField = document.getElementById('leave-balance-viewer-field');
  const balanceViewerEmployee = document.getElementById('leave-balance-viewer-employee');
  if (balanceViewerField && balanceViewerEmployee) {
    balanceViewerField.style.display = isLeaveManager() ? 'block' : 'none';
    renderLeaveBalanceViewerEmployeeOptions(balanceViewerEmployee.value);
  }

  const departments = [...new Set(LEAVE_EMPLOYEES.map(emp => emp.department).filter(Boolean))].sort();
  ['leave-filter-dept', 'calendar-dept-filter'].forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">All Departments</option>' + departments.map(dept => `<option>${dept}</option>`).join('');
    select.value = current;
  });
}

function renderLeaveBalanceViewerEmployeeOptions(preferredValue = '') {
  const select = document.getElementById('leave-balance-viewer-employee');
  if (!select) return;
  const filterText = document.getElementById('leave-balance-viewer-filter')?.value || '';
  const filteredEmployees = LEAVE_EMPLOYEES.filter(emp => leaveEmployeeMatchesFilter(emp, filterText));
  const current = preferredValue || select.value;
  select.innerHTML = leaveEmployeeOptions(filteredEmployees, 'Select employee');
  if ([...select.options].some(option => option.value === current)) {
    select.value = current;
  }
}

function filterLeaveBalanceViewerEmployees() {
  renderLeaveBalanceViewerEmployeeOptions();
}

function formatLeaveDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeLeaveText(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function renderLeaveSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

  set('sum-pending', ALL_LEAVES_DATA.filter(l => l.status === 'Pending').length);
  set('sum-approved', ALL_LEAVES_DATA.filter(l => l.status === 'Approved').length);
  set('sum-rejected', ALL_LEAVES_DATA.filter(l => l.status === 'Rejected').length);
  set('sum-today', new Set(ALL_LEAVES_DATA.filter(l => l.status === 'Approved' && l.date_from <= today && l.date_to >= today).map(l => l.employee_id)).size);
  set('sum-month', ALL_LEAVES_DATA.filter(l => String(l.created_at || '').startsWith(monthPrefix)).length);
}

function getFilteredLeaves() {
  const search = (document.getElementById('leave-filter-search')?.value || '').toLowerCase();
  const dept = document.getElementById('leave-filter-dept')?.value || '';
  const payType = document.getElementById('leave-filter-pay-type')?.value || '';
  const type = document.getElementById('leave-filter-type')?.value || '';
  const status = document.getElementById('leave-filter-status')?.value || '';
  const source = document.getElementById('leave-filter-source')?.value || '';
  const from = document.getElementById('leave-filter-from')?.value || '';
  const to = document.getElementById('leave-filter-to')?.value || '';

  return ALL_LEAVES_DATA.filter(leave => {
    const name = String(leave.employee_name || '').toLowerCase();
    return (!search || name.includes(search))
      && (!dept || leave.department === dept)
      && (!payType || leave.pay_type === payType)
      && (!type || leave.type === type)
      && (!status || leave.status === status)
      && (!source || leave.filing_source === source)
      && (!from || leave.date_from >= from)
      && (!to || leave.date_to <= to);
  });
}

window.renderLeaveTable = function() {
  const tbody = document.getElementById('leave-tbody');
  const empty = document.getElementById('leave-empty-state');
  const mobileList = document.getElementById('leave-mobile-request-list');
  if (!tbody) return;

  const filtered = getFilteredLeaves();
  const totalItems = filtered.length;
  const maxPage = Math.max(Math.ceil(totalItems / LEAVE_PAGE_SIZE), 1);
  LEAVE_PAGE = Math.min(Math.max(LEAVE_PAGE, 1), maxPage);
  const startIndex = (LEAVE_PAGE - 1) * LEAVE_PAGE_SIZE;
  const pageData = filtered.slice(startIndex, startIndex + LEAVE_PAGE_SIZE);

  const info = document.getElementById('leave-page-info');
  if (info) info.textContent = totalItems ? `Showing ${startIndex + 1}-${startIndex + pageData.length} of ${totalItems} results` : 'Showing 0 results';
  if (empty) empty.style.display = totalItems ? 'none' : 'block';

  tbody.innerHTML = pageData.map(leave => `
    <tr data-leave-id="${leave.id}">
      <td><strong>${leave.employee_name || '-'}</strong><div style="color:var(--muted);font-size:11px;">${leave.created_at ? new Date(leave.created_at).toLocaleString() : ''}</div></td>
      <td>${leave.department || '-'}</td>
      <td>${leave.pay_type || '-'}</td>
      <td>${leave.type || '-'}</td>
      <td>${formatLeaveDate(leave.date_from)} to ${formatLeaveDate(leave.date_to)}<div style="color:var(--muted);font-size:11px;">${leave.days || 1} day(s)</div></td>
      <td>${leaveBadge(leave.filing_source, leave.filing_source)}</td>
      <td>${leaveBadge(leave.status, leave.status)}</td>
      <td><div class="leave-actions">
        <button class="btn btn-outline" onclick="viewLeaveDetails(${leave.id})">View</button>
        ${isLeaveApprover() && leave.status === 'Pending' ? `<button class="btn btn-primary" onclick="approveLeaveById(${leave.id})">Approve</button><button class="btn btn-outline" onclick="rejectLeaveById(${leave.id})">Reject</button>` : ''}
      </div></td>
    </tr>
  `).join('');
  if (mobileList) {
    mobileList.innerHTML = pageData.length ? pageData.map(leave => `
      <article class="leave-mobile-request">
        <div class="leave-mobile-request-head">
          <span>${escapeLeaveText(leave.type || 'Leave Request')}</span>
          ${leaveBadge(leave.status, leave.status)}
        </div>
        <div class="leave-mobile-request-dates">${formatLeaveDate(leave.date_from)} - ${formatLeaveDate(leave.date_to)}</div>
        <div class="leave-mobile-request-meta">
          <span>${leave.days || 1} day(s)</span>
          <span>Filed ${formatLeaveDate(leave.created_at)}</span>
        </div>
      </article>
    `).join('') : '<div class="leave-mobile-empty">No leave records found.</div>';
  }
};

async function approveLeaveById(id) {
  if (!(await leaveConfirm('Approve this leave request?', 'Approve Leave Request', 'Approve', 'Cancel'))) return;
  const res = await apiFetch(`/api/leave/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Approved', remarks: 'Approved' })
  });
  if (!res || !res.ok) {
    const error = await res?.json().catch(() => ({}));
    return leaveNotice(error.error || 'Failed to approve leave.', 'Leave Request', 'error');
  }
  await loadLeaveRequests();
}

async function rejectLeaveById(id) {
  const confirmed = await leaveConfirm('Reject this leave request?', 'Reject Leave Request', 'Reject', 'Cancel');
  if (!confirmed) return;
  const remarks = await leaveRemarksPrompt();
  if (!remarks) return;
  const res = await apiFetch(`/api/leave/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Rejected', remarks })
  });
  if (!res || !res.ok) {
    const error = await res?.json().catch(() => ({}));
    return leaveNotice(error.error || 'Failed to reject leave.', 'Leave Request', 'error');
  }
  await loadLeaveRequests();
}

function viewLeaveDetails(id) {
  const leave = ALL_LEAVES_DATA.find(item => Number(item.id) === Number(id));
  const modal = document.getElementById('leave-detail-modal');
  const body = document.getElementById('leave-detail-body');
  if (!leave || !modal || !body) return;
  const total = Number(leave.balance_total_days || 0);
  const used = Number(leave.balance_used_days || 0);
  const remaining = Number(leave.balance_remaining_days || 0);
  const requested = Number(leave.days || 1);
  const afterApproval = remaining - requested;
  body.innerHTML = `
    <div class="leave-grid" style="grid-template-columns:1fr 1fr;">
      <div><strong>Employee</strong><br>${leave.employee_name || '-'}</div>
      <div><strong>Department</strong><br>${leave.department || '-'}</div>
      <div><strong>Pay Type</strong><br>${leave.pay_type || '-'}</div>
      <div><strong>Leave Type</strong><br>${leave.type || '-'}</div>
      <div><strong>Dates</strong><br>${leave.date_from} to ${leave.date_to}</div>
      <div><strong>Duration</strong><br>${leave.days || 1} day(s)</div>
      <div><strong>Source</strong><br>${leave.filing_source || 'Portal'}</div>
      <div><strong>Status</strong><br>${leave.status}</div>
      <div><strong>Sensitive details</strong><br><button type="button" class="btn btn-outline" onclick="revealLeaveSensitiveDetails(${Number(leave.id)})">Show details</button></div>
      ${leave.attachment_available ? `<div><button type="button" class="btn btn-outline" onclick="downloadLeaveAttachment(${Number(leave.id)})">Download attachment</button></div>` : ''}
    </div>
    <div style="margin-top:14px;">
      <strong>Leave Balance Before Approval</strong>
      <div class="leave-table-wrap" style="margin-top:8px;">
        <table class="leave-table" style="min-width:520px;">
          <tbody>
            <tr><th>Total Days</th><td>${total.toFixed(1)}</td><th>Used Days</th><td>${used.toFixed(1)}</td></tr>
            <tr><th>Remaining Days</th><td>${remaining.toFixed(1)}</td><th>Requested Days</th><td>${requested.toFixed(1)}</td></tr>
            <tr><th>Balance After Approval</th><td colspan="3" style="color:${afterApproval < 0 ? 'var(--red)' : 'var(--green)'};">${afterApproval.toFixed(1)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;
  modal.style.display = 'flex';
}

function closeLeaveDetails() {
  const modal = document.getElementById('leave-detail-modal');
  if (modal) modal.style.display = 'none';
}

function toggleLeaveForm() {
  const form = document.getElementById('manual-leave-form');
  const btn = document.getElementById('toggle-form-btn');
  if (!form) return;
  form.style.display = 'block';
  return;
  const open = form.style.display !== 'none';
  form.style.display = open ? 'none' : 'block';
  if (btn) btn.textContent = open ? 'Expand Form' : 'Collapse Form';
}

function syncManualEmployeeInfo() {
  const emp = LEAVE_EMPLOYEES.find(item => String(item.id) === document.getElementById('manual-employee')?.value);
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
  set('manual-pay-type', emp ? leavePayType(emp.wage_type) : '');
  set('manual-department', emp?.department || '');
  if (emp) loadLeaveBalancesForSelection(emp.id);
}

function calculateManualDuration() {
  const from = document.getElementById('manual-start-date')?.value;
  const to = document.getElementById('manual-end-date')?.value;
  const duration = document.getElementById('manual-duration');
  if (!from || !to || !duration) return;
  duration.value = Math.max(Math.floor((new Date(to) - new Date(from)) / 86400000) + 1, 1);
  updateManualBalancePreview();
}

async function submitManualLeave(event) {
  event.preventDefault();
  const leaveSelect = document.getElementById('manual-leave-type');
  const selectedType = leaveSelect?.selectedOptions?.[0];
  const formData = new FormData();
  formData.append('filing_source', 'Manual');
  formData.append('employee_id', document.getElementById('manual-employee').value);
  formData.append('leave_type_id', leaveSelect?.value || '');
  formData.append('type', selectedType?.dataset?.name || selectedType?.textContent || '');
  formData.append('date_from', document.getElementById('manual-start-date').value);
  formData.append('date_to', document.getElementById('manual-end-date').value);
  formData.append('days', document.getElementById('manual-duration').value);
  formData.append('reason', document.getElementById('manual-reason').value);
  formData.append('remarks', document.getElementById('manual-remarks').value);
  const file = document.getElementById('manual-attachment')?.files?.[0];
  if (file) formData.append('attachment', file);
  const res = await apiFetch('/api/leave', { method: 'POST', body: formData });
  if (!res || !res.ok) {
    const error = await res.json().catch(() => ({}));
    return alert(error.error || 'Failed to save manual leave.');
  }
  clearLeaveForm();
  await loadLeaveRequests();
}

function clearLeaveForm() {
  const form = document.getElementById('manual-leave-form');
  if (form) form.reset();
  ['manual-pay-type', 'manual-department'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

async function loadLeaveBalancesForSelection(employeeId = null) {
  const id = employeeId || document.getElementById('leave-balance-viewer-employee')?.value || document.getElementById('manual-employee')?.value || CURRENT_USER?.employeeId;
  const list = document.getElementById('leave-balances-list');
  if (!id) {
    if (list) list.innerHTML = '<div style="color:var(--muted);font-size:13px;">Select an employee to view configured leave balances.</div>';
    return;
  }
  const res = await apiFetch(`/api/leave/balances?employee_id=${id}`);
  if (!res || !res.ok) return;
  const balances = await res.json();
  LEAVE_BALANCES = balances;
  if (list) {
    list.innerHTML = balances.map(row => `
      <div>
        <div class="leave-card-label">${row.leave_type}</div>
        <div class="leave-card-value">${Number(row.remaining_days ?? row.remaining ?? 0).toFixed(1)} / ${Number(row.total_days ?? row.balance ?? 0).toFixed(1)}</div>
        <div style="color:var(--muted);font-size:11px;">${row.category || 'Company'} · used ${Number(row.used || 0).toFixed(1)}</div>
      </div>
    `).join('') || '<div style="color:var(--muted);font-size:13px;">No leave balances configured yet. Open the Leave Types tab and use Employee Leave Balance Setup.</div>';
  }
  renderLeaveBalanceConfigTable();
}

function renderLeaveBalanceConfigTable() {
  const tbody = document.getElementById('leave-balance-config-tbody');
  if (!tbody) return;
  tbody.innerHTML = LEAVE_BALANCES.map(row => `
    <tr>
      <td><strong>${row.leave_type || '-'}</strong><div style="color:var(--muted);font-size:11px;">${row.category || 'Company'}</div></td>
      <td>${row.year || '-'}</td>
      <td>${Number(row.total_days ?? row.balance ?? 0).toFixed(1)}</td>
      <td>${Number(row.used_days ?? row.used ?? 0).toFixed(1)}</td>
      <td>${Number(row.remaining_days ?? row.remaining ?? 0).toFixed(1)}</td>
      <td>${row.last_updated_by_name || '-'}</td>
      <td><button class="btn btn-outline" type="button" onclick="editLeaveBalanceConfig(${row.id})">Edit</button></td>
    </tr>
  `).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);">No configured balances for this employee/year.</td></tr>';
}

function selectedLeaveBalance(employeeId, leaveTypeId) {
  return LEAVE_BALANCES.find(row =>
    String(row.employee_id) === String(employeeId) &&
    String(row.leave_type_id) === String(leaveTypeId)
  );
}

function updateBalanceRemainingPreview() {
  const total = Number(document.getElementById('balance-total-days')?.value || 0);
  const used = Number(document.getElementById('balance-used-days')?.value || 0);
  const remaining = document.getElementById('balance-remaining-days');
  if (remaining) remaining.value = Number.isFinite(total - used) ? Math.max(total - used, 0).toFixed(1) : '';
}

async function loadBalanceConfigForEmployee() {
  const employeeId = document.getElementById('balance-employee')?.value;
  const year = document.getElementById('balance-year')?.value || new Date().getFullYear();
  if (!employeeId) {
    LEAVE_BALANCES = [];
    renderLeaveBalanceConfigTable();
    return;
  }
  const res = await apiFetch(`/api/leave/balances?employee_id=${employeeId}&year=${year}`);
  LEAVE_BALANCES = res && res.ok ? await res.json() : [];
  renderLeaveBalanceConfigTable();
  fillBalanceFormFromSelection();
}

function fillBalanceFormFromSelection() {
  const employeeId = document.getElementById('balance-employee')?.value;
  const leaveTypeId = document.getElementById('balance-leave-type')?.value;
  const row = selectedLeaveBalance(employeeId, leaveTypeId);
  const total = document.getElementById('balance-total-days');
  const used = document.getElementById('balance-used-days');
  if (row) {
    if (total) total.value = Number(row.total_days ?? row.balance ?? 0).toFixed(1);
    if (used) used.value = Number(row.used_days ?? row.used ?? 0).toFixed(1);
  }
  updateBalanceRemainingPreview();
}

function editLeaveBalanceConfig(id) {
  const row = LEAVE_BALANCES.find(item => Number(item.id) === Number(id));
  if (!row) return;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
  set('balance-employee', row.employee_id);
  set('balance-leave-type', row.leave_type_id);
  set('balance-year', row.year);
  set('balance-total-days', Number(row.total_days ?? row.balance ?? 0).toFixed(1));
  set('balance-used-days', Number(row.used_days ?? row.used ?? 0).toFixed(1));
  updateBalanceRemainingPreview();
}

function resetLeaveBalanceForm() {
  ['balance-leave-type', 'balance-total-days', 'balance-used-days', 'balance-remaining-days'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'balance-used-days' ? '0' : '';
  });
  const status = document.getElementById('leave-balance-save-status');
  if (status) status.textContent = '';
}

async function saveLeaveBalanceConfig(event) {
  event.preventDefault();
  const payload = {
    employee_id: document.getElementById('balance-employee')?.value,
    leave_type_id: document.getElementById('balance-leave-type')?.value,
    year: document.getElementById('balance-year')?.value,
    total_days: document.getElementById('balance-total-days')?.value,
    used_days: document.getElementById('balance-used-days')?.value || 0
  };
  const status = document.getElementById('leave-balance-save-status');
  if (status) status.textContent = 'Saving...';
  const res = await apiFetch('/api/leave/balances', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res || !res.ok) {
    const error = await res?.json().catch(() => ({}));
    if (status) status.textContent = error.error || 'Save failed.';
    return;
  }
  if (status) status.textContent = 'Saved.';
  await loadBalanceConfigForEmployee();
  await loadLeaveBalancesForSelection(payload.employee_id);
}

function requestedLeaveDays(prefix = 'req') {
  const startId = prefix === 'manual' ? 'manual-start-date' : 'req-start';
  const endId = prefix === 'manual' ? 'manual-end-date' : 'req-end';
  const manualDuration = document.getElementById('manual-duration')?.value;
  if (prefix === 'manual' && manualDuration) return Number(manualDuration) || 0;
  const start = document.getElementById(startId)?.value;
  const end = document.getElementById(endId)?.value || start;
  if (!start || !end) return 0;
  return Math.max(Math.ceil((new Date(end) - new Date(start)) / 86400000) + 1, 1);
}

function renderBalancePreview(targetId, balance, requestedDays, label = 'Balance After Request', options = {}) {
  const target = document.getElementById(targetId);
  if (!target) return;
  if (!balance) {
    const isManual = options.mode === 'manual';
    target.innerHTML = `<div style="color:${isManual ? 'var(--muted)' : 'var(--red)'};font-size:12px;">
      ${isManual
        ? 'No leave balance configured for this leave type/year. Manual records can be saved, but approval will require a configured balance.'
        : 'No leave balance configured for this leave type/year.'}
    </div>`;
    return;
  }
  const total = Number(balance.total_days ?? balance.balance ?? 0);
  const used = Number(balance.used_days ?? balance.used ?? 0);
  const remaining = Number(balance.remaining_days ?? balance.remaining ?? 0);
  const after = remaining - Number(requestedDays || 0);
  target.innerHTML = `
    <div class="leave-table-wrap" style="margin-top:10px;">
      <table class="leave-table" style="min-width:520px;">
        <tbody>
          <tr><th>Total Days</th><td>${total.toFixed(1)}</td><th>Used Days</th><td>${used.toFixed(1)}</td></tr>
          <tr><th>Remaining Days</th><td>${remaining.toFixed(1)}</td><th>Requested Days</th><td>${Number(requestedDays || 0).toFixed(1)}</td></tr>
          <tr><th>${label}</th><td colspan="3" style="color:${after < 0 ? 'var(--red)' : 'var(--green)'};">${after.toFixed(1)}</td></tr>
        </tbody>
      </table>
    </div>`;
}

async function loadEmployeeLeaveBalances(employeeId, year = new Date().getFullYear()) {
  if (!employeeId) return [];
  const res = await apiFetch(`/api/leave/balances?employee_id=${employeeId}&year=${year}`);
  return res && res.ok ? await res.json() : [];
}

async function updateLeaveRequestBalancePreview() {
  const targetId = 'req-leave-balance-preview';
  if (!document.getElementById(targetId)) return;
  const leaveTypeId = document.getElementById('req-leave-type')?.value;
  const year = new Date(document.getElementById('req-start')?.value || Date.now()).getFullYear();
  const balances = await loadEmployeeLeaveBalances(CURRENT_USER?.employeeId, year);
  const balance = balances.find(row => String(row.leave_type_id) === String(leaveTypeId));
  renderBalancePreview(targetId, balance, requestedLeaveDays('req'), 'Balance After Request');
}

async function updateManualBalancePreview() {
  const targetId = 'manual-leave-balance-preview';
  if (!document.getElementById(targetId)) return;
  const employeeId = document.getElementById('manual-employee')?.value;
  const leaveTypeId = document.getElementById('manual-leave-type')?.value;
  const year = new Date(document.getElementById('manual-start-date')?.value || Date.now()).getFullYear();
  const balances = employeeId ? await loadEmployeeLeaveBalances(employeeId, year) : [];
  const balance = balances.find(row => String(row.leave_type_id) === String(leaveTypeId));
  renderBalancePreview(targetId, balance, requestedLeaveDays('manual'), 'Balance After Save', { mode: 'manual' });
}

function initializeLeaveBalancePreviews() {
  const reqFields = document.getElementById('req-leave-fields');
  if (reqFields && !document.getElementById('req-leave-balance-preview')) {
    const preview = document.createElement('div');
    preview.id = 'req-leave-balance-preview';
    preview.className = 'form-group full';
    reqFields.appendChild(preview);
  }
  const manualForm = document.getElementById('manual-leave-form');
  if (manualForm && !document.getElementById('manual-leave-balance-preview')) {
    const preview = document.createElement('div');
    preview.id = 'manual-leave-balance-preview';
    preview.className = 'leave-field full';
    const grid = manualForm.querySelector('.leave-form-grid');
    if (grid) grid.appendChild(preview);
  }
  ['req-leave-type', 'req-start', 'req-end'].forEach(id => document.getElementById(id)?.addEventListener('change', updateLeaveRequestBalancePreview));
  ['manual-employee', 'manual-leave-type', 'manual-start-date', 'manual-end-date', 'manual-duration'].forEach(id => document.getElementById(id)?.addEventListener('change', updateManualBalancePreview));
  updateLeaveRequestBalancePreview();
  updateManualBalancePreview();
}

function eligibilityText(type) {
  const rules = [];
  if (Number(type.female_only)) rules.push('Female');
  if (Number(type.male_only)) rules.push('Male');
  if (Number(type.married_only)) rules.push('Married');
  if (Number(type.solo_parent_required)) rules.push('Solo parent');
  if (Number(type.medical_certificate_required)) rules.push('Medical cert');
  if (Number(type.legal_document_required)) rules.push('Legal doc');
  if (Number(type.minimum_service_months)) rules.push(`${type.minimum_service_months} mo. service`);
  return rules.join(', ') || 'None';
}

function renderLeaveTypes() {
  const tbody = document.getElementById('leave-types-tbody');
  if (!tbody) return;
  tbody.innerHTML = LEAVE_TYPES.map(type => `
    <tr>
      <td><strong>${type.name}</strong><div style="color:var(--muted);font-size:11px;">${type.description || ''}</div></td>
      <td>${leaveBadge(type.category, type.category)}</td>
      <td>${Number(type.max_allowed_days || 0).toFixed(1)}${Number(type.allow_unpaid_extension) ? ` + ${Number(type.max_extension_days || 0).toFixed(1)} unpaid` : ''}</td>
      <td>${Number(type.is_paid) ? 'Paid' : 'Unpaid'}</td>
      <td>${Number(type.requires_attachment) ? 'Required' : 'Optional'}</td>
      <td>${eligibilityText(type)}</td>
      <td>${leaveBadge(Number(type.is_active) ? 'Active' : 'Inactive', Number(type.is_active) ? 'Approved' : 'Rejected')}</td>
      <td><button class="btn btn-outline" type="button" onclick="editLeaveTypePolicy(${type.id})">Edit</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--muted);">No leave types configured.</td></tr>';
}

function resetLeaveTypeForm() {
  const form = document.getElementById('leave-type-form');
  if (form) form.reset();
  const id = document.getElementById('leave-type-id');
  if (id) id.value = '';
  const status = document.getElementById('leave-type-save-status');
  if (status) status.textContent = '';
}

function editLeaveTypePolicy(id) {
  const type = LEAVE_TYPES.find(item => Number(item.id) === Number(id));
  if (!type) return;
  const set = (fieldId, value) => {
    const el = document.getElementById(fieldId);
    if (!el) return;
    if (el.tagName === 'SELECT' && value && ![...el.options].some(option => option.value === String(value))) {
      el.add(new Option(value, value));
    }
    el.value = value ?? '';
  };
  const check = (fieldId, value) => { const el = document.getElementById(fieldId); if (el) el.checked = Number(value) === 1; };
  set('leave-type-id', type.id);
  set('leave-type-name', type.name);
  set('leave-type-category', type.category);
  set('leave-type-max-days', type.max_allowed_days);
  set('leave-type-paid', Number(type.is_paid) ? '1' : '0');
  set('leave-type-active', Number(type.is_active) ? '1' : '0');
  set('leave-type-attachment', Number(type.requires_attachment) ? '1' : '0');
  set('leave-type-extension', Number(type.allow_unpaid_extension) ? '1' : '0');
  set('leave-type-extension-days', type.max_extension_days || 0);
  set('leave-type-description', type.description || '');
  check('leave-elig-female', type.female_only);
  check('leave-elig-male', type.male_only);
  check('leave-elig-married', type.married_only);
  check('leave-elig-solo', type.solo_parent_required);
  check('leave-elig-medical', type.medical_certificate_required);
  check('leave-elig-legal', type.legal_document_required);
  set('leave-elig-service', type.minimum_service_months || 0);
  switchLeaveModuleTab('policies');
}

async function saveLeaveTypePolicy(event) {
  event.preventDefault();
  const val = id => document.getElementById(id)?.value;
  const checked = id => document.getElementById(id)?.checked ? 1 : 0;
  const payload = {
    id: val('leave-type-id') || undefined,
    name: val('leave-type-name'),
    category: val('leave-type-category'),
    description: val('leave-type-description'),
    max_allowed_days: val('leave-type-max-days'),
    is_paid: val('leave-type-paid'),
    is_active: val('leave-type-active'),
    requires_attachment: val('leave-type-attachment'),
    allow_unpaid_extension: val('leave-type-extension'),
    max_extension_days: val('leave-type-extension-days') || 0,
    female_only: checked('leave-elig-female'),
    male_only: checked('leave-elig-male'),
    married_only: checked('leave-elig-married'),
    solo_parent_required: checked('leave-elig-solo'),
    medical_certificate_required: checked('leave-elig-medical'),
    legal_document_required: checked('leave-elig-legal'),
    minimum_service_months: val('leave-elig-service') || 0
  };
  const status = document.getElementById('leave-type-save-status');
  if (status) status.textContent = 'Saving...';
  const res = await apiFetch('/api/leave/types', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res || !res.ok) {
    const error = await res?.json().catch(() => ({}));
    if (status) status.textContent = error.error || 'Save failed.';
    return;
  }
  resetLeaveTypeForm();
  if (status) status.textContent = 'Saved.';
  await loadLeaveTypes(isLeaveManager());
}

function renderLeaveAudit() {
  const tbody = document.getElementById('leave-audit-tbody');
  if (!tbody) return;
  tbody.innerHTML = LEAVE_AUDIT.slice(0, 25).map(item => `
    <tr><td>${item.created_at ? new Date(item.created_at).toLocaleString() : '-'}</td><td>${item.employee_name || '-'}</td><td>${item.action || '-'}</td><td>${item.actor_name || '-'}</td><td>${item.remarks || '-'}</td></tr>
  `).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);">No audit records.</td></tr>';
}

function renderLeaveCalendar() {
  const calendar = document.getElementById('leave-calendar');
  if (!calendar) return;
  const year = CALENDAR_DATE.getFullYear();
  const month = CALENDAR_DATE.getMonth();
  const label = document.getElementById('calendar-month-year');
  if (label) label.textContent = CALENDAR_DATE.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const dept = document.getElementById('calendar-dept-filter')?.value || '';
  const status = document.getElementById('calendar-status-filter')?.value || '';
  const leaves = ALL_LEAVES_DATA.filter(l => (!dept || l.department === dept) && (!status || l.status === status));
  const heads = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => `<div class="leave-calendar-head">${day}</div>`).join('');
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let cells = '';
  for (let i = 0; i < firstDay; i++) cells += '<div class="leave-calendar-day"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const entries = leaves.filter(l => l.date_from <= date && l.date_to >= date).slice(0, 3);
    cells += `<div class="leave-calendar-day"><strong>${day}</strong>${entries.map(l => `<div class="leave-calendar-entry">${l.employee_name} (${l.status})</div>`).join('')}</div>`;
  }
  calendar.innerHTML = heads + cells;
}

function previousMonth() { CALENDAR_DATE.setMonth(CALENDAR_DATE.getMonth() - 1); renderLeaveCalendar(); }
function nextMonth() { CALENDAR_DATE.setMonth(CALENDAR_DATE.getMonth() + 1); renderLeaveCalendar(); }
function exportLeaveReport(reportType, format) {
  const type = reportType === 'balances' ? 'balances' : reportType === 'monthly' ? 'monthly' : 'summary';
  window.open(`/api/leave/reports/${type}?format=${format || 'csv'}`, '_blank');
}

function switchLeaveModuleTab(tabName) {
  if (isLeaveEmployee() && !EMPLOYEE_LEAVE_TABS.has(tabName)) {
    tabName = 'overview';
  }
  const panelTabName = tabName === 'balances' ? 'overview' : tabName;
  document.querySelectorAll('.leave-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.leaveTab === tabName);
  });
  document.querySelectorAll('.leave-tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `leave-panel-${panelTabName}`);
  });
  document.getElementById('page-leave')?.classList.toggle('leave-balances-mode', tabName === 'balances');
  const pageBody = document.querySelector('.page-body');
  if (pageBody && tabName !== 'balances') {
    pageBody.scrollTop = 0;
    requestAnimationFrame(() => { pageBody.scrollTop = 0; });
  }
  if (tabName === 'balances') {
    requestAnimationFrame(() => document.getElementById('leave-balances-card')?.scrollIntoView({ block: 'start' }));
  }
  if (tabName === 'calendar') window.renderLeaveCalendar();
  if (tabName === 'policies') loadLeaveTypes(isLeaveManager());
}

// ── Watch for page activation (partials load async) ───────────
function watchPageActivation() {
  const observer = new MutationObserver(() => {
    const leavePage    = document.querySelector('#page-leave.active table tbody');
    const requestsPage = document.querySelector('#page-requests.active #req-all-tbody');

    if (leavePage && !leavePage.dataset.loaded) {
      leavePage.dataset.loaded = '1';
      fetchCurrentUser(() => {
        loadLeaveRequests();
        if (isLeaveEmployee() && document.getElementById('general-requests-card')) {
          loadGeneralRequests();
        }
      });
    }
    if (requestsPage && !requestsPage.dataset.loaded) {
      requestsPage.dataset.loaded = '1';
      fetchCurrentUser(async () => {
        await loadLeaveTypes();
        loadAllRequests();
      });
    }
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
}

// ─────────────────────────────────────────────────────────────
// ── LEAVE CALENDAR VIEW ──────────────────────────────────────
// ─────────────────────────────────────────────────────────────

let CALENDAR_DATE = new Date();
let CALENDAR_LEAVES = [];

async function openLeaveCalendar() {
  // Fetch all leave requests — only keep Approved & Pending (exclude Denied/Cancelled)
  try {
    const response = await apiFetch('/api/leave');
    if (!response || !response.ok) return;
    const allLeaves = await response.json();
    CALENDAR_LEAVES = allLeaves.filter(l => l.status === 'Approved' || l.status === 'Pending');
  } catch (err) {
    console.error('Error fetching leaves for calendar:', err);
  }

  // Show modal with transition
  const modal = document.getElementById('leave-calendar-modal');
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => modal.style.opacity = '1', 10);
  }
  
  // Render calendar
  renderLeaveCalendar();
}

function closeLeaveCalendar() {
  const modal = document.getElementById('leave-calendar-modal');
  if (modal) {
    modal.style.opacity = '0';
    setTimeout(() => modal.style.display = 'none', 300);
  }
}

function previousMonth() {
  CALENDAR_DATE.setMonth(CALENDAR_DATE.getMonth() - 1);
  renderLeaveCalendar();
}

function nextMonth() {
  CALENDAR_DATE.setMonth(CALENDAR_DATE.getMonth() + 1);
  renderLeaveCalendar();
}

function renderLeaveCalendar() {
  const year = CALENDAR_DATE.getFullYear();
  const month = CALENDAR_DATE.getMonth();
  
  // Update month/year display
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthYearEl = document.getElementById('calendar-month-year');
  if (monthYearEl) monthYearEl.textContent = `${monthNames[month]} ${year}`;

  // Get calendar containers
  const headersEl = document.getElementById('calendar-headers');
  const calendarEl = document.getElementById('leave-calendar');
  if (!calendarEl || !headersEl) return;
  
  headersEl.innerHTML = '';
  calendarEl.innerHTML = '';

  // Day headers
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  dayNames.forEach(day => {
    const dayHeader = document.createElement('div');
    dayHeader.textContent = day;
    dayHeader.style.cssText = 'font-weight:700;text-align:center;padding:12px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);';
    headersEl.appendChild(dayHeader);
  });

  // Get first day of month and total days
  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
  const currentDay = today.getDate();

  // Helper to format date safely in local time (YYYY-MM-DD)
  const formatDateSafe = (d) => {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // Empty cells before month starts
  for (let i = 0; i < firstDay; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.style.cssText = 'background:rgba(0,0,0,0.05);border-right:1px solid var(--border);border-bottom:1px solid var(--border);';
    calendarEl.appendChild(emptyCell);
  }

  // Days of month
  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(year, month, day);
    const dateStr = formatDateSafe(date);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const isToday = isCurrentMonth && day === currentDay;

    // Find leaves for this date
    const leavesOnDate = CALENDAR_LEAVES.filter(leave => {
      // Create local dates for from/to, ignoring time
      const fromDate = new Date(leave.date_from);
      const toDate = new Date(leave.date_to);
      const fromStr = formatDateSafe(fromDate);
      const toStr = formatDateSafe(toDate);
      return dateStr >= fromStr && dateStr <= toStr;
    });

    const dayCell = document.createElement('div');
    dayCell.style.cssText = `
      min-height:100px;
      border-right:1px solid var(--border);
      border-bottom:1px solid var(--border);
      padding:8px;
      position:relative;
      background: ${isWeekend ? 'rgba(0,0,0,0.02)' : 'transparent'};
      ${isToday ? 'background: rgba(var(--primary-rgb), 0.05);' : ''}
    `;
    
    // Add day number
    const dayNum = document.createElement('div');
    dayNum.textContent = day;
    dayNum.style.cssText = `
      font-weight:${isToday ? '800' : '600'};
      font-size:${isToday ? '16px' : '14px'};
      margin-bottom:8px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      ${isToday ? 'width:28px;height:28px;background:var(--primary);color:white;border-radius:50%;' : 'color:var(--text);'}
    `;
    dayCell.appendChild(dayNum);

    // Add leave indicators
    if (leavesOnDate.length > 0) {
      // Sort approved first
      leavesOnDate.sort((a,b) => a.status === 'Approved' ? -1 : 1);
      
      const leavesContainer = document.createElement('div');
      leavesContainer.style.cssText = 'display:flex;flex-direction:column;gap:3px;';

      const MAX_VISIBLE = 2;
      const visible = leavesOnDate.slice(0, MAX_VISIBLE);
      const overflow = leavesOnDate.length - MAX_VISIBLE;

      // Helper to build a single leave badge
      const buildBadge = (leave) => {
        const badge = document.createElement('div');
        const isApproved = leave.status === 'Approved';
        const isPending = leave.status === 'Pending';
        let shortName = leave.employee_name;
        if (shortName.includes(' ')) {
          const parts = shortName.split(' ');
          shortName = parts[0].charAt(0) + '. ' + parts[parts.length - 1];
        }
        const color = isApproved ? 'var(--green)' : 'var(--yellow)';
        const bgColor = isApproved ? 'rgba(76,175,80,0.1)' : 'rgba(255,193,7,0.1)';
        badge.innerHTML = `
          <div style="width:4px;height:100%;background:${color};border-radius:4px;position:absolute;left:0;top:0;"></div>
          <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${shortName}</span>
          <span style="opacity:0.7;font-size:10px;margin-left:4px;">(${leave.type.substring(0,4)})</span>
        `;
        badge.style.cssText = `font-size:11px;padding:3px 6px 3px 10px;background:${bgColor};color:var(--text);border-radius:4px;position:relative;display:flex;align-items:center;overflow:hidden;cursor:pointer;transition:filter 0.2s;`;
        badge.title = `${leave.employee_name}\nType: ${leave.type}\nStatus: ${leave.status}\nReason: ${leave.reason || 'None'}`;
        badge.onmouseover = () => badge.style.filter = 'brightness(0.9)';
        badge.onmouseout = () => badge.style.filter = 'none';
        return badge;
      };

      visible.forEach(leave => leavesContainer.appendChild(buildBadge(leave)));

      // Overflow "+N more" badge
      if (overflow > 0) {
        const moreBtn = document.createElement('div');
        const approvedCount = leavesOnDate.filter(l => l.status === 'Approved').length;
        const pendingCount = leavesOnDate.filter(l => l.status === 'Pending').length;
        moreBtn.innerHTML = `<span style="font-weight:700;">+${overflow} more</span><span style="opacity:0.6;margin-left:4px;font-size:10px;">(${approvedCount}✓ ${pendingCount}⏳)</span>`;
        moreBtn.style.cssText = 'font-size:11px;padding:3px 8px;background:rgba(99,102,241,0.12);color:var(--text);border-radius:4px;display:flex;align-items:center;cursor:pointer;transition:background 0.2s;';
        moreBtn.onmouseover = () => moreBtn.style.background = 'rgba(99,102,241,0.22)';
        moreBtn.onmouseout = () => moreBtn.style.background = 'rgba(99,102,241,0.12)';

        // Click opens detail popup
        const allLeavesForPopup = [...leavesOnDate];
        const popupDateStr = dateStr;
        moreBtn.onclick = (e) => {
          e.stopPropagation();
          showCalendarDayPopup(popupDateStr, allLeavesForPopup);
        };
        leavesContainer.appendChild(moreBtn);
      }

      // If only showing count badges (many leaves), also make whole cell clickable
      if (leavesOnDate.length > MAX_VISIBLE) {
        dayCell.style.cursor = 'pointer';
        const allLeavesForPopup = [...leavesOnDate];
        const popupDateStr = dateStr;
        dayCell.onclick = () => showCalendarDayPopup(popupDateStr, allLeavesForPopup);
      }

      dayCell.appendChild(leavesContainer);
    }

    calendarEl.appendChild(dayCell);
  }
}

// ─────────────────────────────────────────────────────────────
// ── CALENDAR DAY DETAIL POPUP ────────────────────────────────
// ─────────────────────────────────────────────────────────────
function showCalendarDayPopup(dateStr, leaves) {
  // Remove any existing popup
  const existing = document.getElementById('calendar-day-popup');
  if (existing) existing.remove();

  const dateObj = new Date(dateStr + 'T00:00:00');
  const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const approvedLeaves = leaves.filter(l => l.status === 'Approved');
  const pendingLeaves = leaves.filter(l => l.status === 'Pending');

  const popup = document.createElement('div');
  popup.id = 'calendar-day-popup';
  popup.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;';
  
  popup.innerHTML = `
    <div style="background:var(--bg);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.4);width:90%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border);">
      <div style="padding:20px 24px;border-bottom:1px solid var(--border);background:var(--bg-alt);">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <h3 style="margin:0;font-size:17px;font-weight:700;color:var(--text);">${dateLabel}</h3>
            <div style="font-size:12px;color:var(--muted);margin-top:4px;">${leaves.length} leave${leaves.length !== 1 ? 's' : ''} · ${approvedLeaves.length} approved · ${pendingLeaves.length} pending</div>
          </div>
          <button id="close-day-popup" style="background:none;border:1px solid var(--border);color:var(--text);width:32px;height:32px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;transition:background 0.2s;">✕</button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:16px 24px;">
        ${leaves.map(l => {
          const isApproved = l.status === 'Approved';
          const color = isApproved ? 'var(--green)' : 'var(--yellow)';
          const bgColor = isApproved ? 'rgba(76,175,80,0.08)' : 'rgba(255,193,7,0.08)';
          return `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:${bgColor};border-radius:8px;margin-bottom:8px;border-left:4px solid ${color};">
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:13px;color:var(--text);">${l.employee_name}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;">${l.type} · ${l.days || 1} day(s)</div>
                ${l.reason ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${l.reason}">📝 ${l.reason}</div>` : ''}
              </div>
              <span style="font-size:11px;font-weight:600;padding:3px 8px;border-radius:12px;background:${bgColor};color:${color};border:1px solid ${color};white-space:nowrap;">${l.status}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(popup);
  requestAnimationFrame(() => popup.style.opacity = '1');

  // Close handlers
  const closeBtn = document.getElementById('close-day-popup');
  const closePopup = () => {
    popup.style.opacity = '0';
    setTimeout(() => popup.remove(), 200);
  };
  closeBtn.onclick = closePopup;
  popup.onclick = (e) => { if (e.target === popup) closePopup(); };
}

// ─────────────────────────────────────────────────────────────
// ── CANCEL APPROVED LEAVE (HR Admin) ─────────────────────────
// ─────────────────────────────────────────────────────────────
async function cancelLeave(btn) {
  const row = btn.closest('tr');
  const leaveId = row?.dataset.leaveId;
  if (!leaveId) { alert('Error: Could not find leave request'); return; }
  if (!confirm('Are you sure you want to cancel this approved leave?\n\nThis will revert the leave status to "Cancelled" and restore the employee\'s leave balance.')) return;
  try {
    const res = await apiFetch(`/api/leave/${leaveId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'Cancelled' })
    });
    if (!res || !res.ok) throw new Error('Failed to cancel leave');
    alert('Leave has been cancelled successfully.');
    loadLeaveRequests();
  } catch (err) { alert('Failed to cancel leave: ' + err.message); }
}

window.addEventListener('DOMContentLoaded', watchPageActivation);

// Expose for inline onclick
window.selectReq              = selectReq;
window.saveRequest            = saveRequest;
window.approveLeave           = approveLeave;
window.denyLeave              = denyLeave;
window.cancelLeave            = cancelLeave;
window.approveRequest         = approveRequest;
window.denyRequest            = denyRequest;
window.toggleLeaveForm        = toggleLeaveForm;
window.submitManualLeave      = submitManualLeave;
window.clearLeaveForm         = clearLeaveForm;
window.calculateDaysBetweenDates = calculateDaysBetweenDates;
window.approveRequest   = approveRequest;
window.denyRequest      = denyRequest;
window.loadLeaveRequests  = loadLeaveRequests;
window.loadAllRequests    = loadAllRequests;
window.openLeaveCalendar  = openLeaveCalendar;
window.closeLeaveCalendar = closeLeaveCalendar;
window.previousMonth      = previousMonth;
window.nextMonth          = nextMonth;
window.renderLeaveCalendar = renderLeaveCalendar;
window.showCalendarDayPopup = showCalendarDayPopup;
window.loadGeneralRequests  = loadGeneralRequests;
window.approveGenRequest    = approveGenRequest;
window.denyGenRequest       = denyGenRequest;
window.switchGenTab         = switchGenTab;

window.viewLeaveDetails = viewLeaveDetails;
window.closeLeaveDetails = closeLeaveDetails;
window.syncManualEmployeeInfo = syncManualEmployeeInfo;
window.calculateManualDuration = calculateManualDuration;
window.approveLeaveById = approveLeaveById;
window.rejectLeaveById = rejectLeaveById;
window.exportLeaveReport = exportLeaveReport;
window.switchLeaveModuleTab = switchLeaveModuleTab;
window.loadLeaveTypes = loadLeaveTypes;
window.saveLeaveTypePolicy = saveLeaveTypePolicy;
window.editLeaveTypePolicy = editLeaveTypePolicy;
window.resetLeaveTypeForm = resetLeaveTypeForm;
window.loadBalanceConfigForEmployee = loadBalanceConfigForEmployee;
window.fillBalanceFormFromSelection = fillBalanceFormFromSelection;
window.updateBalanceRemainingPreview = updateBalanceRemainingPreview;
window.saveLeaveBalanceConfig = saveLeaveBalanceConfig;
window.editLeaveBalanceConfig = editLeaveBalanceConfig;
window.resetLeaveBalanceForm = resetLeaveBalanceForm;
window.loadLeaveBalancesForSelection = loadLeaveBalancesForSelection;
window.filterLeaveBalanceViewerEmployees = filterLeaveBalanceViewerEmployees;

window.renderLeaveCalendar = function() {
  const calendar = document.getElementById('leave-calendar');
  if (!calendar) return;
  const year = CALENDAR_DATE.getFullYear();
  const month = CALENDAR_DATE.getMonth();
  const label = document.getElementById('calendar-month-year');
  if (label) label.textContent = CALENDAR_DATE.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const dept = document.getElementById('calendar-dept-filter')?.value || '';
  const status = document.getElementById('calendar-status-filter')?.value || '';
  const leaves = ALL_LEAVES_DATA.filter(l => (!dept || l.department === dept) && (!status || l.status === status));
  let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => `<div class="leave-calendar-head">${day}</div>`).join('');
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let i = 0; i < firstDay; i++) html += '<div class="leave-calendar-day"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const entries = leaves.filter(l => l.date_from <= date && l.date_to >= date).slice(0, 3);
    html += `<div class="leave-calendar-day"><strong>${day}</strong>${entries.map(l => `<div class="leave-calendar-entry">${l.employee_name} (${l.status})</div>`).join('')}</div>`;
  }
  calendar.innerHTML = html;
};

window.previousMonth = function() {
  CALENDAR_DATE.setMonth(CALENDAR_DATE.getMonth() - 1);
  window.renderLeaveCalendar();
};

window.nextMonth = function() {
  CALENDAR_DATE.setMonth(CALENDAR_DATE.getMonth() + 1);
  window.renderLeaveCalendar();
};
