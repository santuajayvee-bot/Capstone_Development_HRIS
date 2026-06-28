/* ============================================================
   public/js/reports.js — Attendance DTR, payroll registry, payslip
   ============================================================ */

const REPORT_OUTPUTS = [
  {
    id: 'daily-attendance',
    name: 'Attendance DTR',
    description: 'Daily time record for one selected employee and selected date range.',
    formats: ['pdf']
  },
  {
    id: 'payroll-register',
    name: 'Payroll Registry',
    description: 'Production payroll registry in Main, 55%, 45%, or SWR-FXR-SUM format.',
    formats: ['pdf']
  },
  {
    id: 'employee-payslip',
    name: 'Payslip',
    description: 'One employee payslip for one selected payroll period.',
    formats: ['pdf']
  }
];

const reportState = {
  bound: false,
  dependenciesLoaded: false,
  outputCache: new Map(),
  pendingReportId: null,
  pendingReportAction: 'generate',
  pendingReportTrigger: null,
  employees: [],
  departments: [],
  payrollPeriods: [],
  pendingDtrAnchorFilters: null
};

const REGISTRY_TYPES = [
  { value: 'main', label: 'Main Sewing Registry' },
  { value: '55', label: '55% Sewing Registry' },
  { value: '45', label: '45% Sewing Registry' },
  { value: 'swr-fxr-sum', label: 'SWR-FXR-SUM Registry' }
];
const DTR_ANCHOR_ROLES = new Set(['hr_admin', 'hr_manager']);

document.addEventListener('DOMContentLoaded', initReportsPage);
document.addEventListener('partialsLoaded', initReportsPage);

const reportsPage = document.getElementById('page-reports');
if (reportsPage) {
  new MutationObserver(() => {
    if (reportsPage.classList.contains('active')) initReportsPage();
  }).observe(reportsPage, { attributes: true, attributeFilter: ['class'] });
}

async function initReportsPage() {
  if (!document.getElementById('report-library-body')) return;

  if (!reportState.bound) {
    setDefaultReportDates();
    bindReportEvents();
    reportState.bound = true;
  }

  renderReportOutputs();
  await loadReportDependencies();
}

function setDefaultReportDates() {
  const from = document.getElementById('report-date-from');
  const to = document.getElementById('report-date-to');
  if (!from || !to || from.value) return;
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  from.value = firstDay.toISOString().slice(0, 10);
  to.value = today.toISOString().slice(0, 10);
}

function bindReportEvents() {
  const resetBtn = document.getElementById('report-reset-btn');
  if (resetBtn && resetBtn.dataset.reportBound !== 'true') {
    resetBtn.addEventListener('click', resetReportFilters);
    resetBtn.dataset.reportBound = 'true';
  }
}

function resetReportFilters() {
  ['report-date-from', 'report-date-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['report-payroll-period'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  setDefaultReportDates();
}

async function loadReportDependencies() {
  if (
    reportState.dependenciesLoaded
    && reportState.employees.length
    && reportState.payrollPeriods.length
  ) return;
  const filters = await fetchReportRows('/api/reports/filters', data => data || null);
  if (filters) {
    reportState.employees = employeesPayload(filters.employees || []);
    reportState.payrollPeriods = rowsPayload(filters.payroll_periods || filters.periods || []);
    reportState.departments = filters.departments || [];
  }
  if (!reportState.employees.length) {
    reportState.employees = await fetchReportRows('/api/attendance/employees', employeesPayload);
  }
  if (!reportState.payrollPeriods.length) {
    reportState.payrollPeriods = await fetchReportRows('/api/payroll/runs', rowsPayload);
  }
  if (!reportState.departments.length) {
    reportState.departments = uniqueReportDepartments(reportState.employees);
  }
  populateReportPayrollPeriodSelect();
  reportState.dependenciesLoaded = Boolean(reportState.employees.length || reportState.payrollPeriods.length || reportState.departments.length);
}

async function fetchReportRows(url, extractRows) {
  try {
    const res = await apiFetch(url);
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status || 'request failed'}`);
    const data = await res.json();
    return extractRows(data);
  } catch (err) {
    console.warn(`Unable to load ${url}:`, err.message);
    return [];
  }
}

function populateReportPayrollPeriodSelect() {
  const select = document.getElementById('report-payroll-period');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="all">All periods</option>' +
    reportState.payrollPeriods
      .map(run => ({
        value: run.month_year || run.payroll_period || run.id,
        label: reportPeriodLabel(run)
      }))
      .filter(option => option.value !== undefined && option.value !== null && option.value !== '')
      .map(option => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function employeesPayload(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.employees)) return data.employees;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function uniqueReportDepartments(employees) {
  return [...new Set((employees || [])
    .map(employee => employee.department || employee.department_name || '')
    .map(value => String(value || '').trim())
    .filter(Boolean))]
    .sort()
    .map(name => ({ name }));
}

function rowsPayload(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.runs)) return data.runs;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function renderReportOutputs() {
  const body = document.getElementById('report-library-body');
  const count = document.getElementById('report-library-count');
  if (!body) return;
  if (count) count.textContent = `${REPORT_OUTPUTS.length} outputs available. DTR and payslips require one selected employee.`;

  body.innerHTML = REPORT_OUTPUTS.map(output => {
    const dtrAnchorButton = output.id === 'daily-attendance'
      ? `<button class="btn btn-outline btn-sm" type="button" onclick="anchorDtrOutput('${escapeAttr(output.id)}', this)">Finalize & Anchor DTR</button>`
      : '';
    return `
      <tr>
        <td>${escapeHtml(output.name)}</td>
        <td>${escapeHtml(output.description)}</td>
        <td>
          <select class="filter-select report-format-select" id="report-format-${escapeAttr(output.id)}">
            ${output.formats.map(format => `<option value="${escapeAttr(format)}">${escapeHtml(format.toUpperCase())}</option>`).join('')}
          </select>
        </td>
        <td>
          <div class="button-row">
            <button class="btn btn-primary btn-sm" type="button" onclick="generateReportOutput('${escapeAttr(output.id)}', this)">Generate</button>
            <button class="btn btn-outline btn-sm" type="button" onclick="printReportOutput('${escapeAttr(output.id)}', this)">Print</button>
            ${dtrAnchorButton}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function generateReportOutput(reportId, trigger = null) {
  await loadReportDependencies();
  if (!reportState.employees.length || !reportState.payrollPeriods.length) {
    reportState.dependenciesLoaded = false;
    await loadReportDependencies();
  }
  openReportOptionsModal(reportId, 'generate', trigger);
}

async function printReportOutput(reportId, trigger = null) {
  await loadReportDependencies();
  if (!reportState.employees.length || !reportState.payrollPeriods.length) {
    reportState.dependenciesLoaded = false;
    await loadReportDependencies();
  }
  openReportOptionsModal(reportId, 'print', trigger);
}

async function anchorDtrOutput(reportId, trigger = null) {
  if (!canFinalizeDtrFromReports()) {
    alert('Only HR Admin / HR Manager can finalize and anchor an Attendance DTR.');
    return;
  }
  openReportOptionsModal(reportId, 'anchor', trigger);
}

async function loadReportOutput(reportId, trigger = null, loadingText = 'Loading...', options = {}) {
  const output = REPORT_OUTPUTS.find(item => item.id === reportId);
  if (!output) return null;
  const format = options.formatOverride || valueOf(`report-format-${reportId}`) || output.formats[0];
  const filters = { ...reportFilterPayload(), ...(options.filterOverrides || {}) };
  if (output.id === 'daily-attendance' && !/^\d+$/.test(filters.employee_id || '')) {
    alert('Select one employee before generating an attendance DTR.');
    return null;
  }
  if (output.id === 'employee-payslip') {
    if (!/^\d+$/.test(filters.employee_id || '')) {
      alert('Select one employee before generating a payslip.');
      return null;
    }
    if (!filters.payroll_period || filters.payroll_period === 'all') {
      alert('Select a payroll period before generating a payslip.');
      return null;
    }
  }
  if (output.id === 'payroll-register' && !registryMonthFromPeriod(filters.payroll_period)) {
    alert('Select a monthly payroll period before generating a payroll registry.');
    return null;
  }

  const query = new URLSearchParams(filters);
  query.set('_fresh', Date.now().toString());

  const button = trigger?.closest?.('button') || null;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = loadingText;
  }

  try {
    const res = await apiFetch(`/api/reports/${encodeURIComponent(output.id)}.${encodeURIComponent(format)}?${query.toString()}`);
    if (!res || !res.ok) {
      const error = await safeJson(res);
      throw new Error(error?.error || 'Output generation failed.');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `${output.id}.${format === 'excel' ? 'xlsx' : format}`;
    return { blob, filename };
  } catch (err) {
    console.error('Output generation failed:', err);
    alert(err.message || 'Unable to generate output.');
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function reportFilterPayload() {
  const dateFrom = valueOf('report-date-from');
  const dateTo = valueOf('report-date-to');
  return {
    date_from: dateFrom,
    date_to: dateTo,
    payroll_period: normalizedPayrollPeriod(dateFrom, dateTo),
    employee_id: '',
    department: '',
    registry_type: 'main'
  };
}

function normalizedPayrollPeriod(dateFrom, dateTo) {
  const selected = valueOf('report-payroll-period');
  if (selected && selected !== 'all') return selected;
  return monthlyPeriodFromDates(dateFrom, dateTo) || selected;
}

function monthlyPeriodFromDates(dateFrom, dateTo) {
  const fromMonth = String(dateFrom || '').match(/^(\d{4}-\d{2})-\d{2}$/)?.[1] || '';
  const toMonth = String(dateTo || '').match(/^(\d{4}-\d{2})-\d{2}$/)?.[1] || '';
  if (fromMonth && toMonth && fromMonth === toMonth) return fromMonth;
  if (fromMonth && !toMonth) return fromMonth;
  if (!fromMonth && toMonth) return toMonth;
  return '';
}

function reportPeriodLabel(run) {
  const value = run.month_year || run.payroll_period || '';
  const label = run.period_label || run.payroll_period_label || value || `Run ${run.id}`;
  if (!value) return label;
  if (label && label !== value) return `${value} - ${label}`;
  return value;
}

function registryMonthFromPeriod(period) {
  const match = String(period || '').match(/^(\d{4}-\d{2})/);
  return match ? match[1] : '';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function previewBlob(blob) {
  const url = URL.createObjectURL(blob);
  const popup = window.open(url, '_blank', 'width=1200,height=800');
  if (!popup) {
    URL.revokeObjectURL(url);
    alert('Allow pop-ups to preview the report.');
    return;
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function employeeOptionLabel(emp) {
  const name = [emp.first_name, emp.middle_name, emp.last_name].filter(Boolean).join(' ') || emp.employee_name || emp.name || 'Employee';
  return `${emp.employee_code || emp.id} - ${name}`;
}

function departmentOptions() {
  return reportState.departments
    .map(dept => ({ value: dept.name || dept, label: dept.name || dept }))
    .filter(option => option.value);
}

function employeeOptions(department = '') {
  return reportState.employees
    .filter(emp => !department || String(emp.department || emp.department_name || '').trim() === department)
    .map(emp => ({ value: emp.id || emp.employee_id, label: employeeOptionLabel(emp) }))
    .filter(option => option.value);
}

function normalizeReportRole(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function reportsUserRole() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return normalizeReportRole(user?.role || document.body?.dataset?.userRole || '');
}

function canFinalizeDtrFromReports() {
  const user = typeof getUser === 'function' ? getUser() : null;
  const role = reportsUserRole();
  const label = String(user?.roleLabel || user?.role_label || '').toLowerCase();
  return DTR_ANCHOR_ROLES.has(role) || /\bhr\s+(admin|manager)\b/i.test(label);
}

function openReportOptionsModal(reportId, action, trigger = null) {
  const output = REPORT_OUTPUTS.find(item => item.id === reportId);
  if (!output) return;
  if (action === 'anchor' && output.id !== 'daily-attendance') return;
  reportState.pendingReportId = reportId;
  reportState.pendingReportAction = action;
  reportState.pendingReportTrigger = trigger || null;
  document.getElementById('report-options-modal')?.remove();

  const dateFrom = valueOf('report-date-from');
  const dateTo = valueOf('report-date-to');
  const payrollPeriod = valueOf('report-payroll-period');
  const deptOptions = departmentOptions();
  const empOptions = employeeOptions();
  const periodOptions = reportState.payrollPeriods
    .map(run => ({ value: run.month_year || run.payroll_period || run.id, label: reportPeriodLabel(run) }))
    .filter(option => option.value);
  const requiresEmployee = ['daily-attendance', 'employee-payslip'].includes(reportId);
  const showRegistry = reportId === 'payroll-register' && action !== 'anchor';
  const actionPhrase = action === 'anchor'
    ? 'finalizing and anchoring'
    : action === 'print'
      ? 'previewing or printing'
      : 'generating';
  const primaryLabel = action === 'anchor'
    ? 'Finalize & Anchor DTR'
    : action === 'print'
      ? 'Preview / Print'
      : 'Generate';

  const modal = document.createElement('div');
  modal.id = 'report-options-modal';
  modal.className = 'report-modal-backdrop';
  modal.innerHTML = `
    <div class="report-modal" role="dialog" aria-modal="true" aria-labelledby="report-options-title">
      <div class="report-modal-header">
        <div>
          <h3 id="report-options-title">${escapeHtml(output.name)}</h3>
          <p>Select filters before ${actionPhrase} this report.</p>
        </div>
        <button type="button" class="report-modal-close" onclick="closeReportOptionsModal()">×</button>
      </div>
      <div class="report-modal-body">
        <div class="report-options-grid">
          ${isAttendanceDtr ? `
            <label>DTR Date From
              <input id="report-modal-date-from" class="search-input" type="date" value="${escapeAttr(dtrDateFrom)}">
            </label>
            <label>DTR Date To
              <input id="report-modal-date-to" class="search-input" type="date" value="${escapeAttr(dtrDateTo)}">
            </label>
          ` : `
            <label>Date From
              <input id="report-modal-date-from" class="search-input" type="date" value="${escapeAttr(dateFrom)}">
            </label>
            <label>Date To
              <input id="report-modal-date-to" class="search-input" type="date" value="${escapeAttr(dateTo)}">
            </label>
          `}
          <label>Payroll Period
            <select id="report-modal-payroll-period" class="filter-select">
              <option value="all">All periods</option>
              ${periodOptions.map(option => `<option value="${escapeAttr(option.value)}" ${String(option.value) === payrollPeriod ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
            </select>
          </label>
          <label class="span-2">Employee${requiresEmployee ? ' *' : ''}
            <select id="report-modal-employee" class="filter-select">
              <option value="all">All employees</option>
              ${empOptions.map(option => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>`).join('')}
            </select>
          </label>
          ${action === 'anchor' ? `
            <div class="span-2 report-anchor-warning">
              This creates the official finalized DTR record, computes its SHA-256 hash, and anchors only the hash/audit metadata. Generate/Print remains for preview only.
            </div>
          ` : ''}
          ${showRegistry ? `
            <div class="span-2 report-choice-block">
              <div class="report-choice-title">Registry Type</div>
              <div class="report-format-list">
                ${REGISTRY_TYPES.map((type, index) => `
                  <label>
                    <input type="radio" name="registry-choice-type" value="${escapeAttr(type.value)}" ${index === 0 ? 'checked' : ''} />
                    ${escapeHtml(type.label)}
                  </label>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>
      <div class="report-modal-footer">
        <button class="btn btn-outline" type="button" onclick="closeReportOptionsModal()">Cancel</button>
        <button class="btn btn-primary" type="button" onclick="confirmReportOptionsModal()">${primaryLabel}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function closeReportOptionsModal() {
  document.getElementById('report-options-modal')?.remove();
}

function renderReportModalEmployeeOptions() {
  const select = document.getElementById('report-modal-employee');
  if (!select) return;
  const department = valueOf('report-modal-department');
  const selected = select.value;
  const options = employeeOptions(department === 'all' ? '' : department);
  select.innerHTML = '<option value="all">All employees</option>' +
    options.map(option => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>`).join('');
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function reportModalFilters(extra = {}) {
  const dateFrom = valueOf('report-modal-date-from');
  const dateTo = valueOf('report-modal-date-to');
  return {
    date_from: dateFrom,
    date_to: dateTo,
    payroll_period: valueOf('report-modal-payroll-period') !== 'all'
      ? valueOf('report-modal-payroll-period')
      : monthlyPeriodFromDates(dateFrom, dateTo),
    department: valueOf('report-modal-department'),
    employee_id: valueOf('report-modal-employee'),
    ...extra
  };
}

async function confirmReportOptionsModal() {
  const reportId = reportState.pendingReportId;
  const action = reportState.pendingReportAction || 'generate';
  const trigger = reportState.pendingReportTrigger;
  const output = REPORT_OUTPUTS.find(item => item.id === reportId);
  if (!output) return;
  const registryType = document.querySelector('input[name="registry-choice-type"]:checked')?.value || 'main';
  const filters = reportModalFilters({ registry_type: registryType });

  if (['daily-attendance', 'employee-payslip'].includes(reportId) && !/^\d+$/.test(filters.employee_id || '')) {
    alert(reportId === 'daily-attendance'
      ? `Select one employee before ${action === 'anchor' ? 'finalizing and anchoring' : 'generating'} an attendance DTR.`
      : 'Select one employee before generating a payslip.');
    return;
  }
  if (reportId === 'daily-attendance' && (!/^\d{4}-\d{2}-\d{2}$/.test(filters.date_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(filters.date_to || ''))) {
    alert('Select a DTR date range before generating an attendance DTR.');
    return;
  }
  if (reportId === 'daily-attendance' && filters.date_from > filters.date_to) {
    alert('DTR Date From must be before or equal to DTR Date To.');
    return;
  }
  if (reportId === 'employee-payslip' && !filters.payroll_period) {
    alert('Select a payroll period before generating a payslip.');
    return;
  }
  if (reportId === 'payroll-register' && !registryMonthFromPeriod(filters.payroll_period)) {
    alert('Select a monthly payroll period before generating a payroll registry.');
    return;
  }

  closeReportOptionsModal();

  if (action === 'anchor') {
    await finalizeAndAnchorDtrFromReports(filters, trigger);
    return;
  }

  if (reportId === 'payroll-register' && ['main', '55', '45'].includes(registryType) && action === 'print') {
    await printSewingRegistryHtml(registryType, trigger, registryMonthFromPeriod(filters.payroll_period));
    return;
  }
  const result = await loadReportOutput(reportId, trigger, action === 'print' ? 'Preparing...' : 'Generating...', {
    formatOverride: action === 'print' ? 'pdf' : undefined,
    filterOverrides: filters
  });
  if (!result) return;
  if (action === 'print') previewBlob(result.blob);
  else {
    downloadBlob(result.blob, result.filename);
    if (reportId === 'daily-attendance' && canFinalizeDtrFromReports()) {
      showDtrPostGeneratePrompt(filters);
    }
  }
}

function selectedReportEmployeeLabel(employeeId) {
  const employee = reportState.employees.find(emp => String(emp.id) === String(employeeId));
  return employee ? employeeOptionLabel(employee) : `Employee #${employeeId}`;
}

function validateDtrAnchorFilters(filters) {
  if (!/^\d+$/.test(filters.employee_id || '')) {
    alert('Select one employee before finalizing and anchoring an attendance DTR.');
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filters.date_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(filters.date_to || '')) {
    alert('Select a valid Date From and Date To before finalizing and anchoring an attendance DTR.');
    return false;
  }
  if (filters.date_to < filters.date_from) {
    alert('Date To cannot be earlier than Date From.');
    return false;
  }
  return true;
}

function closeDtrPostGenerateModal() {
  document.getElementById('dtr-post-generate-modal')?.remove();
}

async function confirmDtrAnchorFromGeneratedReport() {
  const filters = reportState.pendingDtrAnchorFilters;
  closeDtrPostGenerateModal();
  if (!filters) return;
  await finalizeAndAnchorDtrFromReports(filters);
}

function showDtrPostGeneratePrompt(filters) {
  reportState.pendingDtrAnchorFilters = { ...filters };
  closeDtrPostGenerateModal();
  const employeeLabel = selectedReportEmployeeLabel(filters.employee_id);
  const modal = document.createElement('div');
  modal.id = 'dtr-post-generate-modal';
  modal.className = 'report-modal-backdrop';
  modal.innerHTML = `
    <div class="report-modal" role="dialog" aria-modal="true" aria-labelledby="dtr-post-generate-title">
      <div class="report-modal-header">
        <div>
          <h3 id="dtr-post-generate-title">Attendance DTR Generated</h3>
          <p>The PDF was generated. If HR has verified it, finalize and anchor the official DTR hash now.</p>
        </div>
        <button type="button" class="report-modal-close" onclick="closeDtrPostGenerateModal()">×</button>
      </div>
      <div class="report-modal-body">
        <div class="report-anchor-warning">
          Finalize & Anchor DTR for <strong>${escapeHtml(employeeLabel)}</strong><br>
          Period: <strong>${escapeHtml(filters.date_from)}</strong> to <strong>${escapeHtml(filters.date_to)}</strong>
        </div>
      </div>
      <div class="report-modal-footer">
        <button class="btn btn-outline" type="button" onclick="closeDtrPostGenerateModal()">Later</button>
        <button class="btn btn-primary" type="button" onclick="confirmDtrAnchorFromGeneratedReport()">Finalize & Anchor DTR</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function finalizeAndAnchorDtrFromReports(filters, trigger = null) {
  if (!validateDtrAnchorFilters(filters)) return;

  const employeeLabel = selectedReportEmployeeLabel(filters.employee_id);
  const confirmed = window.confirm(
    `Finalize and anchor the official DTR for ${employeeLabel} from ${filters.date_from} to ${filters.date_to}?\n\n` +
    'This will save an off-chain DTR record, compute its SHA-256 hash, and submit only the hash/audit metadata to the blockchain layer.'
  );
  if (!confirmed) return;

  const button = trigger?.closest?.('button') || trigger || null;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Anchoring...';
  }

  try {
    const response = await apiFetch(`/api/blockchain/dtr/generate/${encodeURIComponent(filters.employee_id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_date: filters.date_from,
        end_date: filters.date_to,
        remarks: 'Finalized and anchored from Reports module'
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) {
      if (response.status === 409 && data.existing_dtr_id) {
        showDtrAnchorResult({
          status: 'existing',
          message: data.error || 'A finalized DTR already exists for this employee and date range.',
          dtr_id: data.existing_dtr_id
        });
        return;
      }
      throw new Error(data.error || 'Unable to finalize and anchor DTR.');
    }
    showDtrAnchorResult(data);
  } catch (err) {
    console.error('DTR anchor failed:', err);
    showDtrAnchorResult({
      status: 'failed',
      message: err.message || 'Unable to finalize and anchor DTR.'
    });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function dtrAnchorStatusLabel(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'success') return 'Recorded on Fabric';
  if (normalized === 'pending_anchor') return 'Finalized locally - Pending Fabric anchor';
  if (normalized === 'existing') return 'Already finalized';
  if (normalized === 'failed') return 'Failed';
  return status || 'Completed';
}

async function retryPendingDtrAnchor(dtrId, trigger = null) {
  const id = String(dtrId || '').trim();
  if (!id || id === '-') {
    alert('No pending DTR ID is available for retry.');
    return;
  }

  const button = trigger?.closest?.('button') || trigger || null;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Retrying...';
  }

  try {
    const response = await apiFetch(`/api/blockchain/dtr/anchor/${encodeURIComponent(id)}`, {
      method: 'POST'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) {
      throw new Error(data.error || 'Unable to retry DTR blockchain anchor.');
    }
    showDtrAnchorResult(data);
  } catch (err) {
    console.error('DTR anchor retry failed:', err);
    showDtrAnchorResult({
      status: 'failed',
      dtr_id: id,
      message: err.message || 'Unable to retry DTR blockchain anchor.'
    });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function closeDtrAnchorResultModal() {
  document.getElementById('dtr-anchor-result-modal')?.remove();
}

function showDtrAnchorResult(data = {}) {
  closeDtrAnchorResultModal();
  const status = dtrAnchorStatusLabel(data.status);
  const isCritical = ['failed'].includes(String(data.status || '').toLowerCase());
  const isPending = String(data.status || '').toLowerCase() === 'pending_anchor';
  const dtrId = String(data.dtr_id || '').trim();
  const retryButton = isPending && dtrId
    ? `<button class="btn btn-outline" type="button" onclick="retryPendingDtrAnchor('${escapeAttr(dtrId)}', this)">Retry Fabric Anchor</button>`
    : '';
  const modal = document.createElement('div');
  modal.id = 'dtr-anchor-result-modal';
  modal.className = 'report-modal-backdrop';
  modal.innerHTML = `
    <div class="report-modal" role="dialog" aria-modal="true" aria-labelledby="dtr-anchor-result-title">
      <div class="report-modal-header">
        <div>
          <h3 id="dtr-anchor-result-title">DTR Blockchain Result</h3>
          <p>${escapeHtml(data.message || 'DTR blockchain request completed.')}</p>
        </div>
        <button type="button" class="report-modal-close" onclick="closeDtrAnchorResultModal()">×</button>
      </div>
      <div class="report-modal-body">
        <div class="report-result-grid">
          <div><span>Status</span><strong class="${isCritical ? 'result-critical' : isPending ? 'result-warning' : 'result-success'}">${escapeHtml(status)}</strong></div>
          <div><span>DTR ID</span><strong>${escapeHtml(data.dtr_id || '-')}</strong></div>
          <div class="span-2"><span>DTR Hash</span><code>${escapeHtml(data.dtr_hash || data.computed_hash || '-')}</code></div>
          <div class="span-2"><span>Transaction Hash</span><code>${escapeHtml(data.transaction_hash || '-')}</code></div>
        </div>
        ${isPending ? '<div class="report-anchor-warning">The DTR is finalized in MySQL and queued as PENDING_ANCHOR. Once Fabric is reachable and the DTR chaincode is deployed, click Retry Fabric Anchor.</div>' : ''}
      </div>
      <div class="report-modal-footer">
        ${retryButton}
        <button class="btn btn-primary" type="button" onclick="closeDtrAnchorResultModal()">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function printSewingRegistryHtml(kind, trigger = null, payrollPeriodOverride = '') {
  const dateFrom = valueOf('report-date-from');
  const dateTo = valueOf('report-date-to');
  const payrollPeriod = registryMonthFromPeriod(payrollPeriodOverride || normalizedPayrollPeriod(dateFrom, dateTo));
  if (!/^\d{4}-\d{2}$/.test(payrollPeriod || '')) {
    alert('Select a monthly payroll period before printing a payroll registry.');
    return;
  }

  const button = trigger?.closest?.('button') || null;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Preparing...';
  }

  try {
    const cacheKey = `sewing-registry-html.${kind}.${payrollPeriod}`;
    let registry = reportState.outputCache.get(cacheKey);
    if (!registry) {
      const response = await apiFetch(`/api/payroll/sewing-registries?month_year=${encodeURIComponent(payrollPeriod)}&kind=${encodeURIComponent(kind)}`);
      registry = await response.json();
      if (!response.ok) throw new Error(registry.error || 'Failed to load sewing registry.');
      reportState.outputCache.set(cacheKey, registry);
    }
    printHtmlDocument(renderSewingRegistryHtml(registry), 'Sewing Payroll Registry');
  } catch (err) {
    console.error('Unable to print sewing registry:', err);
    alert(err.message || 'Unable to print sewing registry.');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function renderSewingRegistryHtml(registry) {
  const title = registry.kind === '55' ? '55% Sewing Payroll Registry'
    : registry.kind === '45' ? '45% Sewing Payroll Registry'
      : 'Main Sewing Payroll Registry';
  const dates = Array.isArray(registry.dates) ? registry.dates : [];
  const dailyHeaders = dates.map(date => `<th class="sewing-registry-date"><span>${escapeHtml(sewingRegistryDate(date))}</span><small>Daily Output</small></th>`).join('');
  const employees = (registry.employees || []).map(employee => {
    const body = (employee.rows || []).map(row => `
      <tr>
        <td>${escapeHtml(row.operation_type)}</td>
        <td>${escapeHtml(row.size_range || '-')}</td>
        <td>${reportPeso(row.rate_per_piece)}</td>
        ${dates.map(date => `<td>${registryNumber(row.daily?.[date] || 0)}</td>`).join('')}
        <td>${registryNumber(row.total_output)}</td>
        <td>${reportPeso(row.amount)}</td>
        <td>${escapeHtml(row.partner_roles || 'Solo')}</td>
      </tr>
    `).join('');
    const dailyTotals = dates.map(date => `<th>${registryNumber(employee.daily_totals?.[date] || 0)}</th>`).join('');
    return `
      <tr class="sewing-registry-employee"><th colspan="${dates.length + 7}">${escapeHtml(employee.employee_name)}${employee.agency ? ` - ${escapeHtml(employee.agency)}` : ''}</th></tr>
      ${body}
      <tr class="sewing-registry-total">
        <th colspan="3">Employee Daily Total</th>
        ${dailyTotals}
        <th>${registryNumber(employee.total_output)}</th>
        <th>${reportPeso(employee.total_amount)}</th>
        <th></th>
      </tr>
    `;
  }).join('');
  const grandDailyTotals = dates.map(date => `<th>${registryNumber(registry.totals?.daily_totals?.[date] || 0)}</th>`).join('');
  return `
    <div class="sewing-registry-print">
      <h3>${escapeHtml(title)}</h3>
      <p>PAYROLL PERIOD: ${escapeHtml(registry.payroll_period)}</p>
      <table>
        <thead>
          <tr>
            <th>Sew Type</th>
            <th>Size</th>
            <th>Rate/Piece</th>
            ${dailyHeaders}
            <th>Total Output</th>
            <th>Amount</th>
            <th>Partner Role</th>
          </tr>
        </thead>
        <tbody>${employees || `<tr><td colspan="${dates.length + 7}">No daily sewing output was encoded for this period.</td></tr>`}</tbody>
        <tfoot>
          <tr>
            <th colspan="3">Grand Daily Total</th>
            ${grandDailyTotals}
            <th>${registryNumber(registry.totals?.total_output)}</th>
            <th>${reportPeso(registry.totals?.total_amount)}</th>
            <th></th>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function printHtmlDocument(content, title) {
  const popup = window.open('', '_blank', 'width=1200,height=800');
  if (!popup) {
    alert('Allow pop-ups to preview the report.');
    return;
  }
  popup.document.write(`
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body{font-family:Arial,sans-serif;color:#000;padding:18px}
          h3{font-size:20px;margin:6px 0 18px}
          p{font-size:16px;margin:0 0 18px}
          table{border-collapse:collapse;width:100%;font-size:11px}
          th,td{border:1px solid #222;padding:4px;text-align:right;vertical-align:middle}
          th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}
          thead th{font-weight:700}
          .sewing-registry-date span,.sewing-registry-date small{display:block;line-height:1.1}
          .sewing-registry-date small{font-size:9px;font-weight:400}
          .sewing-registry-employee th{text-align:left;background:#eee}
          .sewing-registry-total th,tfoot th{background:#f7f7f7}
          @page{size:landscape;margin:10mm}
        </style>
      </head>
      <body>${content}</body>
    </html>
  `);
  popup.document.close();
  popup.focus();
  popup.addEventListener('load', () => {
    setTimeout(() => popup.print(), 250);
  });
}

function sewingRegistryDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '-';
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-PH', { day: '2-digit', month: 'short' });
}

function registryNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString('en-PH', { maximumFractionDigits: 2 });
}

function reportPeso(value) {
  const number = Number(value);
  return `PHP ${(Number.isFinite(number) ? number : 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

function valueOf(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

window.generateReportOutput = generateReportOutput;
window.printReportOutput = printReportOutput;
window.anchorDtrOutput = anchorDtrOutput;
window.closeReportOptionsModal = closeReportOptionsModal;
window.confirmReportOptionsModal = confirmReportOptionsModal;
window.closeDtrPostGenerateModal = closeDtrPostGenerateModal;
window.confirmDtrAnchorFromGeneratedReport = confirmDtrAnchorFromGeneratedReport;
window.closeDtrAnchorResultModal = closeDtrAnchorResultModal;
window.retryPendingDtrAnchor = retryPendingDtrAnchor;
window.renderReportModalEmployeeOptions = renderReportModalEmployeeOptions;
