/* ============================================================
   public/js/reports.js — Attendance DTR, payroll registry, payslip
   ============================================================ */

const REPORT_OUTPUTS = [
  {
    id: 'daily-attendance',
    name: 'Attendance DTR',
    description: 'Daily time record with time in, time out, hours, late, undertime, and payroll-ready status.',
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
  payrollPeriods: []
};

const REGISTRY_TYPES = [
  { value: 'main', label: 'Main Sewing Registry' },
  { value: '55', label: '55% Sewing Registry' },
  { value: '45', label: '45% Sewing Registry' },
  { value: 'swr-fxr-sum', label: 'SWR-FXR-SUM Registry' }
];

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
  if (reportState.dependenciesLoaded) return;
  const [employees, periods, setup] = await Promise.all([
    fetchReportRows('/api/employees', employeesPayload),
    fetchReportRows('/api/payroll/runs', rowsPayload),
    fetchReportRows('/api/employee-setup/lookups', data => data.departments || [])
  ]);
  reportState.employees = employees;
  reportState.payrollPeriods = periods;
  reportState.departments = setup;
  populateReportPayrollPeriodSelect();
  reportState.dependenciesLoaded = true;
}

async function fetchReportRows(url, extractRows) {
  try {
    const res = await apiFetch(url);
    if (!res || !res.ok) return [];
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

  body.innerHTML = REPORT_OUTPUTS.map(output => `
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
        </div>
      </td>
    </tr>
  `).join('');
}

async function generateReportOutput(reportId, trigger = null) {
  openReportOptionsModal(reportId, 'generate', trigger);
}

async function printReportOutput(reportId, trigger = null) {
  openReportOptionsModal(reportId, 'print', trigger);
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
  if (output.id === 'payroll-register' && !/^\d{4}-\d{2}/.test(filters.payroll_period || '')) {
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
    .filter(emp => !department || (emp.department || emp.department_name || '') === department)
    .map(emp => ({ value: emp.id, label: employeeOptionLabel(emp) }))
    .filter(option => option.value);
}

function openReportOptionsModal(reportId, action, trigger = null) {
  const output = REPORT_OUTPUTS.find(item => item.id === reportId);
  if (!output) return;
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
  const showRegistry = reportId === 'payroll-register';

  const modal = document.createElement('div');
  modal.id = 'report-options-modal';
  modal.className = 'report-modal-backdrop';
  modal.innerHTML = `
    <div class="report-modal" role="dialog" aria-modal="true" aria-labelledby="report-options-title">
      <div class="report-modal-header">
        <div>
          <h3 id="report-options-title">${escapeHtml(output.name)}</h3>
          <p>Select filters before ${action === 'print' ? 'previewing or printing' : 'generating'} this report.</p>
        </div>
        <button type="button" class="report-modal-close" onclick="closeReportOptionsModal()">×</button>
      </div>
      <div class="report-modal-body">
        <div class="report-options-grid">
          <label>Date From
            <input id="report-modal-date-from" class="search-input" type="date" value="${escapeAttr(dateFrom)}">
          </label>
          <label>Date To
            <input id="report-modal-date-to" class="search-input" type="date" value="${escapeAttr(dateTo)}">
          </label>
          <label>Payroll Period
            <select id="report-modal-payroll-period" class="filter-select">
              <option value="all">All periods</option>
              ${periodOptions.map(option => `<option value="${escapeAttr(option.value)}" ${String(option.value) === payrollPeriod ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
            </select>
          </label>
          <label>Department
            <select id="report-modal-department" class="filter-select" onchange="renderReportModalEmployeeOptions()">
              <option value="all">All departments</option>
              ${deptOptions.map(option => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>`).join('')}
            </select>
          </label>
          <label class="span-2">Employee${requiresEmployee ? ' *' : ''}
            <select id="report-modal-employee" class="filter-select">
              <option value="all">All employees</option>
              ${empOptions.map(option => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>`).join('')}
            </select>
          </label>
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
        <button class="btn btn-primary" type="button" onclick="confirmReportOptionsModal()">${action === 'print' ? 'Preview / Print' : 'Generate'}</button>
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
      ? 'Select one employee before generating an attendance DTR.'
      : 'Select one employee before generating a payslip.');
    return;
  }
  if (reportId === 'employee-payslip' && !filters.payroll_period) {
    alert('Select a payroll period before generating a payslip.');
    return;
  }
  if (reportId === 'payroll-register' && !/^\d{4}-\d{2}/.test(filters.payroll_period || '')) {
    alert('Select a monthly payroll period before generating a payroll registry.');
    return;
  }

  closeReportOptionsModal();

  if (reportId === 'payroll-register' && ['main', '55', '45'].includes(registryType) && action === 'print') {
    await printSewingRegistryHtml(registryType, trigger, filters.payroll_period);
    return;
  }
  const result = await loadReportOutput(reportId, trigger, action === 'print' ? 'Preparing...' : 'Generating...', {
    formatOverride: action === 'print' ? 'pdf' : undefined,
    filterOverrides: filters
  });
  if (!result) return;
  if (action === 'print') previewBlob(result.blob);
  else downloadBlob(result.blob, result.filename);
}

async function printSewingRegistryHtml(kind, trigger = null, payrollPeriodOverride = '') {
  const dateFrom = valueOf('report-date-from');
  const dateTo = valueOf('report-date-to');
  const payrollPeriod = payrollPeriodOverride || normalizedPayrollPeriod(dateFrom, dateTo);
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
window.closeReportOptionsModal = closeReportOptionsModal;
window.confirmReportOptionsModal = confirmReportOptionsModal;
window.renderReportModalEmployeeOptions = renderReportModalEmployeeOptions;
