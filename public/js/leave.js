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

function renderLeaveRequests(leaves) {
  const tbody = document.querySelector('#page-leave table tbody');
  if (!tbody) return;

  let filtered = leaves;
  if (CURRENT_USER && CURRENT_USER.role === 'employee') {
    filtered = leaves.filter(l => l.employee_id === CURRENT_USER.employeeId);
  }

  const isAdmin = CURRENT_USER && CURRENT_USER.role !== 'employee';

  tbody.innerHTML = filtered.length === 0
    ? '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px;">No leave requests found.</td></tr>'
    : filtered.map(leave => `
    <tr data-leave-id="${leave.id}">
      <td>${leave.employee_name}</td>
      <td>${leave.type}</td>
      <td>${new Date(leave.date_from).toLocaleDateString()}</td>
      <td>${new Date(leave.date_to).toLocaleDateString()}</td>
      <td>${leave.days || 1}</td>
      <td>
        <div style="word-break:break-word;">${leave.reason || '-'}</div>
        ${leave.file_path ? `<a href="${leave.file_path}" target="_blank" style="display:inline-block;margin-top:6px;padding:4px 8px;background:var(--blue);color:white;border-radius:4px;font-size:12px;text-decoration:none;cursor:pointer;">📎 View Attachment</a>` : ''}
      </td>
      <td class="leave-status"><span class="badge badge-${leave.status === 'Approved' ? 'green' : leave.status === 'Denied' ? 'red' : 'yellow'}">${leave.status}</span></td>
      <td>
        ${isAdmin ? `
          <button class="btn btn-sm btn-outline" onclick="approveLeave(this)" ${leave.status !== 'Pending' ? 'disabled' : ''}>✓</button>
          <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="denyLeave(this)" ${leave.status !== 'Pending' ? 'disabled' : ''}>✕</button>
        ` : ''}
      </td>
    </tr>
  `).join('');

  const countEl = document.querySelector('.table-wrap + div');
  if (countEl) {
    const pending = filtered.filter(l => l.status === 'Pending').length;
    countEl.textContent = `${pending} pending out of ${filtered.length}`;
  }
}

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

  const isAdmin = CURRENT_USER && CURRENT_USER.role !== 'employee';

  const actionCol = document.getElementById('req-action-col');
  if (actionCol) actionCol.style.display = isAdmin ? '' : 'none';

  const leaveRows = leaves.map(l => ({
    id: l.id, source: 'leave',
    employee: l.employee_name,
    type: 'Leave Request',
    details: `${l.type} · ${new Date(l.date_from).toLocaleDateString()} – ${new Date(l.date_to).toLocaleDateString()} (${l.days || 1}d)`,
    reason: l.reason || '-',
    date: new Date(l.created_at),
    status: l.status,
  }));

  const genRows = genReqs.map(r => ({
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
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No requests found.</td></tr>';
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
      <td style="${isAdmin ? '' : 'display:none'}">
        ${isAdmin ? `
          <button class="btn btn-sm btn-outline" onclick="approveRequest(this)" ${r.status !== 'Pending' ? 'disabled' : ''}>✓</button>
          <button class="btn btn-sm btn-outline" style="color:var(--red)" onclick="denyRequest(this)" ${r.status !== 'Pending' ? 'disabled' : ''}>✕</button>
        ` : ''}
      </td>
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
    if (!startDate) { alert('Please select a start date.'); return; }
    const days = Math.max(Math.ceil((new Date(endDate || startDate) - new Date(startDate)) / 86400000) + 1, 1);
    try {
      const res = await apiFetch('/api/leave', {
        method: 'POST',
        body: JSON.stringify({ type: leaveType, date_from: startDate, date_to: endDate || startDate, days, reason, employee_id: CURRENT_USER.employeeId })
      });
      if (!res || !res.ok) { const e = await res?.text(); throw new Error(e || 'Failed'); }
      alert('Leave request submitted! Status: Pending approval');
      clearRequestForm();
      loadAllRequests();
    } catch (err) { alert('Failed to submit leave request: ' + err.message); }
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
  ['req-start', 'req-end', 'req-reason'].forEach(id => {
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
  if (!['admin', 'payroll_officer', 'payroll_manager'].includes(CURRENT_USER.role)) {
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

// ── Watch for page activation (partials load async) ───────────
function watchPageActivation() {
  const observer = new MutationObserver(() => {
    const leavePage    = document.querySelector('#page-leave.active table tbody');
    const requestsPage = document.querySelector('#page-requests.active #req-all-tbody');

    if (leavePage && !leavePage.dataset.loaded) {
      leavePage.dataset.loaded = '1';
      fetchCurrentUser(() => loadLeaveRequests());
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
  // Fetch all leave requests
  try {
    const response = await apiFetch('/api/leave');
    if (!response || !response.ok) return;
    CALENDAR_LEAVES = await response.json();
  } catch (err) {
    console.error('Error fetching leaves for calendar:', err);
  }

  // Show modal
  const modal = document.getElementById('leave-calendar-modal');
  if (modal) modal.style.display = 'block';
  
  // Render calendar
  renderLeaveCalendar();
}

function closeLeaveCalendar() {
  const modal = document.getElementById('leave-calendar-modal');
  if (modal) modal.style.display = 'none';
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

  // Create calendar grid
  const calendarEl = document.getElementById('leave-calendar');
  if (!calendarEl) return;
  
  calendarEl.innerHTML = '';

  // Day headers
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  dayNames.forEach(day => {
    const dayHeader = document.createElement('div');
    dayHeader.textContent = day;
    dayHeader.style.cssText = 'font-weight:700;text-align:center;padding:10px;background:var(--bg-alt);border-radius:4px;';
    calendarEl.appendChild(dayHeader);
  });

  // Get first day of month and total days
  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();

  // Empty cells before month starts
  for (let i = 0; i < firstDay; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.style.cssText = 'background:transparent;';
    calendarEl.appendChild(emptyCell);
  }

  // Days of month
  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(year, month, day);
    const dateStr = date.toISOString().split('T')[0];

    // Find leaves for this date
    const leavesOnDate = CALENDAR_LEAVES.filter(leave => {
      const from = new Date(leave.date_from).toISOString().split('T')[0];
      const to = new Date(leave.date_to).toISOString().split('T')[0];
      return dateStr >= from && dateStr <= to;
    });

    const dayCell = document.createElement('div');
    dayCell.style.cssText = 'min-height:80px;border:1px solid var(--border);border-radius:4px;padding:8px;overflow:hidden;position:relative;';
    
    // Add day number
    const dayNum = document.createElement('div');
    dayNum.textContent = day;
    dayNum.style.cssText = 'font-weight:700;margin-bottom:4px;';
    dayCell.appendChild(dayNum);

    // Add leave indicators
    if (leavesOnDate.length > 0) {
      leavesOnDate.forEach(leave => {
        const badge = document.createElement('div');
        const color = leave.status === 'Approved' ? 'var(--green)' : leave.status === 'Denied' ? 'var(--red)' : 'var(--yellow)';
        const bgColor = leave.status === 'Approved' ? 'rgba(76,175,80,0.2)' : leave.status === 'Denied' ? 'rgba(244,67,54,0.2)' : 'rgba(255,193,7,0.2)';
        
        badge.textContent = leave.type.substring(0, 3);
        badge.style.cssText = `font-size:10px;padding:2px 6px;background:${bgColor};border:1px solid ${color};border-radius:3px;margin:2px 0;display:inline-block;`;
        badge.title = `${leave.employee_name} - ${leave.type}`;
        dayCell.appendChild(badge);
      });
    }

    calendarEl.appendChild(dayCell);
  }
}

window.addEventListener('DOMContentLoaded', watchPageActivation);

// Expose for inline onclick
window.selectReq              = selectReq;
window.saveRequest            = saveRequest;
window.approveLeave           = approveLeave;
window.denyLeave              = denyLeave;
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