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
let ATT_BIOMETRIC_EVENTS = [];
let ATT_BIOMETRIC_EVENTS_PAGE = 1;
let ATT_BIOMETRIC_EVENTS_SIGNATURE = '';
let ATT_HOLIDAYS = [];
let ATT_HOLIDAYS_PAGE = 1;
const ATT_RECORDS_PAGE_SIZE = 10;
const ATT_BIOMETRIC_EVENTS_PAGE_SIZE = 5;
const ATT_HOLIDAYS_PAGE_SIZE = 10;
const BIOMETRIC_BRIDGE_URL = window.BIOMETRIC_BRIDGE_URL || 'http://localhost:8787';
const LOCAL_BIOMETRIC_DEVICE_REFERENCE = 'ZK9500-LOCAL-001';

const ATT_DATE_PICKER_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const ATT_DATE_PICKER_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function manualAttendanceEl(id) {
  return document.querySelector(`#manual-modal #${id}`);
}

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

function isHr() { return ['hr', 'hradmin', 'hr_admin', 'hr_manager', 'admin'].includes(ATT_USER?.role); }
function isSystemAdmin() { return ['system_admin', 'admin'].includes(ATT_USER?.role); }
function isPayrollOfficer() { return ATT_USER?.role === 'payroll_officer'; }
function isPayrollManager() { return ATT_USER?.role === 'payroll_manager'; }
function isPayrollAttendanceViewer() { return isPayrollOfficer() || isPayrollManager(); }
function isEmployee() { return ATT_USER?.role === 'employee'; }
function canManageAttendanceRecords() { return isHr(); }
function canManageBiometrics() { return isHr() || isSystemAdmin(); }
function canViewAllAttendanceRecords() { return isHr() || isPayrollAttendanceViewer(); }

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

function attendanceBadge(value, title = '') {
  const text = String(value || '-').trim();
  const normalized = text.toLowerCase();
  const definitions = normalized.includes('overtime')
    ? { code: 'OT', color: 'info' }
    : normalized.includes('undertime')
      ? { code: 'UT', color: 'red' }
      : normalized.includes('late')
        ? { code: 'L', color: 'yellow' }
        : normalized.includes('half day')
          ? { code: 'HD', color: 'neutral' }
          : normalized.includes('present')
            ? { code: 'P', color: 'green' }
            : normalized.includes('absent')
              ? { code: 'A', color: 'red' }
              : normalized.includes('review') || normalized.includes('incomplete')
                ? { code: 'NR', color: 'yellow' }
                : normalized.includes('reject')
                  ? { code: 'R', color: 'red' }
                  : { code: text.slice(0, 2).toUpperCase(), color: 'neutral' };
  const tooltip = title || text;
  return `<span class="badge badge-${definitions.color} att-code-badge" title="${esc(tooltip)}" aria-label="${esc(tooltip)}">${esc(definitions.code)}</span>`;
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
    ? summary.items.map(item => attendanceBadge(item.label, `${item.label}: ${item.value}`)).join('')
    : '';

  return `
    <div class="att-summary-card" title="${esc(summary.title)}">
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

function attendanceMenuIcon(name) {
  const paths = {
    view: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    validate: '<path d="m5 12 4 4L19 6"/>',
    reject: '<path d="m6 6 12 12M18 6 6 18"/>',
    correct: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  };
  return `<svg class="att-menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`;
}

function calculateHours(timeIn, timeOut) {
  if (!timeIn || !timeOut) return '-';
  const milliseconds = new Date(`1970-01-01T${timeOut}`) - new Date(`1970-01-01T${timeIn}`);
  return `${Math.max(0, milliseconds / 3600000).toFixed(1)}h`;
}

function calculateDtrHours(record) {
  return calculateHours(record.time_in, record.time_out);
}

function switchAttTab(tab, element) {
  ATT_USER = ATT_USER || getUser();
  if (['biometric', 'policies', 'payroll-policy', 'audit'].includes(tab) && !canManageBiometrics()) {
    tab = 'overview';
    element = document.querySelector('[data-att-tab="overview"]');
  }
  ['overview', 'records', 'biometric', 'policies', 'payroll-policy', 'audit'].forEach(name => {
    const panel = document.getElementById(`att-${name}`);
    if (panel) panel.style.display = name === tab ? 'block' : 'none';
  });
  document.querySelectorAll('#page-attendance .attendance-tabs .tab').forEach(item => item.classList.remove('active'));
  if (element) element.classList.add('active');
  const pageBody = document.querySelector('.page-body');
  if (pageBody) {
    pageBody.scrollTop = 0;
    requestAnimationFrame(() => { pageBody.scrollTop = 0; });
  }

  if (tab === 'records') loadAttRecords();
  if (tab === 'biometric') loadBiometricWorkspace();
  if (tab === 'policies') loadAttendancePolicies();
  if (tab === 'payroll-policy' && typeof loadPayrollPolicySettings === 'function') loadPayrollPolicySettings();
  if (tab === 'audit') loadAuditLog();
}

async function initAttendance() {
  ATT_USER = getUser();
  if (!ATT_USER) return;
  document.getElementById('page-attendance')?.classList.toggle('attendance-employee-mode', isEmployee());
  initAttendanceDatePickers();

  setVisible('biometric-attendance-card', isEmployee() && !!ATT_USER.employeeId);
  setVisible('emp-summary-card', isEmployee() && !!ATT_USER.employeeId);
  setVisible('att-tab-biometric', canManageBiometrics());
  setVisible('att-tab-policies', canManageBiometrics());
  setVisible('att-tab-payroll-policy', isHr() || isSystemAdmin());
  setVisible('att-tab-audit', canManageBiometrics());
  setVisible('btn-manual-attendance', canManageAttendanceRecords());
  setVisible('att-select-all', canManageAttendanceRecords());
  setVisible('hr-payroll-policy-card', isHr() || isSystemAdmin());
  document.querySelectorAll('.att-hr-record-action').forEach(button => {
    button.style.display = canManageAttendanceRecords() ? '' : 'none';
  });

  const controls = document.querySelector('.att-toolbar');
  if (controls) controls.style.display = isEmployee() ? 'none' : 'flex';
  const recordActions = document.querySelector('#att-records .att-records-actionbar .att-actions');
  if (recordActions) recordActions.style.display = isEmployee() ? 'none' : 'flex';

  if (isEmployee()) {
    setText('att-page-title', 'My Attendance');
    setText('att-page-subtitle', 'Use fingerprint time in/out and monitor your attendance hours.');
    setText('att-banner-title', 'Fingerprint attendance');
    setText('att-banner-copy', 'Use the registered fingerprint scanner to record your time in and time out.');
    setText('att-records-copy', 'View your attendance logs and validation status.');
    const recordsTab = document.querySelector('[data-att-tab="records"]');
    if (recordsTab) recordsTab.textContent = 'My Records';
    switchAttTab('overview', document.querySelector('[data-att-tab="overview"]'));
  } else if (isPayrollAttendanceViewer()) {
    setText('att-page-title', 'Attendance Records');
    setText('att-page-subtitle', 'View employee attendance records for payroll review.');
    setText('att-banner-title', 'Attendance Overview');
    setText('att-banner-copy', 'Daily attendance summary for payroll review.');
    setText('att-records-copy', 'View biometric attendance records, payroll-ready status, late, undertime, overtime, and attendance summaries.');
    const recordsTab = document.querySelector('[data-att-tab="records"]');
    if (recordsTab) recordsTab.textContent = 'Attendance Records';
  } else {
    setText('att-page-title', 'Attendance Management');
    setText('att-page-subtitle', '');
    setText('att-banner-title', 'Attendance Overview');
    setText('att-banner-copy', 'Summary metrics only. Validate and correct attendance from Attendance Records.');
    setText('att-records-copy', 'Review biometric scans, validate records, reject invalid entries, correct punches, and prepare payroll-ready attendance.');
    const recordsTab = document.querySelector('[data-att-tab="records"]');
    if (recordsTab) recordsTab.textContent = 'Attendance Records';
  }

  if (isSystemAdmin() && !isHr()) {
    const biometricTab = document.getElementById('att-tab-biometric');
    switchAttTab('biometric', biometricTab);
    return;
  }

  if (isEmployee() && ATT_USER.employeeId) {
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
      label.textContent = `Timed in at ${data.record?.time_in || '-'}. Your next scan will record Time Out.`;
    } else {
      label.textContent = `Completed attendance: ${data.record?.time_in || '-'} to ${data.record?.time_out || '-'}.`;
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
    if (search) params.set('search', search);
    if (department) params.set('department', department);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (status) params.set('status', status);
    if (validation) params.set('validation_status', validation);

    const endpoint = canViewAllAttendanceRecords()
      ? '/api/attendance/all'
      : '/api/attendance/my-records';
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
    const mobileList = document.getElementById('att-mobile-records-list');
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="att-empty">${esc(err.message)}</td></tr>`;
    if (mobileList) mobileList.innerHTML = `<div class="att-mobile-empty">${esc(err.message)}</div>`;
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

function missingDtrPunches(record) {
  const missing = [];
  if (!record?.time_in) missing.push('Time in');
  if (!record?.time_out) missing.push('Time out');
  return missing;
}

function isIncompleteDtr(record) {
  return missingDtrPunches(record).length > 0;
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
  const mobileList = document.getElementById('att-mobile-records-list');
  if (!tbody) return;
  if (!ATT_RECORDS.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="att-empty">No attendance records found.</td></tr>';
    if (mobileList) {
      mobileList.innerHTML = '<div class="att-mobile-empty">No attendance records found.</div>';
    }
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
    const hours = isSummary ? `${(Number(record.regular_minutes || 0) / 60).toFixed(1)}h` : calculateDtrHours(record);
    const summary = attendanceSummary(record);
    const primaryStatus = primaryAttendanceStatus(record);
    const verification = validationLabel(record.verification_status);
    const dtrMissing = isIncompleteDtr(record);
    const actions = canManageAttendanceRecords() && attendanceId
      ? `<div class="att-row-menu">
           <button type="button" class="att-menu-trigger action-dots-button" onclick="toggleAttendanceActionMenu(event, ${Number(attendanceId)})" aria-label="Open attendance actions" aria-haspopup="menu" aria-expanded="false">${actionDotsIcon()}</button>
           <div class="att-menu-panel" id="att-menu-${Number(attendanceId)}" role="menu">
             <button type="button" class="att-menu-item" role="menuitem" onclick="openAttendanceDetail(${Number(attendanceId)})">${attendanceMenuIcon('view')}<span>View details</span></button>
             ${dtrMissing ? '' : `<button type="button" class="att-menu-item att-menu-item-success" role="menuitem" onclick="verifyAttendance(${Number(attendanceId)}, 'VALIDATED')">${attendanceMenuIcon('validate')}<span>Validate</span></button>`}
             <button type="button" class="att-menu-item att-menu-item-danger" role="menuitem" onclick="verifyAttendance(${Number(attendanceId)}, 'REJECTED')">${attendanceMenuIcon('reject')}<span>Reject</span></button>
             <button type="button" class="att-menu-item" role="menuitem" onclick="openOverrideModal(${Number(attendanceId)})">${attendanceMenuIcon('correct')}<span>Correct entry</span></button>
           </div>
         </div>`
      : attendanceId
        ? `<button class="btn btn-outline btn-sm" onclick="openAttendanceDetail(${Number(attendanceId)})">View</button>`
        : '-';

    return `<tr>
      <td>${attendanceId && canManageAttendanceRecords() ? `<input type="checkbox" class="att-row-select" value="${Number(attendanceId)}" />` : ''}</td>
      <td class="att-employee-cell"><strong>${esc(record.employee_name || 'You')}</strong>${record.employee_code ? `<span class="att-employee-code">${esc(record.employee_code)}</span>` : ''}</td>
      <td>${esc(record.department || '-')}</td>
      <td>${esc(formatDate(record.attendance_date || record.date))}</td>
      <td>${esc(record.time_in || '-')}</td>
      <td>${esc(record.time_out || '-')}</td>
      <td>${esc(hours)}</td>
      <td class="att-summary-cell" title="${esc(summary.title)}">
        ${renderAttendanceSummaryCell(primaryStatus, summary)}
      </td>
      <td>${badge(verification)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
  if (mobileList) {
    mobileList.innerHTML = visibleRecords.map(record => {
      const hours = Object.prototype.hasOwnProperty.call(record, 'regular_minutes')
        ? `${(Number(record.regular_minutes || 0) / 60).toFixed(1)}h`
        : calculateDtrHours(record);
      const status = primaryAttendanceStatus(record);
      const lateMinutes = minuteValue(record, 'summary_late_minutes', 'late_minutes');
      const undertimeMinutes = minuteValue(record, 'summary_undertime_minutes', 'undertime_minutes');
      const overtimeMinutes = minuteValue(record, 'summary_overtime_minutes', 'overtime_minutes');
      return `
        <article class="att-mobile-record">
          <div class="att-mobile-record-head">
            <time>${esc(formatDate(record.attendance_date || record.date))}</time>
            ${attendanceBadge(status)}
          </div>
          <div class="att-mobile-record-times">
            <div><span>Time In</span><strong>${esc(record.time_in || '-')}</strong></div>
            <div><span>Time Out</span><strong>${esc(record.time_out || '-')}</strong></div>
            <div><span>Hours</span><strong>${esc(hours)}</strong></div>
          </div>
          <div class="att-mobile-record-meta">
            <span>Late ${esc(formatMinutes(lateMinutes))}</span>
            <span>Undertime ${esc(formatMinutes(undertimeMinutes))}</span>
            <span>Overtime ${esc(formatMinutes(overtimeMinutes))}</span>
          </div>
        </article>`;
    }).join('');
  }
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
  if (isEmployee() && totalPages <= 1) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  if (isEmployee()) {
    container.innerHTML = `
      <button class="btn btn-outline btn-sm" type="button" onclick="setAttendanceRecordsPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="att-records-pagination-page">Page ${currentPage} of ${totalPages}</span>
      <button class="btn btn-outline btn-sm" type="button" onclick="setAttendanceRecordsPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
    `;
    return;
  }
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

function renderBiometricEventsPagination(totalRows, start, end, totalPages) {
  const container = document.getElementById('bio-events-pagination');
  if (!container) return;
  if (!totalRows || totalPages <= 1) {
    container.innerHTML = totalRows ? `<span class="att-records-pagination-summary">Showing ${start}-${end} of ${totalRows}</span>` : '';
    container.style.display = totalRows ? 'flex' : 'none';
    return;
  }
  const currentPage = Math.min(Math.max(Number(ATT_BIOMETRIC_EVENTS_PAGE || 1), 1), totalPages);
  container.style.display = 'flex';
  container.innerHTML = `
    <span class="att-records-pagination-summary">Showing ${start}-${end} of ${totalRows}</span>
    <div class="att-records-pagination-actions">
      <button class="btn btn-outline btn-sm" type="button" onclick="setBiometricEventsPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="att-records-pagination-page">Page ${currentPage} of ${totalPages}</span>
      <button class="btn btn-outline btn-sm" type="button" onclick="setBiometricEventsPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;
}

function renderBiometricEvents() {
  const tbody = document.getElementById('bio-events-tbody');
  if (!tbody) return;
  const rows = ATT_BIOMETRIC_EVENTS;
  if (!rows.length) {
    const emptyHtml = '<tr><td colspan="4" class="att-empty">No recent fingerprint activity.</td></tr>';
    if (tbody.innerHTML !== emptyHtml) tbody.innerHTML = emptyHtml;
    renderBiometricEventsPagination(0, 0, 0, 0);
    return;
  }

  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / ATT_BIOMETRIC_EVENTS_PAGE_SIZE));
  ATT_BIOMETRIC_EVENTS_PAGE = Math.min(Math.max(Number(ATT_BIOMETRIC_EVENTS_PAGE || 1), 1), totalPages);
  const start = (ATT_BIOMETRIC_EVENTS_PAGE - 1) * ATT_BIOMETRIC_EVENTS_PAGE_SIZE;
  const end = Math.min(start + ATT_BIOMETRIC_EVENTS_PAGE_SIZE, totalRows);
  const pageRows = rows.slice(start, end);
  const html = pageRows.map(row => `<tr>
    <td class="att-employee-cell">${esc(row.employee_name || 'Unmapped')}${row.employee_code ? `<span class="att-employee-code">${esc(row.employee_code)}</span>` : ''}</td>
    <td>${esc(formatDateTime(row.scan_timestamp || row.created_at))}</td>
    <td>${esc((row.attendance_type || '-').replace('_', ' '))}</td>
    <td>${badge(formalValidationStatus(row.verification_status || '-'))}</td>
  </tr>`).join('');
  if (tbody.innerHTML !== html) tbody.innerHTML = html;
  renderBiometricEventsPagination(totalRows, start + 1, end, totalPages);
}

function setBiometricEventsPage(page) {
  const totalPages = Math.max(1, Math.ceil(ATT_BIOMETRIC_EVENTS.length / ATT_BIOMETRIC_EVENTS_PAGE_SIZE));
  ATT_BIOMETRIC_EVENTS_PAGE = Math.min(Math.max(Number(page || 1), 1), totalPages);
  ATT_BIOMETRIC_EVENTS_SIGNATURE = '';
  renderBiometricEvents();
}

function closeAttendanceActionMenus() {
  document.querySelectorAll('.att-menu-panel.open').forEach(menu => {
    menu.classList.remove('open');
    menu.style.removeProperty('left');
    menu.style.removeProperty('top');
    menu.closest('.att-row-menu')?.querySelector('.att-menu-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

function toggleAttendanceActionMenu(event, attendanceId) {
  event.stopPropagation();
  const menu = document.getElementById(`att-menu-${attendanceId}`);
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  closeAttendanceActionMenus();
  if (isOpen) return;

  const trigger = event.currentTarget;
  menu.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const viewportGap = 8;
  const left = Math.min(
    window.innerWidth - menuRect.width - viewportGap,
    Math.max(viewportGap, triggerRect.right - menuRect.width)
  );
  const fitsBelow = window.innerHeight - triggerRect.bottom >= menuRect.height + viewportGap;
  const top = fitsBelow
    ? triggerRect.bottom + 6
    : Math.max(viewportGap, triggerRect.top - menuRect.height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function clearAttFilters() {
  ['att-search', 'att-department-filter', 'att-date-from-filter', 'att-date-to-filter', 'att-status-filter', 'att-validation-filter']
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
  const incomplete = ids
    .map(id => ATT_RECORDS.find(record => Number(record.attendance_id) === Number(id)))
    .filter(record => record && isIncompleteDtr(record));
  if (incomplete.length) {
    return alert('Some selected records are missing Time In or Time Out. Correct them before marking payroll ready.');
  }
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
    Object.prototype.hasOwnProperty.call(record, 'regular_minutes') ? `${(Number(record.regular_minutes || 0) / 60).toFixed(1)}h` : calculateDtrHours(record),
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
  const canManage = canManageAttendanceRecords();
  const modal = document.getElementById('attendance-detail-modal');
  const title = modal?.querySelector('.att-card-heading h3');
  const copy = modal?.querySelector('.att-card-heading p');
  const actions = modal?.querySelector('.att-modal-actions');
  if (title) title.textContent = isEmployee() ? 'My Attendance Record' : 'Attendance Details';
  if (copy) {
    copy.textContent = canManage
      ? 'Employee information, biometric scan metadata, validation history, and audit history.'
      : 'Review time in/out, hours worked, and attendance status.';
  }
  if (actions) actions.style.display = canManage ? '' : 'none';
  const hours = Object.prototype.hasOwnProperty.call(record, 'regular_minutes')
    ? `${(Number(record.regular_minutes || 0) / 60).toFixed(1)}h`
    : calculateDtrHours(record);
  const lateMinutes = minuteValue(record, 'summary_late_minutes', 'late_minutes');
  const undertimeMinutes = minuteValue(record, 'summary_undertime_minutes', 'undertime_minutes');
  const overtimeMinutes = minuteValue(record, 'summary_overtime_minutes', 'overtime_minutes');
  const dtrMissing = missingDtrPunches(record);
  const detailValidateButton = document.getElementById('attendance-detail-validate-button');
  if (detailValidateButton) detailValidateButton.style.display = canManage && !dtrMissing.length ? '' : 'none';

  const attendanceDetailSection = `
    <section>
      <h4>${isEmployee() ? 'Record Details' : 'Employee Information'}</h4>
      <table><tbody>
        ${isEmployee()
          ? `<tr><th>Employee</th><td colspan="3">You</td></tr>`
          : `<tr><th>Employee</th><td>${esc(record.employee_name || 'Employee')}</td><th>Employee ID</th><td>${esc(record.employee_code || '-')}</td></tr>
             <tr><th>Department</th><td>${esc(record.department || '-')}</td><th>Position</th><td>${esc(record.position || '-')}</td></tr>`}
      </tbody></table>
    </section>
    <section>
      <h4>Attendance Details</h4>
      <table><tbody>
        <tr><th>Date</th><td>${esc(formatDate(record.attendance_date || record.date))}</td><th>Hours Worked</th><td>${esc(hours)}</td></tr>
        <tr><th>Time In</th><td>${esc(record.time_in || '-')}</td><th>Time Out</th><td>${esc(record.time_out || '-')}</td></tr>
        ${dtrMissing.length ? `<tr><th>Missing DTR Punches</th><td colspan="3">${esc(dtrMissing.join(', '))}</td></tr>` : ''}
        <tr><th>Attendance Status</th><td>${attendanceFlagBadges(record)}</td><th>Payroll Ready</th><td>${badge(isPayrollReadyRecord(record) ? 'Ready' : 'Not Ready')}</td></tr>
        <tr><th>Late Minutes</th><td>${esc(formatMinutes(lateMinutes))}</td><th>Undertime Minutes</th><td>${esc(formatMinutes(undertimeMinutes))}</td></tr>
        <tr><th>Overtime Minutes</th><td>${esc(formatMinutes(overtimeMinutes))}</td><th></th><td></td></tr>
      </tbody></table>
    </section>`;

  const hrSecuritySections = `
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
      </section>`;

  content.innerHTML = canManage ? `${attendanceDetailSection}${hrSecuritySections}` : attendanceDetailSection;
  if (modal) modal.style.display = 'flex';
}

function closeAttendanceDetailModal() {
  document.getElementById('attendance-detail-modal').style.display = 'none';
  ATT_SELECTED_DETAIL_ID = null;
}

function detailValidateAttendance() {
  if (!canManageAttendanceRecords()) return alert('Only HR can validate attendance records.');
  const record = ATT_RECORDS.find(item => Number(item.attendance_id) === Number(ATT_SELECTED_DETAIL_ID));
  if (record && isIncompleteDtr(record)) {
    alert('This attendance record is missing Time In or Time Out.');
    return;
  }
  if (ATT_SELECTED_DETAIL_ID) verifyAttendance(ATT_SELECTED_DETAIL_ID, 'VALIDATED');
  closeAttendanceDetailModal();
}

function detailRejectAttendance() {
  if (!canManageAttendanceRecords()) return alert('Only HR can reject attendance records.');
  if (ATT_SELECTED_DETAIL_ID) verifyAttendance(ATT_SELECTED_DETAIL_ID, 'REJECTED');
  closeAttendanceDetailModal();
}

function detailCorrectAttendance() {
  if (!canManageAttendanceRecords()) return alert('Only HR can correct attendance records.');
  const id = ATT_SELECTED_DETAIL_ID;
  closeAttendanceDetailModal();
  if (id) openOverrideModal(id);
}

function openOverrideModal(attendanceId) {
  if (!canManageAttendanceRecords()) return alert('Only HR can correct attendance records.');
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
  if (!canManageAttendanceRecords()) return alert('Only HR can correct attendance records.');
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
  if (!canManageAttendanceRecords()) return alert('Only HR can validate attendance records.');
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
  const manualEmployee = manualAttendanceEl('manual-employee');
  const manualDepartment = manualAttendanceEl('manual-department');
  const manualEmployeeStatus = manualAttendanceEl('manual-employee-status');
  if (manualEmployee) manualEmployee.innerHTML = '<option value="">Loading employees...</option>';
  if (manualDepartment) manualDepartment.innerHTML = '<option value="">Loading departments...</option>';
  if (manualEmployeeStatus) manualEmployeeStatus.textContent = 'Loading active employees...';
  try {
    const [employeeResponse, lookupResponse] = await Promise.all([
      apiFetch('/api/attendance/employees'),
      apiFetch('/api/employee-setup/lookups')
    ]);
    const normalizeRows = payload => {
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.employees)) return payload.employees;
      if (Array.isArray(payload?.data)) return payload.data;
      if (Array.isArray(payload?.rows)) return payload.rows;
      return [];
    };
    let employeeRows = employeeResponse?.ok ? normalizeRows(await employeeResponse.json()) : [];
    if (!employeeRows.length) {
      const fallbackResponse = await apiFetch('/api/employees?status=all');
      if (fallbackResponse?.ok) {
        const fallbackRows = await fallbackResponse.json();
        employeeRows = normalizeRows(fallbackRows);
      }
    }
    ATT_EMPLOYEES = (Array.isArray(employeeRows) ? employeeRows : [])
      .map(employee => ({
        ...employee,
        id: employee.id || employee.employee_id,
      }))
      .filter(employee => {
        if (!employee || Number(employee.id) <= 0) return false;
        const status = String(employee.status || employee.employment_status || 'Active').toLowerCase();
        return !['inactive', 'resigned', 'terminated', 'separated', 'offboarded'].includes(status);
      })
      .map(employee => ({
        ...employee,
        employee_name: employee.employee_name
          || [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(' ')
          || employee.name
          || employee.employee_code
          || `Employee ${employee.id}`,
        department: employee.department || employee.department_name || 'Unassigned'
      }));
    if (!ATT_EMPLOYEES.length) throw new Error('No active employees were returned by the server.');
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
    if (manualEmployeeStatus) manualEmployeeStatus.textContent = `${ATT_EMPLOYEES.length} active employee${ATT_EMPLOYEES.length === 1 ? '' : 's'} loaded.`;
  } catch (err) {
    console.error('Employee list error:', err);
    if (manualEmployee) manualEmployee.innerHTML = '<option value="">Unable to load employees</option>';
    if (manualDepartment) manualDepartment.innerHTML = '<option value="">Unable to load departments</option>';
    if (manualEmployeeStatus) manualEmployeeStatus.textContent = err.message || 'Unable to load active employees.';
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
  const select = manualAttendanceEl('manual-department');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">All Departments</option>' + ATT_DEPARTMENTS
    .map(department => `<option value="${esc(department.name)}">${esc(department.name)}</option>`)
    .join('');
  if (Array.from(select.options).some(option => option.value === current)) select.value = current;
}

function populateManualAttendanceEmployees() {
  const select = manualAttendanceEl('manual-employee');
  if (!select) return;
  const department = manualAttendanceEl('manual-department')?.value || '';
  const current = select.value;
  const employees = ATT_EMPLOYEES.filter(employee => !department || employee.department === department);
  select.innerHTML = `<option value="">${employees.length ? 'Select employee' : 'No active employees in this department'}</option>` + employees
    .map(employee => {
      const name = employee.employee_name || [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(' ') || employee.name || 'Employee';
      return `<option value="${Number(employee.id)}">${esc(name)} (${esc(employee.employee_code || employee.empCode || employee.id)})</option>`;
    })
    .join('');
  if (Array.from(select.options).some(option => option.value === current)) select.value = current;
  const status = manualAttendanceEl('manual-employee-status');
  if (status) {
    status.textContent = department
      ? `${employees.length} active employee${employees.length === 1 ? '' : 's'} in ${department}.`
      : `${employees.length} active employee${employees.length === 1 ? '' : 's'} loaded.`;
  }
}

async function loadManualAttendanceDropdown() {
  const select = manualAttendanceEl('manual-employee');
  const departmentSelect = manualAttendanceEl('manual-department');
  const status = manualAttendanceEl('manual-employee-status');
  if (select) select.innerHTML = '<option value="">Loading employees...</option>';
  if (departmentSelect) departmentSelect.innerHTML = '<option value="">Loading departments...</option>';
  if (status) status.textContent = 'Loading employee list...';

  try {
    const response = await apiFetch('/api/attendance/employees');
    const payload = await response.json().catch(() => []);
    if (!response.ok) throw new Error(payload.error || 'Unable to load attendance employees.');
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.employees)
        ? payload.employees
        : Array.isArray(payload?.rows)
          ? payload.rows
          : Array.isArray(payload?.data)
            ? payload.data
            : [];

    ATT_EMPLOYEES = rows
      .map(employee => ({
        ...employee,
        id: employee.id || employee.employee_id,
        employee_name: employee.employee_name
          || [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(' ')
          || employee.name
          || employee.employee_code
          || `Employee ${employee.id || employee.employee_id}`,
        department: employee.department || employee.department_name || 'Unassigned'
      }))
      .filter(employee => Number(employee.id) > 0);

    ATT_DEPARTMENTS = [...new Set(ATT_EMPLOYEES.map(employee => employee.department || 'Unassigned'))]
      .sort((a, b) => a.localeCompare(b))
      .map((name, index) => ({ id: `manual-${index}`, name }));

    populateManualAttendanceDepartments();
    populateManualAttendanceEmployees();
  } catch (err) {
    console.error('Manual attendance employee dropdown error:', err);
    if (select) select.innerHTML = '<option value="">Unable to load employees</option>';
    if (departmentSelect) departmentSelect.innerHTML = '<option value="">Unable to load departments</option>';
    if (status) status.textContent = err.message || 'Unable to load employee list.';
  }
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
  await loadManualAttendanceDropdown();
}

function closeManualModal() {
  document.getElementById('manual-modal').style.display = 'none';
}

async function submitManualAttendance() {
  const body = {
    employee_id: manualAttendanceEl('manual-employee').value,
    date: manualAttendanceEl('manual-date').value,
    time_in: manualAttendanceEl('manual-time-in').value,
    time_out: manualAttendanceEl('manual-time-out').value,
    reason: manualAttendanceEl('manual-reason').value,
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
    const nextRows = Array.isArray(rows) ? rows : [];
    const nextSignature = JSON.stringify(nextRows.map(row => [
      row.id || row.event_id || row.attendance_id || '',
      row.employee_code || '',
      row.employee_name || '',
      row.scan_timestamp || row.created_at || '',
      row.attendance_type || '',
      row.verification_status || ''
    ]));
    if (nextSignature !== ATT_BIOMETRIC_EVENTS_SIGNATURE) {
      ATT_BIOMETRIC_EVENTS = nextRows;
      ATT_BIOMETRIC_EVENTS_PAGE = Math.min(
        Math.max(Number(ATT_BIOMETRIC_EVENTS_PAGE || 1), 1),
        Math.max(1, Math.ceil(ATT_BIOMETRIC_EVENTS.length / ATT_BIOMETRIC_EVENTS_PAGE_SIZE))
      );
      ATT_BIOMETRIC_EVENTS_SIGNATURE = nextSignature;
      renderBiometricEvents();
    }
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
  const tbody = document.getElementById('audit-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="att-empty">Loading attendance audit log...</td></tr>';
  try {
    const res = await apiFetch('/api/attendance/audit-log');
    const payload = await res?.json().catch(() => ({}));
    if (!res?.ok) throw new Error(payload.error || 'Failed to load attendance audit log.');
    const rows = Array.isArray(payload) ? payload : [];
    tbody.innerHTML = rows.length ? rows.map(row => `<tr>
      <td>${esc(formatDateTime(row.timestamp))}</td>
      <td>${esc(row.performed_by || 'System')}</td>
      <td>${esc(row.employee_name || '-')}</td>
      <td>${esc(row.action_performed)}</td>
      <td>${esc(row.old_value || '-')}</td>
      <td>${esc(row.new_value || '-')}</td>
      <td>${esc(row.ip_address || '-')}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="att-empty">No attendance audit entries.</td></tr>';
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="7" class="att-empty">Unable to load attendance audit log: ${esc(err.message)}</td></tr>`;
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
    document.getElementById('policy-duplicate-window').value = data.duplicate_scan_window_seconds ?? 60;
    document.getElementById('policy-hr-validation').value = data.hr_validation_required ? '1' : '0';
    setPolicyValue('policy-auto-payroll-ready', String(data.auto_payroll_ready ?? false));
    setPolicyValue('policy-allow-manual', String(data.allow_manual_attendance ?? true));
    setPolicyValue('policy-allow-hr-correction', String(data.allow_hr_correction ?? true));
    setPolicyValue('policy-enable-holiday', String(data.enable_holiday_rules ?? false));
    setPolicyValue('policy-regular-holiday-multiplier', data.regular_holiday_multiplier ?? 2);
    setPolicyValue('policy-special-holiday-multiplier', data.special_holiday_multiplier ?? 1.3);
    setPolicyValue('policy-holiday-ot-multiplier', data.holiday_overtime_multiplier ?? 1.3);
    setPolicyValue('holiday-calendar-year', new Date().getFullYear());
    syncAttendanceValidationPolicy();
    setText('attendance-policy-status', 'Active attendance policy loaded.');
    loadHolidayCalendar();
  } catch (err) {
    setText('attendance-policy-status', err.message);
  }
}

function setPolicyValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

function syncAttendanceValidationPolicy() {
  const requireValidation = document.getElementById('policy-hr-validation')?.value === '1';
  const autoReady = document.getElementById('policy-auto-payroll-ready');
  if (!autoReady) return;
  if (requireValidation) autoReady.value = 'false';
  autoReady.disabled = requireValidation;
}

async function saveAttendancePolicies(event) {
  event?.preventDefault?.();
  syncAttendanceValidationPolicy();
  const button = document.getElementById('attendance-policy-save-button');
  const feedback = document.getElementById('attendance-policy-save-feedback');
  const setFeedback = (message, tone = '') => {
    if (feedback) {
      feedback.textContent = message;
      feedback.className = tone ? `att-muted ${tone}` : 'att-muted';
    }
    setText('attendance-policy-status', message);
  };
  const body = {
    effective_date: document.getElementById('policy-effective-date')?.value,
    work_start_time: document.getElementById('policy-work-start-time')?.value,
    work_end_time: document.getElementById('policy-work-end-time')?.value,
    break_start_time: document.getElementById('policy-break-start-time')?.value,
    break_end_time: document.getElementById('policy-break-end-time')?.value,
    standard_work_hours: document.getElementById('policy-standard-work-hours')?.value,
    grace_period_minutes: Number(document.getElementById('policy-grace-period')?.value || 0),
    duplicate_scan_window_seconds: Number(document.getElementById('policy-duplicate-window')?.value || 0),
    hr_validation_required: document.getElementById('policy-hr-validation')?.value === '1',
    require_hr_validation: document.getElementById('policy-hr-validation')?.value === '1',
    auto_payroll_ready: document.getElementById('policy-auto-payroll-ready')?.value,
    allow_manual_attendance: document.getElementById('policy-allow-manual')?.value,
    allow_hr_correction: document.getElementById('policy-allow-hr-correction')?.value,
    enable_holiday_rules: document.getElementById('policy-enable-holiday')?.value,
    regular_holiday_multiplier: document.getElementById('policy-regular-holiday-multiplier')?.value,
    special_holiday_multiplier: document.getElementById('policy-special-holiday-multiplier')?.value,
    holiday_overtime_multiplier: document.getElementById('policy-holiday-ot-multiplier')?.value,
  };
  if (!body.effective_date) {
    setFeedback('Select an effective date before saving.', 'att-error');
    return;
  }
  if (!body.work_start_time || !body.work_end_time || !body.break_start_time || !body.break_end_time) {
    setFeedback('Complete the work and break schedule before saving.', 'att-error');
    return;
  }
  if (!(Number(body.standard_work_hours) > 0)) {
    setFeedback('Required daily working hours must be greater than zero.', 'att-error');
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = 'Saving...';
  }
  setFeedback('Saving policy version...');
  try {
    const res = await apiFetch('/api/attendance/policies', { method: 'PUT', body: JSON.stringify(body) });
    if (!res) throw new Error('No response received from the server.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save attendance policies.');
    const changes = Number(data.changes?.length || 0);
    const message = changes
      ? `Policy version saved. ${changes} change(s) recorded.`
      : 'Policy version saved. No values changed.';
    setFeedback(message, 'att-success');
  } catch (err) {
    setFeedback(`Save failed: ${err.message}`, 'att-error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Save Policy Version';
    }
  }
}

function holidayCalendarYear() {
  const year = Number(document.getElementById('holiday-calendar-year')?.value || new Date().getFullYear());
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : new Date().getFullYear();
}

function holidayTypeOptions(value) {
  const options = [
    ['REGULAR', 'Regular'],
    ['SPECIAL_NON_WORKING', 'Special Non-working'],
    ['SPECIAL_WORKING', 'Special Working'],
    ['COMPANY', 'Company'],
    ['OTHER', 'Other'],
  ];
  return options.map(([key, label]) => `<option value="${key}" ${key === value ? 'selected' : ''}>${label}</option>`).join('');
}

function renderHolidayPagination(totalRows) {
  const container = document.getElementById('holiday-calendar-pagination');
  if (!container) return;
  const totalPages = Math.max(1, Math.ceil(totalRows / ATT_HOLIDAYS_PAGE_SIZE));
  ATT_HOLIDAYS_PAGE = Math.min(Math.max(ATT_HOLIDAYS_PAGE, 1), totalPages);
  if (!totalRows) {
    container.innerHTML = '';
    return;
  }
  const start = (ATT_HOLIDAYS_PAGE - 1) * ATT_HOLIDAYS_PAGE_SIZE + 1;
  const end = Math.min(totalRows, ATT_HOLIDAYS_PAGE * ATT_HOLIDAYS_PAGE_SIZE);
  container.innerHTML = `
    <span class="att-records-pagination-summary">Showing ${start}-${end} of ${totalRows}</span>
    <div class="att-records-pagination-actions">
      <button class="btn btn-outline btn-sm" type="button" onclick="setHolidayCalendarPage(${ATT_HOLIDAYS_PAGE - 1})" ${ATT_HOLIDAYS_PAGE <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="att-records-pagination-page">Page ${ATT_HOLIDAYS_PAGE} of ${totalPages}</span>
      <button class="btn btn-outline btn-sm" type="button" onclick="setHolidayCalendarPage(${ATT_HOLIDAYS_PAGE + 1})" ${ATT_HOLIDAYS_PAGE >= totalPages ? 'disabled' : ''}>Next</button>
    </div>`;
}

function renderHolidayRows() {
  const tbody = document.getElementById('holiday-calendar-tbody');
  if (!tbody) return;
  if (!ATT_HOLIDAYS.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="att-empty">No holidays found for this year. Sync PH holidays to populate.</td></tr>';
    renderHolidayPagination(0);
    return;
  }
  const start = (ATT_HOLIDAYS_PAGE - 1) * ATT_HOLIDAYS_PAGE_SIZE;
  const pageRows = ATT_HOLIDAYS.slice(start, start + ATT_HOLIDAYS_PAGE_SIZE);
  tbody.innerHTML = pageRows.map(row => {
    const id = Number(row.holiday_id);
    return `<tr>
      <td>${esc(formatDate(row.holiday_date))}</td>
      <td><strong>${esc(row.local_name || row.name)}</strong>${row.name && row.name !== row.local_name ? `<span class="att-employee-code">${esc(row.name)}</span>` : ''}</td>
      <td><select id="holiday-type-${id}">${holidayTypeOptions(row.holiday_type)}</select></td>
      <td><input id="holiday-multiplier-${id}" type="number" min="0" max="5" step="0.01" value="${esc(row.multiplier ?? 1)}" /></td>
      <td><select id="holiday-active-${id}"><option value="true" ${row.is_active ? 'selected' : ''}>Active</option><option value="false" ${!row.is_active ? 'selected' : ''}>Inactive</option></select></td>
      <td>${esc(row.source || 'MANUAL')}</td>
      <td><button class="btn btn-outline btn-sm" type="button" onclick="saveHolidayOverride(${id})">Save</button></td>
    </tr>`;
  }).join('');
  renderHolidayPagination(ATT_HOLIDAYS.length);
}

function setHolidayCalendarPage(page) {
  const totalPages = Math.max(1, Math.ceil(ATT_HOLIDAYS.length / ATT_HOLIDAYS_PAGE_SIZE));
  ATT_HOLIDAYS_PAGE = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  renderHolidayRows();
}

async function loadHolidayCalendar() {
  const tbody = document.getElementById('holiday-calendar-tbody');
  const status = document.getElementById('holiday-calendar-status');
  if (!tbody) return;
  if (status) status.textContent = 'Loading holiday calendar...';
  try {
    const year = holidayCalendarYear();
    setPolicyValue('holiday-calendar-year', year);
    const res = await apiFetch(`/api/holidays?year=${encodeURIComponent(year)}&country_code=PH&active=all`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load holidays.');
    ATT_HOLIDAYS = Array.isArray(data) ? data : [];
    const totalPages = Math.max(1, Math.ceil(ATT_HOLIDAYS.length / ATT_HOLIDAYS_PAGE_SIZE));
    ATT_HOLIDAYS_PAGE = Math.min(Math.max(ATT_HOLIDAYS_PAGE, 1), totalPages);
    renderHolidayRows();
    if (status) {
      status.textContent = ATT_HOLIDAYS.length
        ? `Loaded ${ATT_HOLIDAYS.length} holiday(s) for ${year}.`
        : 'No holidays loaded.';
    }
  } catch (err) {
    ATT_HOLIDAYS = [];
    renderHolidayPagination(0);
    tbody.innerHTML = `<tr><td colspan="7" class="att-empty">${esc(err.message)}</td></tr>`;
    if (status) status.textContent = err.message;
  }
}

async function syncHolidayCalendar() {
  const status = document.getElementById('holiday-calendar-status');
  const year = holidayCalendarYear();
  if (status) status.textContent = `Syncing PH holidays for ${year}...`;
  try {
    const res = await apiFetch('/api/holidays/sync', {
      method: 'POST',
      body: JSON.stringify({ year, country_code: 'PH' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to sync holidays.');
    if (status) status.textContent = data.message || 'Holiday calendar synced.';
    loadHolidayCalendar();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function saveHolidayOverride(holidayId) {
  const status = document.getElementById('holiday-calendar-status');
  const body = {
    holiday_type: document.getElementById(`holiday-type-${holidayId}`)?.value,
    multiplier: document.getElementById(`holiday-multiplier-${holidayId}`)?.value,
    is_active: document.getElementById(`holiday-active-${holidayId}`)?.value,
  };
  if (status) status.textContent = 'Saving holiday override...';
  try {
    const res = await apiFetch(`/api/holidays/${Number(holidayId)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save holiday.');
    if (status) status.textContent = data.message || 'Holiday updated.';
    loadHolidayCalendar();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

window.addEventListener('DOMContentLoaded', watchAttendanceActivation);
window.initAttendance = initAttendance;
window.switchAttTab = switchAttTab;
window.syncAttendanceValidationPolicy = syncAttendanceValidationPolicy;
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
window.setBiometricEventsPage = setBiometricEventsPage;
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
window.loadHolidayCalendar = loadHolidayCalendar;
window.syncHolidayCalendar = syncHolidayCalendar;
window.saveHolidayOverride = saveHolidayOverride;
window.setHolidayCalendarPage = setHolidayCalendarPage;
window.switchAttendancePolicyTab = switchAttendancePolicyTab;
document.addEventListener('click', closeAttendanceActionMenus);
window.addEventListener('resize', closeAttendanceActionMenus);
window.addEventListener('scroll', closeAttendanceActionMenus, true);
