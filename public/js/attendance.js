/* ============================================================
   ATTENDANCE.JS — Attendance Module Controller
   QR Scan · Geofence · Device Binding · Admin Override · OT
   ============================================================ */

let ATT_USER = null;
let ATT_RECORDS = [];
let QR_SCAN_MODE = null; // 'clock-in' or 'clock-out'
let DEVICE_FP = null;

// ── Device fingerprint (simple hash of browser properties) ──
function getDeviceFingerprint() {
  if (DEVICE_FP) return DEVICE_FP;
  const raw = [
    navigator.userAgent,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    navigator.language,
    navigator.hardwareConcurrency,
    new Date().getTimezoneOffset()
  ].join('|');
  // Simple hash
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash |= 0;
  }
  DEVICE_FP = 'DFP-' + Math.abs(hash).toString(36);
  return DEVICE_FP;
}

// ── Tab switching ──
function switchAttTab(tab, el) {
  const tabs = ['overview', 'records', 'overtime', 'audit'];
  tabs.forEach(t => {
    const panel = document.getElementById('att-' + t);
    if (panel) panel.style.display = 'none';
  });
  const target = document.getElementById('att-' + tab);
  if (target) target.style.display = 'block';

  document.querySelectorAll('#page-attendance .tabs .tab')
    .forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');

  // Load data for tab
  if (tab === 'records') loadAttRecords();
  if (tab === 'overtime') loadOvertimeTab();
  if (tab === 'audit') loadAuditLog();
}

// ── Initialize attendance module ──
async function initAttendance() {
  try {
    const res = await apiFetch('/api/auth/me');
    if (res && res.ok) {
      const data = await res.json();
      ATT_USER = data.user;
    }
  } catch (e) { console.error('Attendance init error:', e); }

  if (!ATT_USER) return;

  const isAdmin = ATT_USER.role !== 'employee';

  // Show/hide admin-only elements
  const genCard = document.getElementById('qr-generate-card');
  if (genCard) genCard.style.display = isAdmin ? 'block' : 'none';

  const recordsControls = document.getElementById('att-records-controls');
  if (recordsControls) recordsControls.style.display = isAdmin ? 'block' : 'none';

  const actionCol = document.getElementById('att-action-col');
  if (actionCol) actionCol.style.display = isAdmin ? '' : 'none';

  // Hide admin-only tabs for employees
  const otTab = document.getElementById('att-tab-overtime');
  const auditTab = document.getElementById('att-tab-audit');
  if (otTab) otTab.style.display = isAdmin ? '' : 'none';
  if (auditTab) auditTab.style.display = isAdmin ? '' : 'none';

  // Show employee summary card
  const empSummary = document.getElementById('emp-summary-card');
  if (empSummary) empSummary.style.display = ATT_USER.employeeId ? 'block' : 'none';

  // Load data
  loadClockStatus();
  loadOverviewStats();
  if (ATT_USER.employeeId) loadMySummary();
}

// ── Check clock-in status for today ──
async function loadClockStatus() {
  try {
    const res = await apiFetch('/api/attendance/status');
    if (!res || !res.ok) return;
    const data = await res.json();

    const statusEl = document.getElementById('att-clock-status');
    const btnIn = document.getElementById('btn-clock-in');
    const btnOut = document.getElementById('btn-clock-out');

    if (!data.clocked_in) {
      statusEl.innerHTML = '⚪ Not clocked in yet today';
      btnIn.disabled = false;
      btnIn.style.display = '';
      btnOut.style.display = 'none';
    } else if (!data.clocked_out) {
      statusEl.innerHTML = `🟢 Clocked in at <strong>${data.record.time_in}</strong> — Session active`;
      btnIn.style.display = 'none';
      btnOut.style.display = '';
      btnOut.disabled = false;
    } else {
      statusEl.innerHTML = `✅ Completed — In: <strong>${data.record.time_in}</strong> · Out: <strong>${data.record.time_out}</strong>`;
      btnIn.style.display = 'none';
      btnOut.style.display = 'none';
    }
  } catch (e) { console.error('Clock status error:', e); }
}

// ── QR Scan flow ──
function startClockIn() {
  QR_SCAN_MODE = 'clock-in';
  openQrScanner();
}

function startClockOut() {
  QR_SCAN_MODE = 'clock-out';
  openQrScanner();
}

function openQrScanner() {
  const container = document.getElementById('qr-scanner-container');
  container.style.display = 'block';
  document.getElementById('qr-scan-status').textContent = 'Point camera at the site QR code...';

  // Use html5-qrcode if available, otherwise fallback to manual input
  if (typeof Html5Qrcode !== 'undefined') {
    startHtml5QrScanner();
  } else {
    // Fallback: load the library dynamically
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    script.onload = () => startHtml5QrScanner();
    script.onerror = () => showManualQrInput();
    document.head.appendChild(script);
  }
}

let html5QrScanner = null;

function startHtml5QrScanner() {
  const reader = document.getElementById('qr-reader');
  reader.innerHTML = '';

  html5QrScanner = new Html5Qrcode('qr-reader');
  html5QrScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      html5QrScanner.stop().then(() => {
        processQrScan(decodedText);
      });
    },
    () => {}
  ).catch(err => {
    console.warn('Camera error:', err);
    showManualQrInput();
  });
}

function showManualQrInput() {
  const reader = document.getElementById('qr-reader');
  reader.innerHTML = `
    <div style="padding:20px;text-align:center;">
      <div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Camera unavailable. Enter QR code manually:</div>
      <input type="text" id="manual-qr-input" placeholder="LGSV_ATT:..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text);margin-bottom:12px;" />
      <button class="btn btn-primary" onclick="processQrScan(document.getElementById('manual-qr-input').value)">Submit</button>
    </div>
  `;
}

function cancelQrScan() {
  if (html5QrScanner) {
    html5QrScanner.stop().catch(() => {});
    html5QrScanner = null;
  }
  document.getElementById('qr-scanner-container').style.display = 'none';
  QR_SCAN_MODE = null;
}

async function processQrScan(qrData) {
  document.getElementById('qr-scan-status').innerHTML = '⏳ Validating location...';
  document.getElementById('qr-scanner-container').style.display = 'none';

  // Get GPS
  if (!navigator.geolocation) {
    alert('Geolocation not supported by your browser.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const fp = getDeviceFingerprint();

      const gpsEl = document.getElementById('gps-status');
      gpsEl.style.display = 'block';
      gpsEl.textContent = `📍 GPS: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;

      const endpoint = QR_SCAN_MODE === 'clock-in' ? '/api/attendance/clock-in' : '/api/attendance/clock-out';

      try {
        const res = await apiFetch(endpoint, {
          method: 'POST',
          body: JSON.stringify({
            qr_token: qrData,
            latitude: lat,
            longitude: lng,
            device_fingerprint: fp
          })
        });

        const data = await res.json();
        if (!res.ok) {
          alert('❌ ' + (data.error || 'Failed'));
        } else {
          alert('✅ ' + data.message);
          loadClockStatus();
          loadOverviewStats();
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }

      QR_SCAN_MODE = null;
      setTimeout(() => { gpsEl.style.display = 'none'; }, 5000);
    },
    (err) => {
      alert('📍 GPS Error: ' + err.message + '\nPlease enable location services.');
      QR_SCAN_MODE = null;
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

// ── Generate Site QR (Admin) ──
async function generateSiteQR() {
  try {
    const res = await apiFetch('/api/attendance/qr/generate');
    if (!res || !res.ok) { const e = await res?.json(); alert(e?.error || 'Failed'); return; }
    const data = await res.json();
    document.getElementById('site-qr-img').src = data.qr;
    document.getElementById('site-qr-name').textContent = data.site_name;
    document.getElementById('site-qr-display').style.display = 'block';
  } catch (err) { alert('Error: ' + err.message); }
}

// ── Overview Stats ──
async function loadOverviewStats() {
  try {
    const res = await apiFetch('/api/attendance/overview');
    if (!res || !res.ok) return;
    const d = await res.json();

    const today = new Date(d.date);
    document.getElementById('att-date-label').textContent =
      `📅 ${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

    document.getElementById('stat-present').textContent = d.present || 0;
    document.getElementById('stat-late').textContent = d.late || 0;
    document.getElementById('stat-leave').textContent = d.on_leave || 0;
    document.getElementById('stat-absent').textContent = d.absent || 0;
    document.getElementById('stat-total-hours').textContent = (d.total_hours || 0) + 'h';
    document.getElementById('stat-overtime').textContent = (d.total_overtime || 0) + 'h';
  } catch (e) { console.error('Overview error:', e); }
}

// ── Employee Personal Summary ──
async function loadMySummary() {
  try {
    const res = await apiFetch('/api/attendance/my-summary');
    if (!res || !res.ok) return;
    const d = await res.json();
    document.getElementById('my-present').textContent = d.present_days || 0;
    document.getElementById('my-overtime').textContent = (d.total_overtime || 0) + 'h';
    document.getElementById('my-absences').textContent = d.absent_days || 0;
  } catch (e) { console.error('Summary error:', e); }
}

// ── Records Tab ──
async function loadAttRecords() {
  const isAdmin = ATT_USER && ATT_USER.role !== 'employee';
  const endpoint = isAdmin ? '/api/attendance/all' : '/api/attendance/my-records';
  const params = new URLSearchParams();

  if (isAdmin) {
    const search = document.getElementById('att-search')?.value;
    const date = document.getElementById('att-date-filter')?.value;
    if (search) params.set('search', search);
    if (date) params.set('date', date);
  }

  try {
    const url = endpoint + (params.toString() ? '?' + params.toString() : '');
    const res = await apiFetch(url);
    if (!res || !res.ok) return;
    ATT_RECORDS = await res.json();
    renderAttRecords();
  } catch (e) { console.error('Records error:', e); }
}

function renderAttRecords() {
  const tbody = document.getElementById('att-records-tbody');
  if (!tbody) return;
  const isAdmin = ATT_USER && ATT_USER.role !== 'employee';

  if (ATT_RECORDS.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px;">No attendance records found.</td></tr>';
    return;
  }

  tbody.innerHTML = ATT_RECORDS.map(r => {
    const hours = r.time_in && r.time_out
      ? Math.max(0, (new Date('1970-01-01T' + r.time_out) - new Date('1970-01-01T' + r.time_in)) / 3600000).toFixed(1)
      : '-';
    const statusColor = r.status === 'Present' ? 'green' : r.status === 'Late' ? 'yellow' : r.status === 'Absent' ? 'red' : 'blue';
    const name = r.employee_name || 'You';
    const dateStr = new Date(r.date).toLocaleDateString();

    return `<tr data-att-id="${r.attendance_id}">
      <td><div style="font-weight:600;">${name}</div>${r.employee_code ? `<div style="font-size:11px;color:var(--muted);">${r.employee_code}</div>` : ''}</td>
      <td>${dateStr}</td>
      <td>${r.time_in || '-'}</td>
      <td>${r.time_out || '<span style="color:var(--yellow);">Active</span>'}</td>
      <td>${hours}h</td>
      <td>${r.overtime_hours || 0}h</td>
      <td><span class="badge badge-${statusColor}">${r.status}</span></td>
      ${isAdmin ? `<td><button class="btn btn-outline btn-sm" style="font-size:11px;" onclick="openOverrideModal(${r.attendance_id})">✏️ Edit</button></td>` : ''}
    </tr>`;
  }).join('');
}

function clearAttFilters() {
  const s = document.getElementById('att-search');
  const d = document.getElementById('att-date-filter');
  if (s) s.value = '';
  if (d) d.value = '';
  loadAttRecords();
}

// ── Override Modal ──
function openOverrideModal(attId) {
  const record = ATT_RECORDS.find(r => r.attendance_id === attId);
  if (!record) return;
  document.getElementById('override-att-id').value = attId;
  document.getElementById('override-emp-info').innerHTML =
    `<strong>${record.employee_name}</strong> · ${new Date(record.date).toLocaleDateString()}<br>Current: In ${record.time_in || '-'} · Out ${record.time_out || '-'}`;
  document.getElementById('override-time-in').value = record.time_in || '';
  document.getElementById('override-time-out').value = record.time_out || '';
  const modal = document.getElementById('override-modal');
  modal.style.display = 'flex';
}

function closeOverrideModal() {
  document.getElementById('override-modal').style.display = 'none';
}

async function submitOverride() {
  const attId = document.getElementById('override-att-id').value;
  const timeIn = document.getElementById('override-time-in').value;
  const timeOut = document.getElementById('override-time-out').value;

  if (!timeIn && !timeOut) { alert('Enter at least one time value.'); return; }
  if (!confirm('⚠️ This override will be permanently recorded in the audit log.\n\nContinue?')) return;

  try {
    const body = {};
    if (timeIn) body.time_in = timeIn;
    if (timeOut) body.time_out = timeOut;
    const res = await apiFetch(`/api/attendance/${attId}/override`, {
      method: 'PATCH', body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Override failed.'); return; }
    alert('✅ ' + data.message);
    closeOverrideModal();
    loadAttRecords();
  } catch (err) { alert('Error: ' + err.message); }
}

// ── Overtime Tab ──
async function loadOvertimeTab() {
  // Populate employee dropdown
  try {
    const res = await apiFetch('/api/employees');
    if (!res || !res.ok) return;
    const employees = (await res.json()).sort((a, b) => a.id - b.id);
    const sel = document.getElementById('ot-employee');
    if (sel) {
      sel.innerHTML = '<option value="">-- Select Employee --</option>' +
        employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name} (${e.employee_code})</option>`).join('');
    }
  } catch (e) { console.error(e); }
}

async function encodeOvertime() {
  const empId = document.getElementById('ot-employee').value;
  const date = document.getElementById('ot-date').value;
  const hours = parseFloat(document.getElementById('ot-hours').value);

  if (!empId || !date || isNaN(hours)) { alert('Please fill all fields.'); return; }

  // Find the attendance record for this employee + date
  try {
    const searchRes = await apiFetch(`/api/attendance/all?date=${date}&search=`);
    if (!searchRes || !searchRes.ok) { alert('Failed to search records.'); return; }
    const records = await searchRes.json();
    const record = records.find(r => r.employee_id == empId);

    if (!record) {
      alert('No attendance record found for this employee on the selected date.');
      return;
    }

    if (!confirm(`Encode ${hours}h overtime for ${record.employee_name} on ${new Date(date).toLocaleDateString()}?`)) return;

    const res = await apiFetch(`/api/attendance/${record.attendance_id}/overtime`, {
      method: 'PATCH', body: JSON.stringify({ overtime_hours: hours })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed'); return; }
    alert('✅ ' + data.message);
    document.getElementById('ot-hours').value = '';
  } catch (err) { alert('Error: ' + err.message); }
}

// ── Audit Log Tab ──
async function loadAuditLog() {
  try {
    const res = await apiFetch('/api/attendance/audit-log');
    if (!res || !res.ok) return;
    const logs = await res.json();
    const tbody = document.getElementById('audit-tbody');
    if (!tbody) return;

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No audit records yet.</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(l => `
      <tr>
        <td style="font-size:12px;white-space:nowrap;">${new Date(l.timestamp).toLocaleString()}</td>
        <td><span style="font-weight:600;">${l.performed_by}</span></td>
        <td>${l.employee_name || '-'}</td>
        <td style="font-size:12px;">${l.action_performed}</td>
        <td style="font-size:11px;color:var(--red);max-width:150px;overflow:hidden;text-overflow:ellipsis;" title="${l.old_value || ''}">${l.old_value || '-'}</td>
        <td style="font-size:11px;color:var(--green);max-width:150px;overflow:hidden;text-overflow:ellipsis;" title="${l.new_value || ''}">${l.new_value || '-'}</td>
        <td style="font-size:11px;color:var(--muted);">${l.ip_address || '-'}</td>
      </tr>
    `).join('');
  } catch (e) { console.error('Audit log error:', e); }
}

// ── Page activation watcher ──
function watchAttendanceActivation() {
  const observer = new MutationObserver(() => {
    const page = document.querySelector('#page-attendance.active');
    if (page && !page.dataset.attLoaded) {
      page.dataset.attLoaded = '1';
      initAttendance();
    }
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
}

window.addEventListener('DOMContentLoaded', watchAttendanceActivation);

// Expose globally
window.switchAttTab = switchAttTab;
window.startClockIn = startClockIn;
window.startClockOut = startClockOut;
window.cancelQrScan = cancelQrScan;
window.generateSiteQR = generateSiteQR;
window.loadAttRecords = loadAttRecords;
window.clearAttFilters = clearAttFilters;
window.openOverrideModal = openOverrideModal;
window.closeOverrideModal = closeOverrideModal;
window.submitOverride = submitOverride;
window.encodeOvertime = encodeOvertime;
