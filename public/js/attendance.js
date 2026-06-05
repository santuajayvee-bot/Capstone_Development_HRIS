/* ============================================================
   Attendance Management Module UI
   ============================================================ */

let ATT_USER = null;
let ATT_RECORDS = [];
let ATT_EMPLOYEES = [];
let ATT_DEVICES = [];
let QR_SCAN_MODE = null;
let DEVICE_FP = null;
let html5QrScanner = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function isHr() { return ['hr_admin', 'hr_manager', 'admin'].includes(ATT_USER?.role); }
function isSystemAdmin() { return ['system_admin', 'admin'].includes(ATT_USER?.role); }
function isPayrollOfficer() { return ATT_USER?.role === 'payroll_officer'; }
function isPayrollManager() { return ATT_USER?.role === 'payroll_manager'; }
function isEmployee() { return ATT_USER?.role === 'employee'; }

function setVisible(id, visible) {
  const element = document.getElementById(id);
  if (element) element.style.display = visible ? '' : 'none';
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-PH');
}

function badge(value) {
  const text = String(value || '-');
  const normalized = text.toLowerCase();
  const color = normalized.includes('validated') || normalized.includes('success') || normalized === 'present' || normalized === 'anchored'
    ? 'green'
    : normalized.includes('reject') || normalized.includes('fail') || normalized === 'absent'
      ? 'red'
      : normalized.includes('incomplete') || normalized.includes('review') || normalized.includes('late') || normalized.includes('partial')
        ? 'yellow'
        : 'blue';
  return `<span class="badge badge-${color}">${esc(text)}</span>`;
}

function calculateHours(timeIn, timeOut) {
  if (!timeIn || !timeOut) return '-';
  const milliseconds = new Date(`1970-01-01T${timeOut}`) - new Date(`1970-01-01T${timeIn}`);
  return `${Math.max(0, milliseconds / 3600000).toFixed(1)}h`;
}

function getDeviceFingerprint() {
  if (DEVICE_FP) return DEVICE_FP;
  const raw = [
    navigator.userAgent,
    `${screen.width}x${screen.height}`,
    screen.colorDepth,
    navigator.language,
    navigator.hardwareConcurrency,
    new Date().getTimezoneOffset()
  ].join('|');
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(index);
    hash |= 0;
  }
  DEVICE_FP = `DFP-${Math.abs(hash).toString(36)}`;
  return DEVICE_FP;
}

function switchAttTab(tab, element) {
  ['overview', 'records', 'overtime', 'exceptions', 'biometric', 'audit'].forEach(name => {
    const panel = document.getElementById(`att-${name}`);
    if (panel) panel.style.display = name === tab ? 'block' : 'none';
  });
  document.querySelectorAll('#page-attendance .attendance-tabs .tab').forEach(item => item.classList.remove('active'));
  if (element) element.classList.add('active');

  if (tab === 'records') loadAttRecords();
  if (tab === 'overtime') loadEmployees();
  if (tab === 'exceptions') loadBiometricExceptions();
  if (tab === 'biometric') loadBiometricWorkspace();
  if (tab === 'audit') loadAuditLog();
}

async function initAttendance() {
  ATT_USER = getUser();
  if (!ATT_USER) return;

  setVisible('qr-attendance-card', !!ATT_USER.employeeId && !isSystemAdmin());
  setVisible('qr-generate-card', isHr());
  setVisible('emp-summary-card', isEmployee() && !!ATT_USER.employeeId);
  setVisible('att-tab-overtime', isHr());
  setVisible('att-tab-exceptions', isHr());
  setVisible('att-tab-biometric', isSystemAdmin());
  setVisible('att-tab-audit', isHr() || isSystemAdmin());
  setVisible('btn-manual-attendance', isHr());

  const controls = document.querySelector('.att-toolbar');
  if (controls) controls.style.display = isEmployee() ? 'none' : 'flex';

  if (isSystemAdmin() && !isHr()) {
    const biometricTab = document.getElementById('att-tab-biometric');
    switchAttTab('biometric', biometricTab);
    return;
  }

  if (ATT_USER.employeeId) {
    loadClockStatus();
    loadMySummary();
  }
  loadOverviewStats();
}

async function loadClockStatus() {
  try {
    const res = await apiFetch('/api/attendance/status');
    if (!res?.ok) return;
    const data = await res.json();
    const label = document.getElementById('att-clock-status');
    const clockIn = document.getElementById('btn-clock-in');
    const clockOut = document.getElementById('btn-clock-out');
    if (!label || !clockIn || !clockOut) return;

    if (!data.clocked_in) {
      label.textContent = 'No attendance recorded yet today.';
      clockIn.disabled = false;
      clockIn.style.display = '';
      clockOut.style.display = 'none';
    } else if (!data.clocked_out) {
      label.innerHTML = `Time-in recorded at <strong>${esc(data.record.time_in)}</strong>. Waiting for time-out.`;
      clockIn.style.display = 'none';
      clockOut.style.display = '';
      clockOut.disabled = false;
    } else {
      label.innerHTML = `Completed: <strong>${esc(data.record.time_in)}</strong> to <strong>${esc(data.record.time_out)}</strong> via ${esc(data.record.source)}.`;
      clockIn.style.display = 'none';
      clockOut.style.display = 'none';
    }
  } catch (err) {
    console.error('Attendance status error:', err);
  }
}

async function loadOverviewStats() {
  try {
    const res = await apiFetch('/api/attendance/overview');
    if (!res?.ok) return;
    const data = await res.json();
    document.getElementById('att-date-label').textContent = formatDate(data.date);
    document.getElementById('stat-present').textContent = data.present || 0;
    document.getElementById('stat-late').textContent = data.late || 0;
    document.getElementById('stat-leave').textContent = data.on_leave || 0;
    document.getElementById('stat-absent').textContent = data.absent || 0;
    document.getElementById('stat-total-hours').textContent = `${Number(data.total_hours || 0).toFixed(1)}h`;
    document.getElementById('stat-overtime').textContent = `${Number(data.total_overtime || 0).toFixed(1)}h`;
  } catch (err) {
    console.error('Attendance overview error:', err);
  }
}

async function loadMySummary() {
  try {
    const res = await apiFetch('/api/attendance/my-summary');
    if (!res?.ok) return;
    const data = await res.json();
    document.getElementById('my-present').textContent = data.present_days || 0;
    document.getElementById('my-overtime').textContent = `${Number(data.total_overtime || 0).toFixed(1)}h`;
    document.getElementById('my-absences').textContent = data.absent_days || 0;
  } catch (err) {
    console.error('Personal attendance summary error:', err);
  }
}

async function loadAttRecords() {
  try {
    const params = new URLSearchParams();
    const date = document.getElementById('att-date-filter')?.value;
    const search = document.getElementById('att-search')?.value;
    if (date) params.set('date', date);
    if (search && !isPayrollManager()) params.set('search', search);

    const endpoint = isEmployee()
      ? '/api/attendance/my-records'
      : isPayrollManager()
        ? '/api/attendance/summaries'
        : '/api/attendance/all';
    const res = await apiFetch(`${endpoint}${params.toString() ? `?${params}` : ''}`);
    if (!res?.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to load attendance records.');
    }
    ATT_RECORDS = await res.json();
    renderAttRecords();
  } catch (err) {
    console.error(err);
    const tbody = document.getElementById('att-records-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="att-empty">${esc(err.message)}</td></tr>`;
  }
}

function renderAttRecords() {
  const tbody = document.getElementById('att-records-tbody');
  if (!tbody) return;
  if (!ATT_RECORDS.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="att-empty">No attendance records found.</td></tr>';
    return;
  }

  tbody.innerHTML = ATT_RECORDS.map(record => {
    const isSummary = Object.prototype.hasOwnProperty.call(record, 'regular_minutes');
    const attendanceId = record.attendance_id || '';
    const hours = isSummary ? `${(Number(record.regular_minutes || 0) / 60).toFixed(1)}h` : calculateHours(record.time_in, record.time_out);
    const overtime = isSummary ? `${(Number(record.overtime_minutes || 0) / 60).toFixed(1)}h` : `${Number(record.overtime_hours || 0).toFixed(1)}h`;
    const status = record.attendance_status || record.status;
    const verification = record.verification_status || '-';
    const actions = isHr() && attendanceId
      ? `<div class="att-actions">
           <button class="btn btn-outline btn-sm" onclick="openOverrideModal(${Number(attendanceId)})">Correct</button>
           <button class="btn btn-outline btn-sm" onclick="verifyAttendance(${Number(attendanceId)}, 'VALIDATED')">Verify</button>
         </div>`
      : attendanceId
        ? `<button class="btn btn-outline btn-sm" onclick="verifyIntegrity(${Number(attendanceId)})">Integrity</button>`
        : '-';

    return `<tr>
      <td><strong>${esc(record.employee_name || 'You')}</strong>${record.employee_code ? `<br><small>${esc(record.employee_code)}</small>` : ''}</td>
      <td>${esc(formatDate(record.attendance_date || record.date))}</td>
      <td>${esc(record.time_in || '-')}</td>
      <td>${esc(record.time_out || '-')}</td>
      <td>${esc(hours)}</td>
      <td>${esc(overtime)}</td>
      <td>${badge(status)}</td>
      <td>${badge(verification)}</td>
      <td>${esc(record.source || (isSummary ? 'Validated Summary' : '-'))}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

function clearAttFilters() {
  const search = document.getElementById('att-search');
  const date = document.getElementById('att-date-filter');
  if (search) search.value = '';
  if (date) date.value = '';
  loadAttRecords();
}

function openOverrideModal(attendanceId) {
  const record = ATT_RECORDS.find(item => Number(item.attendance_id) === Number(attendanceId));
  if (!record) return;
  document.getElementById('override-att-id').value = attendanceId;
  document.getElementById('override-emp-info').textContent = `${record.employee_name || 'Employee'} - ${formatDate(record.date)}`;
  document.getElementById('override-time-in').value = record.time_in || '';
  document.getElementById('override-time-out').value = record.time_out || '';
  document.getElementById('override-reason').value = '';
  document.getElementById('override-modal').style.display = 'flex';
}

function closeOverrideModal() {
  document.getElementById('override-modal').style.display = 'none';
}

async function submitOverride() {
  const attendanceId = document.getElementById('override-att-id').value;
  const body = {
    time_in: document.getElementById('override-time-in').value,
    time_out: document.getElementById('override-time-out').value,
    reason: document.getElementById('override-reason').value,
  };
  if (body.reason.trim().length < 8) return alert('Provide a clear correction reason of at least 8 characters.');
  try {
    const res = await apiFetch(`/api/attendance/${attendanceId}/override`, { method: 'PATCH', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(data.message);
    closeOverrideModal();
    loadAttRecords();
    loadOverviewStats();
  } catch (err) {
    alert(err.message);
  }
}

async function verifyAttendance(attendanceId, verificationStatus) {
  const reason = prompt(`Reason for marking this record ${verificationStatus}:`);
  if (!reason) return;
  try {
    const res = await apiFetch(`/api/attendance/${attendanceId}/verify`, {
      method: 'PATCH',
      body: JSON.stringify({ verification_status: verificationStatus, reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(data.message);
    loadAttRecords();
  } catch (err) {
    alert(err.message);
  }
}

async function verifyIntegrity(attendanceId) {
  try {
    const res = await apiFetch(`/api/attendance/integrity/${attendanceId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(`Integrity chain: ${data.chain_valid ? 'VALID' : 'INVALID'}\nVersions: ${data.versions}\nAnchor: ${data.latest_anchor_status || 'Not queued'}`);
  } catch (err) {
    alert(err.message);
  }
}

async function loadEmployees() {
  if (ATT_EMPLOYEES.length) {
    populateEmployeeSelects();
    return;
  }
  try {
    const res = await apiFetch('/api/employees');
    if (!res?.ok) return;
    ATT_EMPLOYEES = await res.json();
    populateEmployeeSelects();
  } catch (err) {
    console.error('Employee list error:', err);
  }
}

function populateEmployeeSelects() {
  const options = '<option value="">Select employee</option>' + ATT_EMPLOYEES
    .map(employee => `<option value="${Number(employee.id)}">${esc(employee.first_name)} ${esc(employee.last_name)} (${esc(employee.employee_code)})</option>`)
    .join('');
  ['ot-employee', 'manual-employee', 'bio-map-employee'].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.innerHTML = options;
  });
}

async function encodeOvertime() {
  const employeeId = document.getElementById('ot-employee').value;
  const date = document.getElementById('ot-date').value;
  const overtimeHours = Number(document.getElementById('ot-hours').value);
  const reason = document.getElementById('ot-reason').value;
  if (!employeeId || !date || !Number.isFinite(overtimeHours) || reason.trim().length < 8) {
    return alert('Select an employee, date, hours, and a reason of at least 8 characters.');
  }
  try {
    const search = await apiFetch(`/api/attendance/all?date=${encodeURIComponent(date)}`);
    const records = await search.json();
    const record = records.find(item => String(item.employee_id) === String(employeeId));
    if (!record) throw new Error('No attendance record exists for this employee and date.');
    const res = await apiFetch(`/api/attendance/${record.attendance_id}/overtime`, {
      method: 'PATCH',
      body: JSON.stringify({ overtime_hours: overtimeHours, reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(data.message);
    document.getElementById('ot-hours').value = '';
    document.getElementById('ot-reason').value = '';
  } catch (err) {
    alert(err.message);
  }
}

function openManualModal() {
  loadEmployees();
  document.getElementById('manual-modal').style.display = 'flex';
}

function closeManualModal() {
  document.getElementById('manual-modal').style.display = 'none';
}

async function submitManualAttendance() {
  const body = {
    employee_id: document.getElementById('manual-employee').value,
    date: document.getElementById('manual-date').value,
    time_in: document.getElementById('manual-time-in').value,
    time_out: document.getElementById('manual-time-out').value,
    reason: document.getElementById('manual-reason').value,
  };
  if (!body.employee_id || !body.date || body.reason.trim().length < 8) {
    return alert('Select an employee, date, and clear reason.');
  }
  try {
    const res = await apiFetch('/api/attendance/manual', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(data.message);
    closeManualModal();
    loadAttRecords();
  } catch (err) {
    alert(err.message);
  }
}

async function loadBiometricExceptions() {
  try {
    const res = await apiFetch('/api/attendance/biometric/exceptions');
    if (!res?.ok) return;
    const rows = await res.json();
    const tbody = document.getElementById('att-exceptions-tbody');
    tbody.innerHTML = rows.length ? rows.map(row => `<tr>
      <td>${esc(formatDateTime(row.scan_timestamp))}</td>
      <td>${esc(row.device_name)}</td>
      <td>${esc(row.employee_name || 'Unmapped')}</td>
      <td>${esc(row.attendance_type)}</td>
      <td>${badge(row.verification_status)}</td>
      <td>${esc(row.error_message || '-')}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="att-empty">No biometric exceptions.</td></tr>';
  } catch (err) {
    console.error(err);
  }
}

async function loadBiometricWorkspace() {
  await Promise.all([loadEmployees(), loadBiometricHealth(), loadBiometricMappings()]);
}

async function loadBiometricHealth() {
  try {
    const res = await apiFetch('/api/attendance/biometric/health');
    if (!res?.ok) return;
    const data = await res.json();
    ATT_DEVICES = data.devices || [];
    const tbody = document.getElementById('bio-health-tbody');
    tbody.innerHTML = ATT_DEVICES.length ? ATT_DEVICES.map(device => `<tr>
      <td><strong>${esc(device.device_name)}</strong><br><small>${esc(device.device_reference)}</small></td>
      <td>${esc(device.vendor || '-')}</td>
      <td>${Number(device.mapped_employees || 0)}</td>
      <td>${Number(device.exceptions || 0)}</td>
      <td>${esc(formatDateTime(device.last_success_at))}</td>
      <td>${esc(device.last_error_message || '-')}</td>
      <td><button class="btn btn-outline btn-sm" onclick="syncBiometricDevice(${Number(device.device_id)})">Sync Now</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="att-empty">No biometric devices configured.</td></tr>';
    populateDeviceSelect();
  } catch (err) {
    console.error(err);
  }
}

function populateDeviceSelect() {
  const select = document.getElementById('bio-map-device');
  if (!select) return;
  select.innerHTML = '<option value="">Select device</option>' + ATT_DEVICES
    .map(device => `<option value="${Number(device.device_id)}">${esc(device.device_name)}</option>`)
    .join('');
}

async function saveBiometricDevice() {
  const body = {
    device_reference: document.getElementById('bio-device-reference').value,
    device_name: document.getElementById('bio-device-name').value,
    vendor: document.getElementById('bio-device-vendor').value,
    api_base_url: document.getElementById('bio-device-url').value,
    logs_endpoint: document.getElementById('bio-device-endpoint').value,
    auth_type: document.getElementById('bio-device-auth').value,
    auth_secret: document.getElementById('bio-device-secret').value,
  };
  try {
    const res = await apiFetch('/api/attendance/biometric/devices', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(data.message);
    ['bio-device-reference', 'bio-device-name', 'bio-device-vendor', 'bio-device-url', 'bio-device-secret'].forEach(id => {
      document.getElementById(id).value = '';
    });
    loadBiometricHealth();
  } catch (err) {
    alert(err.message);
  }
}

async function loadBiometricMappings() {
  try {
    const res = await apiFetch('/api/attendance/biometric/mappings');
    if (!res?.ok) return;
    const rows = await res.json();
    const tbody = document.getElementById('bio-mapping-tbody');
    tbody.innerHTML = rows.length ? rows.map(row => `<tr>
      <td>${esc(row.device_name)}</td>
      <td>${esc(row.employee_name)}<br><small>${esc(row.employee_code)}</small></td>
      <td>${esc(row.biometric_user_reference)}</td>
      <td>${badge(row.is_active ? 'Active' : 'Disabled')}</td>
      <td>${row.is_active ? `<button class="btn btn-outline btn-sm" onclick="disableBiometricMapping(${Number(row.mapping_id)})">Disable</button>` : '-'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="att-empty">No encrypted mappings configured.</td></tr>';
  } catch (err) {
    console.error(err);
  }
}

async function saveBiometricMapping() {
  const body = {
    device_id: document.getElementById('bio-map-device').value,
    employee_id: document.getElementById('bio-map-employee').value,
    biometric_user_id: document.getElementById('bio-map-user-id').value,
  };
  try {
    const res = await apiFetch('/api/attendance/biometric/mappings', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(data.message);
    document.getElementById('bio-map-user-id').value = '';
    loadBiometricMappings();
    loadBiometricHealth();
  } catch (err) {
    alert(err.message);
  }
}

async function disableBiometricMapping(mappingId) {
  if (!confirm('Disable this biometric employee mapping?')) return;
  try {
    const res = await apiFetch(`/api/attendance/biometric/mappings/${mappingId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(data.message);
    loadBiometricMappings();
    loadBiometricHealth();
  } catch (err) {
    alert(err.message);
  }
}

async function syncBiometricDevice(deviceId) {
  try {
    const res = await apiFetch(`/api/attendance/biometric/sync/${deviceId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(`${data.message}\nAccepted: ${data.accepted}\nDuplicates: ${data.duplicates}\nRejected: ${data.rejected}`);
    loadBiometricHealth();
  } catch (err) {
    alert(err.message);
  }
}

async function anchorPendingIntegrity() {
  try {
    const res = await apiFetch('/api/attendance/integrity/anchor-pending', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert(`${data.message}\nAnchored: ${data.anchored}\nFailed: ${data.failed}`);
  } catch (err) {
    alert(err.message);
  }
}

async function loadAuditLog() {
  try {
    const res = await apiFetch('/api/attendance/audit-log');
    if (!res?.ok) return;
    const rows = await res.json();
    const tbody = document.getElementById('audit-tbody');
    tbody.innerHTML = rows.length ? rows.map(row => `<tr>
      <td>${esc(formatDateTime(row.timestamp))}</td>
      <td>${esc(row.performed_by)}</td>
      <td>${esc(row.employee_name || '-')}</td>
      <td>${esc(row.action_performed)}</td>
      <td>${esc(row.old_value || '-')}</td>
      <td>${esc(row.new_value || '-')}</td>
      <td>${esc(row.ip_address || '-')}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="att-empty">No attendance audit entries.</td></tr>';
  } catch (err) {
    console.error(err);
  }
}

function startClockIn() {
  QR_SCAN_MODE = 'clock-in';
  openQrScanner();
}

function startClockOut() {
  QR_SCAN_MODE = 'clock-out';
  openQrScanner();
}

function openQrScanner() {
  document.getElementById('qr-scanner-container').style.display = 'block';
  document.getElementById('qr-scan-status').textContent = 'Point the camera at the HR fallback QR code.';
  if (typeof Html5Qrcode !== 'undefined') return startHtml5QrScanner();
  const script = document.createElement('script');
  script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
  script.onload = startHtml5QrScanner;
  script.onerror = showManualQrInput;
  document.head.appendChild(script);
}

function startHtml5QrScanner() {
  document.getElementById('qr-reader').innerHTML = '';
  html5QrScanner = new Html5Qrcode('qr-reader');
  html5QrScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    decoded => html5QrScanner.stop().then(() => processQrScan(decoded)),
    () => {}
  ).catch(showManualQrInput);
}

function showManualQrInput() {
  document.getElementById('qr-reader').innerHTML = `
    <div class="att-note">
      <p>Camera unavailable. Enter the HR-issued fallback QR token.</p>
      <input type="text" id="manual-qr-input" placeholder="LGSV_ATT:..." />
      <button class="btn btn-primary btn-sm" onclick="processQrScan(document.getElementById('manual-qr-input').value)">Submit</button>
    </div>`;
}

function cancelQrScan() {
  if (html5QrScanner) html5QrScanner.stop().catch(() => {});
  html5QrScanner = null;
  QR_SCAN_MODE = null;
  document.getElementById('qr-scanner-container').style.display = 'none';
}

function processQrScan(qrToken) {
  if (!navigator.geolocation) return alert('Geolocation is unavailable in this browser.');
  navigator.geolocation.getCurrentPosition(async position => {
    const body = {
      qr_token: qrToken,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      device_fingerprint: getDeviceFingerprint(),
    };
    try {
      const endpoint = QR_SCAN_MODE === 'clock-in' ? '/api/attendance/clock-in' : '/api/attendance/clock-out';
      const res = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert(data.message);
      cancelQrScan();
      loadClockStatus();
      loadOverviewStats();
    } catch (err) {
      alert(err.message);
    }
  }, error => alert(`GPS error: ${error.message}`), { enableHighAccuracy: true, timeout: 15000 });
}

async function generateSiteQR() {
  try {
    const res = await apiFetch('/api/attendance/qr/generate');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('site-qr-img').src = data.qr;
    document.getElementById('site-qr-name').textContent = data.site_name;
    document.getElementById('site-qr-display').style.display = 'block';
  } catch (err) {
    alert(err.message);
  }
}

function watchAttendanceActivation() {
  const page = document.getElementById('page-attendance');
  if (!page) return;
  const initializeIfActive = () => {
    if (page.classList.contains('active') && !page.dataset.attLoaded && document.getElementById('att-overview')) {
      page.dataset.attLoaded = '1';
      initAttendance();
    }
  };
  new MutationObserver(initializeIfActive).observe(page, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('partialsLoaded', initializeIfActive);
  initializeIfActive();
}

window.addEventListener('DOMContentLoaded', watchAttendanceActivation);
window.initAttendance = initAttendance;
window.switchAttTab = switchAttTab;
window.startClockIn = startClockIn;
window.startClockOut = startClockOut;
window.cancelQrScan = cancelQrScan;
window.processQrScan = processQrScan;
window.generateSiteQR = generateSiteQR;
window.loadAttRecords = loadAttRecords;
window.clearAttFilters = clearAttFilters;
window.openOverrideModal = openOverrideModal;
window.closeOverrideModal = closeOverrideModal;
window.submitOverride = submitOverride;
window.verifyAttendance = verifyAttendance;
window.verifyIntegrity = verifyIntegrity;
window.encodeOvertime = encodeOvertime;
window.openManualModal = openManualModal;
window.closeManualModal = closeManualModal;
window.submitManualAttendance = submitManualAttendance;
window.loadBiometricExceptions = loadBiometricExceptions;
window.loadBiometricHealth = loadBiometricHealth;
window.saveBiometricDevice = saveBiometricDevice;
window.saveBiometricMapping = saveBiometricMapping;
window.disableBiometricMapping = disableBiometricMapping;
window.syncBiometricDevice = syncBiometricDevice;
window.anchorPendingIntegrity = anchorPendingIntegrity;
window.loadAuditLog = loadAuditLog;
