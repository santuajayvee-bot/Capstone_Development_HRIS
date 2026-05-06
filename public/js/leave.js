/* ============================================================
   LEAVE.JS — Leave management & request form
   ============================================================ */

let CURRENT_USER = null;

// ── Load current user (works on both leave and requests pages) ──
async function fetchCurrentUser(callback) {
  if (CURRENT_USER) { if (callback) callback(); return; }
  try {
    const response = await apiFetch('/api/auth/me');
    if (response && response.ok) {
      const data = await response.json();
      CURRENT_USER = data.user;
      console.log('Current user loaded:', CURRENT_USER);
    }
  } catch (error) {
    console.error('Error fetching current user:', error);
  }
  if (callback) callback();
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
  const isAdmin = CURRENT_USER && CURRENT_USER.role !== 'employee';

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

  const isAdmin = CURRENT_USER && CURRENT_USER.role !== 'employee';

  let filtered = ALL_LEAVES_DATA;
  
  // 1. Filter by Tab (Pending vs History) for Admins
  if (CURRENT_LEAVE_TAB === 'pending') {
    filtered = filtered.filter(r => r.status === 'Pending');
    if (actionColHead) {
      actionColHead.textContent = isAdmin ? 'Actions' : 'Status';
      actionColHead.style.textAlign = isAdmin ? 'right' : 'left';
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
          <span style="text-overflow:ellipsis;overflow:hidden;white-space:nowrap;" title="${leave.reason || '-'}">${leave.reason || '-'}</span>
          ${leave.file_path ? `<a href="${leave.file_path}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text);text-decoration:none;background:var(--bg-alt);padding:4px 10px;border-radius:6px;border:1px solid var(--border);width:max-content;opacity:0.8;transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.8'">📎 View File</a>` : ''}
        </div>
      </td>
      <td style="padding:16px 24px;text-align:${(CURRENT_LEAVE_TAB === 'pending' && isAdmin) ? 'right' : 'left'};">
        ${CURRENT_LEAVE_TAB === 'pending' ? (isAdmin ? `
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
            ${(isAdmin && leave.status === 'Approved') ? `<button class="btn" style="background:none;border:1px solid rgba(244,67,54,0.3);color:var(--red);padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;" onclick="cancelLeave(this)">Cancel</button>` : ''}
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
  if (!leaveId) { alert('Error: Could not find leave request'); return; }
  if (!confirm('Approve this leave request?')) return;
  try {
    const res = await apiFetch(`/api/leave/${leaveId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'Approved' })
    });
    if (!res || !res.ok) throw new Error('Failed to approve');
    alert('Leave approved successfully');
    loadLeaveRequests();
  } catch (err) { alert('Failed to approve leave: ' + err.message); }
}

async function denyLeave(btn) {
  const row = btn.closest('tr');
  const leaveId = row?.dataset.leaveId;
  if (!leaveId) { alert('Error: Could not find leave request'); return; }
  if (!confirm('Deny this leave request?')) return;
  try {
    const res = await apiFetch(`/api/leave/${leaveId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'Denied' })
    });
    if (!res || !res.ok) throw new Error('Failed to deny');
    alert('Leave denied successfully');
    loadLeaveRequests();
  } catch (err) { alert('Failed to deny leave: ' + err.message); }
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
    reason: l.reason || '-',
    date: new Date(l.created_at),
    status: l.status,
  }));

  const genRows = myGenReqs.map(r => ({
    id: r.id, source: 'general',
    employee: r.employee_name,
    type: r.type,
    details: '—',
    reason: r.reason || '-',
    date: new Date(r.created_at),
    status: r.status,
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
      <td><span class="badge badge-${r.status === 'Approved' ? 'green' : r.status === 'Denied' ? 'red' : 'yellow'}">${r.status}</span></td>
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
    const res = await apiFetch(url, { method: 'PATCH', body: JSON.stringify({ status: 'Denied' }) });
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

  const reason = document.getElementById('req-reason')?.value?.trim();
  if (!reason) { alert('Please enter a reason.'); return; }

  if (type === 'Leave Request') {
    const leaveType = document.getElementById('req-leave-type')?.value || 'Casual';
    const startDate = document.getElementById('req-start')?.value;
    const endDate   = document.getElementById('req-end')?.value;
    const attachment = document.getElementById('req-attachment')?.files[0];
    if (!startDate) { alert('Please select a start date.'); return; }
    const days = Math.max(Math.ceil((new Date(endDate || startDate) - new Date(startDate)) / 86400000) + 1, 1);
    
    try {
      const payload = { type: leaveType, date_from: startDate, date_to: endDate || startDate, days, reason, employee_id: CURRENT_USER.employeeId };
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
        const eData = await res?.json().catch(() => null);
        const eText = eData ? eData.error : await res?.text();
        throw new Error(eText || 'Failed'); 
      }
      
      alert('Leave request submitted! Status: Pending approval');
      clearRequestForm();
      loadAllRequests();
    } catch (err) { 
      alert('Failed to submit leave request: ' + err.message); 
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

  // Check if user is HR Admin or payroll staff
  if (!['admin', 'hr_admin', 'system_admin', 'payroll_officer', 'payroll_manager'].includes(CURRENT_USER.role)) {
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

  console.log('Submitting manual leave with payload:', payload);
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
    toggleLeaveForm(); // Collapse form
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
    const isAdmin = CURRENT_USER && CURRENT_USER.role !== 'employee';
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

  const isAdmin = CURRENT_USER && CURRENT_USER.role !== 'employee';
  let filtered = ALL_GEN_REQUESTS;

  if (CURRENT_GEN_TAB === 'pending') {
    filtered = filtered.filter(r => r.status === 'Pending');
    if (colHead) { colHead.textContent = 'Actions'; colHead.style.textAlign = 'right'; }
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
      <td style="padding:16px 24px;text-align:${CURRENT_GEN_TAB === 'pending' ? 'right' : 'left'};">
        ${CURRENT_GEN_TAB === 'pending' ? `
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn" style="background:var(--green);color:white;border:none;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;" onclick="approveGenRequest(this)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Approve
            </button>
            <button class="btn btn-outline" style="color:var(--red);border-color:rgba(244,67,54,0.3);padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;" onclick="denyGenRequest(this)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Reject
            </button>
          </div>
        ` : `
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
      method: 'PATCH', body: JSON.stringify({ status: 'Denied' })
    });
    if (!res || !res.ok) throw new Error('Failed to deny');
    alert('Request denied.');
    loadGeneralRequests();
  } catch (err) { alert('Failed to deny: ' + err.message); }
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
        loadGeneralRequests();
      });
    }
    if (requestsPage && !requestsPage.dataset.loaded) {
      requestsPage.dataset.loaded = '1';
      fetchCurrentUser(() => loadAllRequests());
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