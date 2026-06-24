/* ============================================================
   Attendance Management Module UI
   ============================================================ */

let ATT_USER = null;
let ATT_RECORDS = [];
let ATT_EMPLOYEES = [];
let ATT_DEPARTMENTS = [];
let ATT_DEVICES = [];
let ATT_BIOMETRIC_MAPPINGS = [];
let BIOMETRIC_EXPECTED_SCAN = null;
let ATT_SELECTED_DETAIL_ID = null;
let ATT_ACTIVE_DATE_PICKER = null;
let ATT_RECORDS_PAGE = 1;
let ATT_RECORDS_FILTER_SIGNATURE = '';
let ATT_RECORDS_LOAD_SEQUENCE = 0;
let ATT_RECORDS_SEARCH_TIMER = null;
const ATT_RECORDS_PAGE_SIZE = 10;
const BIOMETRIC_BRIDGE_URL = window.BIOMETRIC_BRIDGE_URL || 'http://localhost:8787';
const LOCAL_BIOMETRIC_DEVICE_REFERENCE = 'ZK9500-LOCAL-001';

const ATT_DATE_PICKER_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const ATT_DATE_PICKER_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function toIsoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null;
  return date;
}

function closeAttendanceDatePicker() {
  if (!ATT_ACTIVE_DATE_PICKER) return;
  ATT_ACTIVE_DATE_PICKER.remove();
  ATT_ACTIVE_DATE_PICKER = null;
}

function positionAttendanceDatePicker(input, picker) {
  const rect = input.getBoundingClientRect();
  const top = window.scrollY + rect.bottom + 4;
  let left = window.scrollX + rect.left;
  picker.style.top = `${top}px`;
  picker.style.left = `${left}px`;

  const pickerRect = picker.getBoundingClientRect();
  const maxLeft = Math.max(12, window.scrollX + window.innerWidth - pickerRect.width - 12);
  if (left > maxLeft) {
    left = maxLeft;
    picker.style.left = `${left}px`;
  }
}

function renderAttendanceDatePicker(input, state) {
  if (!ATT_ACTIVE_DATE_PICKER) return;

  const currentValue = parseIsoDate(input.value);
  const today = new Date();
  const displayYear = state.displayDate.getFullYear();
  const displayMonth = state.displayDate.getMonth();
  const firstDay = new Date(displayYear, displayMonth, 1);
  const startDay = firstDay.getDay();
  const daysInMonth = new Date(displayYear, displayMonth + 1, 0).getDate();
  const monthOptions = ATT_DATE_PICKER_MONTHS.map((month, index) =>
    `<option value="${index}" ${index === displayMonth ? 'selected' : ''}>${month}</option>`
  ).join('');
  const yearStart = today.getFullYear() - 10;
  const yearEnd = today.getFullYear() + 10;
  const yearOptions = Array.from({ length: yearEnd - yearStart + 1 }, (_, offset) => {
    const year = yearStart + offset;
    return `<option value="${year}" ${year === displayYear ? 'selected' : ''}>${year}</option>`;
  }).join('');

  const cells = [];
  for (let index = 0; index < startDay; index += 1) {
    cells.push('<button type="button" class="attendance-date-picker-day is-empty" tabindex="-1" aria-hidden="true"></button>');
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(displayYear, displayMonth, day);
    const iso = toIsoDate(date);
    const isSelected = currentValue && toIsoDate(currentValue) === iso;
    const isToday = toIsoDate(today) === iso;
    cells.push(
      `<button type="button" class="attendance-date-picker-day${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}" data-date="${iso}">${day}</button>`
    );
  }

  ATT_ACTIVE_DATE_PICKER.innerHTML = `
    <div class="attendance-date-picker-header">
      <button type="button" class="attendance-date-picker-nav" data-nav="-1" aria-label="Previous month">&lsaquo;</button>
      <div class="attendance-date-picker-selects">
        <select class="attendance-date-picker-select" data-select="month">${monthOptions}</select>
        <select class="attendance-date-picker-select" data-select="year">${yearOptions}</select>
      </div>
      <button type="button" class="attendance-date-picker-nav" data-nav="1" aria-label="Next month">&rsaquo;</button>
    </div>
    <div class="attendance-date-picker-weekdays">
      ${ATT_DATE_PICKER_DAYS.map(day => `<span>${day}</span>`).join('')}
    </div>
    <div class="attendance-date-picker-grid">
      ${cells.join('')}
    </div>
    <div class="attendance-date-picker-actions">
      <button type="button" class="attendance-date-picker-action" data-action="today">Today</button>
      <button type="button" class="attendance-date-picker-action" data-action="clear">Clear</button>
    </div>
  `;

  positionAttendanceDatePicker(input, ATT_ACTIVE_DATE_PICKER);

  ATT_ACTIVE_DATE_PICKER.querySelectorAll('[data-nav]').forEach(button => {
    button.onclick = () => {
      state.displayDate = new Date(displayYear, displayMonth + Number(button.dataset.nav), 1);
      renderAttendanceDatePicker(input, state);
    };
  });

  ATT_ACTIVE_DATE_PICKER.querySelector('[data-select="month"]').onchange = event => {
    state.displayDate = new Date(displayYear, Number(event.target.value), 1);
    renderAttendanceDatePicker(input, state);
  };

  ATT_ACTIVE_DATE_PICKER.querySelector('[data-select="year"]').onchange = event => {
    state.displayDate = new Date(Number(event.target.value), displayMonth, 1);
    renderAttendanceDatePicker(input, state);
  };

  ATT_ACTIVE_DATE_PICKER.querySelectorAll('.attendance-date-picker-day[data-date]').forEach(button => {
    button.onclick = () => {
      input.value = button.dataset.date || '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closeAttendanceDatePicker();
    };
  });

  ATT_ACTIVE_DATE_PICKER.querySelector('[data-action="today"]').onclick = () => {
    input.value = toIsoDate(today);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    closeAttendanceDatePicker();
  };

  ATT_ACTIVE_DATE_PICKER.querySelector('[data-action="clear"]').onclick = () => {
    input.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    closeAttendanceDatePicker();
  };
}

function openAttendanceDatePicker(input) {
  if (!input) return;
  if (ATT_ACTIVE_DATE_PICKER?.dataset.inputId === input.id) {
    closeAttendanceDatePicker();
    return;
  }

  closeAttendanceDatePicker();

  const selectedDate = parseIsoDate(input.value) || new Date();
  const state = {
    displayDate: new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1),
  };
  const picker = document.createElement('div');
  picker.className = 'attendance-date-picker';
  picker.dataset.inputId = input.id;
  picker.addEventListener('mousedown', event => event.stopPropagation());
  ATT_ACTIVE_DATE_PICKER = picker;
  document.body.appendChild(picker);
  renderAttendanceDatePicker(input, state);
}

function initAttendanceDatePickers() {
  ['att-date-from-filter', 'att-date-to-filter', 'ot-date'].forEach(id => {
    const input = document.getElementById(id);
    if (!input || input.dataset.datePickerBound === '1') return;
    input.setAttribute('autocomplete', 'off');
    input.readOnly = true;
    input.dataset.datePickerBound = '1';
    input.addEventListener('click', event => {
      event.stopPropagation();
      if (ATT_ACTIVE_DATE_PICKER?.dataset.inputId !== input.id) {
        openAttendanceDatePicker(input);
      }
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openAttendanceDatePicker(input);
      }
      if (event.key === 'Escape') closeAttendanceDatePicker();
    });
  });
}

document.addEventListener('click', closeAttendanceDatePicker);
window.addEventListener('resize', closeAttendanceDatePicker);
window.addEventListener('scroll', closeAttendanceDatePicker, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeAttendanceDatePicker();
});

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
function canManageBiometrics() { return isHr() || isSystemAdmin(); }

function setVisible(id, visible) {
  const element = document.getElementById(id);
  if (element) element.style.display = visible ? '' : 'none';
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setBiometricDiagnostic(id, state, text, detail = '') {
  const pill = document.getElementById(`bio-diag-${id}`);
  const detailEl = document.getElementById(`bio-diag-${id}-detail`);
  const tone = state === 'ok' ? 'bio-success' : state === 'bad' ? 'bio-danger' : 'bio-warning';
  if (pill) {
    pill.className = `bio-pill ${tone}`;
    pill.textContent = text;
  }
  if (detailEl && detail) detailEl.textContent = detail;
}

function setBiometricActionStatus(message, tone = '') {
  const status = document.getElementById('bio-action-status');
  if (!status) return;
  status.textContent = message;
  status.className = `att-note${tone ? ` ${tone}` : ''}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-PH');
}

function badge(value, tone = '') {
  const text = String(value || '-');
  const normalized = text.toLowerCase();
  const color = tone || (normalized.includes('not ready')
    ? 'neutral'
    : normalized.includes('validated') || normalized.includes('success') || normalized.includes('payroll_ready') || normalized === 'ready' || normalized === 'present' || normalized === 'anchored'
    ? 'green'
    : normalized.includes('reject') || normalized.includes('fail') || normalized === 'absent'
      ? 'red'
      : normalized.includes('incomplete') || normalized.includes('review') || normalized.includes('late') || normalized.includes('partial')
        ? 'yellow'
        : normalized.includes('overtime')
          ? 'info'
          : 'neutral');
  return `<span class="badge badge-${color}">${esc(text)}</span>`;
}

function attendanceBadge(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('late') || normalized.includes('review') || normalized.includes('incomplete')) return badge(value, 'yellow');
  if (normalized.includes('overtime')) return badge(value, 'info');
  if (normalized.includes('undertime') || normalized.includes('half day')) return badge(value, 'neutral');
  return badge(value);
}

function minuteValue(record, summaryKey, logKey) {
  const summaryValue = Number(record?.[summaryKey] ?? NaN);
  if (Number.isFinite(summaryValue)) return Math.max(0, summaryValue);
  const logValue = Number(record?.[logKey] ?? 0);
  return Number.isFinite(logValue) ? Math.max(0, logValue) : 0;
}

function formatMinutes(value) {
  const minutes = Math.max(0, Math.round(Number(value || 0)));
  if (!minutes) return '-';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function attendanceFlagBadges(record) {
  const flags = [];
  const status = record.attendance_status || record.status || 'Present';
  const lateMinutes = minuteValue(record, 'summary_late_minutes', 'late_minutes');
  const undertimeMinutes = minuteValue(record, 'summary_undertime_minutes', 'undertime_minutes');
  const overtimeMinutes = minuteValue(record, 'summary_overtime_minutes', 'overtime_minutes');
  if (status && !['Late', 'Undertime', 'Overtime'].includes(status)) flags.push(status);
  if (lateMinutes > 0) flags.push('Late');
  if (undertimeMinutes > 0) flags.push('Undertime');
  if (overtimeMinutes > 0) flags.push('Overtime');
  return [...new Set(flags.length ? flags : [status || '-'])].map(flag => attendanceBadge(flag)).join(' ');
}

function primaryAttendanceStatus(record) {
  const validation = normalizeValidationStatus(record.verification_status);
  const status = String(record.attendance_status || record.status || '').trim();
  if (validation === 'NEEDS_REVIEW' || /needs review|incomplete/i.test(status)) return 'Needs Review';
  if (validation === 'REJECTED' || /rejected/i.test(status)) return 'Rejected';
  if (/absent/i.test(status)) return 'Absent';
  if (/half day/i.test(status)) return 'Half Day';
  return 'Present';
}

function attendanceSummary(record) {
  const lateMinutes = minuteValue(record, 'summary_late_minutes', 'late_minutes');
  const undertimeMinutes = minuteValue(record, 'summary_undertime_minutes', 'undertime_minutes');
  const overtimeMinutes = minuteValue(record, 'summary_overtime_minutes', 'overtime_minutes');
  const items = [
    { label: 'Late', value: formatMinutes(lateMinutes), tone: lateMinutes > 0 ? 'warn' : 'neutral' },
    { label: 'Undertime', value: formatMinutes(undertimeMinutes), tone: undertimeMinutes > 0 ? 'bad' : 'neutral' },
    { label: 'Overtime', value: formatMinutes(overtimeMinutes), tone: overtimeMinutes > 0 ? 'info' : 'neutral' }
  ].filter(item => item.value !== '-');
  return {
    items,
    text: items.length ? items.map(item => `${item.label} ${item.value}`).join(' · ') : 'Normal',
    title: `Late: ${formatMinutes(lateMinutes)} | Undertime: ${formatMinutes(undertimeMinutes)} | Overtime: ${formatMinutes(overtimeMinutes)}`
  };
}

function renderAttendanceSummaryCell(primaryStatus, summary) {
  const metricHtml = summary.items.length
    ? summary.items.map(item => `
        <span class="att-summary-chip att-summary-chip-${esc(item.tone)}">
          <span>${esc(item.label)}</span>
          <strong>${esc(item.value)}</strong>
        </span>
      `).join('')
    : '<span class="att-summary-normal">No late, undertime, or overtime</span>';

  return `
    <div class="att-summary-card">
      <div class="att-summary-status">${attendanceBadge(primaryStatus)}</div>
      <div class="att-summary-metrics">${metricHtml}</div>
    </div>
  `;
}

function validationLabel(value) {
  const normalized = normalizeValidationStatus(value);
  if (normalized === 'PAYROLL_READY') return 'Payroll Ready';
  if (normalized === 'VALIDATED' || normalized === 'CORRECTED_BY_HR') return formalValidationStatus(normalized);
  if (normalized === 'REJECTED') return 'Rejected';
  return formalValidationStatus(normalized);
}

function actionDotsIcon() {
  if (typeof window.renderActionDotsIcon === 'function') return window.renderActionDotsIcon();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="action-dots-icon bi bi-three-dots-vertical" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0"/>
  </svg>`;
}

function calculateHours(timeIn, timeOut) {
  if (!timeIn || !timeOut) return '-';
  const milliseconds = new Date(`1970-01-01T${timeOut}`) - new Date(`1970-01-01T${timeIn}`);
  return `${Math.max(0, milliseconds / 3600000).toFixed(1)}h`;
}

function switchAttTab(tab, element) {
  ATT_USER = ATT_USER || getUser();
  if (['overtime', 'exceptions', 'biometric', 'policies', 'audit'].includes(tab) && !canManageBiometrics()) {
    tab = 'overview';
    element = document.querySelector('[data-att-tab="overview"]');
  }
  if (tab === 'overtime' && !isHr()) {
    tab = 'overview';
    element = document.querySelector('[data-att-tab="overview"]');
  }
  ['overview', 'records', 'overtime', 'exceptions', 'biometric', 'policies', 'audit'].forEach(name => {
    const panel = document.getElementById(`att-${name}`);
    if (panel) panel.style.display = name === tab ? 'block' : 'none';
  });
  document.querySelectorAll('#page-attendance .attendance-tabs .tab').forEach(item => item.classList.remove('active'));
  if (element) element.classList.add('active');

  if (tab === 'records') loadAttRecords();
  if (tab === 'overtime') loadEmployees();
  if (tab === 'exceptions') loadBiometricExceptions();
  if (tab === 'biometric') loadBiometricWorkspace();
  if (tab === 'policies') loadAttendancePolicies();
  if (tab === 'audit') loadAuditLog();
}

async function initAttendance() {
  ATT_USER = getUser();
  if (!ATT_USER) return;
  initAttendanceDatePickers();

  setVisible('biometric-attendance-card', !!ATT_USER.employeeId && !isSystemAdmin());
  setVisible('emp-summary-card', isEmployee() && !!ATT_USER.employeeId);
  setVisible('att-tab-overtime', isHr());
  setVisible('att-tab-exceptions', isHr());
  setVisible('att-tab-biometric', canManageBiometrics());
  setVisible('att-tab-policies', canManageBiometrics());
  setVisible('att-tab-audit', canManageBiometrics());
  setVisible('btn-manual-attendance', isHr());

  const controls = document.querySelector('.att-toolbar');
  if (controls) controls.style.display = isEmployee() ? 'none' : 'flex';
  const recordActions = document.querySelector('#att-records .att-records-actionbar .att-actions');
  if (recordActions) recordActions.style.display = isEmployee() ? 'none' : 'flex';

  if (!canManageBiometrics()) {
    setText('att-page-title', 'My Attendance');
    setText('att-page-subtitle', 'Use fingerprint time in/out and monitor your attendance hours.');
    setText('att-banner-title', 'Fingerprint attendance');
    setText('att-banner-copy', 'Use the registered fingerprint scanner to record your time in and time out.');
    switchAttTab('overview', document.querySelector('[data-att-tab="overview"]'));
  } else {
    setText('att-page-title', 'Attendance Management');
    setText('att-page-subtitle', '');
    setText('att-banner-title', 'Attendance Overview');
    setText('att-banner-copy', 'Summary metrics only. Validate and correct attendance from Attendance Records.');
  }

  if (isSystemAdmin() && !isHr()) {
    const biometricTab = document.getElementById('att-tab-biometric');
    switchAttTab('biometric', biometricTab);
    return;
  }

  if (ATT_USER.employeeId) {
    loadClockStatus();
    loadBiometricAttendanceStatus();
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
    if (!label) return;

    if (!data.clocked_in) {
      label.textContent = 'No attendance recorded yet today. Use the Attendance Station to scan your fingerprint.';
    } else if (!data.clocked_out) {
      label.textContent = `Time-in recorded at ${data.record?.time_in || '-'}. Use the Attendance Station again for time-out.`;
    } else {
      label.textContent = `Completed: ${data.record?.time_in || '-'} to ${data.record?.time_out || '-'}.`;
    }
  } catch (err) {
    console.error('Attendance status error:', err);
  }
}

async function loadBiometricAttendanceStatus() {
  try {
    const res = await apiFetch('/api/biometric/status');
    if (!res?.ok) return;
    const data = await res.json();
    const device = data.device;
    const latest = data.latest_scan;
    const setText = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value ?? '-';
    };
    setText('bio-device-status', device
      ? `${device.device_name} (${device.device_reference}) - ${device.is_active ? 'Active' : 'Inactive'}`
      : 'No active ZK9500 device registered');
    setText('bio-scan-employee', latest?.employee_name || '-');
    setText('bio-scan-employee-id', latest?.employee_code || ATT_USER?.employeeCode || '-');
    setText('bio-scan-type', latest?.attendance_type || BIOMETRIC_EXPECTED_SCAN || '-');
    setText('bio-scan-time', latest?.scan_timestamp ? formatDateTime(latest.scan_timestamp) : '-');
    setText('bio-verification-result', latest?.verification_status || '-');
    setText('bio-attendance-result', latest?.error_message || (latest ? 'Attendance scan received.' : '-'));
  } catch (err) {
    const status = document.getElementById('bio-device-status');
    if (status) status.textContent = 'Biometric status unavailable.';
    console.error('Biometric status error:', err);
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
    const filterState = {
      search: document.getElementById('att-search')?.value || '',
      department: document.getElementById('att-department-filter')?.value || '',
      dateFrom: document.getElementById('att-date-from-filter')?.value || '',
      dateTo: document.getElementById('att-date-to-filter')?.value || '',
      status: document.getElementById('att-status-filter')?.value || '',
      validation: document.getElementById('att-validation-filter')?.value || '',
      payrollReady: document.getElementById('att-payroll-ready-filter')?.value || '',
    };
    const nextSignature = JSON.stringify(filterState);
    if (nextSignature !== ATT_RECORDS_FILTER_SIGNATURE) {
      ATT_RECORDS_PAGE = 1;
      ATT_RECORDS_FILTER_SIGNATURE = nextSignature;
    }
    const search = filterState.search;
    const department = filterState.department;
    const dateFrom = filterState.dateFrom;
    const dateTo = filterState.dateTo;
    const status = filterState.status;
    const validation = filterState.validation;
    const payrollReady = filterState.payrollReady;
    if (search) params.set('search', search);
    if (department) params.set('department', department);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (status) params.set('status', status);
    if (validation) params.set('validation_status', validation);
    if (payrollReady !== undefined && payrollReady !== '') params.set('payroll_ready', payrollReady);

    const endpoint = isEmployee()
      ? '/api/attendance/my-records'
      : '/api/attendance/all';
    const loadSequence = ++ATT_RECORDS_LOAD_SEQUENCE;
    const res = await apiFetch(`${endpoint}${params.toString() ? `?${params}` : ''}`);
    if (loadSequence !== ATT_RECORDS_LOAD_SEQUENCE) return;
    if (!res?.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to load attendance records.');
    }
    const records = await res.json();
    if (loadSequence !== ATT_RECORDS_LOAD_SEQUENCE) return;
    ATT_RECORDS = Array.isArray(records) ? records : [];
    console.log('[ATTENDANCE_REALTIME] Attendance API returned records', {
      endpoint,
      count: ATT_RECORDS.length,
      first: ATT_RECORDS[0] || null,
    });
    renderAttRecords();
    populateAttendanceDepartmentFilter();
  } catch (err) {
    console.error(err);
    const tbody = document.getElementById('att-records-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="att-empty">${esc(err.message)}</td></tr>`;
    renderAttendancePagination(0, 0, 0, 0);
  }
}

function scheduleAttRecordsLoad() {
  if (ATT_RECORDS_SEARCH_TIMER) clearTimeout(ATT_RECORDS_SEARCH_TIMER);
  ATT_RECORDS_SEARCH_TIMER = setTimeout(() => {
    ATT_RECORDS_SEARCH_TIMER = null;
    loadAttRecords();
  }, 250);
}

function normalizeValidationStatus(value) {
  const raw = String(value || '').toUpperCase();
  if (raw === 'VALIDATED') return 'PAYROLL_READY';
  return raw || '-';
}

function formalValidationStatus(value) {
  const normalized = normalizeValidationStatus(value);
  const labels = {
    PAYROLL_READY: 'Payroll Ready',
    PENDING_VALIDATION: 'Pending Validation',
    NEEDS_REVIEW: 'Needs Review',
    REJECTED: 'Rejected',
    CORRECTED_BY_HR: 'Corrected by HR',
    INCOMPLETE: 'Incomplete',
    VALIDATED: 'Validated'
  };
  if (labels[normalized]) return labels[normalized];
  return String(value || '-')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function isPayrollReadyRecord(record) {
  const status = normalizeValidationStatus(record.verification_status);
  return status === 'PAYROLL_READY' || Number(record.payroll_ready || record.payroll_eligible || 0) === 1;
}

function populateAttendanceDepartmentFilter() {
  const select = document.getElementById('att-department-filter');
  if (!select || select.dataset.loaded === '1') return;
  const departments = [...new Set(ATT_RECORDS.map(record => record.department).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">All Departments</option>' + departments.map(dept => `<option value="${esc(dept)}">${esc(dept)}</option>`).join('');
  if (departments.length) select.dataset.loaded = '1';
}

function renderAttRecords() {
  const tbody = document.getElementById('att-records-tbody');
  if (!tbody) return;
  if (!ATT_RECORDS.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="att-empty">No attendance records found.</td></tr>';
    renderAttendancePagination(0, 0, 0, 0);
    return;
  }

  const totalRows = ATT_RECORDS.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / ATT_RECORDS_PAGE_SIZE));
  ATT_RECORDS_PAGE = Math.min(Math.max(Number(ATT_RECORDS_PAGE || 1), 1), totalPages);
  const start = (ATT_RECORDS_PAGE - 1) * ATT_RECORDS_PAGE_SIZE;
  const end = Math.min(start + ATT_RECORDS_PAGE_SIZE, totalRows);
  const visibleRecords = ATT_RECORDS.slice(start, end);

  tbody.innerHTML = visibleRecords.map(record => {
    const isSummary = Object.prototype.hasOwnProperty.call(record, 'regular_minutes');
    const attendanceId = record.attendance_id || '';
    const hours = isSummary ? `${(Number(record.regular_minutes || 0) / 60).toFixed(1)}h` : calculateHours(record.time_in, record.time_out);
    const summary = attendanceSummary(record);
    const primaryStatus = primaryAttendanceStatus(record);
    const verification = validationLabel(record.verification_status);
    const payrollReady = isPayrollReadyRecord(record) ? 'Ready' : 'Not Ready';
    const actions = isHr() && attendanceId
      ? `<div class="att-row-menu">
           <button class="att-menu-trigger action-dots-button" onclick="toggleAttendanceActionMenu(event, ${Number(attendanceId)})" aria-label="Attendance actions">${actionDotsIcon()}</button>
           <div class="att-menu-panel" id="att-menu-${Number(attendanceId)}">
             <button onclick="openAttendanceDetail(${Number(attendanceId)})"><span>View</span> View Details</button>
             <button onclick="verifyAttendance(${Number(attendanceId)}, 'VALIDATED')"><span class="status-ok">✓</span> Validate</button>
             <button onclick="verifyAttendance(${Number(attendanceId)}, 'REJECTED')"><span class="status-bad">×</span> Reject</button>
             <button onclick="openOverrideModal(${Number(attendanceId)})"><span>Edit</span> Correct</button>
           </div>
         </div>`
      : attendanceId
        ? `<button class="btn btn-outline btn-sm" onclick="openAttendanceDetail(${Number(attendanceId)})">View</button>`
        : '-';

    return `<tr>
      <td>${attendanceId && isHr() ? `<input type="checkbox" class="att-row-select" value="${Number(attendanceId)}" />` : ''}</td>
      <td><strong>${esc(record.employee_name || 'You')}</strong>${record.employee_code ? `<br><small>${esc(record.employee_code)}</small>` : ''}</td>
      <td>${esc(record.department || '-')}</td>
      <td>${esc(formatDate(record.attendance_date || record.date))}</td>
      <td>${esc(record.time_in || '-')} - ${esc(record.time_out || '-')}</td>
      <td>${esc(hours)}</td>
      <td class="att-summary-cell" title="${esc(summary.title)}">
        ${renderAttendanceSummaryCell(primaryStatus, summary)}
      </td>
      <td>${badge(verification)}</td>
      <td>${badge(payrollReady)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
  renderAttendancePagination(totalRows, start + 1, end, totalPages);
  const selectAll = document.getElementById('att-select-all');
  if (selectAll) selectAll.checked = false;
}

function renderAttendancePagination(totalRows, start, end, totalPages) {
  const container = document.getElementById('att-records-pagination');
  if (!container) return;
  if (!totalRows) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  const currentPage = Math.min(Math.max(Number(ATT_RECORDS_PAGE || 1), 1), Math.max(1, totalPages));
  container.innerHTML = `
    <span class="att-records-pagination-summary">Showing ${start}-${end} of ${totalRows}</span>
    <div class="att-records-pagination-actions">
      <button class="btn btn-outline btn-sm" type="button" onclick="setAttendanceRecordsPage(1)" ${currentPage <= 1 ? 'disabled' : ''}>First</button>
      <button class="btn btn-outline btn-sm" type="button" onclick="setAttendanceRecordsPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="att-records-pagination-page">Page ${currentPage} of ${totalPages}</span>
      <button class="btn btn-outline btn-sm" type="button" onclick="setAttendanceRecordsPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
      <button class="btn btn-outline btn-sm" type="button" onclick="setAttendanceRecordsPage(${totalPages})" ${currentPage >= totalPages ? 'disabled' : ''}>Last</button>
    </div>
  `;
}

function setAttendanceRecordsPage(page) {
  const totalPages = Math.max(1, Math.ceil(ATT_RECORDS.length / ATT_RECORDS_PAGE_SIZE));
  ATT_RECORDS_PAGE = Math.min(Math.max(Number(page || 1), 1), totalPages);
  renderAttRecords();
}

function closeAttendanceActionMenus() {
  document.querySelectorAll('.att-menu-panel.open').forEach(menu => menu.classList.remove('open'));
}

function toggleAttendanceActionMenu(event, attendanceId) {
  event.stopPropagation();
  const menu = document.getElementById(`att-menu-${attendanceId}`);
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  closeAttendanceActionMenus();
  if (!isOpen) menu.classList.add('open');
}

function clearAttFilters() {
  ['att-search', 'att-department-filter', 'att-date-from-filter', 'att-date-to-filter', 'att-status-filter', 'att-validation-filter', 'att-payroll-ready-filter']
    .forEach(id => {
      const element = document.getElementById(id);
      if (element) element.value = '';
    });
  loadAttRecords();
}

function selectedAttendanceIds() {
  return [...document.querySelectorAll('.att-row-select:checked')]
    .map(input => Number(input.value))
    .filter(Boolean);
}

function toggleAllAttendanceRows(checked) {
  document.querySelectorAll('.att-row-select').forEach(input => {
    input.checked = checked;
  });
}

function firstSelectedAttendanceId() {
  const selected = selectedAttendanceIds();
  if (!selected.length) {
    alert('Select at least one attendance record first.');
    return null;
  }
  return selected[0];
}

async function bulkValidateAttendance() {
  const ids = selectedAttendanceIds();
  if (!ids.length) return alert('Select at least one attendance record to validate.');
  for (const id of ids) await verifyAttendance(id, 'VALIDATED', { silent: true });
  alert(`${ids.length} attendance record(s) validated.`);
  loadAttRecords();
  loadOverviewStats();
}

async function bulkRejectAttendance() {
  const ids = selectedAttendanceIds();
  if (!ids.length) return alert('Select at least one attendance record to reject.');
  const reason = prompt('Reason for rejecting selected attendance record(s):');
  if (!reason) return;
  for (const id of ids) await verifyAttendance(id, 'REJECTED', { reason, silent: true });
  alert(`${ids.length} attendance record(s) rejected.`);
  loadAttRecords();
  loadOverviewStats();
}

function bulkCorrectAttendance() {
  const id = firstSelectedAttendanceId();
  if (id) openOverrideModal(id);
}

function exportAttendanceRecords() {
  if (!ATT_RECORDS.length) return alert('No attendance records to export.');
  const headers = ['Employee', 'Department', 'Date', 'Time In', 'Time Out', 'Hours Worked', 'Late Minutes', 'Undertime Minutes', 'Overtime Minutes', 'Attendance Status', 'Validation Status', 'Payroll Ready'];
  const rows = ATT_RECORDS.map(record => [
    record.employee_name || 'You',
    record.department || '',
    formatDate(record.attendance_date || record.date),
    record.time_in || '',
    record.time_out || '',
    Object.prototype.hasOwnProperty.call(record, 'regular_minutes') ? `${(Number(record.regular_minutes || 0) / 60).toFixed(1)}h` : calculateHours(record.time_in, record.time_out),
    minuteValue(record, 'summary_late_minutes', 'late_minutes'),
    minuteValue(record, 'summary_undertime_minutes', 'undertime_minutes'),
    minuteValue(record, 'summary_overtime_minutes', 'overtime_minutes'),
    record.attendance_status || record.status || '',
    formalValidationStatus(record.verification_status),
    isPayrollReadyRecord(record) ? 'Ready' : 'Not Ready'
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `attendance-records-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function openAttendanceDetail(attendanceId) {
  closeAttendanceActionMenus();
  const record = ATT_RECORDS.find(item => Number(item.attendance_id) === Number(attendanceId));
  if (!record) return;
  ATT_SELECTED_DETAIL_ID = Number(attendanceId);
  const content = document.getElementById('attendance-detail-content');
  if (!content) return;
  const hours = Object.prototype.hasOwnProperty.call(record, 'regular_minutes')
    ? `${(Number(record.regular_minutes || 0) / 60).toFixed(1)}h`
    : calculateHours(record.time_in, record.time_out);
  const lateMinutes = minuteValue(record, 'summary_late_minutes', 'late_minutes');
  const undertimeMinutes = minuteValue(record, 'summary_undertime_minutes', 'undertime_minutes');
  const overtimeMinutes = minuteValue(record, 'summary_overtime_minutes', 'overtime_minutes');
  content.innerHTML = `
    <section>
      <h4>Employee Information</h4>
      <table><tbody>
        <tr><th>Employee</th><td>${esc(record.employee_name || 'You')}</td><th>Employee ID</th><td>${esc(record.employee_code || '-')}</td></tr>
        <tr><th>Department</th><td>${esc(record.department || '-')}</td><th>Position</th><td>${esc(record.position || '-')}</td></tr>
      </tbody></table>
    </section>
    <section>
      <h4>Attendance Details</h4>
      <table><tbody>
        <tr><th>Date</th><td>${esc(formatDate(record.attendance_date || record.date))}</td><th>Hours Worked</th><td>${esc(hours)}</td></tr>
        <tr><th>Time In</th><td>${esc(record.time_in || '-')}</td><th>Time Out</th><td>${esc(record.time_out || '-')}</td></tr>
        <tr><th>Attendance Status</th><td>${attendanceFlagBadges(record)}</td><th>Payroll Ready</th><td>${badge(isPayrollReadyRecord(record) ? 'Ready' : 'Not Ready')}</td></tr>
        <tr><th>Late Minutes</th><td>${esc(formatMinutes(lateMinutes))}</td><th>Undertime Minutes</th><td>${esc(formatMinutes(undertimeMinutes))}</td></tr>
        <tr><th>Overtime Minutes</th><td>${esc(formatMinutes(overtimeMinutes))}</td><th></th><td></td></tr>
      </tbody></table>
    </section>
    <section>
      <h4>Biometric Scan Information</h4>
      <table><tbody>
        <tr><th>Source</th><td>${esc(record.source || '-')}</td><th>Device</th><td>${esc(record.device_id || '-')}</td></tr>
        <tr><th>Integrity Hash</th><td colspan="3">${esc(record.integrity_hash || '-')}</td></tr>
      </tbody></table>
    </section>
    <section>
      <h4>Validation History</h4>
      <table><tbody>
        <tr><th>Validation Status</th><td>${badge(formalValidationStatus(record.verification_status))}</td><th>Latest Action</th><td>${esc(record.source || '-')}</td></tr>
      </tbody></table>
    </section>
    <section>
      <h4>Audit History</h4>
      <div class="att-muted">Open the Audit Log tab for complete immutable audit entries for this attendance record.</div>
    </section>
  `;
  document.getElementById('attendance-detail-modal').style.display = 'flex';
}

function closeAttendanceDetailModal() {
  document.getElementById('attendance-detail-modal').style.display = 'none';
  ATT_SELECTED_DETAIL_ID = null;
}

function detailValidateAttendance() {
  if (ATT_SELECTED_DETAIL_ID) verifyAttendance(ATT_SELECTED_DETAIL_ID, 'VALIDATED');
  closeAttendanceDetailModal();
}

function detailRejectAttendance() {
  if (ATT_SELECTED_DETAIL_ID) verifyAttendance(ATT_SELECTED_DETAIL_ID, 'REJECTED');
  closeAttendanceDetailModal();
}

function detailCorrectAttendance() {
  const id = ATT_SELECTED_DETAIL_ID;
  closeAttendanceDetailModal();
  if (id) openOverrideModal(id);
}

function openOverrideModal(attendanceId) {
  closeAttendanceActionMenus();
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
  const reason = document.getElementById('override-reason').value.trim();
  if (reason.length < 8) {
    alert('Provide a correction reason of at least 8 characters.');
    return;
  }
  const body = {
    time_in: document.getElementById('override-time-in').value,
    time_out: document.getElementById('override-time-out').value,
    reason,
  };
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

async function verifyAttendance(attendanceId, verificationStatus, options = {}) {
  closeAttendanceActionMenus();
  let reason = options.reason || '';
  if (verificationStatus !== 'VALIDATED') {
    reason = reason || prompt(`Reason for marking this record ${verificationStatus}:`);
    if (!reason) return;
  }
  try {
    const res = await apiFetch(`/api/attendance/${attendanceId}/verify`, {
      method: 'PATCH',
      body: JSON.stringify({ verification_status: verificationStatus, reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (!options.silent) {
      alert(data.message);
      loadAttRecords();
      loadOverviewStats();
    }
  } catch (err) {
    if (!options.silent) alert(err.message);
    else console.error(err);
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

async function loadEmployees(force = false) {
  if (ATT_EMPLOYEES.length && !force) {
    populateEmployeeSelects();
    populateManualAttendanceDepartments();
    return;
  }
  const manualEmployee = document.getElementById('manual-employee');
  const manualDepartment = document.getElementById('manual-department');
  if (manualEmployee) manualEmployee.innerHTML = '<option value="">Loading employees...</option>';
  if (manualDepartment) manualDepartment.innerHTML = '<option value="">Loading departments...</option>';
  try {
    const [employeeResponse, lookupResponse] = await Promise.all([
      apiFetch('/api/attendance/employees'),
      apiFetch('/api/employee-setup/lookups')
    ]);
    if (!employeeResponse?.ok) throw new Error('Unable to load active employees.');
    ATT_EMPLOYEES = await employeeResponse.json();
    if (lookupResponse?.ok) {
      const lookups = await lookupResponse.json();
      ATT_DEPARTMENTS = Array.isArray(lookups.departments) ? lookups.departments : [];
    } else {
      ATT_DEPARTMENTS = [];
    }
    if (!ATT_DEPARTMENTS.length) {
      ATT_DEPARTMENTS = [...new Set(ATT_EMPLOYEES.map(employee => employee.department).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b))
        .map((name, index) => ({ id: `name-${index}`, name }));
    }
    populateEmployeeSelects();
    populateManualAttendanceDepartments();
  } catch (err) {
    console.error('Employee list error:', err);
    if (manualEmployee) manualEmployee.innerHTML = '<option value="">Unable to load employees</option>';
    if (manualDepartment) manualDepartment.innerHTML = '<option value="">Unable to load departments</option>';
  }
}

function populateEmployeeSelects() {
  const options = '<option value="">Select employee</option>' + ATT_EMPLOYEES
    .map(employee => {
      const name = employee.employee_name || [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(' ') || employee.name || 'Employee';
      return `<option value="${Number(employee.id)}">${esc(name)} (${esc(employee.employee_code || employee.empCode || employee.id)})</option>`;
    })
    .join('');
  ['ot-employee', 'bio-map-employee'].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.innerHTML = options;
  });
  populateManualAttendanceEmployees();
}

function populateManualAttendanceDepartments() {
  const select = document.getElementById('manual-department');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">All Departments</option>' + ATT_DEPARTMENTS
    .map(department => `<option value="${esc(department.name)}">${esc(department.name)}</option>`)
    .join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function populateManualAttendanceEmployees() {
  const select = document.getElementById('manual-employee');
  if (!select) return;
  const department = document.getElementById('manual-department')?.value || '';
  const current = select.value;
  const employees = ATT_EMPLOYEES.filter(employee => !department || employee.department === department);
  select.innerHTML = `<option value="">${employees.length ? 'Select employee' : 'No active employees in this department'}</option>` + employees
    .map(employee => {
      const name = employee.employee_name || [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(' ') || employee.name || 'Employee';
      return `<option value="${Number(employee.id)}">${esc(name)} (${esc(employee.employee_code || employee.empCode || employee.id)})</option>`;
    })
    .join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
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

async function openManualModal() {
  document.getElementById('manual-modal').style.display = 'flex';
  await loadEmployees(true);
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
      <td>${badge(formalValidationStatus(row.verification_status))}</td>
      <td>${esc(row.error_message || '-')}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="att-empty">No biometric exceptions.</td></tr>';
  } catch (err) {
    console.error(err);
  }
}

async function loadBiometricWorkspace() {
  ATT_USER = ATT_USER || getUser();
  if (!canManageBiometrics()) {
    switchAttTab('overview', document.querySelector('[data-att-tab="overview"]'));
    return;
  }
  await Promise.all([loadEmployees(), loadBiometricHealth(), loadBiometricMappings(), loadBiometricEvents()]);
  updateFingerprintEnrollmentView();
  runBiometricDiagnostics();
}

async function loadBiometricHealth() {
  try {
    const res = await apiFetch('/api/attendance/biometric/health');
    if (!res?.ok) return;
    const data = await res.json();
    ATT_DEVICES = data.devices || [];
    renderScannerStatus();
    populateDeviceSelect();
  } catch (err) {
    console.error(err);
  }
}

function renderScannerStatus() {
  const device = ATT_DEVICES[0] || null;
  const status = document.getElementById('bio-hr-status');
  const name = document.getElementById('bio-hr-device-name');
  const sync = document.getElementById('bio-hr-last-sync');
  if (!status || !name || !sync) return;

  if (!device || !device.is_active) {
    status.className = 'bio-pill bio-danger';
    status.textContent = 'Disconnected';
    name.textContent = device?.device_name || '-';
    sync.textContent = '-';
    return;
  }

  status.className = device.last_error_message ? 'bio-pill bio-warning' : 'bio-pill bio-success';
  status.textContent = device.last_error_message ? 'Warning' : 'Connected';
  name.textContent = device.device_name || 'Fingerprint Scanner';
  sync.textContent = formatDateTime(device.last_success_at) || '-';
}

function populateDeviceSelect() {
  const select = document.getElementById('bio-map-device');
  if (!select) return;
  select.value = ATT_DEVICES[0]?.device_id || '';
}

async function checkLocalBiometricBridge() {
  try {
    const res = await fetchWithTimeout(`${BIOMETRIC_BRIDGE_URL}/health`, {}, 2500);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Bridge health check failed.');
    setBiometricDiagnostic('bridge', 'ok', 'Online', `${data.device_id || LOCAL_BIOMETRIC_DEVICE_REFERENCE} - ${data.status || 'Bridge running'}`);
    return data;
  } catch (err) {
    setBiometricDiagnostic('bridge', 'bad', 'Offline', 'Start tools/biometric-bridge/start-bridge-admin.ps1 as Administrator.');
    return null;
  }
}

async function runBiometricDiagnostics() {
  setBiometricActionStatus('Checking biometric setup...');
  const button = document.getElementById('bio-local-device-button');
  if (button) button.style.display = isSystemAdmin() ? '' : 'none';

  const bridge = await checkLocalBiometricBridge();
  if (!ATT_DEVICES.length) await loadBiometricHealth();
  const localDevice = ATT_DEVICES.find(device => device.device_reference === LOCAL_BIOMETRIC_DEVICE_REFERENCE) || ATT_DEVICES[0] || null;
  if (!localDevice) {
    setBiometricDiagnostic('device', 'bad', 'Missing', 'Register the local ZK9500 device in HRIS.');
  } else if (!Number(localDevice.is_active)) {
    setBiometricDiagnostic('device', 'bad', 'Inactive', `${localDevice.device_name || localDevice.device_reference} is disabled.`);
  } else {
    setBiometricDiagnostic('device', localDevice.last_error_message ? 'warn' : 'ok', localDevice.last_error_message ? 'Warning' : 'Registered', localDevice.last_error_message || `${localDevice.device_name || 'ZK9500'} is active.`);
  }

  if (!ATT_BIOMETRIC_MAPPINGS.length) await loadBiometricMappings();
  const activeMappings = ATT_BIOMETRIC_MAPPINGS.filter(item => Number(item.is_active) === 1).length;
  setBiometricDiagnostic(
    'mappings',
    activeMappings > 0 ? 'ok' : 'warn',
    String(activeMappings),
    activeMappings > 0 ? `${activeMappings} active fingerprint enrollment(s).` : 'Enroll at least one employee fingerprint.'
  );

  try {
    const res = await apiFetch('/api/biometric/status');
    const data = await res.json();
    const latest = data.latest_scan || null;
    if (latest) {
      setBiometricDiagnostic('scan', latest.error_message ? 'warn' : 'ok', latest.verification_status || 'Recorded', `${latest.employee_name || latest.employee_code || 'Unknown'} - ${formatDateTime(latest.scan_timestamp)}`);
    } else {
      setBiometricDiagnostic('scan', 'warn', 'No scans', 'No biometric scan has reached HRIS yet.');
    }
  } catch (err) {
    setBiometricDiagnostic('scan', 'warn', 'Unknown', 'Could not load latest biometric scan.');
  }

  if (!bridge) {
    setBiometricActionStatus('Bridge is offline. Start the ZK9500 bridge as Administrator, then run the check again.', 'att-error');
  } else if (!localDevice) {
    setBiometricActionStatus('Bridge is online, but HRIS has no local ZK9500 device. Use Local ZK9500 or register it in System Administration.', 'att-error');
  } else if (!activeMappings) {
    setBiometricActionStatus('Device is ready. Select an employee and enroll their fingerprint before scanning attendance.');
  } else {
    setBiometricActionStatus('Biometric setup looks ready. You can enroll, verify, or use the Attendance Station.');
  }
}

async function createLocalBiometricDevice() {
  if (!isSystemAdmin()) return alert('Only System Administrator can create biometric devices.');
  try {
    const res = await apiFetch('/api/attendance/biometric/devices', {
      method: 'POST',
      body: JSON.stringify({
        device_reference: LOCAL_BIOMETRIC_DEVICE_REFERENCE,
        device_name: 'Local ZK9500 Fingerprint Scanner',
        vendor: 'ZKTeco',
        api_base_url: '',
        logs_endpoint: '/scan',
        auth_type: 'NONE',
        auth_header_name: 'x-biometric-api-key',
        auth_secret: '',
      })
    });
    const data = await res.json();
    if (!res.ok && !/already exists/i.test(data.error || '')) throw new Error(data.error || 'Failed to create local biometric device.');
    await loadBiometricHealth();
    await runBiometricDiagnostics();
    alert(/already exists/i.test(data.error || '') ? 'Local ZK9500 device is already registered.' : 'Local ZK9500 device is registered.');
  } catch (err) {
    alert(err.message);
  }
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
    ATT_BIOMETRIC_MAPPINGS = await res.json();
    updateFingerprintEnrollmentView();
  } catch (err) {
    console.error(err);
  }
}

async function loadBiometricEvents() {
  try {
    const res = await apiFetch('/api/attendance/biometric/events');
    if (!res?.ok) return;
    const rows = await res.json();
    const tbody = document.getElementById('bio-events-tbody');
    if (!tbody) return;
    tbody.innerHTML = rows.length ? rows.map(row => `<tr>
      <td>${esc(row.employee_name || 'Unmapped')}<br><small>${esc(row.employee_code || '')}</small></td>
      <td>${esc(formatDateTime(row.scan_timestamp || row.created_at))}</td>
      <td>${esc((row.attendance_type || '-').replace('_', ' '))}</td>
      <td>${badge(formalValidationStatus(row.verification_status || '-'))}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="att-empty">No recent fingerprint activity.</td></tr>';
  } catch (err) {
    console.error(err);
  }
}

function updateFingerprintEnrollmentView() {
  const employeeId = document.getElementById('bio-map-employee')?.value;
  const status = document.getElementById('bio-fingerprint-status');
  const date = document.getElementById('bio-enrollment-date');
  if (!status || !date) return;
  const mapping = ATT_BIOMETRIC_MAPPINGS.find(item => String(item.employee_id) === String(employeeId) && item.is_active);

  if (!employeeId) {
    status.className = 'bio-pill bio-warning';
    status.textContent = 'Select employee';
    date.textContent = '-';
    setBiometricStep(1);
  } else if (mapping) {
    status.className = 'bio-pill bio-success';
    status.textContent = 'Enrolled';
    date.textContent = formatDate(mapping.created_at);
    setBiometricStep(4);
  } else {
    status.className = 'bio-pill bio-danger';
    status.textContent = 'Not enrolled';
    date.textContent = '-';
    setBiometricStep(1);
  }
}

function setBiometricStep(step) {
  for (let index = 1; index <= 4; index += 1) {
    const element = document.getElementById(`bio-step-${index}`);
    if (!element) continue;
    element.classList.toggle('active', index === step);
    element.classList.toggle('done', index < step);
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
    document.getElementById('bio-map-user-id').value = '';
    await loadBiometricMappings();
    await loadBiometricHealth();
    updateFingerprintEnrollmentView();
    alert('Fingerprint enrollment saved.');
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
    updateFingerprintEnrollmentView();
  } catch (err) {
    alert(err.message);
  }
}

function removeSelectedFingerprint() {
  const employeeId = document.getElementById('bio-map-employee')?.value;
  const mapping = ATT_BIOMETRIC_MAPPINGS.find(item => String(item.employee_id) === String(employeeId) && item.is_active);
  if (!mapping) return alert('No active fingerprint enrollment found for the selected employee.');
  return disableBiometricMapping(mapping.mapping_id);
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

async function enrollFingerprintFromBridge() {
  const employeeSelect = document.getElementById('bio-map-employee');
  const deviceId = document.getElementById('bio-map-device')?.value;
  const employeeId = employeeSelect?.value;
  if (!deviceId || !employeeId) return alert('Select an employee first. Make sure the scanner is connected.');

  const selectedText = employeeSelect.options[employeeSelect.selectedIndex]?.textContent || '';
  const codeMatch = selectedText.match(/\(([^)]+)\)/);

  try {
    setBiometricActionStatus('Checking local bridge before enrollment...');
    const bridge = await checkLocalBiometricBridge();
    if (!bridge) throw new Error('Local ZK9500 bridge is offline.');
    setBiometricStep(2);
    setBiometricActionStatus('Place the employee finger on the scanner. Capture requires three clean reads.');
    const res = await fetchWithTimeout(`${BIOMETRIC_BRIDGE_URL}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: Number(employeeId),
        employee_code: codeMatch ? codeMatch[1] : '',
        employee_name: selectedText.replace(/\s*\([^)]+\)\s*$/, ''),
      }),
    }, 30000);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fingerprint enrollment failed.');
    setBiometricStep(3);
    document.getElementById('bio-map-user-id').value = data.reference_id;
    await saveBiometricMapping();
    setBiometricStep(4);
    setBiometricActionStatus('Fingerprint enrolled and securely mapped to the employee.', 'att-success');
    runBiometricDiagnostics();
  } catch (err) {
    updateFingerprintEnrollmentView();
    setBiometricActionStatus(`Enrollment failed: ${err.message}`, 'att-error');
    alert(`Bridge enrollment failed: ${err.message}\n\nStart the LGSV ZK9500 bridge as Administrator, then try again.`);
  }
}

async function verifyBiometricEnrollment() {
  const employeeSelect = document.getElementById('bio-map-employee');
  const employeeId = employeeSelect?.value;
  const deviceId = document.getElementById('bio-map-device')?.value;
  if (!employeeId || !deviceId) return alert('Select an employee first. Make sure the scanner is connected.');

  const selectedText = employeeSelect.options[employeeSelect.selectedIndex]?.textContent || '';
  try {
    setBiometricActionStatus('Checking local bridge before verification...');
    const bridge = await checkLocalBiometricBridge();
    if (!bridge) throw new Error('Local ZK9500 bridge is offline.');
    setBiometricActionStatus('Place the enrolled finger on the scanner to verify.');
    const res = await fetchWithTimeout(`${BIOMETRIC_BRIDGE_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: Number(employeeId) }),
    }, 15000);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fingerprint verification failed.');
    if (!data.matched) {
      setBiometricActionStatus('Fingerprint matched a different employee.', 'att-error');
      return alert(`Fingerprint matched a different employee.\n\nSelected: ${selectedText}\nMatched: ${data.employee_name || data.employee_id}\nScore: ${data.score}`);
    }
    setBiometricActionStatus(`Fingerprint verified. Score: ${data.score}`, 'att-success');
    alert(`Fingerprint verified successfully.\n\nEmployee: ${selectedText}\nScore: ${data.score}`);
  } catch (err) {
    setBiometricActionStatus(`Verification failed: ${err.message}`, 'att-error');
    alert(`Bridge verification failed: ${err.message}\n\nMake sure the bridge is running and the employee fingerprint is enrolled.`);
  }
}

async function requestBiometricScan(scanType) {
  BIOMETRIC_EXPECTED_SCAN = scanType;
  const status = document.getElementById('bio-action-status');
  if (status) status.textContent = `Waiting for ${scanType.replace('_', ' ').toLowerCase()} fingerprint scan from the ZK9500 bridge...`;

  const employeeId = ATT_USER?.employeeId;
  if (!employeeId) {
    if (status) status.textContent = 'Your account is not linked to an employee record.';
    return alert('Your account is not linked to an employee record.');
  }

  try {
    await fetchWithTimeout(`${BIOMETRIC_BRIDGE_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: employeeId,
        scan_type: scanType,
        hris_api_url: `${window.location.origin}/api/biometric/attendance`,
        auth_token: typeof getToken === 'function' ? getToken() : '',
      }),
    }, 15000);
    if (status) status.textContent = 'Scan request sent. Place finger on the ZK9500 scanner.';
  } catch (err) {
    if (status) status.textContent = 'Local biometric bridge is not reachable. Start the C# ZK9500 bridge, then try again.';
  }

  setTimeout(async () => {
    await loadClockStatus();
    await loadBiometricAttendanceStatus();
    await loadOverviewStats();
    await loadMySummary();
  }, 2500);
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

async function loadAttendancePolicies() {
  try {
    const res = await apiFetch('/api/attendance/policies');
    if (!res?.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load attendance policies.');
    }
    const data = await res.json();
    setPolicyValue('policy-effective-date', new Date().toISOString().slice(0, 10));
    setPolicyValue('policy-work-start-time', data.work_start_time || '08:00');
    setPolicyValue('policy-work-end-time', data.work_end_time || '17:00');
    setPolicyValue('policy-break-start-time', data.break_start_time || '12:00');
    setPolicyValue('policy-break-end-time', data.break_end_time || '13:00');
    setPolicyValue('policy-standard-work-hours', data.standard_work_hours ?? 8);
    document.getElementById('policy-grace-period').value = data.grace_period_minutes ?? 10;
    setPolicyValue('policy-enable-late', String(data.enable_late_tracking ?? true));
    setPolicyValue('policy-late-threshold', data.late_threshold_minutes ?? 0);
    setPolicyValue('policy-count-late-payroll', String(data.count_late_for_payroll ?? true));
    setPolicyValue('policy-enable-undertime', String(data.enable_undertime_tracking ?? true));
    setPolicyValue('policy-count-undertime-payroll', String(data.count_undertime_for_payroll ?? true));
    setPolicyValue('policy-enable-half-day', String(data.enable_half_day_rule ?? true));
    setPolicyValue('policy-half-day-threshold', data.half_day_threshold_hours ?? 4);
    document.getElementById('policy-duplicate-window').value = data.duplicate_scan_window_seconds ?? 60;
    document.getElementById('policy-hr-validation').value = data.hr_validation_required ? '1' : '0';
    setPolicyValue('policy-auto-payroll-ready', String(data.auto_payroll_ready ?? false));
    setPolicyValue('policy-validation-expiration', data.validation_expiration_days ?? 3);
    setPolicyValue('policy-enable-overtime', String(data.enable_overtime ?? true));
    setPolicyValue('policy-overtime-threshold-minutes', data.overtime_threshold_minutes ?? 480);
    setPolicyValue('policy-overtime-approval', String(data.overtime_approval_required ?? true));
    setPolicyValue('policy-minimum-overtime', data.minimum_overtime_minutes ?? 30);
    document.getElementById('policy-missing-timeout').value = data.missing_timeout_handling || 'Needs Review';
    setPolicyValue('policy-payroll-source', data.payroll_attendance_source || 'payroll_ready');
    setPolicyValue('policy-working-days-month', data.working_days_per_month ?? 26);
    setPolicyValue('policy-late-deduction-method', data.late_deduction_method || 'auto_compute');
    setPolicyValue('policy-late-fixed-amount', data.late_fixed_deduction_amount ?? 0);
    setPolicyValue('policy-late-apply-grace', String(data.late_apply_grace_period ?? true));
    setPolicyValue('policy-late-approval', String(data.late_require_hr_approval ?? true));
    setPolicyValue('policy-undertime-deduction-method', data.undertime_deduction_method || 'auto_compute');
    setPolicyValue('policy-undertime-fixed-amount', data.undertime_fixed_deduction_amount ?? 0);
    setPolicyValue('policy-undertime-approval', String(data.undertime_require_hr_approval ?? true));
    setPolicyValue('policy-enable-holiday', String(data.enable_holiday_rules ?? false));
    setPolicyValue('policy-regular-holiday', data.regular_holiday_multiplier ?? 2);
    setPolicyValue('policy-special-holiday', data.special_holiday_multiplier ?? 1.3);
    setPolicyValue('policy-rest-day', data.rest_day_multiplier ?? 1.3);
    setPolicyValue('policy-holiday-overtime', data.holiday_overtime_multiplier ?? 1.3);
    setPolicyValue('policy-allow-manual', String(data.allow_manual_attendance ?? true));
    setPolicyValue('policy-allow-hr-correction', String(data.allow_hr_correction ?? true));
    setPolicyValue('policy-allow-manager-cert', String(data.allow_manager_certification ?? false));
    setPolicyValue('policy-device-failure', data.device_failure_handling || 'HR Correction Required');
    setText('attendance-policy-status', 'Active attendance policy loaded.');
  } catch (err) {
    setText('attendance-policy-status', err.message);
  }
}

function setPolicyValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

function switchAttendancePolicyTab(tabName, trigger) {
  document.querySelectorAll('[id^="policy-tab-"]').forEach(panel => {
    panel.style.display = panel.id === `policy-tab-${tabName}` ? 'block' : 'none';
  });
  document.querySelectorAll('[data-policy-tab]').forEach(tab => tab.classList.remove('active'));
  trigger?.classList?.add('active');
}

async function saveAttendancePolicies(event) {
  event?.preventDefault?.();
  const body = {
    effective_date: document.getElementById('policy-effective-date')?.value,
    work_start_time: document.getElementById('policy-work-start-time')?.value,
    work_end_time: document.getElementById('policy-work-end-time')?.value,
    break_start_time: document.getElementById('policy-break-start-time')?.value,
    break_end_time: document.getElementById('policy-break-end-time')?.value,
    standard_work_hours: document.getElementById('policy-standard-work-hours')?.value,
    grace_period_minutes: Number(document.getElementById('policy-grace-period')?.value || 0),
    enable_late_tracking: document.getElementById('policy-enable-late')?.value,
    late_threshold_minutes: document.getElementById('policy-late-threshold')?.value,
    count_late_for_payroll: document.getElementById('policy-count-late-payroll')?.value,
    enable_undertime_tracking: document.getElementById('policy-enable-undertime')?.value,
    count_undertime_for_payroll: document.getElementById('policy-count-undertime-payroll')?.value,
    enable_half_day_rule: document.getElementById('policy-enable-half-day')?.value,
    half_day_threshold_hours: document.getElementById('policy-half-day-threshold')?.value,
    duplicate_scan_window_seconds: Number(document.getElementById('policy-duplicate-window')?.value || 0),
    hr_validation_required: document.getElementById('policy-hr-validation')?.value === '1',
    require_hr_validation: document.getElementById('policy-hr-validation')?.value === '1',
    auto_payroll_ready: document.getElementById('policy-auto-payroll-ready')?.value,
    validation_expiration_days: document.getElementById('policy-validation-expiration')?.value,
    enable_overtime: document.getElementById('policy-enable-overtime')?.value,
    overtime_threshold_minutes: document.getElementById('policy-overtime-threshold-minutes')?.value,
    overtime_approval_required: document.getElementById('policy-overtime-approval')?.value,
    minimum_overtime_minutes: document.getElementById('policy-minimum-overtime')?.value,
    missing_timeout_handling: document.getElementById('policy-missing-timeout')?.value,
    payroll_attendance_source: document.getElementById('policy-payroll-source')?.value,
    working_days_per_month: document.getElementById('policy-working-days-month')?.value,
    late_deduction_method: document.getElementById('policy-late-deduction-method')?.value,
    late_fixed_deduction_amount: document.getElementById('policy-late-fixed-amount')?.value,
    late_apply_grace_period: document.getElementById('policy-late-apply-grace')?.value,
    late_require_hr_approval: document.getElementById('policy-late-approval')?.value,
    undertime_deduction_method: document.getElementById('policy-undertime-deduction-method')?.value,
    undertime_fixed_deduction_amount: document.getElementById('policy-undertime-fixed-amount')?.value,
    undertime_require_hr_approval: document.getElementById('policy-undertime-approval')?.value,
    enable_holiday_rules: document.getElementById('policy-enable-holiday')?.value,
    regular_holiday_multiplier: document.getElementById('policy-regular-holiday')?.value,
    special_holiday_multiplier: document.getElementById('policy-special-holiday')?.value,
    rest_day_multiplier: document.getElementById('policy-rest-day')?.value,
    holiday_overtime_multiplier: document.getElementById('policy-holiday-overtime')?.value,
    allow_manual_attendance: document.getElementById('policy-allow-manual')?.value,
    allow_hr_correction: document.getElementById('policy-allow-hr-correction')?.value,
    allow_manager_certification: document.getElementById('policy-allow-manager-cert')?.value,
    device_failure_handling: document.getElementById('policy-device-failure')?.value,
  };
  try {
    const res = await apiFetch('/api/attendance/policies', { method: 'PUT', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save attendance policies.');
    setText('attendance-policy-status', `${data.message || 'Attendance policies saved.'} ${data.changes?.length || 0} change(s) recorded.`);
  } catch (err) {
    setText('attendance-policy-status', err.message);
  }
}

window.addEventListener('DOMContentLoaded', watchAttendanceActivation);
window.initAttendance = initAttendance;
window.switchAttTab = switchAttTab;
window.requestBiometricScan = requestBiometricScan;
window.loadClockStatus = loadClockStatus;
window.loadOverviewStats = loadOverviewStats;
window.loadMySummary = loadMySummary;
window.loadAttRecords = loadAttRecords;
window.scheduleAttRecordsLoad = scheduleAttRecordsLoad;
window.setAttendanceRecordsPage = setAttendanceRecordsPage;
window.clearAttFilters = clearAttFilters;
window.toggleAllAttendanceRows = toggleAllAttendanceRows;
window.bulkValidateAttendance = bulkValidateAttendance;
window.bulkRejectAttendance = bulkRejectAttendance;
window.bulkCorrectAttendance = bulkCorrectAttendance;
window.exportAttendanceRecords = exportAttendanceRecords;
window.openAttendanceDetail = openAttendanceDetail;
window.closeAttendanceDetailModal = closeAttendanceDetailModal;
window.detailValidateAttendance = detailValidateAttendance;
window.detailRejectAttendance = detailRejectAttendance;
window.detailCorrectAttendance = detailCorrectAttendance;
window.toggleAttendanceActionMenu = toggleAttendanceActionMenu;
window.openOverrideModal = openOverrideModal;
window.closeOverrideModal = closeOverrideModal;
window.submitOverride = submitOverride;
window.verifyAttendance = verifyAttendance;
window.verifyIntegrity = verifyIntegrity;
window.encodeOvertime = encodeOvertime;
window.openManualModal = openManualModal;
window.populateManualAttendanceEmployees = populateManualAttendanceEmployees;
window.closeManualModal = closeManualModal;
window.submitManualAttendance = submitManualAttendance;
window.loadBiometricExceptions = loadBiometricExceptions;
window.loadBiometricHealth = loadBiometricHealth;
window.loadBiometricWorkspace = loadBiometricWorkspace;
window.loadBiometricEvents = loadBiometricEvents;
window.runBiometricDiagnostics = runBiometricDiagnostics;
window.createLocalBiometricDevice = createLocalBiometricDevice;
window.updateFingerprintEnrollmentView = updateFingerprintEnrollmentView;
window.removeSelectedFingerprint = removeSelectedFingerprint;
window.loadBiometricAttendanceStatus = loadBiometricAttendanceStatus;
window.saveBiometricDevice = saveBiometricDevice;
window.saveBiometricMapping = saveBiometricMapping;
window.enrollFingerprintFromBridge = enrollFingerprintFromBridge;
window.verifyBiometricEnrollment = verifyBiometricEnrollment;
window.disableBiometricMapping = disableBiometricMapping;
window.syncBiometricDevice = syncBiometricDevice;
window.anchorPendingIntegrity = anchorPendingIntegrity;
window.loadAuditLog = loadAuditLog;
window.loadAttendancePolicies = loadAttendancePolicies;
window.saveAttendancePolicies = saveAttendancePolicies;
window.switchAttendancePolicyTab = switchAttendancePolicyTab;
document.addEventListener('click', closeAttendanceActionMenus);
