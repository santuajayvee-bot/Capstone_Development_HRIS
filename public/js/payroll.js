/* ============================================================
   PAYROLL.JS — Payroll page logic with real database data
   ============================================================ */

let currentPayrollData = [];
let currentMonthYear = null;
let payrollRecordsPage = 1;
const PAYROLL_RECORDS_PAGE_SIZE = 10;
let currentSalaryCalculationRecords = [];
let salaryCalculationPage = 1;
const SALARY_CALCULATION_PAGE_SIZE = 10;
let payrollReportPage = 1;
let selectedPayrollReport = null;
let weeklyPayrollEmployees = [];
let pieceRateConfig = {
  sew_types: [],
  size_ranges: [],
  piece_rates: [],
  production_split_configs: [],
  production_shares: [],
  production_share_rules: [],
  incentives: [],
  incentive_entries: [],
  production_outputs: [],
  production_pairs: []
};
let pieceRateRecordsView = 'rates';
const PIECE_RATE_RECORDS_PAGE_SIZE = 10;
const pieceRateRecordsPages = {};

function money(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function payrollEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

async function viewPayslipDetails(employeeId, employeeName, monthYear) {
  try {
    // Fetch monthly summary with detailed breakdown
    const response = await apiFetch(`/api/payroll/employees/${employeeId}/monthly-summary/${monthYear}`);
    if (!response.ok) {
      alert('Failed to load payslip details');
      return;
    }

    const data = await response.json();
    const d = data;

    // Create detailed modal
    let earningsHTML = '';
    if (d.earnings.production && d.earnings.production.length > 0) {
      earningsHTML = `
        <div style="margin-bottom: 12px;">
          <h5 style="margin: 0 0 8px 0; font-size: 12px; font-weight: 600; color: var(--text);">Production Breakdown</h5>
          <div style="background: var(--card); border-radius: 6px; padding: 8px; font-size: 12px;">
            ${d.earnings.production.map(p => `
              <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border);">
                <span>${p.type} (${p.quantity} pcs)</span>
                <span style="font-weight: 600; color: var(--accent);">₱${parseFloat(p.amount).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (d.earnings.logistics && d.earnings.logistics.length > 0) {
      earningsHTML = `
        <div style="margin-bottom: 12px;">
          <h5 style="margin: 0 0 8px 0; font-size: 12px; font-weight: 600; color: var(--text);">Logistics Breakdown</h5>
          <div style="background: var(--card); border-radius: 6px; padding: 8px; font-size: 12px;">
            ${d.earnings.logistics.map(l => `
              <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border);">
                <span>${l.region} (${l.trips} trips)</span>
                <span style="font-weight: 600; color: var(--accent);">₱${parseFloat(l.amount).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    const modalHTML = `
      <div id="payslip-details-modal" style="
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5); display: flex; align-items: center;
        justify-content: center; z-index: 10000;
      ">
        <div style="
          background: var(--bg); border-radius: 14px; max-width: 700px;
          width: 90%; max-height: 85vh; overflow-y: auto; padding: 24px;
          border: 1px solid var(--border);
        ">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <div>
              <h2 style="margin: 0; font-size: 18px; font-weight: 700;">${employeeName}</h2>
              <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">${d.employee.code} • ${d.employee.department || 'N/A'}</div>
            </div>
            <button onclick="document.getElementById('payslip-details-modal')?.remove()" style="
              background: none; border: none; font-size: 24px; cursor: pointer; color: var(--muted);
            ">×</button>
          </div>
          
          <!-- Earnings Section -->
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
            <h4 style="margin: 0 0 12px 0; font-weight: 600; font-size: 13px; text-transform: uppercase; color: var(--muted);">Earnings</h4>
            ${earningsHTML}
            <div style="display: flex; justify-content: space-between; padding: 12px 0; border-top: 2px solid var(--border); margin-top: 8px; font-weight: 700; font-size: 14px;">
              <span style="color: var(--text);">Total Gross Pay</span>
              <span style="color: var(--accent);">₱${parseFloat(d.totalEarning).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
            </div>
          </div>

          <!-- Deductions Section -->
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
            <h4 style="margin: 0 0 12px 0; font-weight: 600; font-size: 13px; text-transform: uppercase; color: var(--muted);">Deductions</h4>
            <div style="font-size: 12px;">
              ${d.deductions.length > 0 ? d.deductions.map(ded => `
                <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border);">
                  <span>${ded.deduction_type}</span>
                  <span style="font-weight: 600; color: var(--red);">₱${parseFloat(ded.amount).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
                </div>
              `).join('') : '<div style="color: var(--muted); padding: 8px 0;">No deductions</div>'}
            </div>
            <div style="display: flex; justify-content: space-between; padding: 12px 0; border-top: 2px solid var(--border); margin-top: 8px; font-weight: 700; font-size: 14px;">
              <span style="color: var(--text);">Total Deductions</span>
              <span style="color: var(--red);">₱${parseFloat(d.totalDeduction).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
            </div>
          </div>

          <!-- Government IDs Section -->
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
            <h4 style="margin: 0 0 12px 0; font-weight: 600; font-size: 13px; text-transform: uppercase; color: var(--muted);">Contribution IDs</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12px;">
              <div>
                <label style="color: var(--muted); font-size: 11px; text-transform: uppercase;">SSS</label>
                <div style="font-weight: 600; color: var(--text);">${d.employee.governmentIds.sss}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px; text-transform: uppercase;">PhilHealth</label>
                <div style="font-weight: 600; color: var(--text);">${d.employee.governmentIds.philhealth}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px; text-transform: uppercase;">Pag-IBIG</label>
                <div style="font-weight: 600; color: var(--text);">${d.employee.governmentIds.pagibig}</div>
              </div>
            </div>
          </div>

          <!-- Net Pay Summary -->
          <div style="background: linear-gradient(135deg, rgba(34, 211, 165, 0.1), rgba(59, 130, 246, 0.1)); border: 2px solid var(--accent); border-radius: 10px; padding: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <div style="font-size: 12px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px;">Net Pay</div>
                <div style="font-size: 24px; font-weight: 700; color: var(--accent);">₱${parseFloat(d.netPay).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
              </div>
              <div style="text-align: right; font-size: 12px; color: var(--muted);">
                <div>Period: ${d.monthYear}</div>
              </div>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; margin-top: 20px;">
            <button onclick="document.getElementById('payslip-details-modal')?.remove()" class="btn btn-primary" style="font-size: 13px;">Close</button>
          </div>
        </div>
      </div>
    `;

    const modalDiv = document.createElement('div');
    modalDiv.innerHTML = modalHTML;
    document.body.appendChild(modalDiv.firstElementChild);
  } catch (err) {
    console.error('Error viewing payslip details:', err);
    alert('Failed to load payslip details');
  }
}

function renderPayroll() {
  const grid = document.getElementById('payroll-grid');
  if (!grid) return;

  const totalPages = Math.max(1, Math.ceil(currentPayrollData.length / PAYROLL_RECORDS_PAGE_SIZE));
  payrollRecordsPage = Math.min(Math.max(payrollRecordsPage, 1), totalPages);
  const startIndex = (payrollRecordsPage - 1) * PAYROLL_RECORDS_PAGE_SIZE;
  const pageRecords = currentPayrollData.slice(startIndex, startIndex + PAYROLL_RECORDS_PAGE_SIZE);

  if (currentPayrollData.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px 20px; text-align: center;">
        <div style="font-size: 14px; color: var(--muted);">
          No generated payroll records found for this period.
        </div>
      </div>
    `;
    return;
  }

  const table = `
    <table class="payroll-erp-table">
      <thead>
        <tr>
          <th>Payroll ID</th>
          <th>Employee</th>
          <th>Department</th>
          <th>Period</th>
          <th>Wage Type</th>
          <th class="text-right">Gross Pay</th>
          <th class="text-right">Deductions</th>
          <th class="text-right">Net Pay</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${pageRecords.map(p => `
          <tr>
            <td>PAY-${String(p.payroll_run_id || p.id || 0).padStart(5, '0')}</td>
            <td>${p.employee_name || '-'}<br><span class="muted-small">${p.employee_code || '-'}</span></td>
            <td>${p.department || '-'}</td>
            <td>${p.month_year || currentMonthYear || '-'}</td>
            <td>${p.wage_type || '-'}</td>
            <td class="text-right">${money(p.total_earning)}</td>
            <td class="text-right">${money(p.total_deduction)}</td>
            <td class="text-right payroll-net">${money(p.net_pay)}</td>
            <td>${payrollBadge(p.status || 'Draft')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${renderPayrollRecordsPagination(currentPayrollData.length, startIndex, totalPages)}
  `;

  grid.innerHTML = table;
  bindPayrollRecordsPagination(grid);
  if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(grid);
}

function renderPayrollRecordsPagination(totalRecords, startIndex, totalPages) {
  if (totalRecords <= PAYROLL_RECORDS_PAGE_SIZE) return '';
  const endIndex = Math.min(startIndex + PAYROLL_RECORDS_PAGE_SIZE, totalRecords);
  return `
    <div class="table-pagination">
      <span>Showing ${startIndex + 1}-${endIndex} of ${totalRecords}</span>
      <div class="table-pagination-actions">
        <button class="btn btn-outline btn-sm" type="button" data-payroll-page-action="prev" ${payrollRecordsPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${payrollRecordsPage} of ${totalPages}</span>
        <button class="btn btn-outline btn-sm" type="button" data-payroll-page-action="next" ${payrollRecordsPage >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  `;
}

function bindPayrollRecordsPagination(root) {
  root.querySelector('[data-payroll-page-action="prev"]')?.addEventListener('click', () => changePayrollRecordsPage(-1));
  root.querySelector('[data-payroll-page-action="next"]')?.addEventListener('click', () => changePayrollRecordsPage(1));
}

function changePayrollRecordsPage(direction) {
  const totalPages = Math.max(1, Math.ceil(currentPayrollData.length / PAYROLL_RECORDS_PAGE_SIZE));
  payrollRecordsPage = Math.min(Math.max(payrollRecordsPage + direction, 1), totalPages);
  renderPayroll();
}

function renderPayrollRecords(records) {
  const grid = document.getElementById('payroll-records-grid');
  if (!grid) return;

  if (!records.length) {
    grid.innerHTML = '<div style="padding:30px; color:var(--muted); text-align:center;">No payroll records yet.</div>';
    return;
  }

  grid.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Payroll ID</th>
          <th>Employee</th>
          <th>Period</th>
          <th>Wage Type</th>
          <th>Gross Pay</th>
          <th>Allowances</th>
          <th>Deductions</th>
          <th>Net Pay</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${records.map(r => {
          const normalizedStatus = String(r.status || 'Draft').trim();
          const normalizedStatusKey = normalizedStatus.toLowerCase();
          const recordJson = JSON.stringify(r).replace(/"/g, '&quot;');
          const approvalAction = normalizedStatusKey === 'submitted' && canApproveSalaryCalculations()
            ? `<button class="btn btn-primary btn-sm" onclick="approveSalaryCalculation(${Number(r.id)})">Approve & Finalize</button>`
            : '';
          const blockchainRecordAction = normalizedStatusKey === 'approved' && canApproveSalaryCalculations()
            ? `<button class="btn btn-primary btn-sm" onclick="recordApprovedPayrollOnBlockchain(${Number(r.id)})">Record on Blockchain</button>`
            : '';
          return `
          <tr>
            <td>CALC-${String(r.id).padStart(5, '0')}</td>
            <td>${r.employee_name}<br><span style="color:var(--muted); font-size:12px;">${r.employee_code}</span></td>
            <td>${(r.calculation_date || '').slice(0, 10)}</td>
            <td>${r.wage_type || '-'}</td>
            <td>PHP ${parseFloat(r.gross_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
            <td>PHP ${parseFloat(r.total_allowances || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
            <td>
              PHP ${parseFloat(r.total_deductions || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}
              <div style="color:${parseFloat(r.total_deductions || 0) > 0 ? 'var(--green)' : 'var(--muted)'}; font-size:11px; margin-top:3px;">
                ${parseFloat(r.total_deductions || 0) > 0 ? 'Deductions applied' : 'No deduction applied'}
              </div>
            </td>
            <td><strong style="color:var(--accent);">PHP ${parseFloat(r.net_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</strong></td>
            <td>${payrollBadge(normalizedStatus)}</td>
            <td>
              ${approvalAction}
              ${blockchainRecordAction}
              <button class="btn btn-outline btn-sm" onclick="showCalculationBreakdown(${recordJson})">View</button>
            </td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
  `;
}

function renderPayslipManagement(records) {
  const grid = document.getElementById('payroll-payslips-grid');
  if (!grid) return;
  const ready = records.filter(r => ['Approved', 'Released', 'Paid'].includes(r.status));

  if (!ready.length) {
    grid.innerHTML = '<div style="padding:30px; color:var(--muted); text-align:center;">Payslips become available after payroll is approved or released.</div>';
    return;
  }

  grid.innerHTML = `
    <table>
      <thead><tr><th>Employee</th><th>Period</th><th>Earnings</th><th>Deductions</th><th>Net Pay</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${ready.map(r => `
          <tr>
            <td>${r.employee_name}</td>
            <td>${(r.calculation_date || '').slice(0, 7)}</td>
            <td>PHP ${parseFloat(r.gross_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
            <td>PHP ${parseFloat(r.total_deductions || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
            <td><strong style="color:var(--accent);">PHP ${parseFloat(r.net_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</strong></td>
            <td>${payrollBadge(r.status)}</td>
            <td><button class="btn btn-outline btn-sm" onclick="exportPayrollReport('employee','pdf')">PDF</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function loadPayrollDashboard(monthYear = null) {
  if (!monthYear) {
    const today = new Date();
    monthYear = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  }
  currentMonthYear = monthYear;
  const status = document.getElementById('payroll-filter-status')?.value || '';
  const query = new URLSearchParams({ month_year: monthYear });
  if (status) query.set('status', status);

  try {
    const response = await apiFetch(`/api/payroll/dashboard?${query.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to load payroll dashboard');
    currentPayrollData = data.records || [];
    updatePayrollDashboard(data);
  } catch (err) {
    console.error('Error loading payroll dashboard:', err);
    currentPayrollData = [];
    updatePayrollDashboard({});
  }

  payrollRecordsPage = 1;
  renderPayroll();
}

// Load payroll records for current month
async function loadPayrollRecords(monthYear = null) {
  if (!monthYear) {
    const today = new Date();
    monthYear = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  }

  currentMonthYear = monthYear;

  try {
    const response = await apiFetch(`/api/payroll/payroll-records/${monthYear}`);
    if (!response.ok) {
      if (response.status === 404) {
        currentPayrollData = [];
      } else {
        throw new Error('Failed to load payroll records');
      }
    } else {
      const data = await response.json();
      currentPayrollData = data.payslips || [];
    }
  } catch (err) {
    console.error('Error loading payroll records:', err);
    currentPayrollData = [];
  }

  payrollRecordsPage = 1;
  renderPayroll();
}

// Update stats cards at the top
function updatePayrollDashboard(data = {}) {
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };
  const metrics = data.metrics || {};
  const estimates = data.estimates || {};
  const period = data.period || {};

  setText('payroll-total-employees', metrics.totalEmployees || 0);
  setText('payroll-ready-employees', metrics.payrollReadyEmployees || 0);
  setText('payroll-pending-attendance', metrics.pendingAttendanceValidation || 0);
  setText('payroll-missing-attendance', metrics.missingAttendanceRecords || 0);
  setText('payroll-draft-payrolls', metrics.draftPayrolls || 0);
  setText('payroll-submitted-payrolls', metrics.submittedPayrolls || 0);
  setValue('payroll-period-start', formatDateValue(period.start_date));
  setValue('payroll-period-end', formatDateValue(period.end_date));
  setValue('payroll-period-status', period.status || 'Not Generated');
  setText('payroll-estimated-gross', money(estimates.gross));
  setText('payroll-estimated-deductions', money(estimates.deductions));
  setText('payroll-estimated-net', money(estimates.net));
}

function updatePayrollStats(summary) {
  updatePayrollDashboard({
    estimates: {
      gross: summary.totalPayroll,
      deductions: summary.totalDeductions,
      net: Number(summary.totalPayroll || 0) - Number(summary.totalDeductions || 0)
    },
    metrics: {
      totalEmployees: summary.totalEmployees || 0,
      payrollReadyEmployees: summary.employeesPaid || 0,
      draftPayrolls: summary.pendingCount || 0,
      submittedPayrolls: 0
    },
    period: {
      month_year: summary.monthYear || currentMonthYear,
      status: 'Generated'
    }
  });
}

function formatDateValue(value) {
  if (!value) return '-';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text;
  return date.toISOString().slice(0, 10);
}

function dateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

function payrollWeekKeyFromDates(startDate, endDate) {
  const end = new Date(`${endDate}T00:00:00`);
  const week = Math.min(5, Math.max(1, Math.ceil(end.getDate() / 7)));
  return `${String(startDate || endDate).slice(0, 7)}-W${week}`;
}

function setDefaultWeeklyPayrollDates() {
  const startInput = document.getElementById('weekly-payroll-start');
  const endInput = document.getElementById('weekly-payroll-end');
  if (!startInput || !endInput || (startInput.value && endInput.value)) return;
  const now = new Date();
  const day = now.getDay() || 7;
  const start = new Date(now);
  start.setDate(now.getDate() - day + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  startInput.value = dateInputValue(start);
  endInput.value = dateInputValue(end);
}

async function loadWeeklyPayrollFilterOptions() {
  const departmentSelect = document.getElementById('weekly-payroll-department');
  const payTypeSelect = document.getElementById('weekly-payroll-pay-type');
  const employeeSelect = document.getElementById('weekly-payroll-employee');
  if (!departmentSelect && !payTypeSelect && !employeeSelect) return;
  try {
    const response = await apiFetch('/api/payroll/filter-options');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to load payroll filter options.');
    weeklyPayrollEmployees = Array.isArray(data.employees) ? data.employees : [];
    if (departmentSelect) {
      const current = departmentSelect.value;
      departmentSelect.innerHTML = '<option value="">All departments</option>' + (data.departments || [])
        .map(row => `<option value="${row.id}">${payrollEscape(row.name)}</option>`)
        .join('');
      if ([...departmentSelect.options].some(option => option.value === current)) departmentSelect.value = current;
    }
    if (payTypeSelect) {
      const normalized = new Map([
        ['Monthly', 'Monthly'],
        ['Daily', 'Daily'],
        ['Hourly', 'Hourly'],
        ['Per-Piece', 'Piece Rate'],
        ['Per-Trip', 'Logistics / Trip-Based']
      ]);
      (data.pay_types || []).forEach(row => {
        if (row.normalized && normalized.has(row.normalized)) return;
        const label = row.normalized || row.name;
        if (label) normalized.set(label, row.name);
      });
      const current = payTypeSelect.value;
      payTypeSelect.innerHTML = '<option value="">All pay types</option>' + [...normalized.entries()]
        .map(([value, label]) => `<option value="${payrollEscape(value)}">${payrollEscape(label)}</option>`)
        .join('');
      if ([...payTypeSelect.options].some(option => option.value === current)) payTypeSelect.value = current;
    }
    renderWeeklyPayrollEmployeeOptions();
  } catch (error) {
    console.warn('Weekly payroll filter options skipped:', error.message);
  }
}

function weeklyPayTypeMatches(employee, selectedPayType) {
  if (!selectedPayType) return true;
  const selected = selectedPayType === 'Piece Rate' ? 'Per-Piece' : selectedPayType === 'Logistics' ? 'Per-Trip' : selectedPayType;
  return employee.normalized_wage_type === selected
    || (selected === 'Per-Trip' && /logistics|trip/i.test(employee.wage_type || ''))
    || (selected === 'Per-Piece' && /piece/i.test(employee.wage_type || ''));
}

function renderWeeklyPayrollEmployeeOptions() {
  const select = document.getElementById('weekly-payroll-employee');
  if (!select) return;
  const current = select.value;
  const departmentId = document.getElementById('weekly-payroll-department')?.value || '';
  const payType = document.getElementById('weekly-payroll-pay-type')?.value || '';
  const rows = weeklyPayrollEmployees
    .filter(employee => !departmentId || String(employee.department_id || '') === String(departmentId))
    .filter(employee => weeklyPayTypeMatches(employee, payType))
    .sort((a, b) =>
      String(a.department || '').localeCompare(String(b.department || ''))
      || String(a.last_name || '').localeCompare(String(b.last_name || ''))
      || String(a.first_name || '').localeCompare(String(b.first_name || ''))
      || String(a.employee_code || '').localeCompare(String(b.employee_code || ''))
    );
  select.innerHTML = '<option value="">All employees in selected filters</option>' + rows.map(employee => {
    const label = `${employee.employee_code || 'No Code'} — ${employee.employee_name || `${employee.first_name || ''} ${employee.last_name || ''}`.trim()} (${employee.department || 'No Department'} / ${employee.wage_type || 'No Pay Type'})`;
    return `<option value="${Number(employee.id)}">${payrollEscape(label)}</option>`;
  }).join('');
  if (rows.some(employee => String(employee.id) === String(current))) {
    select.value = current;
  }
  select.title = `${rows.length} employee(s) match the selected department/pay type.`;
}

function renderWeeklyPayrollRegistry(payload = {}) {
  const target = document.getElementById('weekly-payroll-registry');
  if (!target) return;
  const rows = payload.rows || payload.registry || [];
  if (!rows.length) {
    const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
    target.innerHTML = skipped.length
      ? `
        <div class="table-wrap">
          <div class="payroll-card-header-row">
            <div>
              <h3>No Payroll Rows Generated</h3>
              <p>${Number(payload.employeesProcessed || 0)} employee(s) processed, ${Number(payload.skippedCount || skipped.length)} skipped. Review the reasons below.</p>
            </div>
          </div>
          <table class="payroll-erp-table weekly-payroll-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Pay Type</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              ${skipped.map(row => `
                <tr>
                  <td>${payrollEscape(row.employee_name || row.employee_code || `Employee #${row.employee_id || '-'}`)}<br><span class="muted-small">${payrollEscape(row.employee_code || '')}</span></td>
                  <td>${payrollEscape(row.pay_type || '-')}</td>
                  <td>${payrollEscape(row.reason || 'Skipped by payroll validation.')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `
      : '<div class="payroll-empty-state">No weekly payroll registry rows found for this selection.</div>';
    return;
  }
  const totals = payload.totals || {
    gross_pay: rows.reduce((sum, row) => sum + Number(row.gross_pay || 0), 0),
    allowances: rows.reduce((sum, row) => sum + Number(row.allowances || 0), 0),
    deductions: rows.reduce((sum, row) => sum + Number(row.deductions || 0), 0),
    net_pay: rows.reduce((sum, row) => sum + Number(row.net_pay || 0), 0)
  };
  target.innerHTML = `
    <div class="table-wrap">
      <table class="payroll-erp-table weekly-payroll-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Pay Type</th>
            <th>Payroll Period</th>
            <th>Days</th>
            <th>Hours</th>
            <th>Output Qty</th>
            <th>Trips</th>
            <th class="text-right">Gross Pay</th>
            <th class="text-right">Allowances</th>
            <th class="text-right">Deductions</th>
            <th class="text-right">Net Pay</th>
            <th>Status</th>
            <th>Processed By</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td>${payrollEscape(row.employee_name || '-')}<br><span class="muted-small">${payrollEscape(row.employee_code || '')}</span></td>
              <td>${payrollEscape(row.pay_type || '-')}</td>
              <td>${payrollEscape(row.payroll_period || '-')}</td>
              <td>${Number(row.approved_days_worked || 0).toLocaleString()}</td>
              <td>${Number(row.approved_hours_worked || 0).toLocaleString()}</td>
              <td>${Number(row.approved_output_quantity || 0).toLocaleString()}</td>
              <td>${Number(row.approved_logistics_trips || 0).toLocaleString()}</td>
              <td class="text-right">${money(row.gross_pay)}</td>
              <td class="text-right">${money(row.allowances)}</td>
              <td class="text-right">${money(row.deductions)}</td>
              <td class="text-right payroll-net">${money(row.net_pay)}</td>
              <td>${payrollBadge(row.payroll_status || 'Pending')}</td>
              <td>${payrollEscape(row.processed_by || '-')}<br><span class="muted-small">${row.date_processed ? new Date(row.date_processed).toLocaleString() : ''}</span></td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <th colspan="7">Totals</th>
            <th class="text-right">${money(totals.gross_pay)}</th>
            <th class="text-right">${money(totals.allowances)}</th>
            <th class="text-right">${money(totals.deductions)}</th>
            <th class="text-right">${money(totals.net_pay)}</th>
            <th colspan="2"></th>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

async function loadWeeklyPayrollRegistry() {
  const start = document.getElementById('weekly-payroll-start')?.value;
  const end = document.getElementById('weekly-payroll-end')?.value;
  const departmentId = document.getElementById('weekly-payroll-department')?.value;
  const payType = document.getElementById('weekly-payroll-pay-type')?.value;
  const employeeId = document.getElementById('weekly-payroll-employee')?.value;
  if (!start || !end) return;
  const params = new URLSearchParams({ month_year: payrollWeekKeyFromDates(start, end) });
  if (departmentId) {
    const departmentText = document.getElementById('weekly-payroll-department')?.selectedOptions?.[0]?.textContent || '';
    if (departmentText) params.set('department', departmentText);
  }
  if (payType) params.set('pay_type', payType);
  if (employeeId) params.set('employee_id', employeeId);
  try {
    const response = await apiFetch(`/api/payroll/registry?${params.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to load weekly payroll registry.');
    renderWeeklyPayrollRegistry(data);
  } catch (error) {
    const target = document.getElementById('weekly-payroll-registry');
    if (target) target.innerHTML = `<div class="payroll-empty-state text-danger">${payrollEscape(error.message)}</div>`;
  }
}

async function generateWeeklyPayroll(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('weekly-payroll-result');
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.employee_id) delete data.employee_id;
  data.weekly = true;
  data.month_year = payrollWeekKeyFromDates(data.start_date, data.end_date);
  if (status) status.textContent = 'Generating weekly payroll...';
  try {
    const response = await apiFetch('/api/payroll/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || 'Failed to generate weekly payroll.');
    if (status) status.textContent = result.message || 'Weekly payroll generated.';
    renderWeeklyPayrollRegistry(result);
    await loadPayrollDashboard(document.getElementById('payroll-filter-month')?.value || null);
    await loadSalaryCalculations();
  } catch (error) {
    if (status) status.textContent = error.message;
    if (typeof showAlert === 'function') await showAlert(error.message, 'Payroll Error', 'error');
  }
}

// Load and display salary calculation records
async function loadSalaryCalculations() {
  try {
    const filterDate = document.getElementById('salary-calc-filter-date')?.value;
    const filterStatus = document.getElementById('salary-calc-filter-status')?.value;

    let url = '/api/payroll/salary-calculations?limit=500';
    if (filterStatus) url += `&status=${filterStatus}`;
    if (filterDate) url += `&from_date=${filterDate}&to_date=${filterDate}`;

    const response = await apiFetch(url);
    if (!response.ok) {
      throw new Error('Failed to load salary calculations');
    }

    const data = await response.json();
    currentSalaryCalculationRecords = data.records || [];
    salaryCalculationPage = 1;
    populatePayrollReportFilters();
    renderSalaryCalculations(currentSalaryCalculationRecords);
  } catch (err) {
    console.error('Error loading salary calculations:', err);
    const grid = document.getElementById('salary-calculations-grid');
    if (grid) {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; padding: 40px 20px; text-align: center;">
          <div style="font-size: 14px; color: var(--red);">
            ❌ Error loading salary calculations: ${err.message}
          </div>
        </div>
      `;
    }
  }
}

// Render salary calculation records in a table
function renderSalaryCalculations(records) {
  const grid = document.getElementById('salary-calculations-grid');
  if (!grid) return;

  const totalPages = Math.max(1, Math.ceil(records.length / SALARY_CALCULATION_PAGE_SIZE));
  salaryCalculationPage = Math.min(Math.max(salaryCalculationPage, 1), totalPages);
  const startIndex = (salaryCalculationPage - 1) * SALARY_CALCULATION_PAGE_SIZE;
  const pageRecords = records.slice(startIndex, startIndex + SALARY_CALCULATION_PAGE_SIZE);

  if (records.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px 20px; text-align: center;">
        <div style="font-size: 14px; color: var(--muted);">
          No salary calculation records found.
        </div>
      </div>
    `;
    return;
  }

  const table = `
    <table class="payroll-erp-table">
      <thead>
        <tr>
          <th>Payroll ID</th>
          <th>Employee</th>
          <th>Period</th>
          <th>Department</th>
          <th>Wage Type</th>
          <th>Output</th>
          <th class="text-right">Gross Pay</th>
          <th class="text-right">Deductions</th>
          <th class="text-right">Net Pay</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${pageRecords.map(r => {
          const calcDate = r.payroll_period || new Date(r.calculation_date).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric' 
          });
          
          // Build calculation details string
          let calcDetails = '';
          if (r.wage_type === 'Hourly' && r.hours_worked > 0) {
            calcDetails = `${r.hours_worked} hrs`;
          } else if (r.wage_type === 'Daily' && r.days_worked > 0) {
            calcDetails = `${r.days_worked} days`;
          } else if (r.wage_type === 'Per-Piece' && r.quantity > 0) {
            calcDetails = `${r.quantity} pieces`;
          } else if (r.wage_type === 'Per-Trip' && r.quantity > 0) {
            calcDetails = `${r.quantity} trips`;
          } else {
            calcDetails = 'Fixed amount';
          }
          
          // Add allowances if any
          const totalAllowances = (parseFloat(r.housing_allowance || 0) + 
                                   parseFloat(r.meal_allowance || 0) + 
                                   parseFloat(r.transport_allowance || 0) + 
                                   parseFloat(r.bonus_allowance || 0));
          if (totalAllowances > 0) {
            calcDetails += ` + ₱${totalAllowances.toLocaleString('en-US', {minimumFractionDigits: 2})}`;
          }
          
          const recordJson = JSON.stringify(r).replace(/"/g, '&quot;');
          const normalizedStatus = String(r.status || 'Draft').trim();
          const normalizedStatusKey = normalizedStatus.toLowerCase();
          const draftAction = normalizedStatusKey === 'draft'
            ? `<button class="btn btn-primary btn-sm" onclick="continueSalaryDraft(${recordJson})">Continue</button>`
            : '';
          const approvalAction = normalizedStatusKey === 'submitted' && canApproveSalaryCalculations()
            ? `<button class="btn btn-primary btn-sm" onclick="approveSalaryCalculation(${Number(r.id)})">Approve & Finalize</button>`
            : '';
          const blockchainRecordAction = normalizedStatusKey === 'approved' && canApproveSalaryCalculations()
            ? `<button class="btn btn-primary btn-sm" onclick="recordApprovedPayrollOnBlockchain(${Number(r.id)})">Record on Blockchain</button>`
            : '';
          return `
            <tr>
              <td>CALC-${String(r.id).padStart(5, '0')}</td>
              <td>${r.employee_name}<br><span class="muted-small">${r.employee_code}</span></td>
              <td>${calcDate}</td>
              <td>${r.department || '-'}</td>
              <td>${r.wage_type || '-'}</td>
              <td>${calcDetails}</td>
              <td class="text-right">${money(r.gross_pay)}</td>
              <td class="text-right">${money(r.total_deductions)}</td>
              <td class="text-right payroll-net">${money(r.net_pay)}</td>
              <td>${payrollBadge(normalizedStatus)}</td>
              <td>
                ${draftAction}
                ${approvalAction}
                ${blockchainRecordAction}
                <button class="btn btn-outline btn-sm" onclick="showCalculationBreakdown(${recordJson})">View</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${renderSalaryCalculationPagination(records.length, startIndex, totalPages)}
  `;

  grid.innerHTML = table;
  bindSalaryCalculationPagination(grid);
  if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(grid);
}

function renderSalaryCalculationPagination(totalRecords, startIndex, totalPages) {
  if (totalRecords <= SALARY_CALCULATION_PAGE_SIZE) return '';
  const endIndex = Math.min(startIndex + SALARY_CALCULATION_PAGE_SIZE, totalRecords);
  return `
    <div class="table-pagination">
      <span>Showing ${startIndex + 1}-${endIndex} of ${totalRecords}</span>
      <div class="table-pagination-actions">
        <button class="btn btn-outline btn-sm" type="button" data-salary-page-action="prev" ${salaryCalculationPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${salaryCalculationPage} of ${totalPages}</span>
        <button class="btn btn-outline btn-sm" type="button" data-salary-page-action="next" ${salaryCalculationPage >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  `;
}

function bindSalaryCalculationPagination(root) {
  root.querySelector('[data-salary-page-action="prev"]')?.addEventListener('click', () => changeSalaryCalculationPage(-1));
  root.querySelector('[data-salary-page-action="next"]')?.addEventListener('click', () => changeSalaryCalculationPage(1));
}

function changeSalaryCalculationPage(direction) {
  const totalPages = Math.max(1, Math.ceil(currentSalaryCalculationRecords.length / SALARY_CALCULATION_PAGE_SIZE));
  salaryCalculationPage = Math.min(Math.max(salaryCalculationPage + direction, 1), totalPages);
  renderSalaryCalculations(currentSalaryCalculationRecords);
}

async function continueSalaryDraft(record) {
  if (!record || (record.status || 'Draft') !== 'Draft') return;
  switchPayrollTab('salary');
  if (typeof loadSalaryCalculationPage === 'function') await loadSalaryCalculationPage();
  if (typeof restoreSalaryDraftFromRecord === 'function') {
    await restoreSalaryDraftFromRecord(record);
  }
}

function canApproveSalaryCalculations() {
  if (typeof getUser !== 'function') return false;
  const user = getUser();
  return user?.role === 'payroll_manager'
    || (Array.isArray(user?.permissions) && user.permissions.includes('payroll.approve'));
}

async function approveSalaryCalculation(calculationId) {
  if (!Number.isInteger(Number(calculationId))) return;
  if (!window.confirm('Approve and finalize this payroll calculation?')) return;

  try {
    const response = await apiFetch(`/api/payroll/salary-calculations/${calculationId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Approved' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Payroll approval failed.');

    document.getElementById('calc-breakdown-modal')?.remove();
    alert(data.blockchain_snapshot
      ? 'Payroll approved. It is now ready for blockchain anchoring.'
      : 'Payroll approved.');
    await loadSalaryCalculations();
  } catch (error) {
    alert(error.message);
  }
}

async function recordApprovedPayrollOnBlockchain(calculationId) {
  if (!Number.isInteger(Number(calculationId))) return;
  if (!window.confirm('Record the finalized payroll hash on Hyperledger Fabric?')) return;

  try {
    const response = await apiFetch(`/api/blockchain/payroll/finalize/${calculationId}`, {
      method: 'POST',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) {
      throw new Error(data.error || 'Blockchain recording failed.');
    }

    document.getElementById('calc-breakdown-modal')?.remove();
    alert(response.status === 202
      ? (data.message || 'Payroll was queued for blockchain anchoring.')
      : 'Payroll hash was recorded on Hyperledger Fabric. System Administrator verification is now available.');
    await loadSalaryCalculations();
    if (typeof loadBlockchainRecords === 'function') await loadBlockchainRecords();
  } catch (error) {
    alert(error.message);
  }
}

async function generatePayslipsFromRecords() {
  const monthYear = document.getElementById('payroll-filter-month')?.value
    || currentMonthYear
    || new Date().toISOString().slice(0, 7);
  if (!monthYear) return alert('Select a payroll period first.');
  try {
    const response = await apiFetch('/api/payroll/convert-calculations-to-payslips', {
      method: 'POST',
      body: JSON.stringify({ month_year: monthYear })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.details || 'Failed to generate payslips.');
    alert(data.message || `Payslips generated for ${monthYear}.`);
    loadSalaryCalculations();
    loadPayrollRecords(monthYear);
  } catch (err) {
    alert(err.message);
  }
}

// Show calculation breakdown in modal
function showCalculationBreakdown(record) {
  const totalDeductions = parseFloat(record.total_deductions || 0);
  let snapshot = {};
  try {
    snapshot = record.validation_snapshot
      ? (typeof record.validation_snapshot === 'string' ? JSON.parse(record.validation_snapshot) : record.validation_snapshot)
      : {};
  } catch (_) {
    snapshot = {};
  }
  const logisticsBreakdown = Array.isArray(snapshot.logistics_breakdown) ? snapshot.logistics_breakdown : [];
  const logisticsBreakdownHtml = logisticsBreakdown.length ? `
    <div style="background: var(--card); border-radius: 10px; padding: 16px; margin-bottom: 20px; border: 1px solid var(--border);">
      <h3 style="margin: 0 0 12px 0; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase;">Logistics Trip Breakdown</h3>
      <div class="table-wrap">
        <table class="data-table" data-no-pagination="1">
          <thead>
            <tr>
              <th>Trip Date</th>
              <th>Role</th>
              <th>Truck</th>
              <th>Location</th>
              <th>Trip #</th>
              <th class="text-right">Base Rate</th>
              <th class="text-right">Multiplier</th>
              <th>Rule Applied</th>
              <th class="text-right">Trip Pay</th>
              <th class="text-right">Daily Total</th>
              <th class="text-right">Period Total</th>
            </tr>
          </thead>
          <tbody>
            ${logisticsBreakdown.map(row => `
              <tr>
                <td>${payrollEscape(row.trip_date || '-')}</td>
                <td>${payrollEscape(row.employee_role || '-')}</td>
                <td>${payrollEscape(row.truck_type || '-')}</td>
                <td>${payrollEscape(row.location || '-')}</td>
                <td>${payrollEscape(row.trip_number || '-')}</td>
                <td class="text-right">${money(row.base_rate)}</td>
                <td class="text-right">${Number(row.multiplier || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x</td>
                <td>${payrollEscape(row.rule_applied || '-')}</td>
                <td class="text-right">${money(row.computed_trip_pay)}</td>
                <td class="text-right">${money(row.daily_total)}</td>
                <td class="text-right">${money(row.payroll_period_total)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  ` : '';
  const deductionRows = [
    { label: 'SSS', amount: parseFloat(record.sss_deduction || 0) },
    { label: 'Pag-IBIG', amount: parseFloat(record.pagibig_deduction || 0) },
    { label: 'PhilHealth', amount: parseFloat(record.philhealth_deduction || 0) }
  ].filter(item => item.amount > 0);
  const savedDeductionHtml = deductionRows.length
    ? deductionRows.map(item => `
      <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);">
        <span style="color: var(--muted);">${item.label}</span>
        <span style="color: var(--red);">- ₱${item.amount.toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
      </div>
    `).join('')
    : totalDeductions > 0
      ? `<div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);">
          <span style="color: var(--muted);">Configured deductions</span>
          <span style="color: var(--red);">- ₱${totalDeductions.toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
        </div>`
      : '<div style="color: var(--muted); padding: 8px 0;">No deductions were applied to this calculation.</div>';

  const modalHTML = `
    <div id="calc-breakdown-modal" style="
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6); display: flex; align-items: center;
      justify-content: center; z-index: 10000;
    ">
      <div style="
        background: var(--bg); border-radius: 14px; max-width: 1100px;
        width: 90%; max-height: 80vh; overflow-y: auto; 
        padding: 24px; border: 1px solid var(--border); box-shadow: 0 10px 40px rgba(0,0,0,0.3);
      ">
        <!-- Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid var(--border);">
          <h2 style="margin: 0; font-size: 18px; font-weight: 700; color: var(--text);">Salary Calculation Breakdown</h2>
          <button onclick="document.getElementById('calc-breakdown-modal')?.remove()" style="
            background: none; border: none; font-size: 24px; color: var(--muted); cursor: pointer; padding: 0; width: 32px; height: 32px;
            display: flex; align-items: center; justify-content: center;
          ">✕</button>
        </div>

        <!-- Employee Info -->
        <div style="background: var(--card); border-radius: 10px; padding: 16px; margin-bottom: 20px; border: 1px solid var(--border);">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
            <div>
              <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Employee Name</div>
              <div style="font-size: 14px; font-weight: 600; color: var(--text);">${record.employee_name}</div>
            </div>
            <div>
              <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Employee Code</div>
              <div style="font-size: 14px; font-weight: 600; color: var(--muted); font-family: 'Courier New', monospace;">${record.employee_code}</div>
            </div>
            <div>
              <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Department</div>
              <div style="font-size: 14px; color: var(--text);">${record.department || 'N/A'}</div>
            </div>
            <div>
              <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Date</div>
              <div style="font-size: 14px; color: var(--text);">${new Date(record.calculation_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
            </div>
          </div>
        </div>

        <!-- Wage Type & Rate Info -->
        <div style="background: rgba(79, 124, 255, 0.1); border-radius: 10px; padding: 16px; margin-bottom: 20px; border-left: 4px solid var(--blue);">
          <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Wage Type & Rate</div>
          <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 8px;">${record.wage_type}</div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
            <div>
              <span style="color: var(--muted);">Base Rate:</span>
              <span style="color: var(--text); font-weight: 600;">₱${parseFloat(record.base_rate || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
            </div>
            ${record.wage_type === 'Hourly' ? `
              <div>
                <span style="color: var(--muted);">Hours Worked:</span>
                <span style="color: var(--text); font-weight: 600;">${parseFloat(record.hours_worked || 0).toLocaleString('en-US', {minimumFractionDigits: 1})} hrs</span>
              </div>
            ` : record.wage_type === 'Daily' ? `
              <div>
                <span style="color: var(--muted);">Days Worked:</span>
                <span style="color: var(--text); font-weight: 600;">${parseFloat(record.days_worked || 0).toLocaleString('en-US', {minimumFractionDigits: 1})} days</span>
              </div>
            ` : `
              <div>
                <span style="color: var(--muted);">Quantity:</span>
                <span style="color: var(--text); font-weight: 600;">${parseFloat(record.quantity || 0).toLocaleString('en-US', {minimumFractionDigits: 0})}</span>
              </div>
            `}
          </div>
        </div>

        ${logisticsBreakdownHtml}

        <!-- Calculation Details -->
        <div style="background: var(--card); border-radius: 10px; padding: 16px; margin-bottom: 20px; border: 1px solid var(--border);">
          <h3 style="margin: 0 0 12px 0; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase;">Calculation Breakdown</h3>
          
          <div style="display: grid; gap: 8px; font-size: 13px;">
            <!-- Base Pay -->
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);">
              <span style="color: var(--muted);">Base Pay</span>
              <span style="color: var(--text); font-weight: 600;">₱${(parseFloat(record.base_rate || 0) * (record.hours_worked || record.days_worked || record.quantity || 1)).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
            </div>

            <!-- Allowances -->
            ${parseFloat(record.housing_allowance || 0) > 0 ? `
              <div style="display: flex; justify-content: space-between; padding: 8px 0; color: var(--muted); font-size: 12px;">
                <span>+ Housing Allowance</span>
                <span>₱${parseFloat(record.housing_allowance).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
              </div>
            ` : ''}
            ${parseFloat(record.meal_allowance || 0) > 0 ? `
              <div style="display: flex; justify-content: space-between; padding: 8px 0; color: var(--muted); font-size: 12px;">
                <span>+ Meal Allowance</span>
                <span>₱${parseFloat(record.meal_allowance).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
              </div>
            ` : ''}
            ${parseFloat(record.transport_allowance || 0) > 0 ? `
              <div style="display: flex; justify-content: space-between; padding: 8px 0; color: var(--muted); font-size: 12px;">
                <span>+ Transport Allowance</span>
                <span>₱${parseFloat(record.transport_allowance).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
              </div>
            ` : ''}
            ${parseFloat(record.bonus_allowance || 0) > 0 ? `
              <div style="display: flex; justify-content: space-between; padding: 8px 0; color: var(--muted); font-size: 12px;">
                <span>+ Bonus Allowance</span>
                <span>₱${parseFloat(record.bonus_allowance).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
              </div>
            ` : ''}

            <!-- Gross Pay -->
            <div style="display: flex; justify-content: space-between; padding: 12px 0; background: rgba(34, 211, 165, 0.1); padding: 12px; border-radius: 6px; margin: 8px 0; border-left: 3px solid var(--green);">
              <span style="font-weight: 600; color: var(--text);">Gross Pay</span>
              <span style="font-weight: 700; color: var(--green); font-size: 14px;">₱${parseFloat(record.gross_pay).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
            </div>
          </div>
        </div>

        <!-- Deductions -->
        <div style="background: var(--card); border-radius: 10px; padding: 16px; margin-bottom: 20px; border: 1px solid var(--border);">
          <h3 style="margin: 0 0 12px 0; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase;">Deductions</h3>
          
          <div style="display: grid; gap: 8px; font-size: 13px;">
            ${savedDeductionHtml}

            <!-- Total Deductions -->
            <div style="display: flex; justify-content: space-between; padding: 12px 0; background: rgba(239, 68, 68, 0.1); padding: 12px; border-radius: 6px; margin: 8px 0; border-left: 3px solid var(--red);">
              <span style="font-weight: 600; color: var(--text);">Total Deductions</span>
              <span style="font-weight: 700; color: var(--red); font-size: 14px;">₱${totalDeductions.toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
            </div>
          </div>
        </div>

        <!-- Net Pay Summary -->
        <div style="background: linear-gradient(135deg, rgba(79, 124, 255, 0.15), rgba(34, 211, 165, 0.15)); border-radius: 10px; padding: 20px; border: 2px solid var(--border); margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Net Pay</div>
              <div style="font-size: 12px; color: var(--muted); margin-bottom: 4px;">(Gross Pay - Total Deductions)</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 28px; font-weight: 700; color: var(--accent);">₱${parseFloat(record.net_pay).toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
            </div>
          </div>
        </div>

        <!-- Status -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-top: 1px solid var(--border);">
          <span style="font-size: 12px; color: var(--muted);">Status:</span>
          <span style="background: ${record.status === 'Approved' ? 'rgba(34, 211, 165, 0.2)' : record.status === 'Submitted' ? 'rgba(245, 166, 35, 0.2)' : 'rgba(128, 128, 128, 0.2)'}; 
                   color: ${record.status === 'Approved' ? 'var(--green)' : record.status === 'Submitted' ? 'var(--yellow)' : 'var(--muted)'}; 
                   padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;">
            ${record.status || 'Draft'}
          </span>
        </div>

        <!-- Close Button -->
        <button onclick="document.getElementById('calc-breakdown-modal')?.remove()" style="
          width: 100%; margin-top: 20px; padding: 12px; 
          background: var(--border); border: none; border-radius: 8px;
          color: var(--text); font-weight: 600; cursor: pointer; font-size: 14px;
          transition: background-color 0.2s;
        " onmouseover="this.style.background='var(--card)'" onmouseout="this.style.background='var(--border)'">
          Close
        </button>
      </div>
    </div>
  `;

  const modalDiv = document.createElement('div');
  modalDiv.innerHTML = modalHTML;
  document.body.appendChild(modalDiv.firstElementChild);

  // Close on background click
  document.getElementById('calc-breakdown-modal').addEventListener('click', (e) => {
    if (e.target.id === 'calc-breakdown-modal') {
      document.getElementById('calc-breakdown-modal')?.remove();
    }
  });
}

function payrollBadge(status) {
  const normalized = status || 'Draft';
  const color = normalized === 'Paid' || normalized === 'Released' || normalized === 'Approved'
    ? 'green'
    : normalized === 'Rejected'
      ? 'red'
      : normalized === 'Submitted'
        ? 'yellow'
        : 'blue';
  return `<span class="badge badge-${color}">${normalized}</span>`;
}

function payslipMoney(value) {
  const amount = Number(value || 0);
  const text = `PHP ${Math.abs(amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return amount < 0 ? `(${text})` : text;
}

function payslipLine(label, value, className = '') {
  return `
    <tr class="${className}">
      <td>${label}</td>
      <td class="text-right">${value}</td>
    </tr>
  `;
}

async function generatePayslipPreview(calculationId) {
  try {
    const response = await apiFetch(`/api/payroll/salary-calculations/${calculationId}/payslip`);
    const payslip = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payslip.error || 'Failed to generate payslip.');
    showPayslipPreview(payslip);
  } catch (err) {
    alert(err.message);
  }
}

async function exportPayslipPdf(calculationId, printMode = false) {
  try {
    const response = await apiFetch(`/api/payroll/salary-calculations/${calculationId}/payslip.pdf${printMode ? '?print=1' : ''}`);
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to export payslip PDF.');
    }
    if (!contentType.includes('application/pdf')) {
      const text = await response.text().catch(() => '');
      throw new Error(text || 'The server did not return a valid PDF file.');
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error('The generated PDF file is empty.');
    const url = URL.createObjectURL(blob);
    if (printMode) {
      const win = window.open(url, '_blank');
      if (win) win.addEventListener('load', () => win.print(), { once: true });
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = `payslip-${calculationId}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  } catch (err) {
    alert(err.message);
  }
}

function showPayslipPreview(payslip) {
  const modalId = 'payslip-preview-modal';
  document.getElementById(modalId)?.remove();
  const earningsRows = [
    ['Days Worked', payslip.earnings.days_worked || 0],
    ['Employee Minute Rate', payslipMoney(payslip.earnings.employee_minute_rate)],
    ['Late Minutes', payslip.earnings.late_minutes || 0],
    ['Undertime Minutes', payslip.earnings.undertime_minutes || 0],
    ...(payslip.wage_type === 'Per-Piece' ? [
      ['Quantity', payslip.earnings.quantity || 0],
      ['Piece Rate', payslipMoney(payslip.earnings.piece_rate)],
      ['Production Amount', payslipMoney(payslip.earnings.production_amount)],
      ...(payslip.earnings.share_percentage ? [['Share', `${payslip.earnings.share_percentage}%`]] : [])
    ] : []),
    ...(payslip.wage_type === 'Per-Trip' ? [
      ['Trip Count', payslip.earnings.trip_count || 0],
      ['Driver/Helper Rate', payslipMoney(payslip.earnings.trip_rate)]
    ] : []),
    ...(payslip.wage_type === 'Monthly' ? [
      ['Monthly Salary', payslipMoney(payslip.earnings.monthly_salary)],
      ['Conversion', payslip.earnings.monthly_conversion_method === 'daily_equivalent' ? 'Daily Equivalent' : 'Monthly / 4']
    ] : []),
    ['Basic Pay', payslipMoney(payslip.earnings.basic_pay)],
    ['ROT/SOT', payslipMoney(payslip.earnings.rot_sot)],
    ['ND', payslipMoney(payslip.earnings.nd)],
    ['ADD', payslipMoney(payslip.earnings.add)],
    ['Tardy/UT', payslipMoney(payslip.earnings.tardy_ut)],
    ['Allowances', payslipMoney(payslip.earnings.allowances)],
    ['Gross Pay', payslipMoney(payslip.earnings.gross_pay)]
  ];

  const modal = document.createElement('div');
  modal.id = modalId;
  modal.className = 'erp-modal-backdrop';
  modal.innerHTML = `
    <div class="erp-modal payslip-preview-modal" role="dialog" aria-modal="true">
      <div class="erp-modal-head">
        <div>
          <h2>Payslip</h2>
          <p>${payslip.reference_no} · ${payslip.payroll_period}</p>
        </div>
        <button class="erp-modal-close" type="button" onclick="document.getElementById('${modalId}')?.remove()">×</button>
      </div>
      <div class="payslip-paper">
        <div class="payslip-title">
          <h3>${payslip.company_name}</h3>
          <span>Payroll Period: ${payslip.payroll_period}</span>
        </div>
        <div class="payroll-breakdown-grid">
          <label>Employee<input value="${payslip.employee.name || '-'}" readonly /></label>
          <label>Employee Code<input value="${payslip.employee.code || '-'}" readonly /></label>
          <label>Department<input value="${payslip.employee.department || '-'}" readonly /></label>
          <label>Position<input value="${payslip.employee.position || '-'}" readonly /></label>
        </div>
        <div class="payslip-two-column">
          <div>
            <h3>Earnings</h3>
            <table class="payroll-breakdown-table">
              <tbody>${earningsRows.map(([label, value]) => payslipLine(label, value, label === 'Gross Pay' ? 'is-positive' : '')).join('')}</tbody>
            </table>
          </div>
          <div>
            <h3>Deductions</h3>
            <table class="payroll-breakdown-table">
              <tbody>
                ${payslip.deductions.map(item => payslipLine(item.label, payslipMoney(item.amount), item.amount ? 'is-deduction' : '')).join('')}
                ${payslipLine('Total Deductions', payslipMoney(payslip.summary.total_deductions), 'is-deduction')}
              </tbody>
            </table>
          </div>
        </div>
        <table class="payroll-breakdown-table payslip-summary-table">
          <tbody>
            ${payslipLine('Gross Pay', payslipMoney(payslip.summary.gross_pay))}
            ${payslipLine('Total Deductions', payslipMoney(payslip.summary.total_deductions), 'is-deduction')}
            ${payslipLine('Net Due / Net Pay', payslipMoney(payslip.summary.net_due), 'is-net')}
          </tbody>
        </table>
        <div class="payslip-foot">Generated: ${new Date(payslip.generated_at).toLocaleString()} · Prepared by: ${payslip.prepared_by || '-'}</div>
      </div>
      <div class="payroll-breakdown-actions">
        <button class="btn btn-outline" type="button" onclick="document.getElementById('${modalId}')?.remove()">Close</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target.id === modalId) modal.remove();
  });
  document.body.appendChild(modal);
}

function showCalculationBreakdown(record) {
  const number = value => parseFloat(value || 0);
  const fmt = value => money(number(value));
  const modalId = 'calc-breakdown-modal';
  document.getElementById(modalId)?.remove();

  const calculationDate = record.calculation_date
    ? new Date(record.calculation_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '-';
  const calcNo = `CALC-${String(record.id || '').padStart(5, '0')}`;
  const totalAllowances = number(record.total_allowances)
    || number(record.housing_allowance) + number(record.meal_allowance) + number(record.transport_allowance) + number(record.bonus_allowance);
  const totalDeductions = number(record.total_deductions);
  const basePay = Math.max(0, number(record.gross_pay) - totalAllowances);
  const isPieceRate = /piece/i.test(String(record.wage_type || ''));
  const baseRateField = isPieceRate
    ? ''
    : `<label>Base Rate<input value="${fmt(record.base_rate)}" readonly /></label>`;
  const basePayLabel = isPieceRate ? 'Piece Earnings' : 'Base Pay';
  const workOutput = record.wage_type === 'Hourly'
    ? `${number(record.hours_worked).toLocaleString('en-US')} hours`
    : record.wage_type === 'Daily'
      ? `${number(record.days_worked).toLocaleString('en-US')} days`
      : record.wage_type === 'Per-Trip'
        ? `${number(record.quantity).toLocaleString('en-US')} trips`
        : record.wage_type === 'Per-Piece'
          ? `${number(record.quantity).toLocaleString('en-US')} pieces`
          : '-';

  const deductionRows = [
    ['SSS', number(record.sss_deduction)],
    ['Pag-IBIG', number(record.pagibig_deduction)],
    ['PhilHealth', number(record.philhealth_deduction)]
  ].filter(([, amount]) => amount > 0);
  if (!deductionRows.length && totalDeductions > 0) {
    deductionRows.push(['Configured Deductions', totalDeductions]);
  }

  const row = (label, value, className = '') => `
    <tr class="${className}">
      <td>${label}</td>
      <td class="text-right">${value}</td>
    </tr>
  `;
  const normalizedStatus = String(record.status || '').trim();
  const normalizedStatusKey = normalizedStatus.toLowerCase();
  const approvalAction = normalizedStatusKey === 'submitted' && canApproveSalaryCalculations()
    ? `<button class="btn btn-primary" type="button" onclick="approveSalaryCalculation(${Number(record.id)})">Approve & Finalize</button>`
    : '';
  const blockchainRecordAction = normalizedStatusKey === 'approved' && canApproveSalaryCalculations()
    ? `<button class="btn btn-primary" type="button" onclick="recordApprovedPayrollOnBlockchain(${Number(record.id)})">Record on Blockchain</button>`
    : '';

  const modal = document.createElement('div');
  modal.id = modalId;
  modal.className = 'erp-modal-backdrop';
  modal.innerHTML = `
    <div class="erp-modal payroll-breakdown-modal" role="dialog" aria-modal="true" aria-labelledby="calc-breakdown-title">
      <div class="erp-modal-head">
        <div>
          <h2 id="calc-breakdown-title">Salary Calculation</h2>
          <p>${calcNo} · ${calculationDate}</p>
        </div>
        <button class="erp-modal-close" type="button" aria-label="Close" onclick="document.getElementById('${modalId}')?.remove()">×</button>
      </div>

      <div class="payroll-breakdown-grid">
        <label>Employee<input value="${record.employee_name || '-'}" readonly /></label>
        <label>Employee ID<input value="${record.employee_code || '-'}" readonly /></label>
        <label>Department<input value="${record.department || '-'}" readonly /></label>
        <label>Status<input value="${record.status || 'Draft'}" readonly /></label>
        <label>Wage Type<input value="${record.wage_type || '-'}" readonly /></label>
        ${baseRateField}
        <label>Work Output<input value="${workOutput}" readonly /></label>
        <label>Payroll Date<input value="${calculationDate}" readonly /></label>
      </div>

      <div class="payroll-breakdown-section">
        <h3>Calculation Summary</h3>
        <table class="payroll-breakdown-table">
          <tbody>
            ${row(basePayLabel, fmt(basePay))}
            ${row('Allowances', fmt(totalAllowances))}
            ${row('Gross Pay', fmt(record.gross_pay), 'is-positive')}
            ${deductionRows.map(([label, amount]) => row(label, `- ${fmt(amount)}`, 'is-deduction')).join('')}
            ${row('Total Deductions', `- ${fmt(totalDeductions)}`, 'is-deduction')}
            ${row('Net Pay', fmt(record.net_pay), 'is-net')}
          </tbody>
        </table>
      </div>

      <div class="payroll-breakdown-actions">
        <button class="btn btn-outline" type="button" onclick="document.getElementById('${modalId}')?.remove()">Close</button>
        <button class="btn btn-outline" type="button" onclick="exportPayslipPdf(${Number(record.id)}, true)">Print Payslip</button>
        <button class="btn btn-outline" type="button" onclick="exportPayslipPdf(${Number(record.id)}, false)">Export Payslip PDF</button>
        ${approvalAction}
        ${blockchainRecordAction}
        <button class="btn btn-primary" type="button" onclick="generatePayslipPreview(${Number(record.id)})">Generate Payslip</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target.id === modalId) modal.remove();
  });
  document.body.appendChild(modal);
}

function switchPayrollTab(tab) {
  const targetTab = tab === 'payslips' ? 'records' : tab;
  document.querySelectorAll('.payroll-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.payrollTab === tab);
  });
  document.querySelectorAll('.payroll-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `payroll-tab-${targetTab}`);
  });

  if (targetTab === 'dashboard') loadPayrollDashboard();
  if (targetTab === 'salary' && typeof loadSalaryCalculationPage === 'function') loadSalaryCalculationPage();
  if (targetTab === 'piece-config') loadPieceRateConfig();
  if (targetTab === 'logistics' && typeof loadLogisticsPayrollModule === 'function') loadLogisticsPayrollModule();
  if (targetTab === 'deductions') loadPayrollSettings('deduction');
  if (targetTab === 'cash-advances') loadEmployeeDeductionAccounts('cash_advance');
  if (targetTab === 'employee-loans') loadEmployeeDeductionAccounts('loan');
  if (targetTab === 'allowances') loadPayrollSettings('allowance');
  if (targetTab === 'policies') loadPayrollPolicySettings();
  if (targetTab === 'reports') {
    loadPayrollAudit();
    renderPayrollReportLibrary();
    if (typeof prepareSwrFxrRegistry === 'function') prepareSwrFxrRegistry();
  }
  if (targetTab === 'records') loadSalaryCalculations();
}

async function loadPieceRateConfig() {
  const grid = document.getElementById('piece-rate-config-grid');
  try {
    const res = await apiFetch('/api/payroll/piece-rate-config');
    if (!res.ok) throw new Error('Failed to load piece-rate configuration');
    pieceRateConfig = await res.json();
    window.pieceRateConfig = pieceRateConfig;
    populatePieceRateDropdowns();
    if (typeof refreshSalaryPieceRowOptions === 'function') refreshSalaryPieceRowOptions();
    const pairingSelect = document.querySelector('#production-share-rule-form [name="pairing_type"]');
    if (pairingSelect && !pairingSelect.dataset.bound) {
      pairingSelect.addEventListener('change', applyPairingTypeDefaults);
      pairingSelect.dataset.bound = '1';
    }
    bindProductionPairPreview();
    enhancePieceRateMinimizers();
    if (grid) grid.innerHTML = renderPieceRateConfig(pieceRateConfig);
  } catch (err) {
    if (grid) grid.innerHTML = `<div style="padding:30px;color:var(--red);text-align:center;">${err.message}</div>`;
  }
}

function enhancePieceRateMinimizers() {
  const sections = document.querySelectorAll('#payroll-tab-piece-config .payroll-form-page fieldset');
  sections.forEach((section, index) => {
    const legend = section.querySelector('legend');
    if (!legend || legend.dataset.minimizeReady) return;
    const key = section.dataset.minimizeKey || legend.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    section.dataset.minimizeKey = key;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'payroll-mini-toggle';
    button.addEventListener('click', () => {
      const next = !section.classList.contains('is-minimized');
      setPieceRateSectionMinimized(section, next, true);
    });
    legend.appendChild(button);
    legend.dataset.minimizeReady = '1';
    const saved = localStorage.getItem(`pieceRateSection:${key}`);
    const shouldMinimize = saved === '1' || (saved == null && index > 0);
    setPieceRateSectionMinimized(section, shouldMinimize, false);
  });
}

function setPieceRateSectionMinimized(section, minimized, persist = true) {
  section.classList.toggle('is-minimized', minimized);
  const button = section.querySelector('.payroll-mini-toggle');
  if (button) button.textContent = minimized ? 'Expand' : 'Minimize';
  if (persist && section.dataset.minimizeKey) {
    localStorage.setItem(`pieceRateSection:${section.dataset.minimizeKey}`, minimized ? '1' : '0');
  }
}

function setPieceRateSectionsMinimized(minimized) {
  const sections = document.querySelectorAll('#payroll-tab-piece-config .payroll-form-page fieldset');
  sections.forEach(section => setPieceRateSectionMinimized(section, minimized, true));
}

function activeRows(rows) {
  return (rows || []).filter(row => Number(row.is_active) === 1);
}

function latestByDate(rows) {
  return [...(rows || [])].sort((a, b) => String(b.effective_date || '').localeCompare(String(a.effective_date || '')))[0] || null;
}

function getConfiguredPieceRate(sewType, sizeRange) {
  const sew = String(sewType || '').trim();
  const size = String(sizeRange || '').trim();
  return latestByDate(activeRows(pieceRateConfig.piece_rates).filter(row => {
    const rowSew = row.sew_type_code || row.product_type;
    const rowSize = row.size_range || row.product_category || '';
    return rowSew === sew && rowSize === size;
  }));
}

function getConfiguredPairRule(pairingType) {
  return latestByDate(activeRows(pieceRateConfig.production_share_rules).filter(row => row.pairing_type === pairingType));
}

function populatePieceRateDropdowns() {
  const sewRows = activeRows(pieceRateConfig.sew_types);
  const sewFromRates = activeRows(pieceRateConfig.piece_rates)
    .map(row => ({
      code: row.sew_type_code || row.product_type,
      description: row.description || ''
    }))
    .filter(row => row.code);
  const uniqueSewRows = [...new Map([...sewRows, ...sewFromRates].map(row => [row.code, row])).values()];
  const sewOptions = uniqueSewRows
    .map(row => `<option value="${row.code}">${row.code}${row.description ? ` - ${row.description}` : ''}</option>`)
    .join('');
  const sizeOptions = activeRows(pieceRateConfig.size_ranges)
    .map(row => `<option value="${row.size_range}">${row.size_range}${row.description ? ` - ${row.description}` : ''}</option>`)
    .join('');
  const rateOptions = activeRows(pieceRateConfig.piece_rates)
    .map(row => {
      const sew = row.sew_type_code || row.product_type;
      const size = row.size_range || row.product_category || '';
      return `<option value="${sew}" data-size="${size}" data-category="${size}">${sew}${size ? ` / ${size}` : ''} (${money(row.piece_rate)})</option>`;
    })
    .join('');
  const workerOptions = activeRows(pieceRateConfig.production_shares)
    .map(row => `<option value="${row.worker_category}">${row.worker_category} (${Number(row.percentage_share || 0)}%)</option>`)
    .join('');

  ['rate-sew-type', 'output-sew-type', 'pair-sew-type'].forEach(id => {
    const select = document.getElementById(id);
    if (select) {
      select.innerHTML = sewOptions
        ? `<option value="">Select type</option>${sewOptions}`
        : '<option value="">No active type configured</option>';
    }
  });
  ['rate-size-range', 'salary-piece-size-range', 'output-size-range', 'pair-size-range'].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.innerHTML = `<option value="">Select size range</option>${sizeOptions}`;
  });
  ['salary-piece-product'].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.innerHTML = `<option value="">Select type</option>${sewOptions || rateOptions}`;
  });
  ['salary-worker-category', 'output-worker-category'].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.innerHTML = `<option value="">Select category</option>${workerOptions}`;
  });
  updateProductionPairSummary();
}

function renderPieceRateConfig(config) {
  const views = [
    ['rates', 'Piece Rates'],
    ['splits', 'Production Splits'],
    ['sew', 'Type of Sew'],
    ['sizes', 'Size Ranges'],
    ['rules', 'Sharing Rules'],
    ['incentives', 'Incentive Rules'],
    ['production', 'Production Encodings'],
    ['register', 'SWR-FXR-SUM Register'],
    ['entries', 'Incentive Encodings']
  ];
  return `
    <div class="piece-records-compact">
      <div class="piece-records-head">
        <div>
          <h3>Records</h3>
          <p>Choose one record type to view or edit. This keeps the page light.</p>
        </div>
        <select id="piece-rate-record-view" onchange="switchPieceRateRecordsView(this.value)">
          ${views.map(([value, label]) => `<option value="${value}" ${pieceRateRecordsView === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div id="piece-rate-record-table">${renderPieceRateRecordTable(config, pieceRateRecordsView)}</div>
    </div>
  `;
}

function switchPieceRateRecordsView(view) {
  pieceRateRecordsView = view;
  pieceRateRecordsPages[view] = pieceRateRecordsPages[view] || 1;
  const target = document.getElementById('piece-rate-record-table');
  if (target) target.innerHTML = renderPieceRateRecordTable(pieceRateConfig, pieceRateRecordsView);
}

function pieceRecordJson(row) {
  return payrollEscape(JSON.stringify(row));
}

function pieceRecordActions(view, row) {
  const id = Number(row.id);
  if (!id) return '';
  const editMap = {
    sew: 'editSewType',
    sizes: 'editSizeRange',
    rules: 'editProductionShareRule',
    splits: 'editProductionSplit',
    incentives: 'editPieceIncentive',
    rates: 'editPieceRate'
  };
  const editFn = editMap[view];
  const edit = editFn
    ? `<button class="btn btn-outline btn-sm" type="button" onclick='${editFn}(${pieceRecordJson(row)})'>Edit</button>`
    : '';
  const del = `<button class="btn btn-danger btn-sm" type="button" onclick="deletePieceRateRecord('${view}', ${id})">Delete</button>`;
  return `<div class="piece-record-actions">${edit}${del}</div>`;
}

function pieceRecordTable(columns, rows, rowRenderer, emptyText) {
  return `
    <div class="table-wrap piece-record-table-wrap">
      <table class="piece-record-table" data-no-pagination="1">
        <thead><tr>${columns.map(column => `<th>${payrollEscape(column)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(rowRenderer).join('') || `<tr class="table-empty"><td colspan="${columns.length}">${payrollEscape(emptyText)}</td></tr>`}</tbody>
      </table>
    </div>`;
}

function pieceRecordPagination(totalRows, startIndex, currentPage, totalPages) {
  if (totalRows <= PIECE_RATE_RECORDS_PAGE_SIZE) return '';
  const endIndex = Math.min(startIndex + PIECE_RATE_RECORDS_PAGE_SIZE, totalRows);
  return `
    <div class="table-pagination piece-record-pagination">
      <span>Showing ${startIndex + 1}-${endIndex} of ${totalRows}</span>
      <div class="table-pagination-actions">
        <button class="btn btn-outline btn-sm" type="button" onclick="changePieceRateRecordsPage(-1)" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${currentPage} of ${totalPages}</span>
        <button class="btn btn-outline btn-sm" type="button" onclick="changePieceRateRecordsPage(1)" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    </div>`;
}

function pieceRecordPageRows(allRows) {
  const totalPages = Math.max(1, Math.ceil(allRows.length / PIECE_RATE_RECORDS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(pieceRateRecordsPages[pieceRateRecordsView] || 1, 1), totalPages);
  pieceRateRecordsPages[pieceRateRecordsView] = currentPage;
  const startIndex = (currentPage - 1) * PIECE_RATE_RECORDS_PAGE_SIZE;
  return {
    rows: allRows.slice(startIndex, startIndex + PIECE_RATE_RECORDS_PAGE_SIZE),
    startIndex,
    currentPage,
    totalPages,
    totalRows: allRows.length
  };
}

function renderPieceRateRecordTable(config, view) {
  if (view === 'sew') {
    const page = pieceRecordPageRows(config.sew_types || []);
    return pieceRecordTable(['Code', 'Description', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.code)}</td><td>${payrollEscape(row.description || '-')}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`, 'No Type of Sew configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'sizes') {
    const page = pieceRecordPageRows(config.size_ranges || []);
    return pieceRecordTable(['Size Range', 'Description', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.size_range)}</td><td>${payrollEscape(row.description || '-')}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`, 'No size ranges configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'rules') {
    const page = pieceRecordPageRows(config.production_share_rules || []);
    return pieceRecordTable(['Pairing Type', 'Worker 1', 'Worker 2', 'Effective', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.pairing_type)}</td><td>${Number(row.worker1_share || 0)}%</td><td>${Number(row.worker2_share || 0)}%</td><td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`, 'No sharing rules configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'splits') {
    const page = pieceRecordPageRows(config.production_split_configs || []);
    return pieceRecordTable(['Split Name', 'Sewer %', 'Fixer %', 'Total', 'Effective', 'Status', 'Action'], page.rows, row => {
        const total = Number(row.sewer_percentage || 0) + Number(row.fixer_percentage || 0);
        return `<tr><td>${payrollEscape(row.split_name)}</td><td>${Number(row.sewer_percentage || 0)}%</td><td>${Number(row.fixer_percentage || 0)}%</td><td>${total}%</td><td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`;
      }, 'No production split configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'incentives') {
    const page = pieceRecordPageRows(config.incentives || []);
    return pieceRecordTable(['Name', 'Category', 'Amount', 'Effective', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.incentive_name)}</td><td>${payrollEscape(row.incentive_category)}</td><td>${money(row.amount)}</td><td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`, 'No incentive rules configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'production') {
    const page = pieceRecordPageRows(config.production_pairs || []);
    return pieceRecordTable(['Date', 'Pairing', 'Sewer', 'Partner', 'Sew / Size', 'Qty', 'Raw Earnings'], page.rows, row => `<tr><td>${payrollEscape((row.production_date || '').slice(0, 10))}</td><td>${payrollEscape(row.pairing_type)}</td><td>${payrollEscape(row.worker1_name || row.worker1_employee_id)}</td><td>${payrollEscape(row.worker2_name || row.worker2_employee_id)}</td><td>${payrollEscape(row.sew_type_code || row.product_type)} / ${payrollEscape(row.size_range || row.product_category || '-')}</td><td>${payrollEscape(row.quantity_produced)}</td><td>${money(row.production_value)}</td></tr>`, 'No production encodings yet.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'register') {
    const totals = new Map();
    (config.production_pairs || []).forEach(row => {
      const sewerName = row.worker1_name || row.worker1_employee_id;
      const fixerName = row.worker2_name || row.worker2_employee_id;
      const sewerKey = `${sewerName}:Sewer`;
      const fixerKey = `${fixerName}:Fixer`;
      totals.set(sewerKey, { employee: sewerName, role: 'Sewer', amount: (totals.get(sewerKey)?.amount || 0) + Number(row.worker1_earnings || 0) });
      totals.set(fixerKey, { employee: fixerName, role: 'Fixer', amount: (totals.get(fixerKey)?.amount || 0) + Number(row.worker2_earnings || 0) });
    });
    const rows = [...totals.values()].sort((a, b) => String(a.employee).localeCompare(String(b.employee)));
    const grandTotal = rows.reduce((sum, row) => sum + row.amount, 0);
    return `
      <table><thead><tr><th>Employee</th><th>Role</th><th>Payroll Amount</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${row.employee}</td><td>${row.role}</td><td>${money(row.amount)}</td></tr>`).join('') || '<tr><td colspan="3">No register data yet.</td></tr>'}
      ${rows.length ? `<tr><th colspan="2">Total</th><th>${money(grandTotal)}</th></tr>` : ''}</tbody></table>`;
  }
  if (view === 'entries') {
    const page = pieceRecordPageRows(config.incentive_entries || []);
    return pieceRecordTable(['Employee', 'Period', 'Type', 'Amount', 'Remarks'], page.rows, row => `<tr><td>${payrollEscape(row.employee_name || row.employee_code || row.employee_id)}</td><td>${payrollEscape(row.payroll_period)}</td><td>${payrollEscape(row.incentive_type)}</td><td>${money(row.amount)}</td><td>${payrollEscape(row.remarks || '-')}</td></tr>`, 'No incentive encodings yet.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  const page = pieceRecordPageRows(config.piece_rates || []);
  return pieceRecordTable(['Type of Sew', 'Size Range', 'Rate', 'Effective', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.sew_type_code || row.product_type)}</td><td>${payrollEscape(row.size_range || row.product_category || '-')}</td><td>${money(row.piece_rate)}</td><td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions('rates', row)}</td></tr>`, 'No piece rates configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
}

function changePieceRateRecordsPage(direction) {
  const rowsByView = {
    sew: pieceRateConfig.sew_types || [],
    sizes: pieceRateConfig.size_ranges || [],
    rules: pieceRateConfig.production_share_rules || [],
    splits: pieceRateConfig.production_split_configs || [],
    incentives: pieceRateConfig.incentives || [],
    production: pieceRateConfig.production_pairs || [],
    register: [],
    entries: pieceRateConfig.incentive_entries || [],
    rates: pieceRateConfig.piece_rates || []
  };
  const totalPages = Math.max(1, Math.ceil((rowsByView[pieceRateRecordsView] || []).length / PIECE_RATE_RECORDS_PAGE_SIZE));
  pieceRateRecordsPages[pieceRateRecordsView] = Math.min(Math.max((pieceRateRecordsPages[pieceRateRecordsView] || 1) + direction, 1), totalPages);
  const target = document.getElementById('piece-rate-record-table');
  if (target) target.innerHTML = renderPieceRateRecordTable(pieceRateConfig, pieceRateRecordsView);
}

function setFormValues(formId, row) {
  const form = document.getElementById(formId);
  if (!form) return;
  Object.entries(row).forEach(([key, value]) => {
    const input = form.elements[key];
    if (!input) return;
    input.value = key.includes('date') && value ? String(value).slice(0, 10) : value ?? '';
  });
}

function editPieceRate(row) {
  setFormValues('piece-rate-form', {
    ...row,
    sew_type_code: row.sew_type_code || row.product_type,
    size_range: row.size_range || row.product_category
  });
  document.getElementById('piece-rate-form')?.scrollIntoView({ block: 'nearest' });
}

async function deletePieceRateRecord(view, id) {
  const endpointMap = {
    sew: `/api/payroll/sew-types/${id}`,
    sizes: `/api/payroll/size-ranges/${id}`,
    rules: `/api/payroll/production-share-rules/${id}`,
    splits: `/api/payroll/production-splits/${id}`,
    incentives: `/api/payroll/piece-incentives/${id}`,
    rates: `/api/payroll/piece-rates/${id}`
  };
  const endpoint = endpointMap[view];
  if (!endpoint) return;
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Delete this record from the active setup list?', 'Delete Record', 'Delete', 'Cancel')
    : confirm('Delete this record from the active setup list?');
  if (!confirmed) return;

  try {
    const res = await apiFetch(endpoint, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to delete record.');
    await loadPieceRateConfig();
    if (typeof showAlert === 'function') await showAlert(data.message || 'Record deleted.', 'Deleted', 'success');
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

function editSewType(row) {
  setFormValues('sew-type-form', row);
  document.getElementById('sew-type-form')?.scrollIntoView({ block: 'nearest' });
}

function editSizeRange(row) {
  setFormValues('size-range-form', row);
  document.getElementById('size-range-form')?.scrollIntoView({ block: 'nearest' });
}

async function saveSewType(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await apiFetch('/api/payroll/sew-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save Type of Sew');
    form.reset();
    await loadPieceRateConfig();
    if (typeof showAlert === 'function') await showAlert('Type of Sew saved.', 'Saved', 'success');
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

async function saveSizeRange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await apiFetch('/api/payroll/size-ranges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save size range');
    form.reset();
    await loadPieceRateConfig();
    if (typeof showAlert === 'function') await showAlert('Size range saved.', 'Saved', 'success');
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

function editPieceIncentive(row) {
  setFormValues('piece-incentive-form', row);
  document.getElementById('piece-incentive-form')?.scrollIntoView({ block: 'nearest' });
}

function editProductionShareRule(row) {
  setFormValues('production-share-rule-form', row);
  document.getElementById('production-share-rule-form')?.scrollIntoView({ block: 'nearest' });
}

function editProductionSplit(row) {
  setFormValues('production-split-form', row);
  document.getElementById('production-split-form')?.scrollIntoView({ block: 'nearest' });
}

function applyPairingTypeDefaults() {
  const form = document.getElementById('production-share-rule-form');
  if (!form) return;
  const type = form.elements.pairing_type?.value;
  if (type === 'Standard Sewer-Fixer') {
    form.elements.worker1_share.value = 55;
    form.elements.worker2_share.value = 45;
  } else if (type === 'Substitute Sewer-Sewer') {
    form.elements.worker1_share.value = 50;
    form.elements.worker2_share.value = 50;
  }
}

function bindProductionPairPreview() {
  const form = document.getElementById('production-pair-form');
  if (!form || form.dataset.previewBound) return;
  ['pairing_type', 'sew_type_code', 'size_range', 'quantity_produced'].forEach(name => {
    const input = form.elements[name];
    if (!input) return;
    input.addEventListener('input', updateProductionPairSummary);
    input.addEventListener('change', updateProductionPairSummary);
  });
  form.dataset.previewBound = '1';
  restoreProductionPairDraft();
  togglePiecePartnerFields();
  updateProductionPairSummary();
}

function setPairSummary(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateProductionPairSummary() {
  const form = document.getElementById('production-pair-form');
  if (!form) return;
  const sewType = form.elements.sew_type_code?.value || '';
  const sizeRange = form.elements.size_range?.value || '';
  const quantity = Number(form.elements.quantity_produced?.value || 0);
  const outputMode = form.elements.output_mode?.value || 'solo';
  const pairingType = form.elements.pairing_type?.value || '';
  const rate = getConfiguredPieceRate(sewType, sizeRange);
  const rule = getConfiguredPairRule(pairingType);
  const pieceRate = Number(rate?.piece_rate || 0);
  const raw = quantity * pieceRate;
  const worker1Share = outputMode === 'solo' ? 100 : Number(rule?.worker1_share || 0);
  const worker2Share = outputMode === 'solo' ? 0 : Number(rule?.worker2_share || 0);
  const rateInput = document.getElementById('pair-piece-rate-preview');
  if (rateInput) rateInput.value = money(pieceRate);
  setPairSummary('pair-raw-earnings', money(raw));
  setPairSummary('pair-worker1-share', `${worker1Share}%`);
  setPairSummary('pair-worker1-earnings', money(raw * (worker1Share / 100)));
  setPairSummary('pair-worker2-share', `${worker2Share}%`);
  setPairSummary('pair-worker2-earnings', money(raw * (worker2Share / 100)));
}

function saveProductionPairDraft() {
  const form = document.getElementById('production-pair-form');
  const status = document.getElementById('production-pair-status');
  if (!form) return;
  const data = Object.fromEntries(new FormData(form).entries());
  localStorage.setItem('payrollProductionPairDraft', JSON.stringify({ data, savedAt: new Date().toISOString() }));
  if (status) status.textContent = 'Draft saved.';
}

function restoreProductionPairDraft() {
  const form = document.getElementById('production-pair-form');
  if (!form || form.dataset.draftRestored) return;
  const raw = localStorage.getItem('payrollProductionPairDraft');
  if (!raw) {
    form.dataset.draftRestored = '1';
    return;
  }
  try {
    const draft = JSON.parse(raw);
    Object.entries(draft.data || {}).forEach(([key, value]) => {
      if (form.elements[key]) form.elements[key].value = value;
    });
  } catch (err) {
    console.warn('Unable to restore production pair draft:', err.message);
  }
  form.dataset.draftRestored = '1';
}

function clearProductionPairForm() {
  const form = document.getElementById('production-pair-form');
  const status = document.getElementById('production-pair-status');
  if (!form) return;
  form.reset();
  localStorage.removeItem('payrollProductionPairDraft');
  updateProductionPairSummary();
  if (status) status.textContent = '';
}

async function savePieceRate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await apiFetch('/api/payroll/piece-rates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save piece rate');
    form.reset();
    await loadPieceRateConfig();
    if (typeof showAlert === 'function') await showAlert('Piece rate saved.', 'Saved', 'success');
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

async function saveProductionShares(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  const total = Number(data.sewer_share || 0) + Number(data.fixer_share || 0);
  const status = document.getElementById('share-save-status');
  if (Math.abs(total - 100) > 0.001) {
    if (status) status.textContent = 'Shares must total exactly 100%.';
    return;
  }
  const shares = [
    { worker_category: 'Sewer', percentage_share: data.sewer_share, effective_date: data.effective_date },
    { worker_category: 'Fixer', percentage_share: data.fixer_share, effective_date: data.effective_date }
  ];
  try {
    const res = await apiFetch('/api/payroll/production-shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shares })
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save shares');
    if (status) status.textContent = 'Shares saved.';
    await loadPieceRateConfig();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function saveProductionSplit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('production-split-status');
  const data = Object.fromEntries(new FormData(form).entries());
  const total = Number(data.sewer_percentage || 0) + Number(data.fixer_percentage || 0);
  if (status) {
    status.className = 'payroll-form-status';
    status.textContent = 'Saving...';
  }
  if (Math.abs(total - 100) > 0.001) {
    if (status) {
      status.className = 'payroll-form-status error';
      status.textContent = 'Total percentage must equal 100%.';
    }
    return;
  }
  try {
    const res = await apiFetch('/api/payroll/production-splits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Failed to save production split');
    form.reset();
    if (status) {
      status.className = 'payroll-form-status success';
      status.textContent = 'Production split saved.';
    }
    await loadPieceRateConfig();
    if (typeof showAlert === 'function') await showAlert('Production split configuration saved.', 'Saved', 'success');
  } catch (err) {
    if (status) {
      status.className = 'payroll-form-status error';
      status.textContent = err.message;
    }
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
  }
}

async function saveProductionShareRule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('pair-rule-status');
  const data = Object.fromEntries(new FormData(form).entries());
  const total = Number(data.worker1_share || 0) + Number(data.worker2_share || 0);
  if (Math.abs(total - 100) > 0.001) {
    if (status) status.textContent = 'Worker shares must total exactly 100%.';
    return;
  }
  try {
    const res = await apiFetch('/api/payroll/production-share-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save pair rule');
    if (status) status.textContent = 'Pair rule saved.';
    form.reset();
    await loadPieceRateConfig();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function savePieceIncentive(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await apiFetch('/api/payroll/piece-incentives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save incentive');
    form.reset();
    await loadPieceRateConfig();
    if (typeof showAlert === 'function') await showAlert('Incentive saved.', 'Saved', 'success');
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

async function encodeProductionOutput(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('production-output-status');
  const data = Object.fromEntries(new FormData(form).entries());
  data.is_sunday = data.is_sunday === '1';
  try {
    const res = await apiFetch('/api/payroll/production-output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Failed to encode production output');
    if (status) status.textContent = `Saved. Gross pay: ${money(result.final_gross_pay)}`;
    form.reset();
    await loadPieceRateConfig();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function encodePieceIncentive(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('piece-incentive-entry-status');
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await apiFetch('/api/payroll/piece-incentive-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Failed to encode incentive');
    if (status) status.textContent = 'Incentive encoded.';
    form.reset();
    await loadPieceRateConfig();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function encodeProductionPair(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('production-pair-status');
  const data = Object.fromEntries(new FormData(form).entries());
  if (data.output_mode === 'partner' && String(data.worker1_employee_id || '') === String(data.worker2_employee_id || '')) {
    if (status) status.textContent = 'Sewer and partner cannot be the same employee.';
    return;
  }
  const rate = getConfiguredPieceRate(data.sew_type_code, data.size_range);
  if (!rate) {
    if (status) status.textContent = 'No active rate found for this Type of Sew and Size Range.';
    return;
  }
  try {
    const res = await apiFetch('/api/payroll/piece-rate-outputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Failed to encode production pair');
    if (status) status.textContent = `Saved daily output. Full amount: ${money(result.fullAmount)}.`;
    localStorage.removeItem('payrollProductionPairDraft');
    form.reset();
    updateProductionPairSummary();
    await loadPieceRateConfig();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function generatePiecePayrollRegister() {
  const month = document.getElementById('payroll-filter-month')?.value || new Date().toISOString().slice(0, 7);
  try {
    const res = await apiFetch('/api/payroll/piece-payroll-register/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month_year: month })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Failed to generate per-piece payroll register.');
    pieceRateRecordsView = 'register';
    await loadPieceRateConfig();
    if (typeof showAlert === 'function') {
      await showAlert(`Per-piece payroll register generated for ${month}. Total: ${money(result.totals?.combined_payroll || 0)}`, 'Generated', 'success');
    }
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

function refreshPayrollDashboard() {
  const month = document.getElementById('payroll-filter-month')?.value;
  loadPayrollDashboard(month || null);
  loadSalaryCalculations();
}

function togglePiecePartnerFields() {
  const partnerMode = document.getElementById('piece-output-mode')?.value === 'partner';
  document.querySelectorAll('.piece-partner-field').forEach(field => {
    field.style.display = partnerMode ? '' : 'none';
    field.querySelectorAll('input, select').forEach(input => { input.required = partnerMode; });
  });
  updateProductionPairSummary();
}

let currentSewingRegistry = null;

function sewingRegistryDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '-';
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-PH', { day: '2-digit', month: 'short' });
}

function renderSewingRegistry(registry) {
  const title = registry.kind === '55' ? '55% Sewing Payroll Registry' : registry.kind === '45' ? '45% Sewing Payroll Registry' : 'Main Sewing Payroll Registry';
  const dates = Array.isArray(registry.dates) ? registry.dates : [];
  const dailyHeaders = dates.map(date => `<th class="sewing-registry-date"><span>${payrollEscape(sewingRegistryDate(date))}</span><small>Daily Output</small></th>`).join('');
  const employees = registry.employees.map(employee => {
    const body = employee.rows.map(row => `<tr><td>${payrollEscape(row.operation_type)}</td><td>${payrollEscape(row.size_range || '-')}</td><td>${money(row.rate_per_piece)}</td>${dates.map(date => `<td>${Number(row.daily?.[date] || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 })}</td>`).join('')}<td>${Number(row.total_output).toLocaleString('en-PH', { maximumFractionDigits: 2 })}</td><td>${money(row.amount)}</td><td>${payrollEscape(row.partner_roles || 'Solo')}</td></tr>`).join('');
    const dailyTotals = dates.map(date => `<th>${Number(employee.daily_totals?.[date] || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 })}</th>`).join('');
    return `<tr class="sewing-registry-employee"><th colspan="${dates.length + 7}">${payrollEscape(employee.employee_name)}${employee.agency ? ` · ${payrollEscape(employee.agency)}` : ''}</th></tr>${body}<tr class="sewing-registry-total"><th colspan="3">Employee Daily Total</th>${dailyTotals}<th>${Number(employee.total_output).toLocaleString('en-PH', { maximumFractionDigits: 2 })}</th><th>${money(employee.total_amount)}</th><th></th></tr>`;
  }).join('');
  const grandDailyTotals = dates.map(date => `<th>${Number(registry.totals?.daily_totals?.[date] || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 })}</th>`).join('');
  return `<div class="sewing-registry-print"><h3>${title}</h3><p>PAYROLL PERIOD: ${payrollEscape(registry.payroll_period)}</p><div class="table-wrap"><table><thead><tr><th>Sew Type</th><th>Size</th><th>Rate/Piece</th>${dailyHeaders}<th>Total Output</th><th>Amount</th><th>Partner Role</th></tr></thead><tbody>${employees || `<tr><td colspan="${dates.length + 7}">No daily sewing output was encoded for this period.</td></tr>`}</tbody><tfoot><tr><th colspan="3">Grand Daily Total</th>${grandDailyTotals}<th>${Number(registry.totals.total_output).toLocaleString('en-PH', { maximumFractionDigits: 2 })}</th><th>${money(registry.totals.total_amount)}</th><th></th></tr></tfoot></table></div></div>`;
}

async function generateSewingRegistry(kind) {
  const period = document.getElementById('sewing-registry-period')?.value || document.getElementById('report-period')?.value;
  const target = document.getElementById('sewing-registry');
  if (!period) { if (target) target.innerHTML = '<div class="payroll-empty-state">Select a payroll period first.</div>'; return; }
  try {
    const response = await apiFetch(`/api/payroll/sewing-registries?month_year=${encodeURIComponent(period)}&kind=${encodeURIComponent(kind)}`);
    const registry = await response.json();
    if (!response.ok) throw new Error(registry.error || 'Failed to generate sewing registry.');
    currentSewingRegistry = registry;
    target.innerHTML = renderSewingRegistry(registry);
  } catch (error) { if (target) target.innerHTML = `<div class="payroll-empty-state">${payrollEscape(error.message)}</div>`; }
}

function printSewingRegistry() {
  const content = document.getElementById('sewing-registry')?.innerHTML;
  if (!currentSewingRegistry || !content) return;
  const popup = window.open('', '_blank', 'width=1200,height=800');
  if (!popup) return;
  popup.document.write(`<html><head><title>Sewing Payroll Registry</title><style>body{font-family:Arial,sans-serif;padding:18px}table{border-collapse:collapse;width:100%;font-size:11px}th,td{border:1px solid #222;padding:4px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}.sewing-registry-date span,.sewing-registry-date small{display:block;line-height:1.2}.sewing-registry-date small{font-size:9px;font-weight:400}.sewing-registry-employee th{text-align:left;background:#eee}.sewing-registry-total th{background:#f7f7f7}@page{size:landscape;margin:10mm}</style></head><body>${content}</body></html>`);
  popup.document.close(); popup.focus(); popup.print();
}

async function loadPayrollSettings(type) {
  const gridId = type === 'deduction' ? 'deduction-settings-grid' : 'allowance-settings-grid';
  const grid = document.getElementById(gridId);
  if (!grid) return;

  try {
    const res = await apiFetch(`/api/payroll/${type}-settings`);
    if (!res.ok) throw new Error(`Failed to load ${type} settings`);
    const rows = await res.json();

    if (!rows.length) {
      grid.innerHTML = `<div style="padding:30px; color:var(--muted); text-align:center;">No ${type} settings configured.</div>`;
      return;
    }

    grid.innerHTML = type === 'deduction' ? renderDeductionSettings(rows) : renderAllowanceSettings(rows);
  } catch (err) {
    grid.innerHTML = `<div style="padding:30px; color:var(--red); text-align:center;">${err.message}</div>`;
  }
}

function renderDeductionSettings(rows) {
  return `
    <table>
      <thead><tr><th>Name</th><th>Category</th><th>Computation</th><th>Rate/Amount</th><th>Schedule</th><th>Status</th><th>Effective</th><th>Actions</th></tr></thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${payrollEscape(row.name)}</td>
            <td>${payrollEscape(row.category)}</td>
            <td>${payrollEscape(row.computation_type)}</td>
            <td>${payrollEscape(row.rate_or_amount)}</td>
            <td>${payrollEscape(row.apply_schedule)}</td>
            <td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td>
            <td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td>
            <td><button class="btn btn-outline btn-sm" type="button" onclick="deleteDeductionSetting(${Number(row.id)})">Delete</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function deleteDeductionSetting(id) {
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Delete this deduction setting? It will no longer affect future payroll calculations. Historical payroll records remain unchanged.', 'Delete Deduction', 'Delete', 'Cancel')
    : window.confirm('Delete this deduction setting?');
  if (!confirmed) return;

  try {
    const res = await apiFetch(`/api/payroll/deduction-settings/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to delete deduction setting.');
    await loadPayrollSettings('deduction');
    await loadPayrollAudit();
    if (typeof showAlert === 'function') await showAlert('Deduction setting deleted.', 'Deleted', 'success');
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

function renderAllowanceSettings(rows) {
  return `
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Reference Amount/Rate</th><th>Taxable</th><th>Status</th><th>Effective</th></tr></thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${row.name}</td>
            <td>${row.allowance_type}</td>
            <td>${row.amount_or_rate}</td>
            <td>${row.is_taxable ? 'Yes' : 'No'}</td>
            <td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td>
            <td>${(row.effective_date || '').slice(0, 10)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

let payrollDeductionEmployees = [];

async function ensureEmployeeDeductionDropdowns() {
  if (!payrollDeductionEmployees.length) {
    const res = await apiFetch('/api/employees');
    if (!res.ok) throw new Error('Failed to load employees');
    payrollDeductionEmployees = await res.json();
  }
  const options = '<option value="">Select employee</option>' + payrollDeductionEmployees.map(emp => {
    const name = emp.name || [emp.first_name, emp.middle_name, emp.last_name].filter(Boolean).join(' ') || emp.employee_name || `Employee ${emp.id}`;
    const code = emp.employee_code || emp.empCode || emp.code || '';
    return `<option value="${emp.id}">${code ? `${code} - ` : ''}${name}</option>`;
  }).join('');
  document.querySelectorAll('.employee-deduction-employee').forEach(select => {
    const current = select.value;
    select.innerHTML = options;
    if (current) select.value = current;
  });
}

async function loadEmployeeDeductionAccounts(type) {
  const grid = document.getElementById(type === 'cash_advance' ? 'cash-advance-grid' : 'employee-loan-grid');
  if (!grid) return;
  try {
    await ensureEmployeeDeductionDropdowns();
    const res = await apiFetch(`/api/payroll/employee-deductions?type=${encodeURIComponent(type)}`);
    if (!res.ok) throw new Error('Failed to load employee deductions');
    const rows = await res.json();
    grid.innerHTML = renderEmployeeDeductionAccounts(rows, type);
  } catch (err) {
    grid.innerHTML = `<div style="padding:30px; color:var(--red); text-align:center;">${err.message}</div>`;
  }
}

function renderEmployeeDeductionAccounts(rows, type) {
  if (!rows.length) {
    return `<div style="padding:30px; color:var(--muted); text-align:center;">No ${type === 'cash_advance' ? 'cash advances' : 'employee loans'} assigned.</div>`;
  }
  return `
    <table>
      <thead>
        <tr>
          <th>Employee</th>
          <th>Name</th>
          <th>Original Amount</th>
          <th>Remaining</th>
          <th>Installment</th>
          <th>Period</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${row.employee_code || '-'}</td>
            <td>${row.employee_name || '-'}</td>
            <td>${money(row.original_amount)}</td>
            <td>${money(row.remaining_balance)}</td>
            <td>${money(row.installment_amount)}</td>
            <td>${(row.start_date || '').slice(0, 10)} - ${row.end_date ? String(row.end_date).slice(0, 10) : 'Open'}</td>
            <td>${payrollBadge(row.status)}</td>
            <td>
              <button class="btn btn-outline btn-sm" type="button" onclick='editEmployeeDeductionAccount(${JSON.stringify(row).replace(/'/g, '&#39;')}, "${type}")'>Edit</button>
              ${row.status === 'Active'
                ? `<button class="btn btn-outline btn-sm" type="button" onclick="updateEmployeeDeductionStatus(${row.id}, '${type}', 'Paused')">Pause</button>`
                : `<button class="btn btn-outline btn-sm" type="button" onclick="updateEmployeeDeductionStatus(${row.id}, '${type}', 'Active')">Activate</button>`}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function editEmployeeDeductionAccount(row, type) {
  const form = document.getElementById(type === 'cash_advance' ? 'cash-advance-form' : 'employee-loan-form');
  if (!form) return;
  form.elements.id.value = row.id || '';
  form.elements.employee_id.value = row.employee_id || '';
  form.elements.deduction_name.value = row.deduction_name || '';
  if (form.elements.loan_type) form.elements.loan_type.value = row.loan_type || 'Employee Loan';
  form.elements.amount.value = row.original_amount || '';
  form.elements.remaining_balance.value = row.remaining_balance || '';
  form.elements.installment_amount.value = row.installment_amount || '';
  form.elements.start_date.value = (row.start_date || '').slice(0, 10);
  form.elements.end_date.value = row.end_date ? String(row.end_date).slice(0, 10) : '';
  form.elements.status.value = row.status || 'Active';
  form.elements.remarks.value = row.remarks || '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveEmployeeDeductionAccount(event, type) {
  event.preventDefault();
  const form = event.currentTarget;
  const statusEl = document.getElementById(type === 'cash_advance' ? 'cash-advance-save-status' : 'employee-loan-save-status');
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.remaining_balance) data.remaining_balance = data.amount;
  if (statusEl) {
    statusEl.className = 'payroll-form-status';
    statusEl.textContent = 'Saving...';
  }
  try {
    const endpoint = type === 'cash_advance' ? '/api/payroll/employee-cash-advances' : '/api/payroll/employee-loans';
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to save employee deduction');
    }
    form.reset();
    if (type === 'cash_advance' && form.elements.deduction_name) form.elements.deduction_name.value = 'Cash Advance';
    if (type === 'loan' && form.elements.deduction_name) form.elements.deduction_name.value = 'Employee Loan';
    if (statusEl) {
      statusEl.className = 'payroll-form-status success';
      statusEl.textContent = 'Saved successfully.';
    }
    await loadEmployeeDeductionAccounts(type);
    if (typeof showAlert === 'function') await showAlert('Employee deduction saved.', 'Saved', 'success');
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'payroll-form-status error';
      statusEl.textContent = err.message;
    }
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

async function updateEmployeeDeductionStatus(id, type, status) {
  try {
    const res = await apiFetch(`/api/payroll/employee-deductions/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update status');
    }
    await loadEmployeeDeductionAccounts(type);
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

async function savePayrollSetting(event, type) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  const statusEl = document.getElementById(type === 'deduction' ? 'deduction-save-status' : 'allowance-save-status');
  if (statusEl) {
    statusEl.className = 'payroll-form-status';
    statusEl.textContent = 'Saving...';
  }
  if (type === 'deduction') {
    data.name = data.category === 'Government'
      ? data.government_name
      : data.category === 'Company'
        ? data.company_name
      : data.custom_name;
    delete data.government_name;
    delete data.company_name;
    delete data.custom_name;
  } else if (type === 'allowance' && !data.amount_or_rate) {
    data.amount_or_rate = 0;
  }
  const endpoint = type === 'deduction' ? '/api/payroll/deduction-settings' : '/api/payroll/allowance-settings';

  try {
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to save ${type} setting`);
    }
    form.reset();
    if (statusEl) {
      statusEl.className = 'payroll-form-status success';
      statusEl.textContent = `${type === 'deduction' ? 'Deduction' : 'Allowance'} saved successfully.`;
    }
    loadPayrollSettings(type);
    loadPayrollAudit();
    if (typeof showAlert === 'function') {
      await showAlert(`${type === 'deduction' ? 'Deduction' : 'Allowance'} setting saved.`, 'Saved', 'success');
    }
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'payroll-form-status error';
      statusEl.textContent = err.message;
    }
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
  }
}

function toggleDeductionNameField() {
  const category = document.getElementById('deduction-category')?.value || 'Government';
  const governmentGroup = document.getElementById('deduction-government-name-group');
  const companyGroup = document.getElementById('deduction-company-name-group');
  const customGroup = document.getElementById('deduction-custom-name-group');
  const governmentName = document.getElementById('deduction-government-name');
  const companyName = document.getElementById('deduction-company-name');
  const customName = document.getElementById('deduction-custom-name');
  const isGovernment = category === 'Government';
  const isCompany = category === 'Company';

  if (governmentGroup) governmentGroup.style.display = isGovernment ? 'block' : 'none';
  if (companyGroup) companyGroup.style.display = isCompany ? 'block' : 'none';
  if (customGroup) customGroup.style.display = (!isGovernment && !isCompany) ? 'block' : 'none';
  if (governmentName) governmentName.required = isGovernment;
  if (companyName) companyName.required = isCompany;
  if (customName) customName.required = !isGovernment && !isCompany;
}

async function loadPayrollPolicySettings() {
  const form = document.getElementById('payroll-policy-form');
  const status = document.getElementById('payroll-policy-save-status');
  if (!form) return;
  if (status) {
    status.className = 'payroll-form-status';
    status.textContent = 'Loading...';
  }
  try {
    const res = await apiFetch('/api/payroll/policy-settings');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load payroll policies.');
    const values = (data.settings || []).reduce((acc, item) => {
      acc[item.setting_key] = item.setting_value;
      return acc;
    }, {});
    [...form.elements].forEach(field => {
      if (field.name && Object.prototype.hasOwnProperty.call(values, field.name)) {
        field.value = values[field.name];
      }
    });
    if (status) status.textContent = 'Loaded.';
  } catch (err) {
    if (status) {
      status.className = 'payroll-form-status error';
      status.textContent = err.message;
    }
  }
}

async function savePayrollPolicySettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('payroll-policy-save-status');
  const settings = Object.fromEntries(new FormData(form).entries());
  if (status) {
    status.className = 'payroll-form-status';
    status.textContent = 'Saving...';
  }
  try {
    const res = await apiFetch('/api/payroll/policy-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save payroll policies.');
    if (status) {
      status.className = 'payroll-form-status success';
      status.textContent = 'Payroll policy saved.';
    }
    if (typeof showAlert === 'function') await showAlert('Payroll policy settings saved.', 'Saved', 'success');
  } catch (err) {
    if (status) {
      status.className = 'payroll-form-status error';
      status.textContent = err.message;
    }
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
  }
}

async function loadPayrollAudit() {
  const grid = document.getElementById('payroll-audit-grid');
  if (!grid) return;
  try {
    const res = await apiFetch('/api/payroll/audit');
    if (!res.ok) throw new Error('Failed to load payroll audit trail');
    const rows = await res.json();
    if (!rows.length) {
      grid.innerHTML = '<div style="padding:30px; color:var(--muted); text-align:center;">No payroll audit activity yet.</div>';
      return;
    }
    grid.innerHTML = `
      <table>
        <thead><tr><th>Date/Time</th><th>User</th><th>Action</th><th>Employee</th><th>Remarks</th></tr></thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td>${new Date(row.created_at).toLocaleString()}</td>
              <td>${row.username || '-'}</td>
              <td>${row.action}</td>
              <td>${row.employee_name || '-'}</td>
              <td>${row.remarks || '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    grid.innerHTML = `<div style="padding:30px; color:var(--red); text-align:center;">${err.message}</div>`;
  }
}

const PAYROLL_REPORTS = [
  { id: 'summary', name: 'Payroll Summary Report', category: 'General', description: 'Payroll totals, employee count, deductions and net pay.', formats: ['CSV', 'Excel', 'PDF'] },
  { id: 'employee', name: 'Employee Payroll Report', category: 'General', description: 'Employee-level wage type, gross pay, deductions and net pay.', formats: ['CSV', 'Excel', 'PDF'] },
  { id: 'monthly', name: 'Monthly Payroll Report', category: 'General', description: 'Monthly payroll records based on the selected payroll period.', formats: ['CSV', 'Excel', 'PDF'] },
  { id: 'weekly-payroll-registry', name: 'Weekly Payroll Registry', category: 'General', description: 'All pay types with approved days, hours, outputs, trips, deductions and net pay.', formats: ['CSV', 'Excel'] },
  { id: 'daily-rate-register', name: 'Daily Rate Payroll Register', category: 'Attendance', description: 'Daily-rate calculations with days worked and payroll-ready attendance validation.', formats: ['CSV', 'Excel'] },
  { id: 'per-hour-register', name: 'Per-Hour Payroll Register', category: 'Attendance', description: 'Hourly calculations with hours worked, overtime, and attendance validation.', formats: ['CSV', 'Excel'] },
  { id: 'attendance-payroll-validation', name: 'Attendance-to-Payroll Validation', category: 'Attendance', description: 'Validation status, excluded attendance, warnings, and blocking errors.', formats: ['CSV', 'Excel'] },
  { id: 'sewing-registry', name: 'Main Sewing Payroll Registry', category: 'Production', description: 'Client-style daily sewing quantities, configured rates, totals, and full amounts.', formats: ['CSV', 'Excel'] },
  { id: 'sewing-55-registry', name: '55% Sewing Registry', category: 'Production', description: 'Daily sewing register showing the sewer 55% share.', formats: ['CSV', 'Excel'] },
  { id: 'sewing-45-registry', name: '45% Sewing Registry', category: 'Production', description: 'Daily sewing register showing the fixer 45% share.', formats: ['CSV', 'Excel'] },
  { id: 'swr-fxr-summary', name: 'SWR-FXR Summary', category: 'Production', description: 'Sewer-fixer pairs, agency, days, split amounts, and combined totals.', formats: ['CSV', 'Excel'] },
  { id: 'piece-production-register', name: 'Production Register', category: 'Production', description: 'Production date, sewer, fixer, quantity, rate and production amount.', formats: ['CSV', 'Excel'] },
  { id: 'piece-sewer-register', name: 'Sewer Payroll Register', category: 'Production', description: 'Sewer production amount and payroll share.', formats: ['CSV', 'Excel'] },
  { id: 'piece-fixer-register', name: 'Fixer Payroll Register', category: 'Production', description: 'Fixer production amount and payroll share.', formats: ['CSV', 'Excel'] },
  { id: 'deductions', name: 'Deduction Report', category: 'Government', description: 'Configured deductions and deduction totals.', formats: ['CSV', 'Excel', 'PDF'] },
  { id: 'government', name: 'Government Contribution Report', category: 'Government', description: 'SSS, PhilHealth, and Pag-IBIG summary.', formats: ['CSV', 'Excel', 'PDF'] },
  { id: 'audit', name: 'Audit Trail', category: 'Audit', description: 'Salary calculations, approvals, releases, settings updates and report activity.', formats: ['CSV'] }
];

function getReportFavorites() {
  try {
    return JSON.parse(localStorage.getItem('payrollReportFavorites') || '[]');
  } catch (_) {
    return [];
  }
}

function setReportFavorites(favorites) {
  localStorage.setItem('payrollReportFavorites', JSON.stringify([...new Set(favorites)]));
}

function populateSelectOptions(selectId, values, fallback = 'All') {
  const select = document.getElementById(selectId);
  if (!select) return;
  const current = select.value;
  const unique = [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))].sort();
  select.innerHTML = `<option value="">${fallback}</option>${unique.map(value => `<option value="${value}">${value}</option>`).join('')}`;
  if (unique.includes(current)) select.value = current;
}

function populatePayrollReportFilters() {
  populateSelectOptions('report-category', PAYROLL_REPORTS.map(report => report.category));
  populateSelectOptions('report-department', [
    ...currentPayrollData.map(row => row.department),
    ...currentSalaryCalculationRecords.map(row => row.department)
  ]);
  populateSelectOptions('report-wage-type', [
    ...currentPayrollData.map(row => row.wage_type),
    ...currentSalaryCalculationRecords.map(row => row.wage_type)
  ]);
  const period = document.getElementById('report-period');
  const payrollPeriod = document.getElementById('payroll-filter-month')?.value;
  if (period && payrollPeriod && !period.value) period.value = payrollPeriod;
}

function filteredPayrollReports() {
  const search = String(document.getElementById('report-search')?.value || '').trim().toLowerCase();
  const category = document.getElementById('report-category')?.value || '';
  const favorites = getReportFavorites();
  return PAYROLL_REPORTS
    .filter(report => !category || report.category === category)
    .filter(report => !search || `${report.name} ${report.description}`.toLowerCase().includes(search))
    .sort((a, b) => {
      const favDiff = Number(favorites.includes(b.id)) - Number(favorites.includes(a.id));
      return favDiff || a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
    });
}

function renderPayrollReportLibrary() {
  populatePayrollReportFilters();
  const body = document.getElementById('payroll-report-library-body');
  if (!body) return;
  const reports = filteredPayrollReports();
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(reports.length / pageSize));
  payrollReportPage = Math.min(Math.max(1, payrollReportPage), pages);
  const pageRows = reports.slice((payrollReportPage - 1) * pageSize, payrollReportPage * pageSize);
  const favorites = getReportFavorites();
  body.innerHTML = pageRows.map(report => `
    <tr>
      <td><button class="report-star ${favorites.includes(report.id) ? 'active' : ''}" type="button" onclick="togglePayrollReportFavorite('${report.id}')" aria-label="Favorite ${report.name}">★</button></td>
      <td>${report.name}</td>
      <td><span class="report-category-badge">${report.category}</span></td>
      <td>${report.description}</td>
      <td>${report.formats.join(' | ')}</td>
      <td><button class="btn btn-outline btn-sm" type="button" onclick="openPayrollReportModal('${report.id}')">Generate</button></td>
    </tr>
  `).join('') || '<tr><td colspan="6">No reports match your filters.</td></tr>';
  const pagination = document.getElementById('payroll-report-pagination');
  if (pagination) {
    pagination.innerHTML = `
      <span>Showing ${reports.length ? (payrollReportPage - 1) * pageSize + 1 : 0}-${Math.min(payrollReportPage * pageSize, reports.length)} of ${reports.length}</span>
      <button class="btn btn-outline btn-sm" type="button" data-payroll-report-page-action="prev" ${payrollReportPage <= 1 ? 'disabled' : ''}>Previous</button>
      <button class="btn btn-outline btn-sm" type="button" data-payroll-report-page-action="next" ${payrollReportPage >= pages ? 'disabled' : ''}>Next</button>
    `;
    pagination.querySelector('[data-payroll-report-page-action="prev"]')?.addEventListener('click', () => changePayrollReportPage(-1));
    pagination.querySelector('[data-payroll-report-page-action="next"]')?.addEventListener('click', () => changePayrollReportPage(1));
  }
}

function changePayrollReportPage(delta) {
  const reports = filteredPayrollReports();
  const pages = Math.max(1, Math.ceil(reports.length / 10));
  payrollReportPage = Math.min(Math.max(payrollReportPage + delta, 1), pages);
  renderPayrollReportLibrary();
}

function togglePayrollReportFavorite(reportId) {
  const favorites = getReportFavorites();
  const next = favorites.includes(reportId)
    ? favorites.filter(id => id !== reportId)
    : [...favorites, reportId];
  setReportFavorites(next);
  renderPayrollReportLibrary();
}

function resetPayrollReportFilters() {
  ['report-search', 'report-employee'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['report-category', 'report-department', 'report-wage-type'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const period = document.getElementById('report-period');
  const payrollPeriod = document.getElementById('payroll-filter-month')?.value || '';
  if (period) period.value = payrollPeriod;
  payrollReportPage = 1;
  renderPayrollReportLibrary();
}

function syncReportPeriod() {
  const period = document.getElementById('report-period')?.value;
  const payrollPeriod = document.getElementById('payroll-filter-month');
  if (period && payrollPeriod) payrollPeriod.value = period;
}

function openPayrollReportModal(reportId) {
  selectedPayrollReport = PAYROLL_REPORTS.find(report => report.id === reportId);
  if (!selectedPayrollReport) return;
  document.getElementById('payroll-report-export-modal')?.remove();
  const defaultFormat = selectedPayrollReport.formats[0].toLowerCase();
  const modal = document.createElement('div');
  modal.id = 'payroll-report-export-modal';
  modal.className = 'report-modal-backdrop';
  modal.innerHTML = `
    <div class="report-modal" role="dialog" aria-modal="true" aria-labelledby="payroll-report-modal-title">
      <div class="report-modal-header">
        <div>
          <h3 id="payroll-report-modal-title">${selectedPayrollReport.name}</h3>
          <p>${selectedPayrollReport.description}</p>
        </div>
        <button type="button" class="report-modal-close" onclick="closePayrollReportModal()">×</button>
      </div>
      <div class="report-modal-body">
        <label>Export Format</label>
        <div class="report-format-list">
          ${selectedPayrollReport.formats.map(format => {
            const value = format.toLowerCase();
            return `<label><input type="radio" name="payroll-report-format" value="${value}" ${value === defaultFormat ? 'checked' : ''} /> ${format}</label>`;
          }).join('')}
        </div>
      </div>
      <div class="report-modal-footer">
        <button class="btn btn-outline" type="button" onclick="closePayrollReportModal()">Cancel</button>
        <button class="btn btn-primary" type="button" onclick="generateSelectedPayrollReport()">Generate Report</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function closePayrollReportModal() {
  document.getElementById('payroll-report-export-modal')?.remove();
}

function getPayrollReportQuery() {
  const params = new URLSearchParams();
  const month = document.getElementById('report-period')?.value || document.getElementById('payroll-filter-month')?.value || '';
  const department = document.getElementById('report-department')?.value || '';
  const wageType = document.getElementById('report-wage-type')?.value || '';
  const employee = document.getElementById('report-employee')?.value || '';
  if (month) params.set('month_year', month);
  if (department) params.set('department', department);
  if (wageType) params.set('wage_type', wageType);
  if (employee) params.set('employee', employee);
  return params;
}

function generateSelectedPayrollReport() {
  if (!selectedPayrollReport) return;
  const format = document.querySelector('input[name="payroll-report-format"]:checked')?.value || 'csv';
  exportPayrollReport(selectedPayrollReport.id, format);
  closePayrollReportModal();
}

function exportPayrollReport(type, format) {
  const params = getPayrollReportQuery();
  if (!params.has('month_year')) {
    const month = document.getElementById('payroll-filter-month')?.value || '';
    if (month) params.set('month_year', month);
  }
  const query = params.toString();
  const url = `/api/payroll/reports/${encodeURIComponent(type)}.${encodeURIComponent(format)}${query ? `?${query}` : ''}`;
  window.open(url, '_blank');
}

function initializePayrollModule() {
  const monthInput = document.getElementById('payroll-filter-month');
  if (monthInput && !monthInput.value) {
    const today = new Date();
    monthInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  }
  setDefaultWeeklyPayrollDates();

  const deductionDate = document.querySelector('#deduction-setting-form [name="effective_date"]');
  const allowanceDate = document.querySelector('#allowance-setting-form [name="effective_date"]');
  const splitDate = document.querySelector('#production-split-form [name="effective_date"]');
  const cashAdvanceDate = document.querySelector('#cash-advance-form [name="start_date"]');
  const loanDate = document.querySelector('#employee-loan-form [name="start_date"]');
  const today = new Date().toISOString().split('T')[0];
  if (deductionDate && !deductionDate.value) deductionDate.value = today;
  if (allowanceDate && !allowanceDate.value) allowanceDate.value = today;
  if (splitDate && !splitDate.value) splitDate.value = today;
  if (cashAdvanceDate && !cashAdvanceDate.value) cashAdvanceDate.value = today;
  if (loanDate && !loanDate.value) loanDate.value = today;
  const weeklyDepartment = document.getElementById('weekly-payroll-department');
  const weeklyPayType = document.getElementById('weekly-payroll-pay-type');
  const weeklyEmployee = document.getElementById('weekly-payroll-employee');
  if (weeklyDepartment && !weeklyDepartment.dataset.employeeFilterBound) {
    weeklyDepartment.addEventListener('change', () => {
      renderWeeklyPayrollEmployeeOptions();
      loadWeeklyPayrollRegistry();
    });
    weeklyDepartment.dataset.employeeFilterBound = '1';
  }
  if (weeklyPayType && !weeklyPayType.dataset.employeeFilterBound) {
    weeklyPayType.addEventListener('change', () => {
      renderWeeklyPayrollEmployeeOptions();
      loadWeeklyPayrollRegistry();
    });
    weeklyPayType.dataset.employeeFilterBound = '1';
  }
  if (weeklyEmployee && !weeklyEmployee.dataset.employeeFilterBound) {
    weeklyEmployee.addEventListener('change', loadWeeklyPayrollRegistry);
    weeklyEmployee.dataset.employeeFilterBound = '1';
  }
  // Payroll is loaded as an in-page partial. DOMContentLoaded has normally
  // already fired by the time its controls exist, so load the option data here
  // as well instead of leaving native selects with only their placeholder.
  loadWeeklyPayrollFilterOptions();
  if (document.getElementById('pair-sew-type') || document.getElementById('salary-piece-product')) {
    loadPieceRateConfig();
  }
  toggleDeductionNameField();
}

// Export functions to global scope FIRST
window.loadPayrollRecords = loadPayrollRecords;
window.loadPayrollDashboard = loadPayrollDashboard;
window.renderPayroll = renderPayroll;
window.changePayrollRecordsPage = changePayrollRecordsPage;
window.updatePayrollStats = updatePayrollStats;
window.loadSalaryCalculations = loadSalaryCalculations;
window.renderSalaryCalculations = renderSalaryCalculations;
window.changeSalaryCalculationPage = changeSalaryCalculationPage;
window.showCalculationBreakdown = showCalculationBreakdown;
window.continueSalaryDraft = continueSalaryDraft;
window.generatePayslipsFromRecords = generatePayslipsFromRecords;
window.approveSalaryCalculation = approveSalaryCalculation;
window.recordApprovedPayrollOnBlockchain = recordApprovedPayrollOnBlockchain;
window.generatePayslipPreview = generatePayslipPreview;
window.exportPayslipPdf = exportPayslipPdf;
window.switchPayrollTab = switchPayrollTab;
window.refreshPayrollDashboard = refreshPayrollDashboard;
window.loadPayrollSettings = loadPayrollSettings;
window.savePayrollSetting = savePayrollSetting;
window.deleteDeductionSetting = deleteDeductionSetting;
window.toggleDeductionNameField = toggleDeductionNameField;
window.loadEmployeeDeductionAccounts = loadEmployeeDeductionAccounts;
window.saveEmployeeDeductionAccount = saveEmployeeDeductionAccount;
window.editEmployeeDeductionAccount = editEmployeeDeductionAccount;
window.updateEmployeeDeductionStatus = updateEmployeeDeductionStatus;
window.loadPayrollPolicySettings = loadPayrollPolicySettings;
window.savePayrollPolicySettings = savePayrollPolicySettings;
window.loadPayrollAudit = loadPayrollAudit;
window.exportPayrollReport = exportPayrollReport;
window.renderPayrollReportLibrary = renderPayrollReportLibrary;
window.changePayrollReportPage = changePayrollReportPage;
window.togglePayrollReportFavorite = togglePayrollReportFavorite;
window.resetPayrollReportFilters = resetPayrollReportFilters;
window.syncReportPeriod = syncReportPeriod;
window.openPayrollReportModal = openPayrollReportModal;
window.closePayrollReportModal = closePayrollReportModal;
window.generateSelectedPayrollReport = generateSelectedPayrollReport;
window.initializePayrollModule = initializePayrollModule;
window.saveProductionSplit = saveProductionSplit;
window.editProductionSplit = editProductionSplit;
window.generatePiecePayrollRegister = generatePiecePayrollRegister;
window.generateWeeklyPayroll = generateWeeklyPayroll;
window.loadWeeklyPayrollRegistry = loadWeeklyPayrollRegistry;
window.renderWeeklyPayrollRegistry = renderWeeklyPayrollRegistry;
window.renderWeeklyPayrollEmployeeOptions = renderWeeklyPayrollEmployeeOptions;
window.generateSewingRegistry = generateSewingRegistry;
window.printSewingRegistry = printSewingRegistry;
window.togglePiecePartnerFields = togglePiecePartnerFields;
window.switchPieceRateRecordsView = switchPieceRateRecordsView;
window.changePieceRateRecordsPage = changePieceRateRecordsPage;
window.deletePieceRateRecord = deletePieceRateRecord;
window.editPieceRate = editPieceRate;
window.editSewType = editSewType;
window.editSizeRange = editSizeRange;
window.editProductionShareRule = editProductionShareRule;
window.editProductionSplit = editProductionSplit;
window.editPieceIncentive = editPieceIncentive;

// Load data when DOM is ready or if already ready
function initializePayroll() {
  initializePayrollModule();
  loadWeeklyPayrollFilterOptions();
  loadPayrollDashboard();
  loadSalaryCalculations();
  const sewingPeriod = document.getElementById('sewing-registry-period');
  if (sewingPeriod && !sewingPeriod.value) sewingPeriod.value = new Date().toISOString().slice(0, 7);

  // Add filter event listeners
  document.getElementById('salary-calc-filter-date')?.addEventListener('change', loadSalaryCalculations);
  document.getElementById('salary-calc-filter-status')?.addEventListener('change', loadSalaryCalculations);
}

// Check if DOM is already loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePayroll);
} else {
  // DOM already loaded, initialize immediately
  initializePayroll();
}
