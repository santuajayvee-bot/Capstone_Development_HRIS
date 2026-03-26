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
      <td>${leave.reason || '-'}</td>
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

window.addEventListener('DOMContentLoaded', watchPageActivation);

// Expose for inline onclick
window.selectReq        = selectReq;
window.saveRequest      = saveRequest;
window.approveLeave     = approveLeave;
window.denyLeave        = denyLeave;
window.approveRequest   = approveRequest;
window.denyRequest      = denyRequest;
window.loadLeaveRequests  = loadLeaveRequests;
window.loadAllRequests    = loadAllRequests;