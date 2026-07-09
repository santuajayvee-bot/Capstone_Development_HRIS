/* ============================================================
   PAYROLL.JS — Payroll page logic with real database data
   ============================================================ */

let currentPayrollData = [];
let currentMonthYear = null;
let payrollRecordsPage = 1;
const PAYROLL_RECORDS_PAGE_SIZE = 10;
let currentSalaryCalculationRecords = [];
let salaryCalculationPage = 1;
let payrollRecordWorkflowFilter = 'all';
let payrollRecordSearchQuery = '';
let payrollRecordDepartmentFilter = 'all';
let payrollRecordWageFilter = 'all';
const SALARY_CALCULATION_PAGE_SIZE = 10;
const PAYROLL_STEP_UP_STATUSES = new Set(['Approved', 'Released', 'Locked', 'Paid']);
let offboardingClearanceRows = [];
let finalPayApprovalRows = [];
let weeklyPayrollEmployees = [];
let weeklyPayrollRegistryPayload = null;
let weeklyPayrollRegistryPage = 1;
let payrollAttendanceConfigRows = [];
let payrollAttendanceConfigOptions = { departments: [], employees: [], pay_types: [], employment_types: [] };
const WEEKLY_PAYROLL_REGISTRY_PAGE_SIZE = 10;
let payrollAuditRows = [];
let payrollAuditPage = 1;
const PAYROLL_AUDIT_PAGE_SIZE = 10;
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
let pieceRateRecordsView = 'sizes';
const PIECE_RATE_RECORDS_PAGE_SIZE = 10;
const pieceRateRecordsPages = {};

function money(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pieceRateMoney(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

function payrollExactHourLabel(hours, minutes = null) {
  const numericMinutes = Number(minutes);
  const totalMinutes = Number.isFinite(numericMinutes) && numericMinutes >= 0
    ? Math.round(numericMinutes)
    : Math.max(0, Math.round(Number(hours || 0) * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const remainderMinutes = totalMinutes % 60;
  const decimalHours = totalMinutes / 60;
  const minuteLabel = `${wholeHours}h${remainderMinutes ? ` ${remainderMinutes}m` : ''}`;
  return `${minuteLabel} (${decimalHours.toLocaleString('en-US', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  })} hrs)`;
}

function payrollSnapshot(record) {
  try {
    return record?.validation_snapshot
      ? (typeof record.validation_snapshot === 'string' ? JSON.parse(record.validation_snapshot) : record.validation_snapshot)
      : {};
  } catch (_) {
    return {};
  }
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

function payrollOffboardingCaseId(row) {
  const id = Number(row?.offboarding_case_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function payrollActionDotsIcon() {
  if (typeof window.renderActionDotsIcon === 'function') return window.renderActionDotsIcon();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="action-dots-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0"/>
  </svg>`;
}

function closePayrollActionMenus() {
  document.querySelectorAll('.payroll-action-dropdown.open').forEach(menu => {
    menu.classList.remove('open');
    menu.style.top = '';
    menu.style.left = '';
    menu.style.right = '';
  });
  document.querySelectorAll('.payroll-action-trigger.active').forEach(button => {
    button.classList.remove('active');
  });
}

function togglePayrollActionMenu(event, recordId) {
  event.stopPropagation();
  const menu = document.getElementById(`payroll-action-menu-${recordId}`);
  const trigger = event.currentTarget;
  const isOpen = menu?.classList.contains('open');
  closePayrollActionMenus();
  if (!menu || isOpen) return;

  const rect = trigger.getBoundingClientRect();
  menu.classList.add('open');
  const menuHeight = menu.offsetHeight;
  const menuWidth = menu.offsetWidth;
  const preferredTop = rect.bottom + 8;
  const top = preferredTop + menuHeight > window.innerHeight
    ? Math.max(12, rect.top - menuHeight - 8)
    : preferredTop;
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(12, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12))}px`;
  menu.style.right = 'auto';
  trigger.classList.add('active');
}

document.addEventListener('click', closePayrollActionMenus);

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
          const blockchainRecordAction = ['approved', 'finalized', 'released'].includes(normalizedStatusKey) && canApproveSalaryCalculations()
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
            <td><button class="btn btn-outline btn-sm" onclick="generatePayslipPreview(${Number(r.id)})">View</button></td>
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
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function addDaysToIsoDate(value, days) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function payrollDateSpanDays(startValue, endValue) {
  const startMatch = String(startValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const endMatch = String(endValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!startMatch || !endMatch) return 0;
  const utcValue = match => Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.floor((utcValue(endMatch) - utcValue(startMatch)) / 86400000) + 1;
}

function syncWeeklyPayrollEndDate() {
  const startInput = document.getElementById('weekly-payroll-start');
  const endInput = document.getElementById('weekly-payroll-end');
  const frequency = document.getElementById('weekly-payroll-frequency')?.value || 'Weekly';
  if (!startInput?.value || !endInput || frequency !== 'Weekly') return;
  const today = window.LGSVDatePicker?.todayValue?.() || dateInputValue(new Date());
  const synchronizedEnd = addDaysToIsoDate(startInput.value, 5) || startInput.value;
  endInput.value = synchronizedEnd > today ? today : synchronizedEnd;
}

function payrollWeekKeyFromDates(startDate, endDate) {
  const match = String(startDate || endDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return `${String(startDate || endDate).slice(0, 7)}-W1`;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const firstDayOfMonth = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const week = Math.min(5, Math.max(1, Math.ceil((day + firstDayOfMonth) / 7)));
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
  end.setDate(start.getDate() + 5);
  const today = window.LGSVDatePicker?.todayValue?.() || dateInputValue(new Date());
  startInput.value = dateInputValue(start);
  const defaultEnd = dateInputValue(end);
  endInput.value = defaultEnd > today ? today : defaultEnd;
}

function validateWeeklyPayrollDates({ adjustEnd = false } = {}) {
  const startInput = document.getElementById('weekly-payroll-start');
  const endInput = document.getElementById('weekly-payroll-end');
  const submitButton = document.querySelector('#weekly-payroll-form button[type="submit"]');
  if (!startInput || !endInput) return true;
  const frequency = document.getElementById('weekly-payroll-frequency')?.value || 'Weekly';
  const today = window.LGSVDatePicker?.todayValue?.() || dateInputValue(new Date());
  startInput.removeAttribute('min');
  startInput.removeAttribute('max');
  endInput.removeAttribute('min');
  endInput.removeAttribute('max');
  startInput.setCustomValidity('');
  endInput.setCustomValidity('');
  if (adjustEnd && startInput.value && (!endInput.value || endInput.value < startInput.value)) {
    const adjustedEnd = addDaysToIsoDate(startInput.value, frequency === 'Weekly' ? 5 : 6) || startInput.value;
    endInput.value = adjustedEnd > today ? today : adjustedEnd;
    if (window.LGSVDatePicker?.refresh) window.LGSVDatePicker.refresh(document.getElementById('weekly-payroll-form'));
  }
  const hasStart = Boolean(startInput.value);
  const hasEnd = Boolean(endInput.value);
  const startFuture = Boolean(startInput.value && startInput.value > today);
  const endFuture = Boolean(endInput.value && endInput.value > today);
  const dateOrderValid = Boolean(startInput.value && endInput.value && startInput.value <= endInput.value);
  const weeklyRangeValid = frequency !== 'Weekly'
    || (dateOrderValid && payrollDateSpanDays(startInput.value, endInput.value) <= 7);
  const futureDateValid = !startFuture && !endFuture;
  const valid = hasStart && hasEnd && dateOrderValid && weeklyRangeValid && futureDateValid;
  if (submitButton) submitButton.disabled = !valid;
  if (!hasStart) {
    setWeeklyPayrollStatus('Select a payroll start date.');
  } else if (!hasEnd) {
    setWeeklyPayrollStatus('Select a payroll end date.');
  } else if (startFuture) {
    setWeeklyPayrollStatus('Payroll start date cannot be in the future.');
  } else if (endFuture) {
    setWeeklyPayrollStatus('Payroll end date cannot be in the future.');
  } else if (!dateOrderValid && startInput.value && endInput.value) {
    setWeeklyPayrollStatus('Period start must be before or equal to period end.');
  } else if (!weeklyRangeValid) {
    setWeeklyPayrollStatus('Weekly payroll range must not exceed 7 calendar days.');
  } else {
    const status = document.getElementById('weekly-payroll-result');
    if ([
      'Payroll start date cannot be in the future.',
      'Payroll end date cannot be in the future.',
      'Period start must be before or equal to period end.',
      'Weekly payroll range must not exceed 7 calendar days.',
      'Select a payroll start date.',
      'Select a payroll end date.'
    ].includes(status?.textContent || '')) {
      status.textContent = '';
    }
  }
  return valid;
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
  const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
  weeklyPayrollRegistryPayload = { ...payload, rows, skipped };
  if (!rows.length) {
    const totalPages = Math.max(1, Math.ceil(skipped.length / WEEKLY_PAYROLL_REGISTRY_PAGE_SIZE));
    weeklyPayrollRegistryPage = Math.min(Math.max(weeklyPayrollRegistryPage, 1), totalPages);
    const startIndex = (weeklyPayrollRegistryPage - 1) * WEEKLY_PAYROLL_REGISTRY_PAGE_SIZE;
    const endIndex = Math.min(startIndex + WEEKLY_PAYROLL_REGISTRY_PAGE_SIZE, skipped.length);
    const visibleSkipped = skipped.slice(startIndex, endIndex);
    target.innerHTML = skipped.length
      ? `
        <div class="table-wrap">
          <div class="payroll-card-header-row">
            <div>
              <h3>No Payroll Rows Generated</h3>
              <p>${Number(payload.employeesProcessed || 0)} employee(s) processed, ${Number(payload.skippedCount || skipped.length)} skipped. Review the reasons below.</p>
            </div>
          </div>
          <table class="payroll-erp-table weekly-payroll-table" data-no-pagination="1">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Pay Type</th>
                <th>Reason</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${visibleSkipped.map(row => `
                <tr>
                  <td>${payrollEscape(row.employee_name || row.employee_code || `Employee #${row.employee_id || '-'}`)}<br><span class="muted-small">${payrollEscape(row.employee_code || '')}</span></td>
                  <td>${payrollEscape(row.pay_type || '-')}</td>
                  <td>
                    ${payrollEscape(row.reason || 'Skipped by payroll validation.')}
                    ${row.resolution ? `<span class="payroll-skip-resolution">${payrollEscape(row.resolution)}</span>` : ''}
                  </td>
                  <td>${row.existing_salary_calculation_id
                    ? `<button class="btn btn-outline btn-sm" type="button" onclick="reviewPayrollCalculation(${Number(row.existing_salary_calculation_id)})">Review</button>`
                    : '-'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${renderWeeklyPayrollRegistryPagination(skipped.length, startIndex, endIndex, totalPages)}
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
  const totalPages = Math.max(1, Math.ceil(rows.length / WEEKLY_PAYROLL_REGISTRY_PAGE_SIZE));
  weeklyPayrollRegistryPage = Math.min(Math.max(weeklyPayrollRegistryPage, 1), totalPages);
  const startIndex = (weeklyPayrollRegistryPage - 1) * WEEKLY_PAYROLL_REGISTRY_PAGE_SIZE;
  const endIndex = Math.min(startIndex + WEEKLY_PAYROLL_REGISTRY_PAGE_SIZE, rows.length);
  const visibleRows = rows.slice(startIndex, endIndex);
  target.innerHTML = `
    <div class="table-wrap">
      <table class="payroll-erp-table weekly-payroll-table" data-no-pagination="1">
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
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${visibleRows.map(row => `
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
              <td class="text-right">
                <span>${money(row.deductions)}</span>
                <span class="payroll-deduction-detail">Government: ${money(row.statutory_deductions || 0)}</span>
                ${Number(row.attendance_deductions || 0) > 0 ? `<span class="payroll-deduction-detail">Late / UT: ${money(row.attendance_deductions)}</span>` : ''}
              </td>
              <td class="text-right payroll-net">${money(row.net_pay)}</td>
              <td>${payrollBadge(row.payroll_status || 'Pending')}</td>
              <td>${payrollEscape(row.processed_by || '-')}<br><span class="muted-small">${row.date_processed ? new Date(row.date_processed).toLocaleString() : ''}</span></td>
              <td>${row.salary_calculation_id ? `<button class="btn btn-outline btn-sm" type="button" onclick="reviewPayrollCalculation(${Number(row.salary_calculation_id)})">Review</button>` : '-'}</td>
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
            <th colspan="3"></th>
          </tr>
        </tfoot>
      </table>
    </div>
    ${renderWeeklyPayrollRegistryPagination(rows.length, startIndex, endIndex, totalPages)}
  `;
}

function renderWeeklyPayrollRegistryPagination(totalRows, startIndex, endIndex, totalPages) {
  if (!totalRows) return '';
  return `
    <div class="table-pagination weekly-payroll-pagination">
      <span>Showing ${startIndex + 1}-${endIndex} of ${totalRows}</span>
      <div class="table-pagination-actions">
        <button class="btn btn-outline btn-sm" type="button" onclick="changeWeeklyPayrollRegistryPage(-1)" ${weeklyPayrollRegistryPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${weeklyPayrollRegistryPage} of ${totalPages}</span>
        <button class="btn btn-outline btn-sm" type="button" onclick="changeWeeklyPayrollRegistryPage(1)" ${weeklyPayrollRegistryPage >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  `;
}

function changeWeeklyPayrollRegistryPage(direction) {
  if (!weeklyPayrollRegistryPayload) return;
  const rows = weeklyPayrollRegistryPayload.rows || [];
  const skipped = weeklyPayrollRegistryPayload.skipped || [];
  const activeRows = rows.length ? rows : skipped;
  const totalPages = Math.max(1, Math.ceil(activeRows.length / WEEKLY_PAYROLL_REGISTRY_PAGE_SIZE));
  weeklyPayrollRegistryPage = Math.min(
    Math.max(weeklyPayrollRegistryPage + Number(direction || 0), 1),
    totalPages
  );
  renderWeeklyPayrollRegistry(weeklyPayrollRegistryPayload);
}

async function loadWeeklyPayrollRegistry() {
  if (!validateWeeklyPayrollDates()) return;
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
    weeklyPayrollRegistryPage = 1;
    const response = await apiFetch(`/api/payroll/registry?${params.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to load weekly payroll registry.');
    renderWeeklyPayrollRegistry(data);
  } catch (error) {
    const target = document.getElementById('weekly-payroll-registry');
    if (target) target.innerHTML = `<div class="payroll-empty-state text-danger">${payrollEscape(error.message)}</div>`;
  }
}

function weeklyPayrollFormPayload(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.employee_id) delete data.employee_id;
  data.weekly = true;
  data.month_year = payrollWeekKeyFromDates(data.start_date, data.end_date);
  return data;
}

function closePayrollGeneratePreviewModal() {
  document.getElementById('payroll-generate-preview-modal')?.remove();
}

function setWeeklyPayrollStatus(message, loading = false) {
  const status = document.getElementById('weekly-payroll-result');
  if (!status) return;
  const text = payrollEscape(message || '');
  status.innerHTML = loading
    ? `<span class="payroll-loader-row"><span class="payroll-generate-loader small" aria-hidden="true"></span><span>${text}</span></span>`
    : text;
}

function setPayrollGenerateModalLoading(loading, message = 'Generating payroll records...') {
  const loader = document.getElementById('payroll-generate-loading');
  const loaderText = document.getElementById('payroll-generate-loading-text');
  const confirmButton = document.getElementById('payroll-preview-confirm-btn');
  if (loader) loader.hidden = !loading;
  if (loaderText) loaderText.textContent = message;
  if (confirmButton) {
    confirmButton.disabled = Boolean(loading);
    confirmButton.innerHTML = loading
      ? '<span class="payroll-loader-row"><span class="payroll-generate-loader small" aria-hidden="true"></span><span>Generating...</span></span>'
      : 'Confirm Generate Payroll';
  }
}

function showPayrollGeneratePreviewModal(preview, payload) {
  closePayrollGeneratePreviewModal();
  const rows = preview.rows || [];
  const skipped = preview.skipped || [];
  const modal = document.createElement('div');
  modal.id = 'payroll-generate-preview-modal';
  modal.className = 'modal-overlay';
  modal.style.display = 'flex';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `
    <div class="modal-content payroll-preview-modal" style="width:min(1040px,94vw);max-height:86vh;overflow:auto;padding:0;border-radius:8px;">
      <div class="modal-header" style="padding:18px 22px;border-bottom:1px solid var(--border);">
        <div>
          <h2 style="margin:0;font-size:18px;font-weight:500;">Preview Payroll Generation</h2>
          <p class="muted-small" style="margin:4px 0 0;">Review this batch before creating payroll records.</p>
        </div>
        <button class="modal-close btn btn-outline" type="button" onclick="closePayrollGeneratePreviewModal()">×</button>
      </div>
      <div style="padding:18px 22px;">
        <div class="payroll-preview-summary">
          <div><span>Total Employees</span><strong>${Number(preview.totalEmployees || 0)}</strong></div>
          <div><span>Will Generate</span><strong>${Number(preview.employeesProcessable || rows.length)}</strong></div>
          <div><span>Skipped</span><strong>${Number(preview.skippedCount || skipped.length)}</strong></div>
          <div><span>Net Payroll</span><strong>${money(preview.totals?.net_pay || 0)}</strong></div>
        </div>
        <div class="payroll-preview-warning">
          Confirming will create payroll records, apply configured deductions, and mark included source records as consumed for this payroll period.
        </div>
        <div class="payroll-generate-loading" id="payroll-generate-loading" hidden>
          <div class="payroll-generate-loader" aria-hidden="true"></div>
          <div>
            <div id="payroll-generate-loading-text">Generating payroll records...</div>
            <div class="muted-small">Please keep this window open.</div>
          </div>
        </div>
        <div class="table-wrap" style="margin-top:14px;">
          <table class="payroll-erp-table" data-no-pagination="1">
            <thead>
              <tr><th>Employee</th><th>Type</th><th class="text-right">Gross</th><th class="text-right">Government</th><th class="text-right">Late / UT</th><th class="text-right">Net</th></tr>
            </thead>
            <tbody>
              ${rows.slice(0, 8).map(row => `
                <tr>
                  <td>${payrollEscape(row.employee_name || '-')}<br><span class="muted-small">${payrollEscape(row.employee_code || '')}</span></td>
                  <td>${payrollEscape(row.pay_type || '-')}</td>
                  <td class="text-right">${money(row.gross_pay)}</td>
                  <td class="text-right">${money(row.statutory_deductions || 0)}</td>
                  <td class="text-right">${money(row.attendance_deductions || 0)}</td>
                  <td class="text-right">${money(row.net_pay)}</td>
                </tr>
              `).join('') || '<tr><td colspan="6" class="text-center">No processable employees.</td></tr>'}
            </tbody>
          </table>
        </div>
        ${rows.length > 8 ? `<p class="muted-small" style="margin-top:10px;">Showing first 8 of ${rows.length} processable employee(s). The full preview is shown in the register below.</p>` : ''}
        ${skipped.length ? `
          <details class="payroll-preview-skipped" ${rows.length ? '' : 'open'}>
            <summary>${skipped.length} skipped employee(s)</summary>
            <ul>
              ${skipped.slice(0, 20).map(row => `<li><strong>${payrollEscape(row.employee_name || row.employee_code || '-')}</strong>: ${payrollEscape(row.reason || 'Skipped')}</li>`).join('')}
            </ul>
          </details>
        ` : ''}
      </div>
      <div class="modal-footer" style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;">
        <button class="btn btn-outline" type="button" onclick="closePayrollGeneratePreviewModal()">Cancel</button>
        <button class="btn btn-primary" id="payroll-preview-confirm-btn" type="button" ${rows.length ? '' : 'disabled'} onclick='confirmWeeklyPayrollGeneration(${JSON.stringify(payload).replace(/'/g, '&#39;')})'>${rows.length ? 'Confirm Generate Payroll' : 'No Records to Generate'}</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal) closePayrollGeneratePreviewModal();
  });
  document.body.appendChild(modal);
  if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(modal);
}

async function performWeeklyPayrollGeneration(data) {
  const status = document.getElementById('weekly-payroll-result');
  const form = document.getElementById('weekly-payroll-form');
  const submitButton = form?.querySelector('button[type="submit"]');
  const confirmButton = document.getElementById('payroll-preview-confirm-btn');
  if (submitButton?.disabled) return;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.innerHTML = '<span class="payroll-loader-row"><span class="payroll-generate-loader small" aria-hidden="true"></span><span>Generating...</span></span>';
  }
  if (confirmButton) {
    setPayrollGenerateModalLoading(true, data.department_id
      ? 'Processing employees in the selected department...'
      : 'Processing all active employees. This may take longer...');
  }
  setWeeklyPayrollStatus(data.department_id
    ? 'Processing employees in the selected department...'
    : 'Processing all active employees. This may take longer...', true);
  try {
    const response = await apiFetch('/api/payroll/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || 'Failed to generate weekly payroll.');
    setWeeklyPayrollStatus(result.message || 'Weekly payroll generated.');
    closePayrollGeneratePreviewModal();
    weeklyPayrollRegistryPage = 1;
    renderWeeklyPayrollRegistry(result);
    await loadPayrollDashboard(document.getElementById('payroll-filter-month')?.value || null);
    await loadSalaryCalculations();
  } catch (error) {
    setWeeklyPayrollStatus(error.message);
    if (typeof showAlert === 'function') await showAlert(error.message, 'Payroll Error', 'error');
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Preview Payroll';
    }
    if (confirmButton) {
      confirmButton.disabled = false;
      setPayrollGenerateModalLoading(false);
    }
  }
}

async function confirmWeeklyPayrollGeneration(data) {
  return performWeeklyPayrollGeneration(data);
}

async function generateWeeklyPayroll(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('weekly-payroll-result');
  const submitButton = form.querySelector('button[type="submit"]');
  if (!validateWeeklyPayrollDates({ adjustEnd: true })) return;
  const data = weeklyPayrollFormPayload(form);
  if (submitButton?.disabled) return;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.innerHTML = '<span class="payroll-loader-row"><span class="payroll-generate-loader small" aria-hidden="true"></span><span>Preparing Preview...</span></span>';
  }
  setWeeklyPayrollStatus('Checking source records and calculating a preview...', true);
  try {
    const response = await apiFetch('/api/payroll/generate/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const preview = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(preview.error || preview.message || 'Failed to preview payroll.');
    weeklyPayrollRegistryPage = 1;
    renderWeeklyPayrollRegistry(preview);
    setWeeklyPayrollStatus(preview.message || 'Preview ready. Confirm to generate payroll records.');
    showPayrollGeneratePreviewModal(preview, data);
  } catch (error) {
    setWeeklyPayrollStatus(error.message);
    if (typeof showAlert === 'function') await showAlert(error.message, 'Payroll Preview Error', 'error');
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Preview Payroll';
    }
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
function payrollRecordHasAppliedDeductions(record = {}) {
  const status = String(record.status || '').trim().toLowerCase();
  if (Number(record.payroll_run_id || 0) > 0) return true;
  if (['approved', 'finalized', 'released', 'locked', 'paid'].includes(status)) return true;
  if (Number(record.total_deductions || 0) > 0) return true;
  if (['sss_deduction', 'pagibig_deduction', 'philhealth_deduction', 'employee_deduction_total']
    .some(key => Number(record[key] || 0) > 0)) return true;

  let snapshot = {};
  try {
    snapshot = typeof record.validation_snapshot === 'string'
      ? JSON.parse(record.validation_snapshot || '{}')
      : (record.validation_snapshot || {});
  } catch (_) {
    snapshot = {};
  }
  return /applied|generated|processed/i.test(String(snapshot.deduction_status || ''));
}

function payrollRecordIdLabel(record = {}) {
  return `CALC-${String(record.id || '').padStart(5, '0')}`;
}

function payrollRecordSearchText(record = {}) {
  return [
    payrollRecordIdLabel(record),
    record.employee_name,
    record.employee_code,
    record.payroll_period,
    record.period_start,
    record.period_end,
    record.department,
    record.wage_type,
    record.status,
    record.source_workflow_status,
    record.agency_name,
  ].map(value => String(value || '').toLowerCase()).join(' ');
}

function payrollRecordFilterKey(value) {
  return String(value || '').trim().toLowerCase();
}

function payrollRecordMatchesFilters(record = {}) {
  if (payrollRecordWorkflowFilter !== 'all' && payrollRecordWorkflowGroup(record) !== payrollRecordWorkflowFilter) return false;
  if (payrollRecordDepartmentFilter !== 'all' && payrollRecordFilterKey(record.department || '-') !== payrollRecordDepartmentFilter) return false;
  if (payrollRecordWageFilter !== 'all' && payrollRecordFilterKey(record.wage_type || '-') !== payrollRecordWageFilter) return false;
  const query = payrollRecordSearchQuery.trim().toLowerCase();
  return !query || payrollRecordSearchText(record).includes(query);
}

function filteredSalaryCalculationRecords(records = currentSalaryCalculationRecords) {
  return records.filter(record => payrollRecordMatchesFilters(record));
}

function uniquePayrollRecordOptions(records, key) {
  const seen = new Map();
  records.forEach(record => {
    const label = String(record?.[key] || '-').trim() || '-';
    const value = payrollRecordFilterKey(label);
    if (!seen.has(value)) seen.set(value, label);
  });
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

function updatePayrollRecordSelectOptions(selectId, records, key, allLabel, selectedValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const options = uniquePayrollRecordOptions(records, key);
  select.innerHTML = [
    `<option value="all">${payrollEscape(allLabel)}</option>`,
    ...options.map(([value, label]) => `<option value="${payrollEscape(value)}">${payrollEscape(label)}</option>`)
  ].join('');
  select.value = options.some(([value]) => value === selectedValue) ? selectedValue : 'all';
}

function syncPayrollRecordFilterControls(records = currentSalaryCalculationRecords) {
  const searchInput = document.getElementById('payroll-record-search');
  if (searchInput && searchInput.value !== payrollRecordSearchQuery) searchInput.value = payrollRecordSearchQuery;
  updatePayrollRecordSelectOptions('payroll-record-department-filter', records, 'department', 'All Departments', payrollRecordDepartmentFilter);
  updatePayrollRecordSelectOptions('payroll-record-wage-filter', records, 'wage_type', 'All Wage Types', payrollRecordWageFilter);
  payrollRecordDepartmentFilter = document.getElementById('payroll-record-department-filter')?.value || 'all';
  payrollRecordWageFilter = document.getElementById('payroll-record-wage-filter')?.value || 'all';
}

function renderSalaryCalculations(records) {
  const grid = document.getElementById('salary-calculations-grid');
  if (!grid) return;

  syncPayrollRecordFilterControls(records);
  const classifiedRecords = records.map(record => ({
    record,
    workflow: payrollRecordWorkflowGroup(record)
  }));
  const workflowCounts = classifiedRecords.reduce((counts, item) => {
    counts[item.workflow] = (counts[item.workflow] || 0) + 1;
    return counts;
  }, { source: 0, review: 0, finalized: 0 });
  updatePayrollRecordWorkflowOptions(records.length, workflowCounts);
  const filteredRecords = filteredSalaryCalculationRecords(records);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / SALARY_CALCULATION_PAGE_SIZE));
  salaryCalculationPage = Math.min(Math.max(salaryCalculationPage, 1), totalPages);
  const startIndex = (salaryCalculationPage - 1) * SALARY_CALCULATION_PAGE_SIZE;
  const pageRecords = filteredRecords.slice(startIndex, startIndex + SALARY_CALCULATION_PAGE_SIZE);

  if (filteredRecords.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px 20px; text-align: center;">
        <div style="font-size: 14px; color: var(--muted);">
          No payroll records match the selected filters.
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
          const sourceDateLabel = r.source_date_from
            ? r.source_date_from === r.source_date_to
              ? new Date(`${r.source_date_from}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
              : `${new Date(`${r.source_date_from}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date(`${r.source_date_to}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
            : '';
          const isGeneratedPayroll = payrollRecordHasAppliedDeductions(r);
          const calcDate = isGeneratedPayroll
            ? r.payroll_period
            : sourceDateLabel || new Date(r.calculation_date).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric' 
          });
          
          // Build calculation details string
          let calcDetails = '';
          if (r.wage_type === 'Hourly' && r.hours_worked > 0) {
            const snapshot = payrollSnapshot(r);
            calcDetails = payrollExactHourLabel(r.hours_worked, Number(snapshot.net_credited_minutes || 0) || null);
          } else if (r.wage_type === 'Daily' && r.days_worked > 0) {
            calcDetails = `${r.days_worked} days`;
          } else if (r.wage_type === 'Per-Piece' && (Number(r.quantity) > 0 || Number(r.source_output_quantity) > 0)) {
            calcDetails = `${Number(r.quantity || r.source_output_quantity).toLocaleString('en-US')} pieces`;
          } else if (r.wage_type === 'Per-Trip' && (Number(r.quantity) > 0 || Number(r.source_output_quantity) > 0)) {
            calcDetails = `${Number(r.quantity || r.source_output_quantity).toLocaleString('en-US')} trips`;
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
          const isFinalizedRecord = ['approved', 'finalized', 'released', 'locked', 'paid'].includes(normalizedStatusKey);
          const hasPayrollAmounts = isGeneratedPayroll || isFinalizedRecord;
          const displayDeductions = hasPayrollAmounts ? Number(r.total_deductions || 0) : 0;
          const displayNetPay = hasPayrollAmounts ? Number(r.net_pay || 0) : Number(r.gross_pay || 0);
          const displayStatus = hasPayrollAmounts
            ? normalizedStatus
            : r.source_workflow_status
              ? r.source_workflow_status
            : normalizedStatusKey === 'for approval'
              ? 'Source Ready'
              : normalizedStatusKey === 'for review'
                ? 'Source Review'
                : normalizedStatus;
          const canReviewRecalculate = isGeneratedPayroll && ['draft', 'calculated', 'for review'].includes(normalizedStatusKey);
          const draftAction = !isGeneratedPayroll && normalizedStatusKey === 'draft'
            ? `<button class="payroll-menu-item" type="button" onclick="continueSalaryDraft(${recordJson})">Continue Draft</button>`
            : '';
          const recalcAction = canReviewRecalculate
            ? `<button class="payroll-menu-item" type="button" onclick="recalculateSalaryCalculation(${Number(r.id)})">Recalculate</button>`
            : '';
          const submitAction = canReviewRecalculate && canSubmitSalaryCalculations() && !canApproveSalaryCalculations()
            ? `<button class="payroll-menu-item primary" type="button" onclick="submitSalaryCalculationForApproval(${Number(r.id)})">Submit Payroll to Manager</button>`
            : '';
          const approvalAction = isGeneratedPayroll && ['for review', 'submitted', 'for approval'].includes(normalizedStatusKey) && canApproveSalaryCalculations()
            ? `<button class="payroll-menu-item primary" type="button" onclick="approveSalaryCalculation(${Number(r.id)})">Approve & Finalize</button>`
            : '';
          const blockchainRecordAction = ['approved', 'finalized', 'released'].includes(normalizedStatusKey) && canApproveSalaryCalculations()
            ? `<button class="payroll-menu-item primary" type="button" onclick="recordApprovedPayrollOnBlockchain(${Number(r.id)})">Load to Blockchain</button>`
            : '';
          const releaseAction = hasPayrollAmounts && normalizedStatusKey === 'approved' && canApproveSalaryCalculations()
            ? `<button class="payroll-menu-item" type="button" onclick="releaseSalaryCalculation(${Number(r.id)})">Release Payslip</button>`
            : '';
          const lockAction = hasPayrollAmounts && ['approved', 'released'].includes(normalizedStatusKey) && canApproveSalaryCalculations()
            ? `<button class="payroll-menu-item" type="button" onclick="lockSalaryCalculation(${Number(r.id)})">Lock Record</button>`
            : '';
          const actionItems = [
            draftAction,
            recalcAction,
            submitAction,
            approvalAction,
            releaseAction,
            lockAction,
            blockchainRecordAction,
            `<button class="payroll-menu-item" type="button" onclick="showCalculationBreakdown(${recordJson})">View Details</button>`
          ].filter(Boolean).join('');
          const generationNote = hasPayrollAmounts
            ? ''
            : '<span class="muted-small">Generate payroll to apply deductions.</span>';
          return `
            <tr>
              <td>${payrollEscape(payrollRecordIdLabel(r))}</td>
              <td>${payrollEscape(r.employee_name || r.employee_code || '-')}<br><span class="muted-small">${payrollEscape(r.employee_code || '')}</span></td>
              <td>${payrollEscape(calcDate)}</td>
              <td>${payrollEscape(r.department || '-')}</td>
              <td>${payrollEscape(r.wage_type || '-')}</td>
              <td>${payrollEscape(calcDetails)}</td>
              <td class="text-right">${money(hasPayrollAmounts ? r.gross_pay : (Number(r.gross_pay) || Number(r.source_output_amount)))}</td>
              <td class="text-right">${hasPayrollAmounts ? money(displayDeductions) : 'Deferred'}</td>
              <td class="text-right payroll-net">${money(hasPayrollAmounts ? displayNetPay : (displayNetPay || Number(r.source_output_amount)))}</td>
              <td>${payrollBadge(displayStatus)}${generationNote}</td>
              <td class="payroll-record-action-cell" onclick="event.stopPropagation();">
                <div class="payroll-action-menu">
                  <button class="payroll-action-trigger action-dots-button" type="button" title="Payroll actions" aria-label="Payroll actions" onclick="togglePayrollActionMenu(event, ${Number(r.id)})">${payrollActionDotsIcon()}</button>
                  <div class="payroll-action-dropdown" id="payroll-action-menu-${Number(r.id)}">
                    ${actionItems}
                  </div>
                </div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${renderSalaryCalculationPagination(filteredRecords.length, startIndex, totalPages)}
  `;

  grid.innerHTML = table;
  bindSalaryCalculationPagination(grid);
  if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(grid);
}

function payrollRecordWorkflowGroup(record = {}) {
  const status = String(record.status || 'Draft').trim().toLowerCase();
  if (['approved', 'finalized', 'released', 'locked', 'paid'].includes(status)) return 'finalized';
  if (payrollRecordHasAppliedDeductions(record)) return 'review';
  return 'source';
}

function updatePayrollRecordWorkflowOptions(total, counts) {
  const select = document.getElementById('payroll-record-workflow-filter');
  if (!select) return;
  const labels = {
    all: `All Records (${total})`,
    source: `Source Ready (${counts.source || 0})`,
    review: `For Review / Approval (${counts.review || 0})`,
    finalized: `Finalized / Released (${counts.finalized || 0})`
  };
  [...select.options].forEach(option => {
    option.textContent = labels[option.value] || option.textContent;
  });
  select.value = payrollRecordWorkflowFilter;
}

function setPayrollRecordWorkflowFilter(value) {
  payrollRecordWorkflowFilter = ['source', 'review', 'finalized'].includes(value) ? value : 'all';
  salaryCalculationPage = 1;
  closePayrollActionMenus();
  renderSalaryCalculations(currentSalaryCalculationRecords);
}

function setPayrollRecordSearch(value) {
  payrollRecordSearchQuery = String(value || '');
  salaryCalculationPage = 1;
  closePayrollActionMenus();
  renderSalaryCalculations(currentSalaryCalculationRecords);
}

function setPayrollRecordDepartmentFilter(value) {
  payrollRecordDepartmentFilter = value && value !== 'all' ? payrollRecordFilterKey(value) : 'all';
  salaryCalculationPage = 1;
  closePayrollActionMenus();
  renderSalaryCalculations(currentSalaryCalculationRecords);
}

function setPayrollRecordWageFilter(value) {
  payrollRecordWageFilter = value && value !== 'all' ? payrollRecordFilterKey(value) : 'all';
  salaryCalculationPage = 1;
  closePayrollActionMenus();
  renderSalaryCalculations(currentSalaryCalculationRecords);
}

function clearPayrollRecordFilters() {
  payrollRecordWorkflowFilter = 'all';
  payrollRecordSearchQuery = '';
  payrollRecordDepartmentFilter = 'all';
  payrollRecordWageFilter = 'all';
  salaryCalculationPage = 1;
  closePayrollActionMenus();
  const statusSelect = document.getElementById('payroll-record-workflow-filter');
  if (statusSelect) statusSelect.value = 'all';
  renderSalaryCalculations(currentSalaryCalculationRecords);
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
  const filteredCount = filteredSalaryCalculationRecords().length;
  const totalPages = Math.max(1, Math.ceil(filteredCount / SALARY_CALCULATION_PAGE_SIZE));
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

function canManagePayslipActions() {
  if (typeof getUser !== 'function') return false;
  return getUser()?.role === 'payroll_manager';
}

function enforcePayslipActionVisibility() {
  if (canManagePayslipActions()) return;
  document.querySelectorAll('[data-payroll-manager-payslip-action]').forEach(element => element.remove());
}

function canSubmitSalaryCalculations() {
  if (typeof getUser !== 'function') return false;
  const user = getUser();
  return user?.role === 'payroll_officer';
}

function findSalaryCalculationRecord(calculationId) {
  return (currentSalaryCalculationRecords || []).find(row => Number(row.id) === Number(calculationId));
}

async function reviewPayrollCalculation(calculationId) {
  const record = findSalaryCalculationRecord(calculationId);
  if (record) {
    showCalculationBreakdown(record);
    return;
  }
  await loadSalaryCalculations();
  const refreshed = findSalaryCalculationRecord(calculationId);
  if (refreshed) showCalculationBreakdown(refreshed);
}

async function requestPayrollStepUpPassword(status) {
  const actionLabel = status === 'Approved'
    ? 'approving and finalizing payroll'
    : status === 'Released'
      ? 'releasing the payslip'
      : status === 'Locked'
        ? 'locking the payroll record'
        : 'updating finalized payroll';

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'payroll-step-up-overlay';
    overlay.innerHTML = `
      <div class="payroll-step-up-dialog" role="dialog" aria-modal="true" aria-labelledby="payroll-step-up-title">
        <h3 id="payroll-step-up-title">Password Confirmation</h3>
        <p>Re-enter your password before ${payrollEscape(actionLabel)}.</p>
        <label>
          <span>Current password</span>
          <input type="password" autocomplete="current-password" id="payroll-step-up-password" />
        </label>
        <div class="payroll-step-up-actions">
          <button type="button" class="btn btn-outline" data-step-up-cancel>Cancel</button>
          <button type="button" class="btn btn-primary" data-step-up-confirm>Continue</button>
        </div>
      </div>
    `;

    const cleanup = (value) => {
      overlay.remove();
      resolve(value);
    };

    overlay.querySelector('[data-step-up-cancel]')?.addEventListener('click', () => cleanup(null));
    overlay.querySelector('[data-step-up-confirm]')?.addEventListener('click', () => {
      const password = overlay.querySelector('#payroll-step-up-password')?.value || '';
      cleanup(password.trim() ? password : null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') cleanup(null);
      if (event.key === 'Enter') {
        event.preventDefault();
        overlay.querySelector('[data-step-up-confirm]')?.click();
      }
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.querySelector('#payroll-step-up-password')?.focus());
  });
}

async function updateSalaryCalculationStatus(calculationId, status, confirmText, options = {}) {
  if (!Number.isInteger(Number(calculationId))) return;
  if (confirmText) {
    const confirmed = typeof showConfirm === 'function'
      ? await showConfirm(confirmText, 'Payroll Status', status === 'Approved' ? 'Approve' : 'Continue', 'Cancel')
      : window.confirm(confirmText);
    if (!confirmed) return;
  }
  const body = { status };
  if (PAYROLL_STEP_UP_STATUSES.has(status)) {
    const currentPassword = await requestPayrollStepUpPassword(status);
    if (!currentPassword) return;
    body.currentPassword = currentPassword;
  }

  try {
    const response = await apiFetch(`/api/payroll/salary-calculations/${calculationId}/status`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Payroll status update failed.');

    document.getElementById('calc-breakdown-modal')?.remove();
    if (!options.suppressSuccessAlert && typeof showAlert === 'function') {
      await showAlert(
        options.successMessage || (data.blockchain_snapshot ? 'Payroll status updated and integrity snapshot refreshed.' : 'Payroll status updated.'),
        'Payroll Updated',
        'success'
      );
    } else if (!options.suppressSuccessAlert) {
      alert(options.successMessage || (data.blockchain_snapshot ? 'Payroll status updated and integrity snapshot refreshed.' : 'Payroll status updated.'));
    }
    await loadSalaryCalculations();
    await loadWeeklyPayrollRegistry();
    return data;
  } catch (error) {
    if (typeof showAlert === 'function') await showAlert(error.message, 'Payroll Error', 'error');
    else alert(error.message);
    return null;
  }
}

async function submitSalaryCalculationForApproval(calculationId) {
  return updateSalaryCalculationStatus(calculationId, 'For Approval', 'Submit this payroll calculation for manager approval?');
}

async function approveSalaryCalculation(calculationId) {
  return updateSalaryCalculationStatus(calculationId, 'Approved', 'Approve and finalize this payroll calculation?');
}

async function releaseSalaryCalculation(calculationId) {
  const data = await updateSalaryCalculationStatus(
    calculationId,
    'Released',
    'Release this payslip to the employee? The finalized payroll hash will be loaded to blockchain after release.',
    { suppressSuccessAlert: true }
  );
  if (!data) return;

  try {
    const blockchain = await finalizePayrollOnBlockchain(calculationId, { confirm: false });
    const message = blockchain?.message || 'Payslip released and payroll hash loaded to blockchain.';
    if (typeof showAlert === 'function') await showAlert(message, 'Payslip Released', 'success');
    else alert(message);
    await loadSalaryCalculations();
    if (typeof loadBlockchainRecords === 'function') await loadBlockchainRecords();
  } catch (error) {
    const message = `Payslip was released, but blockchain recording needs attention: ${error.message}`;
    if (typeof showAlert === 'function') await showAlert(message, 'Blockchain Pending', 'warning');
    else alert(message);
    await loadSalaryCalculations();
  }
}

async function lockSalaryCalculation(calculationId) {
  return updateSalaryCalculationStatus(calculationId, 'Locked', 'Lock this payroll record as read-only?');
}

async function recalculateSalaryCalculation(calculationId) {
  if (!Number.isInteger(Number(calculationId))) return;
  try {
    const response = await apiFetch(`/api/payroll/salary-calculations/${calculationId}/recalculation-preview`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load the recalculation preview.');
    showPayrollRecalculationModal(data);
  } catch (error) {
    if (typeof showAlert === 'function') await showAlert(error.message, 'Payroll Error', 'error');
    else alert(error.message);
  }
}

function showPayrollRecalculationModal(preview) {
  const modalId = 'payroll-recalculation-modal';
  document.getElementById('calc-breakdown-modal')?.remove();
  document.getElementById(modalId)?.remove();
  const entries = Array.isArray(preview.entries) ? preview.entries : [];
  const modal = document.createElement('div');
  modal.id = modalId;
  modal.className = 'erp-modal-backdrop';
  const rows = entries.map((entry, index) => `
    <tr>
      <td data-label="Source">
        <strong>${payrollEscape(entry.description || 'Payroll source')}</strong>
        <small>${payrollEscape(entry.date || '-')}</small>
      </td>
      <td data-label="Unit rate">PHP ${Number(entry.unit_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} / ${payrollEscape(String(entry.unit_label || 'unit').replace(/s$/, ''))}</td>
      <td data-label="Current">${Number(entry.current_value || 0).toLocaleString()} ${payrollEscape(entry.unit_label || '')}</td>
      <td data-label="Corrected">
        <input class="payroll-recalc-value" type="number" min="0" max="1000000" step="0.01"
          data-index="${index}" value="${Number(entry.current_value || 0)}" aria-label="Corrected ${payrollEscape(entry.unit_label || 'value')}" required />
      </td>
      <td data-label="Corrected amount" class="payroll-recalc-row-amount">${money(Number(entry.current_amount || 0))}</td>
    </tr>
  `).join('');
  modal.innerHTML = `
    <div class="erp-modal payroll-recalculation-dialog" role="dialog" aria-modal="true" aria-labelledby="payroll-recalculation-title">
      <div class="erp-modal-head">
        <div>
          <h2 id="payroll-recalculation-title">Payroll Recalculation Preview</h2>
          <p>${payrollEscape(preview.employee_name || '-')} · ${payrollEscape(preview.employee_code || '-')} · ${payrollEscape(preview.wage_type || '-')}</p>
        </div>
        <button class="erp-modal-close" type="button" aria-label="Close" onclick="document.getElementById('${modalId}')?.remove()">×</button>
      </div>
      <form id="payroll-recalculation-form">
        <div class="payroll-recalculation-note">
          Correct only the source quantity or payable hours that were encoded incorrectly. Payroll totals and statutory deductions are recalculated by the system after you apply the correction.
        </div>
        <div class="payroll-recalculation-current">
          <span>Current gross<strong>${money(Number(preview.current?.gross_pay || 0))}</strong></span>
          <span>Current deductions<strong>${money(Number(preview.current?.total_deductions || 0))}</strong></span>
          <span>Current net pay<strong>${money(Number(preview.current?.net_pay || 0))}</strong></span>
          <span>Corrected source earnings<strong id="payroll-recalc-projected">${money(entries.reduce((sum, entry) => sum + Number(entry.current_amount || 0), 0))}</strong></span>
        </div>
        <div class="table-responsive payroll-recalculation-table-wrap">
          <table class="payroll-breakdown-table payroll-recalculation-table">
            <thead><tr><th>Source</th><th>Unit Rate</th><th>Current</th><th>Corrected</th><th>Corrected Amount</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <label class="payroll-recalculation-reason">
          Correction reason
          <textarea id="payroll-recalculation-reason" rows="3" maxlength="500" minlength="8" placeholder="State what was encoded incorrectly and why it must be corrected." required></textarea>
          <small>Required for the payroll audit trail (minimum 8 characters).</small>
        </label>
        <div class="payroll-breakdown-actions">
          <button class="btn btn-outline" type="button" onclick="document.getElementById('${modalId}')?.remove()">Cancel</button>
          <button class="btn btn-primary" type="submit">Apply Recalculation</button>
        </div>
      </form>
    </div>
  `;

  const updateProjection = () => {
    let projected = 0;
    modal.querySelectorAll('.payroll-recalc-value').forEach(input => {
      const index = Number(input.dataset.index);
      const entry = entries[index] || {};
      const correctedValue = Math.max(0, Number(input.value || 0));
      const correctedAmount = correctedValue * Number(entry.unit_amount || 0) + Number(entry.fixed_amount || 0);
      projected += correctedAmount;
      const amountCell = input.closest('tr')?.querySelector('.payroll-recalc-row-amount');
      if (amountCell) amountCell.textContent = money(correctedAmount);
    });
    const total = modal.querySelector('#payroll-recalc-projected');
    if (total) total.textContent = money(projected);
  };
  modal.querySelectorAll('.payroll-recalc-value').forEach(input => input.addEventListener('input', updateProjection));
  modal.addEventListener('click', event => { if (event.target.id === modalId) modal.remove(); });
  modal.querySelector('#payroll-recalculation-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const reason = String(modal.querySelector('#payroll-recalculation-reason')?.value || '').trim();
    if (reason.length < 8) {
      if (typeof showAlert === 'function') await showAlert('Enter a correction reason of at least 8 characters.', 'Reason Required', 'warning');
      return;
    }
    const corrections = [...modal.querySelectorAll('.payroll-recalc-value')].map(input => {
      const entry = entries[Number(input.dataset.index)] || {};
      return { key: entry.key, corrected_value: Number(input.value) };
    });
    const changed = corrections.some((item, index) => Math.abs(Number(item.corrected_value) - Number(entries[index]?.current_value || 0)) > 0.0001);
    if (!changed) {
      if (typeof showAlert === 'function') await showAlert('Change at least one quantity or hour value.', 'No Correction Entered', 'warning');
      return;
    }
    const submitButton = event.submitter;
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Applying...'; }
    try {
      const response = await apiFetch(`/api/payroll/salary-calculations/${Number(preview.id)}/recalculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, corrections })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Payroll recalculation failed.');
      modal.remove();
      const message = `Payroll recalculated. Gross pay: ${money(Number(data.gross_pay || 0))}; Net pay: ${money(Number(data.net_pay || 0))}.`;
      if (typeof showAlert === 'function') await showAlert(message, 'Payroll Updated', 'success');
      else alert(message);
      await loadSalaryCalculations();
      await loadWeeklyPayrollRegistry();
    } catch (error) {
      if (typeof showAlert === 'function') await showAlert(error.message, 'Payroll Error', 'error');
      else alert(error.message);
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = 'Apply Recalculation'; }
    }
  });
  document.body.appendChild(modal);
}

async function finalizePayrollOnBlockchain(calculationId, options = {}) {
  if (!Number.isInteger(Number(calculationId))) return;
  if (options.confirm !== false) {
    const confirmed = typeof showConfirm === 'function'
      ? await showConfirm('Record the finalized payroll hash on Hyperledger Fabric?', 'Blockchain Recording', 'Record', 'Cancel')
      : window.confirm('Record the finalized payroll hash on Hyperledger Fabric?');
    if (!confirmed) return null;
  }

  const response = await apiFetch(`/api/blockchain/payroll/finalize/${calculationId}`, {
    method: 'POST',
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 409 && data.transaction_hash) {
    return {
      ...data,
      message: 'Payroll hash is already recorded on blockchain.',
      already_recorded: true,
    };
  }
  if (!response.ok && response.status !== 202) {
    throw new Error(data.error || 'Blockchain recording failed.');
  }
  return {
    ...data,
    message: response.status === 202
      ? (data.message || 'Payroll was queued for blockchain anchoring.')
      : 'Payroll hash was recorded on Hyperledger Fabric. System Administrator verification is now available.',
  };
}

async function recordApprovedPayrollOnBlockchain(calculationId) {
  try {
    const data = await finalizePayrollOnBlockchain(calculationId);
    if (!data) return;

    document.getElementById('calc-breakdown-modal')?.remove();
    const message = data.message || 'Payroll hash was recorded on Hyperledger Fabric. System Administrator verification is now available.';
    if (typeof showAlert === 'function') await showAlert(message, 'Blockchain Recording', 'success');
    else alert(message);
    await loadSalaryCalculations();
    if (typeof loadBlockchainRecords === 'function') await loadBlockchainRecords();
  } catch (error) {
    if (typeof showAlert === 'function') await showAlert(error.message, 'Blockchain Error', 'error');
    else alert(error.message);
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
                <span style="color: var(--text); font-weight: 600;">${payrollEscape(payrollExactHourLabel(record.hours_worked, Number(snapshot.net_credited_minutes || 0) || null))}</span>
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
              <span style="color: var(--text); font-weight: 600;">₱${(record.wage_type === 'Hourly' && Number(snapshot.net_credited_minutes || 0) > 0
                ? parseFloat(record.base_rate || 0) * (Number(snapshot.net_credited_minutes || 0) / 60)
                : parseFloat(record.base_rate || 0) * (record.hours_worked || record.days_worked || record.quantity || 1)).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
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
  const color = ['Paid', 'Released', 'Approved', 'Payroll Ready'].includes(normalized)
    ? 'green'
    : ['Rejected', 'Cancelled'].includes(normalized)
      ? 'red'
      : ['Submitted', 'For Approval', 'For Validation'].includes(normalized)
        ? 'yellow'
        : 'blue';
  return `<span class="badge badge-${color}">${normalized}</span>`;
}

function payslipMoney(value) {
  const amount = Number(value || 0);
  const text = `PHP ${Math.abs(amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return amount < 0 ? `(${text})` : text;
}

function payslipNumber(value) {
  return Number(value || 0);
}

function payslipAmountToWords(value) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const chunk = number => {
    const parts = [];
    const hundreds = Math.floor(number / 100);
    const rest = number % 100;
    if (hundreds) parts.push(`${ones[hundreds]} Hundred`);
    if (rest >= 20) {
      parts.push([tens[Math.floor(rest / 10)], ones[rest % 10]].filter(Boolean).join(' '));
    } else if (rest >= 10) {
      parts.push(teens[rest - 10]);
    } else if (rest > 0) {
      parts.push(ones[rest]);
    }
    return parts.join(' ');
  };
  const integerWords = number => {
    if (number === 0) return 'Zero';
    const scales = ['', 'Thousand', 'Million', 'Billion'];
    const parts = [];
    let remaining = number;
    let scale = 0;
    while (remaining > 0) {
      const current = remaining % 1000;
      if (current) parts.unshift([chunk(current), scales[scale]].filter(Boolean).join(' '));
      remaining = Math.floor(remaining / 1000);
      scale += 1;
    }
    return parts.join(' ');
  };
  const amount = Math.abs(payslipNumber(value));
  const pesos = Math.floor(amount);
  const centavos = Math.round((amount - pesos) * 100);
  return `${integerWords(pesos)} Pesos${centavos ? ` and ${String(centavos).padStart(2, '0')}/100` : ''}`;
}

function payslipWorkLabel(payslip) {
  if (payslip.wage_type === 'Per-Piece') return 'Output Quantity';
  if (payslip.wage_type === 'Per-Trip') return 'Trip Count';
  if (payslipNumber(payslip.earnings?.hours_worked) > 0) return 'Worked Hours';
  return 'Worked Days';
}

function payslipWorkValue(payslip) {
  if (payslip.wage_type === 'Per-Piece') return payslipNumber(payslip.earnings?.quantity);
  if (payslip.wage_type === 'Per-Trip') return payslipNumber(payslip.earnings?.trip_count);
  if (payslipNumber(payslip.earnings?.hours_worked) > 0) {
    return payrollExactHourLabel(
      payslipNumber(payslip.earnings?.hours_worked),
      payslipNumber(payslip.earnings?.net_credited_minutes)
        || Math.round(payslipNumber(payslip.earnings?.hours_worked) * 60)
    );
  }
  return payslipNumber(payslip.earnings?.days_worked);
}

function payslipMinuteLabel(value) {
  const minutes = Math.round(payslipNumber(value));
  if (!minutes) return '0 min';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return [
    hours ? `${hours} hr${hours === 1 ? '' : 's'}` : '',
    remainder ? `${remainder} min` : ''
  ].filter(Boolean).join(' ');
}

function payslipAttendanceRows(payslip) {
  const earnings = payslip.earnings || {};
  const lateMinutes = payslipNumber(earnings.late_minutes);
  const undertimeMinutes = payslipNumber(earnings.undertime_minutes);
  const lateDeduction = payslipNumber(earnings.late_deduction);
  const undertimeDeduction = payslipNumber(earnings.undertime_deduction);
  const adjustmentNote = String(earnings.attendance_pay_basis || '').trim()
    ? 'Included in adjusted base'
    : '';

  return [
    {
      label: 'Late',
      value: lateMinutes > 0 ? payslipMinuteLabel(lateMinutes) : '',
      amount: lateDeduction > 0 ? payslipMoney(lateDeduction) : '',
      note: lateDeduction > 0 ? adjustmentNote : ''
    },
    {
      label: 'Undertime',
      value: undertimeMinutes > 0 ? payslipMinuteLabel(undertimeMinutes) : '',
      amount: undertimeDeduction > 0 ? payslipMoney(undertimeDeduction) : '',
      note: undertimeDeduction > 0 ? adjustmentNote : ''
    }
  ];
}

function payslipAttendanceTable(payslip) {
  const rows = payslipAttendanceRows(payslip);
  return `
    <div class="lgsv-payslip-attendance">
      <h4>Attendance Adjustments</h4>
      ${rows.map(row => `
        <div class="lgsv-payslip-attendance-row">
          <span>${payrollEscape(row.label)}</span>
          <strong>${payrollEscape(row.value)}</strong>
          <strong>${payrollEscape(row.amount)}</strong>
          <strong>${payrollEscape(row.note)}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function payslipRows(payslip) {
  const isPiece = payslip.wage_type === 'Per-Piece';
  const isTrip = payslip.wage_type === 'Per-Trip';
  const isHourly = payslip.wage_type === 'Hourly';
  const earnings = [];

  if (isPiece) {
    earnings.push({ label: 'Output Pay', amount: payslipNumber(payslip.earnings?.basic_pay) });
  } else if (isTrip) {
    earnings.push({ label: 'Trip Pay', amount: payslipNumber(payslip.earnings?.basic_pay) });
  } else {
    earnings.push({
      label: isHourly && String(payslip.earnings?.attendance_pay_basis || '').trim() ? 'Adjusted Base Pay' : 'Basic Pay',
      amount: payslipNumber(payslip.earnings?.basic_pay)
    });
  }

  if (payslipNumber(payslip.earnings?.rot_sot) > 0) earnings.push({ label: 'Overtime / Premium', amount: payslipNumber(payslip.earnings.rot_sot) });
  if (payslipNumber(payslip.earnings?.add) > 0) earnings.push({ label: 'Additional Pay', amount: payslipNumber(payslip.earnings.add) });
  earnings.push({ label: 'Allowances', amount: payslipNumber(payslip.earnings?.allowances), blankWhenZero: true });
  earnings.push({ label: 'Gross Pay', amount: payslipNumber(payslip.summary?.gross_pay), total: true });

  const seen = new Set();
  const deductions = [];
  (Array.isArray(payslip.deductions) ? payslip.deductions : []).forEach(item => {
    const amount = payslipNumber(item.amount);
    const rowKey = String(item.key || '').toLowerCase();
    const alwaysShow = ['sss', 'hdmf', 'phic'].includes(rowKey);
    if ((!alwaysShow && amount <= 0) || item.key === 'tardy_ut_total') return;
    const label = String(item.label || 'Deduction')
      .replace(/^HDMF\s*\/\s*/i, '')
      .replace(/^PHIC\s*\/\s*/i, '');
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deductions.push({ label, amount });
  });
  deductions.push({ label: 'Total Deductions', amount: payslipNumber(payslip.summary?.total_deductions), total: true });
  deductions.push({ label: 'Net Pay', amount: payslipNumber(payslip.summary?.net_due), total: true });

  return { earnings, deductions };
}

function payslipTable(title, rows) {
  return `
    <table class="lgsv-payslip-table">
      <thead>
        <tr>
          <th>${payrollEscape(title)}</th>
          <th>Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(row => `
          <tr class="${row.total ? 'is-total' : ''}">
            <td>${payrollEscape(row.label)}</td>
            <td>${payrollEscape(row.blankWhenZero && payslipNumber(row.amount) <= 0 ? '' : payslipMoney(row.amount))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function payslipDetail(label, value) {
  return `
    <div class="lgsv-payslip-detail">
      <span>${payrollEscape(label)}</span>
      <b>:</b>
      <strong>${payrollEscape(value ?? '-')}</strong>
    </div>
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
  const rows = payslipRows(payslip);
  const generated = payslip.generated_at ? new Date(payslip.generated_at).toLocaleString('en-PH') : '-';

  const modal = document.createElement('div');
  modal.id = modalId;
  modal.className = 'erp-modal-backdrop';
  modal.innerHTML = `
    <div class="erp-modal payslip-preview-modal" role="dialog" aria-modal="true">
      <style>
        .payslip-preview-modal { max-width: 860px; }
        .lgsv-payslip-paper {
          background: #ffffff;
          color: #000000;
          border: 1px solid #d7d7d7;
          padding: 34px 44px 28px;
          font-family: Arial, Helvetica, sans-serif;
          box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
        }
        .lgsv-payslip-title { text-align: center; margin-bottom: 42px; }
        .lgsv-payslip-title h3 { margin: 0 0 10px; font-size: 24px; line-height: 1.1; color: #000000; }
        .lgsv-payslip-title p { margin: 4px 0; color: #000000; font-size: 17px; }
        .lgsv-payslip-details {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          column-gap: 54px;
          row-gap: 12px;
          margin-bottom: 36px;
        }
        .lgsv-payslip-detail {
          display: grid;
          grid-template-columns: 128px 12px minmax(0, 1fr);
          align-items: baseline;
          gap: 4px;
          font-size: 15px;
          line-height: 1.35;
        }
        .lgsv-payslip-detail strong { font-weight: 400; min-width: 0; overflow-wrap: anywhere; }
        .lgsv-payslip-attendance {
          border: 2px solid #111111;
          margin: -10px 0 28px;
        }
        .lgsv-payslip-attendance h4 {
          background: #d9d9d9;
          border-bottom: 2px solid #111111;
          margin: 0;
          padding: 8px 10px;
          color: #000000;
          font-size: 16px;
          text-align: center;
        }
        .lgsv-payslip-attendance-row {
          display: grid;
          grid-template-columns: 130px minmax(0, 1fr) 150px minmax(0, 1fr);
          border-bottom: 1px solid #111111;
          min-height: 30px;
        }
        .lgsv-payslip-attendance-row:last-child { border-bottom: 0; }
        .lgsv-payslip-attendance-row span,
        .lgsv-payslip-attendance-row strong {
          padding: 7px 10px;
          color: #000000;
          font-size: 13px;
          line-height: 1.25;
        }
        .lgsv-payslip-attendance-row span {
          border-right: 1px solid #111111;
          font-weight: 700;
        }
        .lgsv-payslip-attendance-row strong:not(:last-child) {
          border-right: 1px solid #111111;
        }
        .lgsv-payslip-attendance-row strong {
          font-weight: 400;
          overflow-wrap: anywhere;
        }
        .lgsv-payslip-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
          margin: 0 0 28px;
          border: 2px solid #111111;
        }
        .lgsv-payslip-table th {
          background: #d9d9d9;
          border: 2px solid #111111;
          padding: 8px 10px;
          color: #000000;
          font-size: 18px;
          text-align: center;
        }
        .lgsv-payslip-table th:last-child,
        .lgsv-payslip-table td:last-child { width: 160px; text-align: right; }
        .lgsv-payslip-table td {
          border: 2px solid #111111;
          padding: 7px 10px;
          color: #000000;
          font-size: 15px;
          line-height: 1.2;
        }
        .lgsv-payslip-table tr.is-total td { font-weight: 700; }
        .lgsv-payslip-table tr.is-total td:first-child { text-align: right; }
        .lgsv-payslip-net-words { text-align: center; margin: 42px 0 52px; font-size: 16px; color: #000000; }
        .lgsv-payslip-net-words strong { display: block; margin-bottom: 8px; font-size: 18px; }
        .lgsv-payslip-signatures {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 80px;
          margin: 0 34px 38px;
          text-align: center;
          color: #000000;
          font-size: 15px;
        }
        .lgsv-payslip-signatures span { display: block; margin-bottom: 70px; }
        .lgsv-payslip-signatures i { display: block; border-top: 2px solid #111111; height: 1px; }
        .lgsv-payslip-footer { text-align: center; color: #000000; font-size: 13px; }
        .lgsv-payslip-meta { margin-top: 10px; font-size: 11px; color: #555555; }
        @media (max-width: 760px) {
          .lgsv-payslip-paper { padding: 24px 18px; }
          .lgsv-payslip-details { grid-template-columns: 1fr; gap: 10px; }
          .lgsv-payslip-detail { grid-template-columns: 118px 10px minmax(0, 1fr); font-size: 14px; }
          .lgsv-payslip-table th { font-size: 15px; }
          .lgsv-payslip-table td { font-size: 13px; }
          .lgsv-payslip-table th:last-child,
          .lgsv-payslip-table td:last-child { width: 118px; }
          .lgsv-payslip-attendance-row { grid-template-columns: 1fr; }
          .lgsv-payslip-attendance-row span,
          .lgsv-payslip-attendance-row strong { border-right: 0; border-bottom: 1px solid #111111; }
          .lgsv-payslip-signatures { gap: 24px; margin-left: 0; margin-right: 0; }
        }
      </style>
      <div class="erp-modal-head">
        <div>
          <h2>Payslip</h2>
          <p>${payrollEscape(payslip.reference_no)} | ${payrollEscape(payslip.payroll_period)}</p>
        </div>
        <button class="erp-modal-close" type="button" onclick="document.getElementById('${modalId}')?.remove()">×</button>
      </div>
      <div class="lgsv-payslip-paper">
        <div class="lgsv-payslip-title">
          <h3>Payslip</h3>
          <p>${payrollEscape(payslip.company_name || 'Marulas Industrial Corporation')}</p>
          <p>LGSV HR Payroll System</p>
        </div>
        <div class="lgsv-payslip-details">
          ${payslipDetail('Date Hired', payslip.employee?.date_hired || '-')}
          ${payslipDetail('Employee Name', payslip.employee?.name || '-')}
          ${payslipDetail('Pay Period', payslip.payroll_period || '-')}
          ${payslipDetail('Designation', payslip.employee?.position || '-')}
          ${payslipDetail(payslipWorkLabel(payslip), payslipWorkValue(payslip))}
          ${payslipDetail('Department', payslip.employee?.department || '-')}
          ${payslipDetail('Wage Type', payslip.wage_type || '-')}
          ${payslipDetail('Reference No.', payslip.reference_no || '-')}
        </div>
        ${payslipAttendanceTable(payslip)}
        ${payslipTable('Earnings', rows.earnings)}
        ${payslipTable('Deductions', rows.deductions)}
        <div class="lgsv-payslip-net-words">
          <strong>${payrollEscape(payslipMoney(payslip.summary?.net_due))}</strong>
          ${payrollEscape(payslipAmountToWords(payslip.summary?.net_due))}
        </div>
        <div class="lgsv-payslip-signatures">
          <div><span>Employer Signature</span><i></i></div>
          <div><span>Employee Signature</span><i></i></div>
        </div>
        <div class="lgsv-payslip-footer">This is a system generated payslip</div>
        <div class="lgsv-payslip-footer lgsv-payslip-meta">Generated: ${payrollEscape(generated)} | Prepared by: ${payrollEscape(payslip.prepared_by || '-')}</div>
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
  let snapshot = {};
  try {
    snapshot = record.validation_snapshot
      ? (typeof record.validation_snapshot === 'string' ? JSON.parse(record.validation_snapshot) : record.validation_snapshot)
      : {};
  } catch (_) {
    snapshot = {};
  }

  const sourceDateLabel = record.source_date_from
    ? record.source_date_from === record.source_date_to
      ? new Date(`${record.source_date_from}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : `${new Date(`${record.source_date_from}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date(`${record.source_date_to}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';
  const deductionsApplied = payrollRecordHasAppliedDeductions(record);
  const calculationDate = !deductionsApplied && sourceDateLabel
    ? sourceDateLabel
    : record.calculation_date
      ? new Date(record.calculation_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '-';
  const calcNo = `CALC-${String(record.id || '').padStart(5, '0')}`;
  const totalAllowances = number(record.total_allowances)
    || number(record.housing_allowance) + number(record.meal_allowance) + number(record.transport_allowance) + number(record.bonus_allowance);
  const sourceEntries = Array.isArray(record.source_entries) ? record.source_entries : [];
  const attendanceEntries = sourceEntries.filter(entry => entry.kind === 'attendance');
  const sourceOutputEntries = sourceEntries.filter(entry => entry.kind !== 'attendance');
  const sourceOutputQuantity = number(record.source_output_quantity)
    || sourceOutputEntries.reduce((sum, entry) => sum + number(entry.quantity), 0);
  const sourceOutputAmount = number(record.source_output_amount)
    || sourceOutputEntries.reduce((sum, entry) => sum + number(entry.amount), 0);
  const displayGrossPay = deductionsApplied ? number(record.gross_pay) : (number(record.gross_pay) || sourceOutputAmount);
  const totalDeductions = deductionsApplied ? number(record.total_deductions) : 0;
  const displayNetPay = deductionsApplied ? number(record.net_pay) : displayGrossPay;
  const basePay = Math.max(0, displayGrossPay - totalAllowances);
  const isPieceRate = /piece/i.test(String(record.wage_type || ''));
  const baseRateField = isPieceRate
    ? ''
    : `<label>Base Rate<input value="${fmt(record.base_rate)}" readonly /></label>`;
  const hourlyLateEmbeddedInBase = record.wage_type === 'Hourly' && Boolean(snapshot.attendance_deduction_embedded_in_base);
  const basePayLabel = isPieceRate ? 'Piece Earnings' : hourlyLateEmbeddedInBase ? 'Adjusted Base Pay' : 'Base Pay';
  const approvedRegularHours = (() => {
    const explicitNoGraceHours = number(snapshot.approved_regular_hours);
    if (explicitNoGraceHours > 0) return explicitNoGraceHours;
    const sourceHours = attendanceEntries.reduce((sum, entry) => sum + number(entry.regular_hours), 0);
    if (sourceHours > 0) return sourceHours;
    const snapshotRows = Array.isArray(snapshot.attendance_rows) ? snapshot.attendance_rows : [];
    const snapshotHours = snapshotRows.reduce((sum, entry) => sum + number(entry.regular_hours), 0);
    if (snapshotHours > 0) return snapshotHours;
    return number(record.hours_worked);
  })();
  const approvedRegularMinutes = number(snapshot.approved_regular_minutes)
    || attendanceEntries.reduce((sum, entry) => sum + number(entry.regular_minutes), 0)
    || (Array.isArray(snapshot.attendance_rows)
      ? snapshot.attendance_rows.reduce((sum, entry) => sum + number(entry.regular_minutes), 0)
      : 0);
  const scheduledHoursPerDay = Math.max(0, number(snapshot.policy?.standard_hours_per_day || snapshot.policy?.standard_work_hours) || 8)
    - Math.max(0, number(snapshot.policy?.break_deduction_hours));
  const attendanceDayCount = attendanceEntries.filter(entry => number(entry.regular_hours) > 0).length
    || (Array.isArray(snapshot.attendance_rows)
      ? snapshot.attendance_rows.filter(entry => number(entry.regular_hours) > 0).length
      : 0);
  const scheduledBasisHours = number(snapshot.scheduled_hours) || (attendanceDayCount > 0
    ? attendanceDayCount * (scheduledHoursPerDay > 0 ? scheduledHoursPerDay : 8)
    : number(snapshot.hours_worked) || number(record.hours_worked));
  const scheduledBasisMinutes = number(snapshot.scheduled_minutes) || Math.round(scheduledBasisHours * 60);
  const payrollBasisHours = scheduledBasisHours || number(snapshot.hours_worked) || number(record.hours_worked);
  const deductibleLateMinutes = Object.prototype.hasOwnProperty.call(snapshot, 'deductible_late_minutes')
    ? number(snapshot.deductible_late_minutes)
    : number(snapshot.late_minutes);
  const deductibleUndertimeMinutes = number(snapshot.undertime_minutes);
  const netCreditedMinutes = number(snapshot.net_credited_minutes)
    || Math.max(0, scheduledBasisMinutes - deductibleLateMinutes - deductibleUndertimeMinutes);
  const netCreditedHours = netCreditedMinutes / 60;
  const workOutput = record.wage_type === 'Hourly'
    ? payrollExactHourLabel(netCreditedHours, netCreditedMinutes)
    : record.wage_type === 'Daily'
      ? `${number(record.days_worked).toLocaleString('en-US')} days`
      : record.wage_type === 'Per-Trip'
        ? `${(number(record.quantity) || sourceOutputQuantity).toLocaleString('en-US')} trips`
        : record.wage_type === 'Per-Piece'
          ? `${(number(record.quantity) || sourceOutputQuantity).toLocaleString('en-US')} pieces`
          : '-';
  const hourlyWorkOutputAuditFields = record.wage_type === 'Hourly'
    ? `
        <label>Scheduled Basis Hours<input value="${payrollEscape(payrollExactHourLabel(payrollBasisHours, scheduledBasisMinutes))}" readonly /></label>
        <label>Clocked Regular Hrs<input value="${payrollEscape(payrollExactHourLabel(approvedRegularHours, approvedRegularMinutes || null))}" readonly /></label>
        <label>Grace Treatment<input value="${payrollEscape('Included in work output; only beyond-grace late is deducted')}" readonly /></label>
        <label>Deductible Late / UT<input value="${payrollEscape(`${deductibleLateMinutes.toLocaleString('en-US')} / ${deductibleUndertimeMinutes.toLocaleString('en-US')} min`)}" readonly /></label>
      `
    : '';
  const formatSourceDate = value => {
    if (!value) return '-';
    const text = String(value);
    const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const date = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(text);
    return Number.isNaN(date.getTime())
      ? payrollEscape(text)
      : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const formatSourceDateTime = value => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return payrollEscape(value);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };
  const formatSourceTime = value => {
    if (!value) return '-';
    const text = String(value);
    const timeOnly = text.match(/(?:T|\s)?(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (timeOnly && !text.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const hour = Number(timeOnly[1]);
      const minute = timeOnly[2];
      const suffix = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour % 12 || 12;
      return `${displayHour}:${minute} ${suffix}`;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return payrollEscape(value);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  const hasAttendanceEntries = sourceEntries.some(entry => entry.kind === 'attendance');
  const attendanceEntryRows = sourceEntries.filter(entry => entry.kind === 'attendance').map(entry => `
    <tr>
      <td>${formatSourceDate(entry.activity_date)}</td>
      <td>${formatSourceTime(entry.time_in)}</td>
      <td>${formatSourceTime(entry.time_out)}</td>
      <td>${payrollEscape(entry.type || '-')}<br><span class="muted-small">${payrollEscape(entry.details || '')}</span></td>
      <td class="text-right">${payrollEscape(payrollExactHourLabel(number(entry.regular_hours), number(entry.regular_minutes) || null))}</td>
      <td class="text-right">${payrollEscape(payrollExactHourLabel(number(entry.overtime_hours)))}</td>
      <td class="text-right">${number(entry.late_minutes).toLocaleString('en-US')} / ${number(entry.undertime_minutes).toLocaleString('en-US')}</td>
      <td>${payrollEscape(entry.status || '-')}</td>
    </tr>
  `).join('');
  const outputEntryRows = sourceEntries.filter(entry => entry.kind !== 'attendance').map(entry => {
    const quantityUnit = entry.quantity_unit || (entry.kind === 'trip' ? 'trip' : 'pieces');
    const quantity = number(entry.quantity);
    const quantityLabel = quantity
      ? `${quantity.toLocaleString('en-US')} ${payrollEscape(quantityUnit)}`
      : '-';
    const details = [
      entry.details,
      entry.role && !String(entry.details || '').includes(entry.role) ? entry.role : '',
      number(entry.share_percentage) ? `${number(entry.share_percentage).toLocaleString('en-US')}% share` : '',
      entry.status ? `Status: ${entry.status}` : ''
    ].filter(Boolean).join(' · ');
    return `
      <tr>
        <td>${formatSourceDate(entry.activity_date)}</td>
        <td>${formatSourceDateTime(entry.entered_at)}</td>
        <td>${payrollEscape(entry.source || entry.type || '-')}<br><span class="muted-small">${payrollEscape(entry.type || '')}</span></td>
        <td>${payrollEscape(details || '-')}</td>
        <td class="text-right">${quantityLabel}</td>
        <td class="text-right">${fmt(entry.amount)}</td>
      </tr>
    `;
  }).join('');
  const sourceEntriesSection = `
    <div class="payroll-breakdown-section">
      <h3>${hasAttendanceEntries ? 'Attendance Logs' : 'Encoded Outputs / Trips'}</h3>
      ${hasAttendanceEntries ? `
        <div class="payroll-source-table-wrap">
          <table class="payroll-breakdown-table payroll-source-table">
            <thead>
              <tr>
                <th>Work Date</th>
                <th>Time In</th>
                <th>Time Out</th>
                <th>Status</th>
                <th class="text-right">Regular Hrs</th>
                <th class="text-right">OT Hrs</th>
                <th class="text-right">Late / UT Min</th>
                <th>Payroll State</th>
              </tr>
            </thead>
            <tbody>${attendanceEntryRows}</tbody>
          </table>
        </div>
      ` : sourceEntries.length ? `
        <div class="payroll-source-table-wrap">
          <table class="payroll-breakdown-table payroll-source-table">
            <thead>
              <tr>
                <th>Output / Trip Date</th>
                <th>Encoded At</th>
                <th>Source</th>
                <th>Details</th>
                <th class="text-right">Qty / Trips</th>
                <th class="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>${outputEntryRows}</tbody>
          </table>
        </div>
      ` : '<div class="empty-state">No source details found for this calculation.</div>'}
    </div>
  `;

  const deductionRows = [
    ['SSS', number(record.sss_deduction)],
    ['Pag-IBIG', number(record.pagibig_deduction)],
    ['PhilHealth', number(record.philhealth_deduction)],
    ['Late Deduction', hourlyLateEmbeddedInBase ? 0 : number(snapshot.late_deduction)],
    ['Undertime Deduction', hourlyLateEmbeddedInBase ? 0 : number(snapshot.undertime_deduction)]
  ].filter(([, amount]) => deductionsApplied && amount > 0);
  if (deductionsApplied && !deductionRows.length && totalDeductions > 0) {
    deductionRows.push(['Configured Deductions', totalDeductions]);
  }
  const lateDeductionAmount = number(snapshot.late_deduction);
  const undertimeDeductionAmount = number(snapshot.undertime_deduction);
  const attendanceDeductionAmount = lateDeductionAmount + undertimeDeductionAmount;
  const hasLateUtSummary = deductionsApplied
    && (deductibleLateMinutes > 0 || deductibleUndertimeMinutes > 0 || attendanceDeductionAmount > 0);
  const lateUtSummaryValue = (() => {
    const minutesLabel = `${deductibleLateMinutes.toLocaleString('en-US')} / ${deductibleUndertimeMinutes.toLocaleString('en-US')} min`;
    if (hourlyLateEmbeddedInBase && attendanceDeductionAmount > 0) {
      return `${minutesLabel} (${fmt(attendanceDeductionAmount)} included in adjusted base)`;
    }
    if (attendanceDeductionAmount > 0) return `${minutesLabel} (- ${fmt(attendanceDeductionAmount)})`;
    return minutesLabel;
  })();

  const row = (label, value, className = '') => `
    <tr class="${className}">
      <td>${label}</td>
      <td class="text-right">${value}</td>
    </tr>
  `;
  const normalizedStatus = String(record.status || '').trim();
  const normalizedStatusKey = normalizedStatus.toLowerCase();
  const displayWorkflowStatus = deductionsApplied
    ? normalizedStatus
    : record.source_workflow_status || (normalizedStatusKey === 'for approval' ? 'Source Submitted' : normalizedStatus);
  const canReviewRecalculate = deductionsApplied && ['draft', 'calculated', 'for review'].includes(normalizedStatusKey);
  const recalcAction = canReviewRecalculate
    ? `<button class="btn btn-outline" type="button" onclick="recalculateSalaryCalculation(${Number(record.id)})">Recalculate This Employee</button>`
    : '';
  const submitAction = canReviewRecalculate && canSubmitSalaryCalculations() && !canApproveSalaryCalculations()
    ? `<button class="btn btn-primary" type="button" onclick="submitSalaryCalculationForApproval(${Number(record.id)})">Submit Payroll to Manager</button>`
    : '';
  const approvalAction = ['for review', 'submitted', 'for approval'].includes(normalizedStatusKey) && canApproveSalaryCalculations()
    && deductionsApplied
    ? `<button class="btn btn-primary" type="button" onclick="approveSalaryCalculation(${Number(record.id)})">Approve & Finalize</button>`
    : '';
  const blockchainRecordAction = ['approved', 'finalized', 'released'].includes(normalizedStatusKey) && canApproveSalaryCalculations()
    && deductionsApplied
    ? `<button class="btn btn-primary" type="button" onclick="recordApprovedPayrollOnBlockchain(${Number(record.id)})">Load to Blockchain</button>`
    : '';
  const releaseAction = normalizedStatusKey === 'approved' && canApproveSalaryCalculations()
    && deductionsApplied
    ? `<button class="btn btn-outline" type="button" onclick="releaseSalaryCalculation(${Number(record.id)})">Release Payslip</button>`
    : '';
  const lockAction = ['approved', 'released'].includes(normalizedStatusKey) && canApproveSalaryCalculations()
    && deductionsApplied
    ? `<button class="btn btn-outline" type="button" onclick="lockSalaryCalculation(${Number(record.id)})">Lock</button>`
    : '';
  const payslipActions = deductionsApplied && canManagePayslipActions()
    ? `
        <button class="btn btn-outline" type="button" onclick="exportPayslipPdf(${Number(record.id)}, true)">Print Payslip</button>
        <button class="btn btn-outline" type="button" onclick="exportPayslipPdf(${Number(record.id)}, false)">Export Payslip PDF</button>
        <button class="btn btn-primary" type="button" onclick="generatePayslipPreview(${Number(record.id)})">Generate Payslip</button>
      `
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
        <label>Employee<input value="${payrollEscape(record.employee_name || '-')}" readonly /></label>
        <label>Employee ID<input value="${payrollEscape(record.employee_code || '-')}" readonly /></label>
        <label>Department<input value="${payrollEscape(record.department || '-')}" readonly /></label>
        <label>Status<input value="${payrollEscape(displayWorkflowStatus || 'Encoding Draft')}" readonly /></label>
        <label>Wage Type<input value="${payrollEscape(record.wage_type || '-')}" readonly /></label>
        ${baseRateField}
        <label>Work Output<input value="${payrollEscape(workOutput)}" readonly /></label>
        ${hourlyWorkOutputAuditFields}
        <label>${deductionsApplied ? 'Payroll Calculation Date' : 'Work / Output Date(s)'}<input value="${payrollEscape(calculationDate)}" readonly /></label>
      </div>

      ${sourceEntriesSection}

      <div class="payroll-breakdown-section">
        <h3>Calculation Summary</h3>
        <table class="payroll-breakdown-table">
          <tbody>
            ${row(basePayLabel, fmt(basePay))}
            ${row('Allowances', fmt(totalAllowances))}
            ${row(deductionsApplied ? 'Gross Pay' : 'Encoded Source Total', fmt(displayGrossPay), 'is-positive')}
            ${deductionsApplied ? `
              ${hasLateUtSummary ? row('Late / UT', payrollEscape(lateUtSummaryValue), hourlyLateEmbeddedInBase ? '' : 'is-deduction') : ''}
              ${deductionRows.map(([label, amount]) => row(label, `- ${fmt(amount)}`, 'is-deduction')).join('')}
              ${row('Total Deductions', `- ${fmt(totalDeductions)}`, 'is-deduction')}
              ${row('Net Pay', fmt(displayNetPay), 'is-net')}
            ` : `
              ${row('Deduction Status', 'Deferred until Generate Payroll')}
              ${row('Encoded Total Before Deductions', fmt(displayNetPay), 'is-net')}
            `}
          </tbody>
        </table>
      </div>

      <div class="payroll-breakdown-actions">
        <button class="btn btn-outline" type="button" onclick="document.getElementById('${modalId}')?.remove()">Close</button>
        ${recalcAction}
        ${submitAction}
        ${approvalAction}
        ${releaseAction}
        ${lockAction}
        ${blockchainRecordAction}
        ${payslipActions}
      </div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target.id === modalId) modal.remove();
  });
  document.body.appendChild(modal);
}

function updatePayrollDropdownNav(activeTab) {
  const activeButton = document.querySelector(`.payroll-tab[data-payroll-tab="${activeTab}"]`);
  const activeLabel = activeButton?.textContent?.trim() || 'Dashboard';
  const processingTabs = new Set(['dashboard', 'run', 'salary', 'records', 'offboarding-clearance', 'final-pay-approval', 'audit']);
  const activeGroup = processingTabs.has(activeTab) ? 'processing' : 'configuration';

  document.querySelectorAll('.payroll-nav-dropdown').forEach(dropdown => {
    const isActive = dropdown.dataset.payrollGroup === activeGroup;
    dropdown.classList.toggle('active', isActive);
    if (isActive) dropdown.setAttribute('open', '');
    else dropdown.removeAttribute('open');
  });

  const processingCurrent = document.getElementById('payroll-processing-current');
  const configurationCurrent = document.getElementById('payroll-configuration-current');
  if (processingCurrent) processingCurrent.textContent = activeGroup === 'processing' ? activeLabel : 'Open processing';
  if (configurationCurrent) configurationCurrent.textContent = activeGroup === 'configuration' ? activeLabel : 'Select setup';
}

function switchPayrollTab(tab, options = {}) {
  const requestedTab = tab === 'payslips' ? 'records' : tab;
  const targetTab = ['allowances', 'employee-deductions'].includes(requestedTab) ? 'deductions' : requestedTab;
  document.querySelectorAll('.payroll-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.payrollTab === targetTab);
  });
  document.querySelectorAll('.payroll-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `payroll-tab-${targetTab}`);
  });
  updatePayrollDropdownNav(targetTab);

  if (targetTab === 'dashboard') loadPayrollDashboard();
  if (targetTab === 'run') {
    loadWeeklyPayrollFilterOptions();
    loadWeeklyPayrollRegistry();
  }
  if (targetTab === 'salary' && typeof loadSalaryCalculationPage === 'function') loadSalaryCalculationPage();
  if (targetTab === 'piece-config') loadPieceRateConfig();
  if (targetTab === 'logistics' && typeof loadLogisticsPayrollModule === 'function') loadLogisticsPayrollModule();
  if (targetTab === 'deductions') {
    loadPayrollSettings('deduction');
    refreshSssContributionTableVisibility({ loadWhenVisible: true });
  }
  if (targetTab === 'policies') loadPayrollPolicySettings();
  if (targetTab === 'records') loadSalaryCalculations();
  if (targetTab === 'offboarding-clearance') loadOffboardingClearance();
  if (targetTab === 'final-pay-approval') loadFinalPayApprovals();
  if (targetTab === 'audit') loadPayrollAudit();
  if (!options.skipRouteUpdate && typeof syncRouteForPage === 'function') {
    syncRouteForPage('payroll', { payrollTab: targetTab });
  }
}

function payrollOffboardingTable(rows, actionRenderer) {
  if (!rows.length) return '<div class="empty-state">No offboarding records found.</div>';
  return `
    <table class="payroll-table">
      <thead><tr>
        <th>Employee ID</th><th>Employee Name</th><th>Position</th><th>Department</th>
        <th>Offboarding Type</th><th>Last Working Day</th><th>Workflow</th><th>Payroll Clearance</th><th>Final Pay</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows.map(row => `
        <tr>
          <td>${payrollEscape(row.employee_code || '-')}</td>
          <td>${payrollEscape(row.employee_name || '-')}</td>
          <td>${payrollEscape(row.position || '-')}</td>
          <td>${payrollEscape(row.department || '-')}</td>
          <td>${payrollEscape(row.offboarding_type || '-')}</td>
          <td>${payrollEscape(row.last_working_day || '-')}</td>
          <td>${payrollEscape(row.offboarding_status || '-')}</td>
          <td>${payrollEscape(row.payroll_clearance_status || 'Pending')}</td>
          <td>${payrollEscape(row.final_pay_status || 'Pending')}</td>
          <td>${actionRenderer(row)}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

async function loadOffboardingClearance() {
  const grid = document.getElementById('offboarding-clearance-grid');
  if (grid) grid.innerHTML = '<div class="muted-small">Loading...</div>';
  try {
    const res = await apiFetch('/api/payroll/offboarding-clearance');
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error(data.error || 'Failed to load offboarding clearances.');
    offboardingClearanceRows = data;
    if (grid) grid.innerHTML = payrollOffboardingTable(data, row => {
      const caseId = payrollOffboardingCaseId(row);
      if (!caseId) return '<button class="btn btn-outline" type="button" disabled>Review</button>';
      return `<button class="btn btn-outline" type="button" onclick="openPayrollClearanceReview(${caseId})">Review</button>`;
    });
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="empty-state">${payrollEscape(err.message)}</div>`;
  }
}

async function loadFinalPayApprovals() {
  const grid = document.getElementById('final-pay-approval-grid');
  if (grid) grid.innerHTML = '<div class="muted-small">Loading...</div>';
  try {
    const res = await apiFetch('/api/payroll/final-pay-approval');
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error(data.error || 'Failed to load final pay approvals.');
    finalPayApprovalRows = data;
    if (grid) grid.innerHTML = payrollOffboardingTable(data, row => {
      const caseId = payrollOffboardingCaseId(row);
      if (!caseId) return '<button class="btn btn-outline" type="button" disabled>Review</button>';
      return `<button class="btn btn-outline" type="button" onclick="openFinalPayReview(${caseId})">Review</button>`;
    });
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="empty-state">${payrollEscape(err.message)}</div>`;
  }
}

function offboardingReadonlyBlock(row) {
  const item = (label, value) => `<label>${label}<input value="${payrollEscape(value || '-')}" readonly /></label>`;
  return `
    <div class="payroll-breakdown-grid">
      ${item('Employee ID', row.employee_code)}
      ${item('Name', row.employee_name)}
      ${item('Position', row.position)}
      ${item('Department', row.department)}
      ${item('Offboarding Type', row.offboarding_type)}
      ${item('Effective Date', row.effective_date)}
      ${item('Last Working Day', row.last_working_day)}
      ${item('Reason', row.separation_reason)}
      ${item('Workflow Status', row.offboarding_status)}
    </div>
  `;
}

function payrollModal(id, title, body) {
  document.getElementById(id)?.remove();
  const modal = document.createElement('div');
  modal.id = id;
  modal.className = 'erp-modal-backdrop';
  modal.innerHTML = `
    <div class="erp-modal payroll-breakdown-modal" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
      <div class="erp-modal-head">
        <div>
          <h2 id="${id}-title">${payrollEscape(title)}</h2>
        </div>
        <button class="erp-modal-close" type="button" aria-label="Close" onclick="document.getElementById('${id}')?.remove()">&times;</button>
      </div>
      ${body}
    </div>
  `;
  modal.addEventListener('click', event => { if (event.target.id === id) modal.remove(); });
  document.body.appendChild(modal);
}

function openPayrollClearanceReview(caseId) {
  const row = offboardingClearanceRows.find(item => Number(item.offboarding_case_id) === Number(caseId));
  if (!row) {
    alert('Unable to find this offboarding clearance record. Please refresh and try again.');
    loadOffboardingClearance();
    return;
  }
  const checklistFields = [
    ['last_payroll_period_checked', 'Last Payroll Period'],
    ['attendance_checked', 'Attendance'],
    ['leave_balance_checked', 'Leave Balance'],
    ['deductions_checked', 'Deductions'],
    ['benefits_or_13th_month_checked', 'Benefits / 13th Month'],
  ];
  const moneyField = (label, name, value) => `
    <label class="payroll-clearance-field">
      <span class="payroll-clearance-label">${label}</span>
      <span class="payroll-clearance-money"><span>PHP</span><input name="${name}" type="number" min="0" step="0.01" value="${payrollEscape(value || '0.00')}" /></span>
    </label>
  `;
  const checklist = checklistFields.map(([field, label]) => `
    <label class="payroll-clearance-toggle-row">
      <span>${label}</span>
      <span class="payroll-clearance-toggle">
        <input type="hidden" name="${field}" value="No" />
        <input type="checkbox" name="${field}" value="Yes" ${row[field] === 'Yes' ? 'checked' : ''} aria-label="${label} checked" />
        <span class="payroll-clearance-toggle-track" aria-hidden="true"></span>
      </span>
    </label>
  `).join('');
  payrollModal('payroll-clearance-modal', 'Payroll Clearance Review', `
    ${offboardingReadonlyBlock(row)}
    <form id="payroll-clearance-form" class="payroll-clearance-form" onsubmit="submitPayrollClearance(event, ${caseId})">
      <section class="payroll-clearance-section">
        <h3>Final Pay Inputs</h3>
        <div class="payroll-clearance-grid">
          <label class="payroll-clearance-field">
            <span class="payroll-clearance-label">Final Attendance Cutoff</span>
            <input name="final_attendance_cutoff" type="date" value="${payrollEscape(row.final_attendance_cutoff || '')}" />
          </label>
          ${moneyField('Unpaid Salary', 'unpaid_salary', row.unpaid_salary)}
          ${moneyField('Deductions', 'final_deductions', row.final_deductions)}
          ${moneyField('Allowances', 'final_allowances', row.final_allowances)}
          ${moneyField('Pending Benefits', 'pending_benefits', row.pending_benefits)}
        </div>
      </section>
      <section class="payroll-clearance-section">
        <h3>Clearance Checklist</h3>
        <div class="payroll-clearance-grid payroll-clearance-checklist">
          ${checklist}
          <label class="payroll-clearance-field">
            <span class="payroll-clearance-label">Loans / Cash Advances</span>
            <select name="loans_or_cash_advances_checked"><option ${row.loans_or_cash_advances_checked === 'No' ? 'selected' : ''}>No</option><option ${row.loans_or_cash_advances_checked === 'Yes' ? 'selected' : ''}>Yes</option><option ${row.loans_or_cash_advances_checked === 'Not Applicable' ? 'selected' : ''}>Not Applicable</option></select>
          </label>
          <label class="payroll-clearance-field">
            <span class="payroll-clearance-label">Clearance Status</span>
            <select name="payroll_clearance_status"><option>Pending</option><option>Checked</option><option>Cleared</option><option>With Issue</option></select>
          </label>
          <label class="payroll-clearance-field payroll-clearance-field-wide">
            <span class="payroll-clearance-label">Payroll Remarks</span>
            <textarea name="payroll_remarks" rows="3" placeholder="Add payroll clearance notes">${payrollEscape(row.payroll_remarks || '')}</textarea>
          </label>
        </div>
      </section>
      <div class="payroll-breakdown-actions payroll-clearance-actions"><button class="btn btn-outline" type="button" onclick="document.getElementById('payroll-clearance-modal')?.remove()">Cancel</button><button class="btn btn-primary" type="submit">Save Changes</button></div>
    </form>
  `);
  document.querySelector('#payroll-clearance-form [name="payroll_clearance_status"]').value = row.payroll_clearance_status || 'Pending';
}

async function submitPayrollClearance(event, caseId) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const res = await apiFetch(`/api/payroll/offboarding-clearance/${caseId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Failed to update payroll clearance.');
  alert(data.message || 'Payroll clearance updated.');
  document.getElementById('payroll-clearance-modal')?.remove();
  loadOffboardingClearance();
}

function openFinalPayReview(caseId) {
  const row = finalPayApprovalRows.find(item => Number(item.offboarding_case_id) === Number(caseId));
  if (!row) {
    alert('Unable to find this final pay record. Please refresh and try again.');
    loadFinalPayApprovals();
    return;
  }
  payrollModal('final-pay-modal', 'Final Pay Approval', `
    ${offboardingReadonlyBlock(row)}
    <form id="final-pay-form" class="payroll-breakdown-grid" onsubmit="submitFinalPayApproval(event, ${caseId})">
      <label>Final Attendance Cutoff<input value="${payrollEscape(row.final_attendance_cutoff || '-')}" readonly /></label>
      <label>Unpaid Salary<input value="${money(row.unpaid_salary || 0)}" readonly /></label>
      <label>Deductions<input value="${money(row.final_deductions || 0)}" readonly /></label>
      <label>Allowances<input value="${money(row.final_allowances || 0)}" readonly /></label>
      <label>Pending Benefits<input value="${money(row.pending_benefits || 0)}" readonly /></label>
      <label>Final Pay Status<select name="final_pay_status"><option>Pending</option><option>For Approval</option><option>Approved</option><option>Released</option><option>With Issue</option></select></label>
      <label>Final Pay Release Date<input name="final_pay_release_date" type="date" value="${payrollEscape(row.final_pay_release_date || '')}" /></label>
      <label style="grid-column:1/-1;">Final Pay Remarks<textarea name="final_pay_remarks" rows="3">${payrollEscape(row.final_pay_remarks || '')}</textarea></label>
      <div class="payroll-breakdown-actions" style="grid-column:1/-1;"><button class="btn btn-outline" type="button" onclick="document.getElementById('final-pay-modal')?.remove()">Cancel</button><button class="btn btn-primary" type="submit">Save</button></div>
    </form>
  `);
  document.querySelector('#final-pay-form [name="final_pay_status"]').value = row.final_pay_status || 'Pending';
}

async function submitFinalPayApproval(event, caseId) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const res = await apiFetch(`/api/payroll/final-pay-approval/${caseId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Failed to update final pay.');
  alert(data.message || 'Final pay updated.');
  document.getElementById('final-pay-modal')?.remove();
  loadFinalPayApprovals();
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

function activeSetupRows(rows) {
  return activeRows(rows);
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
      return `<option value="${sew}" data-size="${size}" data-category="${size}">${sew}${size ? ` / ${size}` : ''} (${pieceRateMoney(row.piece_rate)})</option>`;
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
    ['sew', 'Type of Sew'],
    ['sizes', 'Size Ranges'],
    ['incentives', 'Incentive Rules'],
    ['production', 'Production Encodings'],
    ['register', 'SWR-FXR-SUM Register'],
    ['entries', 'Incentive Encodings']
  ];
  return `
    <div class="piece-records-compact">
      <div class="piece-records-head">
        <div>
          <h3>Active Configurations</h3>
          <p>View or edit the active payroll configuration records below.</p>
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
    const page = pieceRecordPageRows(activeSetupRows(config.sew_types));
    return pieceRecordTable(['Code', 'Description', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.code)}</td><td>${payrollEscape(row.description || '-')}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`, 'No Type of Sew configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'sizes') {
    const page = pieceRecordPageRows(activeSetupRows(config.size_ranges));
    return pieceRecordTable(['Size Range', 'Description', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.size_range)}</td><td>${payrollEscape(row.description || '-')}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`, 'No size ranges configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'rules') {
    const page = pieceRecordPageRows(activeSetupRows(config.production_share_rules));
    return pieceRecordTable(['Pairing Type', 'Worker 1', 'Worker 2', 'Effective', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.pairing_type)}</td><td>${Number(row.worker1_share || 0)}%</td><td>${Number(row.worker2_share || 0)}%</td><td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`, 'No sharing rules configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'splits') {
    const page = pieceRecordPageRows(activeSetupRows(config.production_split_configs));
    return pieceRecordTable(['Split Name', 'Sewer %', 'Fixer %', 'Total', 'Effective', 'Status', 'Action'], page.rows, row => {
        const total = Number(row.sewer_percentage || 0) + Number(row.fixer_percentage || 0);
        return `<tr><td>${payrollEscape(row.split_name)}</td><td>${Number(row.sewer_percentage || 0)}%</td><td>${Number(row.fixer_percentage || 0)}%</td><td>${total}%</td><td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions(view, row)}</td></tr>`;
      }, 'No production split configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
  }
  if (view === 'incentives') {
    const page = pieceRecordPageRows(activeSetupRows(config.incentives));
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
  const page = pieceRecordPageRows(activeSetupRows(config.piece_rates));
  return pieceRecordTable(['Type of Sew', 'Size Range', 'Rate', 'Effective', 'Status', 'Action'], page.rows, row => `<tr><td>${payrollEscape(row.sew_type_code || row.product_type)}</td><td>${payrollEscape(row.size_range || row.product_category || '-')}</td><td>${pieceRateMoney(row.piece_rate)}</td><td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td>${pieceRecordActions('rates', row)}</td></tr>`, 'No piece rates configured.') + pieceRecordPagination(page.totalRows, page.startIndex, page.currentPage, page.totalPages);
}

function changePieceRateRecordsPage(direction) {
  const rowsByView = {
    sew: activeSetupRows(pieceRateConfig.sew_types),
    sizes: activeSetupRows(pieceRateConfig.size_ranges),
    rules: activeSetupRows(pieceRateConfig.production_share_rules),
    splits: activeSetupRows(pieceRateConfig.production_split_configs),
    incentives: activeSetupRows(pieceRateConfig.incentives),
    production: pieceRateConfig.production_pairs || [],
    register: [],
    entries: pieceRateConfig.incentive_entries || [],
    rates: activeSetupRows(pieceRateConfig.piece_rates)
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
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Failed to save size range');
    form.reset();
    pieceRateRecordsView = 'sizes';
    pieceRateRecordsPages.sizes = 1;
    await loadPieceRateConfig();
    document.getElementById('piece-rate-config-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof showAlert === 'function') await showAlert(result.message || 'Size range saved.', 'Saved', 'success');
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

function calendarBasedDivisorText(schedule = '') {
  const normalized = String(schedule || '').trim();
  if (normalized === 'Monthly') return 'Auto divisor: 1 for monthly payroll.';
  if (['Semi-Monthly', 'First Payroll of Month', 'Last Payroll of Month'].includes(normalized)) {
    return 'Auto divisor: 2 for semi-monthly payroll.';
  }
  return 'Auto divisor: 4 or 5 for weekly payroll, based on the number of cutoff dates in the payroll end month.';
}

function renderDeductionProration(row = {}) {
  const mode = String(row.proration_mode || 'Calendar-Based Payroll Date Range');
  if (mode === 'Calendar-Based Payroll Date Range') {
    return `
      ${payrollEscape(mode)}
      <span class="payroll-deduction-detail">${payrollEscape(calendarBasedDivisorText(row.apply_schedule))}</span>
    `;
  }
  return `Manual Divisor${row.fixed_divisor ? ` / ${payrollEscape(row.fixed_divisor)}` : ''}`;
}

function renderDeductionSettings(rows) {
  return `
    <table>
      <thead><tr><th>Name</th><th>Category</th><th>Computation</th><th>Employee Share</th><th>Base Limits</th><th>Priority</th><th>Schedule</th><th>Proration</th><th>Status</th><th>Effective</th><th>Actions</th></tr></thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${payrollEscape(row.name)}</td>
            <td>${payrollEscape(row.category)}</td>
            <td>${payrollEscape(row.computation_type)}</td>
            <td>${payrollEscape(row.employee_share_rate || row.rate_or_amount || 0)}</td>
            <td>
              <span class="payroll-deduction-detail">Floor: ${money(row.minimum_salary_base || 0)}</span>
              <span class="payroll-deduction-detail">Ceiling: ${money(row.maximum_salary_ceiling || 0)}</span>
              <span class="payroll-deduction-detail">Cap: ${money(row.maximum_contribution_cap || 0)}</span>
            </td>
            <td>${payrollEscape(row.priority_order || 5)}</td>
            <td>${payrollEscape(row.apply_schedule)}</td>
            <td>${renderDeductionProration(row)}</td>
            <td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td>
            <td>${payrollEscape((row.effective_date || '').slice(0, 10))}</td>
            <td>
              ${row.computation_type === 'Table Lookup / Matrix Bracket' && /^sss(?:\b|\s|$)/i.test(String(row.name || '').trim()) ? `<button class="btn btn-outline btn-sm" type="button" onclick="openDeductionBracketManager()">SSS Brackets</button>` : ''}
              <button class="btn btn-outline btn-sm" type="button" onclick="deleteDeductionSetting(${Number(row.id)})">Delete</button>
            </td>
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
let payrollDeductionPickerListenersAttached = false;

async function ensureEmployeeDeductionDropdowns() {
  if (!payrollDeductionEmployees.length) {
    const res = await apiFetch('/api/employees');
    if (!res.ok) throw new Error('Failed to load employees');
    payrollDeductionEmployees = await res.json();
  }
  setupEmployeeDeductionPickers();
}

function employeeDeductionName(emp) {
  return emp.name || [emp.first_name, emp.middle_name, emp.last_name].filter(Boolean).join(' ') || emp.employee_name || `Employee ${emp.id}`;
}

function employeeDeductionCode(emp) {
  return emp.employee_code || emp.empCode || emp.code || '';
}

function employeeDeductionLabel(emp) {
  const code = employeeDeductionCode(emp);
  return `${code ? `${code} - ` : ''}${employeeDeductionName(emp)}`;
}

function employeeDeductionSearchText(emp) {
  return [
    employeeDeductionCode(emp),
    employeeDeductionName(emp),
    emp.department,
    emp.position,
  ].filter(Boolean).join(' ').toLowerCase();
}

function getPickerEmployeeById(employeeId) {
  return payrollDeductionEmployees.find(emp => String(emp.id) === String(employeeId));
}

function closeEmployeeDeductionPickers(exceptPicker = null) {
  document.querySelectorAll('.employee-deduction-picker').forEach(picker => {
    if (picker !== exceptPicker) {
      const results = picker.querySelector('.employee-deduction-results');
      if (results) results.hidden = true;
    }
  });
}

function selectEmployeeDeductionPicker(picker, employee) {
  const hidden = picker.querySelector('.employee-deduction-employee');
  const search = picker.querySelector('.employee-deduction-search');
  const results = picker.querySelector('.employee-deduction-results');
  if (hidden) hidden.value = employee?.id || '';
  if (search) search.value = employee ? employeeDeductionLabel(employee) : '';
  if (results) results.hidden = true;
}

function renderEmployeeDeductionPickerResults(picker, term = '') {
  const results = picker.querySelector('.employee-deduction-results');
  if (!results) return;
  const normalizedTerm = String(term || '').trim().toLowerCase();
  const matches = payrollDeductionEmployees
    .filter(emp => !normalizedTerm || employeeDeductionSearchText(emp).includes(normalizedTerm))
    .slice(0, 30);

  if (!matches.length) {
    results.innerHTML = '<div class="employee-deduction-empty">No employees found.</div>';
    results.hidden = false;
    return;
  }

  results.innerHTML = matches.map(emp => `
    <button type="button" class="employee-deduction-option" data-employee-id="${Number(emp.id)}">
      <span>${payrollEscape(employeeDeductionLabel(emp))}</span>
      <small>${payrollEscape([emp.department, emp.position].filter(Boolean).join(' · ') || 'No department details')}</small>
    </button>
  `).join('') + (payrollDeductionEmployees.length > matches.length
    ? '<div class="employee-deduction-empty">Keep typing to narrow the list.</div>'
    : '');
  results.hidden = false;
}

function setupEmployeeDeductionPickers() {
  document.querySelectorAll('.employee-deduction-picker').forEach(picker => {
    if (picker.dataset.ready === '1') return;
    picker.dataset.ready = '1';
    const hidden = picker.querySelector('.employee-deduction-employee');
    const search = picker.querySelector('.employee-deduction-search');
    const results = picker.querySelector('.employee-deduction-results');
    if (!hidden || !search || !results) return;

    search.addEventListener('focus', () => {
      closeEmployeeDeductionPickers(picker);
      renderEmployeeDeductionPickerResults(picker, search.value);
    });
    search.addEventListener('input', () => {
      hidden.value = '';
      renderEmployeeDeductionPickerResults(picker, search.value);
    });
    results.addEventListener('click', event => {
      const option = event.target.closest('.employee-deduction-option');
      if (!option) return;
      const employee = getPickerEmployeeById(option.dataset.employeeId);
      if (employee) selectEmployeeDeductionPicker(picker, employee);
    });
    picker.closest('form')?.addEventListener('reset', () => {
      window.setTimeout(() => selectEmployeeDeductionPicker(picker, null), 0);
    });
  });

  if (!payrollDeductionPickerListenersAttached) {
    payrollDeductionPickerListenersAttached = true;
    document.addEventListener('click', event => {
      if (!event.target.closest('.employee-deduction-picker')) closeEmployeeDeductionPickers();
    });
  }
}

async function loadEmployeeDeductionAccounts(type = 'all') {
  const grid = document.getElementById(type === 'cash_advance' ? 'cash-advance-grid' : type === 'loan' ? 'employee-loan-grid' : 'employee-deductions-grid');
  if (!grid) return;
  try {
    await ensureEmployeeDeductionDropdowns();
    const query = type && type !== 'all' ? `?type=${encodeURIComponent(type)}` : '';
    const res = await apiFetch(`/api/payroll/employee-deductions${query}`);
    if (!res.ok) throw new Error('Failed to load employee deductions');
    const rows = await res.json();
    grid.innerHTML = renderEmployeeDeductionAccounts(rows, type);
  } catch (err) {
    grid.innerHTML = `<div style="padding:30px; color:var(--red); text-align:center;">${err.message}</div>`;
  }
}

function renderEmployeeDeductionAccounts(rows, type) {
  if (!rows.length) {
    return `<div style="padding:30px; color:var(--muted); text-align:center;">No employee cash advances or loans assigned.</div>`;
  }
  const totalOriginal = rows.reduce((sum, row) => sum + Number(row.original_amount || 0), 0);
  const totalRemaining = rows.reduce((sum, row) => sum + Number(row.remaining_balance || 0), 0);
  const totalInstallment = rows
    .filter(row => row.status === 'Active')
    .reduce((sum, row) => sum + Number(row.installment_amount || 0), 0);
  const activeAccounts = rows.filter(row => row.status === 'Active').length;
  return `
    <div class="employee-deduction-summary">
      <div><span>Total Accounts</span><strong>${activeAccounts} active / ${rows.length}</strong></div>
      <div><span>Total Original</span><strong>${money(totalOriginal)}</strong></div>
      <div><span>Cash Advance + Loan Balance</span><strong>${money(totalRemaining)}</strong></div>
      <div><span>Active Installments</span><strong>${money(totalInstallment)}</strong></div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Type</th>
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
            <td>${payrollEscape(row.module_type || '-')}</td>
            <td>${payrollEscape(row.employee_code || '-')}</td>
            <td>${payrollEscape(row.employee_name || '-')}</td>
            <td>${money(row.original_amount)}</td>
            <td>${money(row.remaining_balance)}</td>
            <td>${money(row.installment_amount)}</td>
            <td>${(row.start_date || '').slice(0, 10)} - ${row.end_date ? String(row.end_date).slice(0, 10) : 'Open'}</td>
            <td>${payrollBadge(row.status)}</td>
            <td>
              <button class="btn btn-outline btn-sm" type="button" onclick='editEmployeeDeductionAccount(${JSON.stringify(row).replace(/'/g, '&#39;')}, "${row.module_type === 'Cash Advance' ? 'cash_advance' : 'loan'}")'>Edit</button>
              ${row.status === 'Active'
                ? `<button class="btn btn-outline btn-sm" type="button" onclick="updateEmployeeDeductionStatus(${row.id}, 'all', 'Paused')">Pause</button>`
                : `<button class="btn btn-outline btn-sm" type="button" onclick="updateEmployeeDeductionStatus(${row.id}, 'all', 'Active')">Activate</button>`}
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
  const picker = form.querySelector('.employee-deduction-picker');
  const employee = getPickerEmployeeById(row.employee_id) || {
    id: row.employee_id,
    employee_code: row.employee_code,
    employee_name: row.employee_name,
  };
  if (picker) selectEmployeeDeductionPicker(picker, employee);
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
    if (!data.employee_id) {
      throw new Error('Please search and select an employee.');
    }
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
    await loadEmployeeDeductionAccounts('all');
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
    await loadEmployeeDeductionAccounts(type || 'all');
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
    if (data.category === 'Government' && String(data.name || '').trim().toUpperCase() === 'SSS') {
      data.computation_type = 'Table Lookup / Matrix Bracket';
      data.rate_or_amount = 0;
      data.employee_share_rate = 0;
      data.employer_share_rate = 0;
      data.total_contribution_rate = 0;
      if (!data.priority_order || Number(data.priority_order) > 1) data.priority_order = 1;
    }
    if (data.category === 'Government' && /^(philhealth|pag-?ibig)$/i.test(String(data.name || '').trim())) {
      data.computation_type = 'Percentage';
      data.rate_or_amount = data.employee_share_rate || data.rate_or_amount || 0;
    }
    if (data.proration_mode === 'Calendar-Based Payroll Date Range') {
      delete data.fixed_divisor;
    } else if (data.proration_mode === 'Fixed Divisor' && !data.fixed_divisor) {
      const message = 'Enter a manual divisor before saving.';
      if (statusEl) {
        statusEl.className = 'payroll-form-status error';
        statusEl.textContent = message;
      }
      if (typeof showAlert === 'function') await showAlert(message, 'Manual Divisor Required', 'error');
      return;
    }
    if (data.percentage_rate && !data.rate_or_amount) data.rate_or_amount = data.percentage_rate;
    if (data.employee_share_percentage && !data.employee_share_rate) data.employee_share_rate = data.employee_share_percentage;
    if (data.employer_share_percentage && !data.employer_share_rate) data.employer_share_rate = data.employer_share_percentage;
    if (data.salary_floor && !data.minimum_salary_base) data.minimum_salary_base = data.salary_floor;
    if (data.salary_ceiling && !data.maximum_salary_ceiling) data.maximum_salary_ceiling = data.salary_ceiling;
    delete data.government_name;
    delete data.company_name;
    delete data.custom_name;
    delete data.percentage_rate;
    delete data.employee_share_percentage;
    delete data.employer_share_percentage;
    delete data.salary_floor;
    delete data.salary_ceiling;
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
  refreshSssContributionTableVisibility({ loadWhenVisible: true });
}

function canManagePayrollAttendancePolicies() {
  const role = String(typeof getUser === 'function' ? (getUser()?.role || '') : '').toLowerCase();
  return ['hr', 'hradmin', 'hr_admin', 'hr_manager', 'admin', 'system_admin'].includes(role);
}

function applyPayrollAttendancePolicyAccess() {
  const canManage = canManagePayrollAttendancePolicies();
  const card = document.getElementById('hr-payroll-policy-card');
  if (card) card.style.display = canManage ? '' : 'none';
  document.querySelectorAll('#payroll-policy-form input, #payroll-policy-form select, #payroll-attendance-config-form input, #payroll-attendance-config-form select').forEach(field => {
    field.disabled = !canManage;
  });
  document.querySelectorAll('#payroll-policy-form button[type="submit"], #payroll-attendance-config-form button[type="submit"], #payroll-attendance-config-form button[type="reset"]').forEach(button => {
    button.disabled = !canManage;
    button.style.display = canManage ? '' : 'none';
  });
  return canManage;
}

async function loadPayrollPolicySettings() {
  const form = document.getElementById('payroll-policy-form');
  const status = document.getElementById('payroll-policy-save-status');
  if (!form) return;
  if (!applyPayrollAttendancePolicyAccess()) return;
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
    await loadPayrollAttendanceConfigs();
  } catch (err) {
    if (status) {
      status.className = 'payroll-form-status error';
      status.textContent = err.message;
    }
  }
}

function toggleDeductionFormSections() {
  const category = document.getElementById('deduction-category')?.value || 'Government';
  const computationSelect = document.getElementById('deduction-computation-type');
  const rateInput = document.querySelector('#deduction-setting-form [name="rate_or_amount"]');
  const rateGroup = rateInput?.closest('.form-group');
  const prorationMode = document.getElementById('deduction-proration-mode')?.value || 'Calendar-Based Payroll Date Range';
  const fixedDivisorGroup = document.getElementById('deduction-fixed-divisor-group');
  const fixedDivisorInput = fixedDivisorGroup?.querySelector('[name="fixed_divisor"]');
  const calendarDivisorGroup = document.getElementById('deduction-calendar-divisor-group');
  const calendarDivisorHelp = document.getElementById('deduction-calendar-divisor-help');
  const applySchedule = document.getElementById('deduction-apply-schedule')?.value
    || document.querySelector('#deduction-setting-form [name="apply_schedule"]')?.value
    || '';
  const manualDivisor = prorationMode === 'Fixed Divisor';
  if (fixedDivisorGroup) fixedDivisorGroup.style.display = manualDivisor ? '' : 'none';
  if (fixedDivisorInput) {
    fixedDivisorInput.disabled = !manualDivisor;
    fixedDivisorInput.required = manualDivisor;
    if (!manualDivisor) fixedDivisorInput.value = '';
  }
  if (calendarDivisorGroup) calendarDivisorGroup.style.display = prorationMode === 'Calendar-Based Payroll Date Range' ? '' : 'none';
  if (calendarDivisorHelp) calendarDivisorHelp.textContent = calendarBasedDivisorText(applySchedule);
  const deductionName = String(getSelectedDeductionName()).trim();
  const sssSelected = isSssDeductionSelected();
  const percentageStatutorySelected = category === 'Government' && /^(philhealth|pag-?ibig)$/i.test(deductionName);
  if (sssSelected && computationSelect) {
    computationSelect.value = 'Table Lookup / Matrix Bracket';
    computationSelect.title = 'SSS uses the active SSS contribution matrix.';
  } else if (percentageStatutorySelected && computationSelect) {
    computationSelect.value = 'Percentage';
    computationSelect.title = `${deductionName} uses percentage-based monthly contribution limits.`;
  } else if (computationSelect) {
    computationSelect.title = '';
  }
  if (rateGroup) rateGroup.style.display = (sssSelected || percentageStatutorySelected) ? 'none' : '';
  if (rateInput && sssSelected) {
    rateInput.value = '0';
    rateInput.required = false;
  }
  if (rateInput && percentageStatutorySelected) rateInput.required = false;
  document.querySelectorAll('.deduction-statutory-section, .deduction-statutory-field').forEach(el => {
    el.style.display = percentageStatutorySelected ? '' : 'none';
  });
  document.querySelectorAll('.deduction-statutory-field input').forEach(input => {
    input.disabled = !percentageStatutorySelected;
  });
  const computationType = computationSelect?.value || '';
  const showBracket = computationType === 'Table Lookup / Matrix Bracket' && sssSelected;
  document.querySelectorAll('.deduction-bracket-section').forEach(el => { el.style.display = showBracket ? '' : 'none'; });
  refreshSssContributionTableVisibility({ loadWhenVisible: true });
}

let sssImportPreview = null;
let sssTableSummaryLoaded = false;

function getSelectedDeductionName() {
  const category = document.getElementById('deduction-category')?.value || 'Government';
  if (category === 'Government') return document.getElementById('deduction-government-name')?.value || '';
  if (category === 'Company') return document.getElementById('deduction-company-name')?.value || '';
  return document.getElementById('deduction-custom-name')?.value || '';
}

function isSssDeductionSelected() {
  const category = document.getElementById('deduction-category')?.value || 'Government';
  return category === 'Government' && String(getSelectedDeductionName()).trim().toUpperCase() === 'SSS';
}

function refreshSssContributionTableVisibility(options = {}) {
  const card = document.getElementById('sss-contribution-table-card');
  const summary = document.getElementById('sss-table-summary');
  if (!card) return false;

  const show = isSssDeductionSelected();
  card.style.display = show ? '' : 'none';

  if (!show) {
    sssTableSummaryLoaded = false;
    if (summary) summary.textContent = 'Select SSS as the deduction name to manage the SSS contribution table.';
    return false;
  }

  if (options.loadWhenVisible && !sssTableSummaryLoaded) {
    loadSssTableSummary();
  }
  return true;
}

function renderSssTableVersionSummary(rows) {
  const active = rows.find(row => row.status === 'Active');
  const drafts = rows.filter(row => row.status === 'Draft').length;
  const latest = active || rows[0];

  if (!rows.length) {
    return `
      <div class="payroll-empty-state">
        No SSS table versions have been imported yet.
        <div style="margin-top:10px;">
          <button class="btn btn-primary btn-sm" type="button" onclick="openDeductionBracketManager()">Import SSS Table</button>
        </div>
      </div>`;
  }

  return `
    <table>
      <thead><tr><th>Active Version</th><th>Effective Date</th><th>Rows</th><th>Drafts</th><th>Action</th></tr></thead>
      <tbody>
        <tr>
          <td>${active ? payrollEscape(active.version_name) : '<span class="muted-small">No active version</span>'}</td>
          <td>${active ? payrollEscape(String(active.effective_date || '').slice(0, 10)) : '-'}</td>
          <td>${active ? payrollEscape(active.row_count) : payrollEscape(latest?.row_count || 0)}</td>
          <td>${payrollEscape(drafts)}</td>
          <td><button class="btn btn-outline btn-sm" type="button" onclick="openDeductionBracketManager()">Review Versions</button></td>
        </tr>
      </tbody>
    </table>`;
}

async function loadSssTableSummary() {
  const target = document.getElementById('sss-table-summary');
  if (!target) return;
  if (!isSssDeductionSelected()) {
    refreshSssContributionTableVisibility();
    return;
  }
  target.textContent = 'Loading SSS table versions...';
  try {
    const res = await apiFetch('/api/payroll/sss-tables');
    const rows = await res.json().catch(() => []);
    if (!res.ok) throw new Error(rows.error || 'Failed to load SSS table versions.');
    target.innerHTML = renderSssTableVersionSummary(rows);
    sssTableSummaryLoaded = true;
  } catch (err) {
    target.innerHTML = `
      <div class="payroll-empty-state">
        SSS table versions are not ready yet. Run the SSS table migration, then import the contribution table.
      </div>`;
    sssTableSummaryLoaded = false;
  }
}

function renderSssImportPreview(preview) {
  const columns = [
    'row_number', 'compensation_from', 'compensation_to', 'regular_ss_msc', 'ec_msc', 'mpf_msc',
    'total_msc', 'employer_regular_ss', 'employer_mpf', 'employer_ec', 'employer_total',
    'employee_regular_ss', 'employee_mpf', 'employee_total', 'grand_total_contribution'
  ];
  const labels = {
    row_number: 'Row', compensation_from: 'From', compensation_to: 'To', regular_ss_msc: 'Regular MSC',
    ec_msc: 'EC MSC', mpf_msc: 'MPF MSC', total_msc: 'Total MSC', employer_regular_ss: 'Employer SS',
    employer_mpf: 'Employer MPF', employer_ec: 'Employer EC', employer_total: 'Employer Total',
    employee_regular_ss: 'Employee SS', employee_mpf: 'Employee MPF', employee_total: 'Employee Total',
    grand_total_contribution: 'Grand Total'
  };
  return `
    <div class="table-wrap" style="max-height:300px; overflow:auto; margin-top:12px;">
      <table>
        <thead><tr>${columns.map(column => `<th>${labels[column]}</th>`).join('')}<th>Validation</th></tr></thead>
        <tbody>${preview.rows.map(row => `
          <tr>
            ${columns.map(column => `<td>${payrollEscape(row[column] ?? '')}</td>`).join('')}
            <td>${row.valid
              ? `<span class="status-badge approved">Valid</span>${row.warnings.length ? `<div class="muted-small">${payrollEscape(row.warnings.join('; '))}</div>` : ''}`
              : `<span class="status-badge rejected">Invalid</span><div class="muted-small">${payrollEscape(row.errors.join('; '))}</div>`}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function loadSssTableVersions() {
  const target = document.getElementById('sss-table-versions');
  if (!target) return;
  target.textContent = 'Loading SSS table versions...';
  try {
    const res = await apiFetch('/api/payroll/sss-tables');
    const rows = await res.json().catch(() => []);
    if (!res.ok) throw new Error(rows.error || 'Failed to load SSS table versions.');
    target.innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Version</th><th>Effective</th><th>Status</th><th>Rows</th><th>Actions</th></tr></thead><tbody>
          ${rows.map(row => `<tr>
            <td>${payrollEscape(row.version_name)}</td>
            <td>${payrollEscape(String(row.effective_date || '').slice(0, 10))}</td>
            <td>${payrollBadge(row.status)}</td>
            <td>${payrollEscape(row.row_count)}</td>
            <td>${renderSssTableVersionActions(row)}</td>
          </tr>`).join('')}
        </tbody></table></div>`
      : '<div class="payroll-empty-state">No SSS table versions have been imported yet.</div>';
  } catch (err) {
    target.innerHTML = `<div class="payroll-form-status error">${payrollEscape(err.message)}</div>`;
  }
}

function canManageSssTables() {
  if (typeof getUser !== 'function') return false;
  const role = getUser()?.role;
  return ['payroll_manager', 'hr_manager', 'hr_admin', 'admin', 'system_admin'].includes(role);
}

function renderSssTableVersionActions(row) {
  const status = String(row.status || '');
  const viewButton = `<button class="btn btn-outline btn-sm" type="button" onclick="viewSssTableRows(${Number(row.id)})">View Rows</button>`;
  if (status === 'Active') return `${viewButton} <span class="muted-small">Current active table</span>`;
  if (status !== 'Draft') return viewButton;
  if (!canManageSssTables()) return `${viewButton} <span class="muted-small">Manager/Admin only</span>`;
  return `${viewButton} <button class="btn btn-primary btn-sm" type="button" onclick="activateSssTableVersion(${Number(row.id)})">Activate Version</button>`;
}

async function downloadSssImportTemplate() {
  try {
    const res = await apiFetch('/api/payroll/sss-tables/template');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to download the SSS import template.');
    }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'sss-table-import-template.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  } catch (err) {
    if (typeof showAlert === 'function') showAlert(err.message, 'SSS Table', 'error');
    else alert(err.message);
  }
}

async function previewSssTableImport() {
  const fileInput = document.getElementById('sss-table-import-file');
  const status = document.getElementById('sss-import-status');
  const previewTarget = document.getElementById('sss-import-preview');
  const file = fileInput?.files?.[0];
  if (!file) {
    status.textContent = 'Choose a CSV or XLSX file first.';
    status.className = 'payroll-form-status error';
    return;
  }
  status.textContent = 'Validating import file...';
  status.className = 'payroll-form-status';
  previewTarget.innerHTML = '';
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiFetch('/api/payroll/sss-tables/preview', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to validate SSS import file.');
    sssImportPreview = data;
    status.textContent = data.has_invalid_rows
      ? `${data.invalid_row_count} invalid row(s). Fix the file before saving a draft.`
      : `${data.rows.length} row(s) validated${data.warning_count ? ` with ${data.warning_count} warning(s)` : ''}.`;
    status.className = `payroll-form-status ${data.has_invalid_rows ? 'error' : 'success'}`;
    previewTarget.innerHTML = renderSssImportPreview(data);
  } catch (err) {
    sssImportPreview = null;
    status.textContent = err.message;
    status.className = 'payroll-form-status error';
  }
}

async function ensureSssImportPreview() {
  if (sssImportPreview && !sssImportPreview.has_invalid_rows) return sssImportPreview;
  await previewSssTableImport();
  if (!sssImportPreview || sssImportPreview.has_invalid_rows) return null;
  return sssImportPreview;
}

async function saveSssTableDraft() {
  const status = document.getElementById('sss-import-status');
  const versionName = document.getElementById('sss-table-version-name')?.value.trim();
  const effectiveDate = document.getElementById('sss-table-effective-date')?.value;
  if (!versionName || !effectiveDate) {
    status.textContent = 'Version name and effective date are required.';
    status.className = 'payroll-form-status error';
    return;
  }
  try {
    const preview = await ensureSssImportPreview();
    if (!preview) {
      status.textContent = 'The selected SSS table could not be validated. Check the preview errors before saving.';
      status.className = 'payroll-form-status error';
      return;
    }
    status.textContent = 'Saving draft...';
    status.className = 'payroll-form-status';
    const res = await apiFetch('/api/payroll/sss-tables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version_name: versionName,
        effective_date: effectiveDate,
        source_filename: preview.filename,
        rows: preview.rows
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save SSS table draft.');
    status.textContent = `Draft saved with ${data.row_count} row(s). Activate it when ready.`;
    status.className = 'payroll-form-status success';
    sssImportPreview = null;
    document.getElementById('sss-import-preview').innerHTML = '';
    document.getElementById('sss-table-import-file').value = '';
    await loadSssTableVersions();
    await loadSssTableSummary();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'payroll-form-status error';
  }
}

async function activateSssTableVersion(versionId) {
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Activating this SSS table will archive the current active version. Future payroll runs will use the new table. Continue?', 'Activate SSS Table', 'Activate', 'Cancel')
    : window.confirm('Activating this SSS table will archive the current active version. Future payroll runs will use the new table. Continue?');
  if (!confirmed) return;
  try {
    const res = await apiFetch(`/api/payroll/sss-tables/${Number(versionId)}/activate`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to activate SSS table version.');
    await loadSssTableVersions();
    await loadSssTableSummary();
    if (typeof showAlert === 'function') await showAlert('SSS table version activated.', 'SSS Table', 'success');
  } catch (err) {
    if (typeof showAlert === 'function') showAlert(err.message, 'SSS Table', 'error');
    else alert(err.message);
  }
}

async function viewSssTableRows(versionId) {
  try {
    const res = await apiFetch(`/api/payroll/sss-tables/${Number(versionId)}/rows`);
    const rows = await res.json().catch(() => []);
    if (!res.ok) throw new Error(rows.error || 'Failed to load SSS table rows.');
    const previewTarget = document.getElementById('sss-import-preview');
    previewTarget.innerHTML = renderSssImportPreview({ rows: rows.map((row, index) => ({ ...row, row_number: index + 1, valid: true, errors: [], warnings: [] })) });
  } catch (err) {
    if (typeof showAlert === 'function') showAlert(err.message, 'SSS Table', 'error');
    else alert(err.message);
  }
}

function openDeductionBracketManager() {
  document.getElementById('sss-table-manager-modal')?.remove();
  const today = window.LGSVDatePicker?.todayValue?.() || dateInputValue(new Date());
  const versionLabel = `SSS Table ${today.slice(0, 4)}`;
  const modal = document.createElement('div');
  modal.id = 'sss-table-manager-modal';
  modal.className = 'erp-modal-backdrop';
  modal.innerHTML = `
    <section class="erp-modal sss-table-modal" role="dialog" aria-modal="true" aria-labelledby="sss-table-manager-title">
      <div class="erp-modal-head">
        <div>
          <h2 id="sss-table-manager-title">SSS Bracket Table Management</h2>
          <p>Import an official contribution table, validate it, save a draft, then activate it.</p>
        </div>
        <button class="erp-modal-close" type="button" aria-label="Close" onclick="document.getElementById('sss-table-manager-modal')?.remove()">×</button>
      </div>
      <div class="sss-table-modal-body">
        <div class="form-grid">
          <div class="form-group"><label>Version Name</label><input id="sss-table-version-name" value="${versionLabel}" placeholder="SSS Table 2026" /></div>
          <div class="form-group"><label>Effective Date</label><input id="sss-table-effective-date" type="date" value="${today}" /></div>
          <div class="form-group span-2"><label>SSS Table File</label><input id="sss-table-import-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" /></div>
        </div>
        <div class="form-actions"><span id="sss-import-status" class="payroll-form-status" aria-live="polite"></span><button class="btn btn-outline" type="button" onclick="downloadSssImportTemplate()">Download Template</button><button class="btn btn-outline" type="button" onclick="previewSssTableImport()">Preview Imported Rows</button><button class="btn btn-primary" type="button" onclick="saveSssTableDraft()">Save as Draft</button></div>
        <div id="sss-import-preview"></div>
        <div class="sss-table-versions-panel"><h3>SSS Table Versions</h3><div id="sss-table-versions"></div></div>
      </div>
    </section>`;
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
  loadSssTableVersions();
}

async function savePayrollPolicySettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('payroll-policy-save-status');
  if (!applyPayrollAttendancePolicyAccess()) {
    if (status) {
      status.className = 'payroll-form-status';
      status.textContent = '';
    }
    return;
  }
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

function payrollDateKey(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function payrollSelectOptions(rows, valueKey, labelFn, placeholder) {
  return `<option value="">${payrollEscape(placeholder || 'Select')}</option>${(rows || []).map(row => {
    const value = row?.[valueKey];
    return `<option value="${payrollEscape(value)}">${payrollEscape(labelFn(row))}</option>`;
  }).join('')}`;
}

function togglePayrollAttendanceConfigScope() {
  const scope = document.getElementById('payroll-att-config-scope')?.value || 'DEFAULT';
  document.querySelectorAll('.payroll-att-config-scope').forEach(el => { el.style.display = 'none'; });
  const map = {
    DEPARTMENT: '.payroll-att-config-department',
    EMPLOYMENT_TYPE: '.payroll-att-config-employment',
    WAGE_TYPE: '.payroll-att-config-wage',
    EMPLOYEE: '.payroll-att-config-employee'
  };
  if (map[scope]) document.querySelectorAll(map[scope]).forEach(el => { el.style.display = ''; });
  renderPayrollAttendanceConfigOptions();
}

function renderPayrollAttendanceConfigOptions() {
  const department = document.getElementById('payroll-att-config-department');
  const employment = document.getElementById('payroll-att-config-employment');
  const wageType = document.getElementById('payroll-att-config-wage-type');
  const employee = document.getElementById('payroll-att-config-employee');
  const selectedDepartment = department?.value || '';
  const selectedEmployment = employment?.value || '';
  const selectedWageType = wageType?.value || '';
  const selectedEmployee = employee?.value || '';
  if (department) {
    department.innerHTML = payrollSelectOptions(payrollAttendanceConfigOptions.departments, 'id', row => row.name, 'Select department');
    if ([...department.options].some(option => option.value === selectedDepartment)) department.value = selectedDepartment;
  }
  if (employment) {
    employment.innerHTML = `<option value="">Select employment type</option>${(payrollAttendanceConfigOptions.employment_types || []).map(value => `<option value="${payrollEscape(value)}">${payrollEscape(value)}</option>`).join('')}`;
    if ([...employment.options].some(option => option.value === selectedEmployment)) employment.value = selectedEmployment;
  }
  if (wageType) {
    wageType.innerHTML = payrollSelectOptions(payrollAttendanceConfigOptions.pay_types, 'id', row => row.name, 'Select wage type');
    if ([...wageType.options].some(option => option.value === selectedWageType)) wageType.value = selectedWageType;
  }
  if (employee) {
    const scope = document.getElementById('payroll-att-config-scope')?.value || 'DEFAULT';
    let employeeRows = payrollAttendanceConfigOptions.employees || [];
    if (scope === 'DEPARTMENT' && department?.value) {
      employeeRows = employeeRows.filter(row => String(row.department_id || '') === String(department.value));
    }
    if (scope === 'EMPLOYMENT_TYPE' && employment?.value) {
      employeeRows = employeeRows.filter(row => String(row.employment_type || '').toLowerCase() === String(employment.value).toLowerCase());
    }
    if (scope === 'WAGE_TYPE' && wageType?.value) {
      employeeRows = employeeRows.filter(row => String(row.wage_type_id || '') === String(wageType.value));
    }
    employee.innerHTML = payrollSelectOptions(
      employeeRows,
      'id',
      row => `${row.employee_code || ''} - ${row.employee_name || row.first_name || row.last_name || 'Employee'}`,
      'Select employee'
    );
    if ([...employee.options].some(option => option.value === selectedEmployee)) employee.value = selectedEmployee;
  }
}

function payrollAttendanceConfigScopeLabel(row) {
  const scope = row.scope_type || 'DEFAULT';
  if (scope === 'EMPLOYEE') return `Employee: ${row.employee_code || row.employee_id || '-'}`;
  if (scope === 'DEPARTMENT') return `Department: ${row.department_name || row.department_id || '-'}`;
  if (scope === 'WAGE_TYPE') return `Wage Type: ${row.wage_type_name || row.wage_type_id || '-'}`;
  if (scope === 'EMPLOYMENT_TYPE') return `Employment Type: ${row.scope_value || '-'}`;
  return 'Default fallback';
}

function renderPayrollAttendanceConfigs() {
  const grid = document.getElementById('payroll-attendance-config-grid');
  if (!grid) return;
  const canManage = canManagePayrollAttendancePolicies();
  if (!payrollAttendanceConfigRows.length) {
    grid.innerHTML = '<div class="empty-state">No employee or group payroll configurations yet.</div>';
    return;
  }
  grid.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th><th>Scope</th><th>Schedule</th><th>Factor</th><th>Tardy Trigger</th><th>Status</th><th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${payrollAttendanceConfigRows.map(row => `
          <tr>
            <td>${payrollEscape(row.config_name)}</td>
            <td>${payrollEscape(payrollAttendanceConfigScopeLabel(row))}</td>
            <td>${payrollEscape((row.work_start_time || '-').slice(0, 5))} - ${payrollEscape((row.work_end_time || '-').slice(0, 5))}<br><small>${payrollEscape(Number(row.daily_hours || row.standard_work_hours || 0).toFixed(2))}h/day</small></td>
            <td>${payrollEscape(row.working_days_per_year || '-')} days/year<br><small>${payrollEscape(row.working_days_per_month || '-')} days/month</small></td>
            <td>${payrollEscape(row.habitual_tardiness_threshold || 5)} per ${payrollEscape(String(row.habitual_tardiness_period || 'MONTHLY').toLowerCase().replace('_', ' '))}</td>
            <td>${Number(row.is_active) === 1 ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Inactive</span>'}</td>
            <td>
              ${canManage ? `<button class="btn btn-outline btn-sm" type="button" onclick="editPayrollAttendanceConfig(${Number(row.id)})">Edit</button>` : '<span class="muted-small">View only</span>'}
              ${canManage && Number(row.is_active) === 1 ? `<button class="btn btn-outline btn-sm" type="button" onclick="deactivatePayrollAttendanceConfig(${Number(row.id)})">Deactivate</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function loadPayrollAttendanceConfigs() {
  const status = document.getElementById('payroll-att-config-status');
  if (!applyPayrollAttendancePolicyAccess()) return;
  try {
    const [optionsRes, configsRes] = await Promise.all([
      apiFetch('/api/payroll/filter-options'),
      apiFetch('/api/payroll/attendance-configurations')
    ]);
    const options = await optionsRes.json().catch(() => ({}));
    const configs = await configsRes.json().catch(() => []);
    if (!optionsRes.ok) throw new Error(options.error || 'Failed to load payroll options.');
    if (!configsRes.ok) throw new Error(configs.error || 'Failed to load payroll attendance configurations.');
    payrollAttendanceConfigOptions = options || payrollAttendanceConfigOptions;
    payrollAttendanceConfigRows = Array.isArray(configs) ? configs : [];
    renderPayrollAttendanceConfigOptions();
    renderPayrollAttendanceConfigs();
    togglePayrollAttendanceConfigScope();
    if (status && !status.textContent) status.textContent = 'Configuration list loaded.';
  } catch (err) {
    if (status) {
      status.className = 'payroll-form-status error';
      status.textContent = err.message;
    }
  }
}

async function savePayrollAttendanceConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('payroll-att-config-status');
  if (!applyPayrollAttendancePolicyAccess()) {
    if (status) {
      status.className = 'payroll-form-status';
      status.textContent = '';
    }
    return;
  }
  const payload = Object.fromEntries(new FormData(form).entries());
  if (!payload.working_days_per_month && payload.working_days_per_year) {
    payload.working_days_per_month = (Number(payload.working_days_per_year) / 12).toFixed(2);
  }
  if (status) {
    status.className = 'payroll-form-status';
    status.textContent = 'Saving...';
  }
  try {
    const res = await apiFetch('/api/payroll/attendance-configurations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save payroll attendance configuration.');
    resetPayrollAttendanceConfigForm();
    await loadPayrollAttendanceConfigs();
    if (status) {
      status.className = 'payroll-form-status success';
      status.textContent = 'Payroll attendance configuration saved.';
    }
  } catch (err) {
    if (status) {
      status.className = 'payroll-form-status error';
      status.textContent = err.message;
    }
  }
}

function editPayrollAttendanceConfig(id) {
  if (!canManagePayrollAttendancePolicies()) return;
  const row = payrollAttendanceConfigRows.find(item => Number(item.id) === Number(id));
  const form = document.getElementById('payroll-attendance-config-form');
  if (!row || !form) return;
  Object.entries({
    id: row.id,
    config_name: row.config_name,
    scope_type: row.scope_type,
    employee_id: row.employee_id,
    department_id: row.department_id,
    wage_type_id: row.wage_type_id,
    scope_value: row.scope_value,
    work_start_time: String(row.work_start_time || '').slice(0, 5),
    work_end_time: String(row.work_end_time || '').slice(0, 5),
    break_start_time: String(row.break_start_time || '').slice(0, 5),
    break_end_time: String(row.break_end_time || '').slice(0, 5),
    daily_hours: row.daily_hours || row.standard_work_hours,
    working_days_per_month: row.working_days_per_month,
    working_days_per_year: row.working_days_per_year,
    grace_period_minutes: row.grace_period_minutes,
    habitual_tardiness_threshold: row.habitual_tardiness_threshold,
    tardiness_alert_enabled: Number(row.tardiness_alert_enabled) === 1 ? 'true' : 'false',
    priority: row.priority || 0,
    effective_date: payrollDateKey(row.effective_date),
    end_date: payrollDateKey(row.end_date),
    is_active: Number(row.is_active) === 1 ? 'true' : 'false',
    notes: row.notes || ''
  }).forEach(([name, value]) => {
    const field = form.elements[name];
    if (field) field.value = value ?? '';
  });
  togglePayrollAttendanceConfigScope();
  document.getElementById('payroll-att-config-status').textContent = 'Editing existing configuration.';
}

async function deactivatePayrollAttendanceConfig(id) {
  if (!canManagePayrollAttendancePolicies()) return;
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Deactivate this payroll attendance configuration?', 'Deactivate Attendance Policy', 'Deactivate', 'Cancel')
    : window.confirm('Deactivate this payroll attendance configuration?');
  if (!confirmed) return;
  const status = document.getElementById('payroll-att-config-status');
  try {
    const res = await apiFetch(`/api/payroll/attendance-configurations/${Number(id)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to deactivate configuration.');
    await loadPayrollAttendanceConfigs();
    if (status) {
      status.className = 'payroll-form-status success';
      status.textContent = 'Configuration deactivated.';
    }
  } catch (err) {
    if (status) {
      status.className = 'payroll-form-status error';
      status.textContent = err.message;
    }
  }
}

function resetPayrollAttendanceConfigForm() {
  const form = document.getElementById('payroll-attendance-config-form');
  if (!form) return;
  form.reset();
  form.elements.id.value = '';
  const today = window.LGSVDatePicker?.todayValue?.() || dateInputValue(new Date());
  if (form.elements.effective_date) form.elements.effective_date.value = today;
  togglePayrollAttendanceConfigScope();
}

async function loadPayrollAudit() {
  const grid = document.getElementById('payroll-audit-grid');
  if (!grid) return;
  try {
    const res = await apiFetch('/api/payroll/audit');
    if (!res.ok) throw new Error('Failed to load payroll audit trail');
    payrollAuditRows = await res.json();
    if (!Array.isArray(payrollAuditRows)) payrollAuditRows = [];
    payrollAuditPage = 1;
    renderPayrollAudit();
  } catch (err) {
    payrollAuditRows = [];
    grid.innerHTML = `<div style="padding:30px; color:var(--red); text-align:center;">${payrollEscape(err.message)}</div>`;
  }
}

function renderPayrollAudit() {
  const grid = document.getElementById('payroll-audit-grid');
  if (!grid) return;
  const rows = Array.isArray(payrollAuditRows) ? payrollAuditRows : [];
  const totalRows = rows.length;
  if (!totalRows) {
      grid.innerHTML = '<div style="padding:30px; color:var(--muted); text-align:center;">No payroll audit activity yet.</div>';
      return;
  }
  const totalPages = Math.max(1, Math.ceil(totalRows / PAYROLL_AUDIT_PAGE_SIZE));
  payrollAuditPage = Math.min(Math.max(Number(payrollAuditPage || 1), 1), totalPages);
  const startIndex = (payrollAuditPage - 1) * PAYROLL_AUDIT_PAGE_SIZE;
  const pageRows = rows.slice(startIndex, startIndex + PAYROLL_AUDIT_PAGE_SIZE);
  const start = startIndex + 1;
  const end = Math.min(startIndex + PAYROLL_AUDIT_PAGE_SIZE, totalRows);

  grid.innerHTML = `
      <div class="audit-trail-table-wrap">
      <table class="payroll-erp-table" data-no-pagination="1">
        <thead><tr><th>Date/Time</th><th>User</th><th>Role</th><th>Action</th><th>Employee</th><th>Remarks</th><th>Details</th></tr></thead>
        <tbody>
          ${pageRows.map(row => `
            <tr>
              <td>${payrollEscape(row.created_at ? formatPayrollDateTime(row.created_at) : '-')}</td>
              <td>${payrollEscape(row.username || '-')}</td>
              <td>${payrollEscape(payrollAuditRoleLabel(row.user_role))}</td>
              <td>${payrollEscape(payrollAuditActionLabel(row.action))}</td>
              <td>${payrollEscape(row.employee_name || row.employee_code || '-')}</td>
              <td>${payrollEscape(row.remarks || '-')}</td>
              <td>${payrollEscape(payrollAuditDetails(row.metadata))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      <div class="audit-trail-pagination" aria-live="polite">
        <span class="audit-trail-pagination-summary">Showing ${start}-${end} of ${totalRows}</span>
        <div class="audit-trail-pagination-actions">
          <button class="btn btn-outline btn-sm" type="button" onclick="setPayrollAuditPage(${payrollAuditPage - 1})" ${payrollAuditPage <= 1 ? 'disabled' : ''}>Previous</button>
          <span class="audit-trail-pagination-page">Page ${payrollAuditPage} of ${totalPages}</span>
          <button class="btn btn-outline btn-sm" type="button" onclick="setPayrollAuditPage(${payrollAuditPage + 1})" ${payrollAuditPage >= totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;
}

function setPayrollAuditPage(page) {
  payrollAuditPage = Number(page) || 1;
  renderPayrollAudit();
}

function formatPayrollDateTime(value) {
  if (typeof formatPhilippineDateTime === 'function') {
    return formatPhilippineDateTime(value, { timeStyle: 'short' });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '-');
  return `${date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })} PHT`;
}

function payrollAuditRoleLabel(role) {
  const labels = {
    payroll_officer: 'Payroll Officer',
    payroll_manager: 'Payroll Manager',
    hr_manager: 'HR Manager',
    hr_admin: 'HR Admin',
    system_admin: 'System Administrator',
    admin: 'System Administrator',
    employee: 'Regular Employee',
  };
  const key = String(role || '').trim().toLowerCase();
  return labels[key] || titleCasePayrollAudit(key.replace(/_/g, ' ')) || '-';
}

function payrollAuditActionLabel(action) {
  const labels = {
    per_piece_payroll_batch_generated: 'Per-Piece Payroll Batch Generated',
    salary_calculation_generated: 'Payroll Record Generated',
    salary_calculation_generated_for_review: 'Payroll Record Generated for Review',
    payroll_generated: 'Payroll Generated',
    payroll_submitted_for_approval: 'Payroll Submitted for Approval',
    payroll_approved: 'Payroll Approved',
    payroll_released: 'Payroll Released',
    payroll_locked: 'Payroll Locked',
    payslip_generated: 'Payslip Preview Generated',
    payslip_exported: 'Payslip Exported',
    payslip_printed: 'Payslip Printed',
    piece_rate_configuration_saved: 'Piece Rate Configuration Saved',
    piece_rate_daily_output_encoded: 'Piece-Rate Output Encoded',
    piece_rate_daily_output_updated: 'Piece-Rate Output Updated',
    piece_rate_daily_output_deleted: 'Piece-Rate Output Deleted',
    production_output_approved: 'Production Output Approved',
    production_output_rejected: 'Production Output Rejected',
    production_output_submitted: 'Production Output Submitted',
    PAYROLL_CLEARANCE_VIEWED: 'Payroll Clearance Viewed',
    PAYROLL_CLEARANCE_UPDATED: 'Payroll Clearance Updated',
    PAYROLL_CLEARANCE_MARKED_WITH_ISSUE: 'Payroll Clearance Marked With Issue',
    FINAL_PAY_APPROVED: 'Final Pay Approved',
    FINAL_PAY_RELEASED: 'Final Pay Released',
    deduction_setting_updated: 'Deduction Setting Saved',
    deduction_setting_deleted: 'Deduction Setting Deleted',
    allowance_setting_updated: 'Allowance Setting Saved',
    employee_deduction_created: 'Cash Advance / Loan Created',
    employee_deduction_updated: 'Cash Advance / Loan Updated',
    employee_deduction_status_changed: 'Cash Advance / Loan Status Updated',
  };
  const raw = String(action || '').trim();
  return labels[raw] || titleCasePayrollAudit(raw.replace(/_/g, ' ')) || '-';
}

function titleCasePayrollAudit(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function payrollAuditDetails(metadata) {
  if (!metadata) return '-';
  let parsed = metadata;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata);
    } catch (_) {
      return '-';
    }
  }
  if (!parsed || typeof parsed !== 'object') return String(parsed || '-');
  const details = [];
  if (parsed.processedCount !== undefined) details.push(`${Number(parsed.processedCount || 0)} employee(s) processed`);
  if (parsed.skippedCount !== undefined) details.push(`${Number(parsed.skippedCount || 0)} employee(s) skipped`);
  if (parsed.source_type) details.push(`Source: ${titleCasePayrollAudit(String(parsed.source_type).replace(/_/g, ' '))}`);
  if (parsed.reference_no) details.push(`Reference No.: ${parsed.reference_no}`);
  if (parsed.piece_rate_output_id || parsed.id) details.push(`Record ID: ${parsed.piece_rate_output_id || parsed.id}`);
  if (parsed.gross_pay !== undefined) details.push(`Gross Pay: ${money(parsed.gross_pay)}`);
  if (parsed.net_pay !== undefined) details.push(`Net Pay: ${money(parsed.net_pay)}`);

  const oldValue = parsed.old_value;
  const newValue = parsed.new_value;
  if (oldValue && newValue) {
    details.push(`Changed from ${payrollAuditCompactValue(oldValue)} to ${payrollAuditCompactValue(newValue)}`);
  } else if (newValue) {
    details.push(`New value: ${payrollAuditCompactValue(newValue)}`);
  } else if (oldValue) {
    details.push(`Previous value: ${payrollAuditCompactValue(oldValue)}`);
  }

  return details.join('. ') || '-';
}

function payrollAuditCompactValue(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value !== 'object') return String(value);
  const preferred = ['sew_type_code', 'size_range', 'piece_rate', 'effective_date', 'status', 'name', 'amount', 'rate', 'quantity_produced'];
  const parts = preferred
    .filter(key => value[key] !== undefined && value[key] !== null && value[key] !== '')
    .map(key => `${titleCasePayrollAudit(key.replace(/_/g, ' '))}: ${value[key]}`);
  return parts.length ? parts.join(', ') : 'updated record values';
}

function initializePayrollModule() {
  enforcePayslipActionVisibility();
  const weeklyPayrollForm = document.getElementById('weekly-payroll-form');
  if (weeklyPayrollForm) weeklyPayrollForm.noValidate = true;
  const monthInput = document.getElementById('payroll-filter-month');
  if (monthInput && !monthInput.value) {
    const today = new Date();
    monthInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  }
  setDefaultWeeklyPayrollDates();

  const deductionDate = document.querySelector('#deduction-setting-form [name="effective_date"]');
  const splitDate = document.querySelector('#production-split-form [name="effective_date"]');
  const today = window.LGSVDatePicker?.todayValue?.() || dateInputValue(new Date());
  if (deductionDate && !deductionDate.value) deductionDate.value = today;
  if (splitDate && !splitDate.value) splitDate.value = today;
  const attConfigDate = document.querySelector('#payroll-attendance-config-form [name="effective_date"]');
  if (attConfigDate && !attConfigDate.value) attConfigDate.value = today;
  validateWeeklyPayrollDates({ adjustEnd: true });
  const weeklyDepartment = document.getElementById('weekly-payroll-department');
  const weeklyPayType = document.getElementById('weekly-payroll-pay-type');
  const weeklyEmployee = document.getElementById('weekly-payroll-employee');
  const weeklyFrequency = document.getElementById('weekly-payroll-frequency');
  const weeklyStart = document.getElementById('weekly-payroll-start');
  const weeklyEnd = document.getElementById('weekly-payroll-end');
  if (weeklyStart && !weeklyStart.dataset.dateGuardBound) {
    weeklyStart.addEventListener('change', () => {
      syncWeeklyPayrollEndDate();
      validateWeeklyPayrollDates();
      loadWeeklyPayrollRegistry();
    });
    weeklyStart.dataset.dateGuardBound = '1';
  }
  if (weeklyFrequency && !weeklyFrequency.dataset.dateGuardBound) {
    weeklyFrequency.addEventListener('change', () => {
      if (weeklyFrequency.value === 'Weekly') syncWeeklyPayrollEndDate();
      validateWeeklyPayrollDates();
      loadWeeklyPayrollRegistry();
    });
    weeklyFrequency.dataset.dateGuardBound = '1';
  }
  if (weeklyEnd && !weeklyEnd.dataset.dateGuardBound) {
    weeklyEnd.addEventListener('change', () => {
      validateWeeklyPayrollDates();
      loadWeeklyPayrollRegistry();
    });
    weeklyEnd.dataset.dateGuardBound = '1';
  }
  if (weeklyDepartment && !weeklyDepartment.dataset.employeeFilterBound) {
    weeklyDepartment.addEventListener('change', () => {
      if (weeklyEmployee) weeklyEmployee.value = '';
      renderWeeklyPayrollEmployeeOptions();
      loadWeeklyPayrollRegistry();
    });
    weeklyDepartment.dataset.employeeFilterBound = '1';
  }
  if (weeklyPayType && !weeklyPayType.dataset.employeeFilterBound) {
    weeklyPayType.addEventListener('change', () => {
      if (weeklyEmployee) weeklyEmployee.value = '';
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
  toggleDeductionFormSections();
  document.getElementById('deduction-setting-form')?.addEventListener('reset', () => {
    window.setTimeout(() => {
      toggleDeductionNameField();
      toggleDeductionFormSections();
    }, 0);
  });
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
window.setPayrollRecordWorkflowFilter = setPayrollRecordWorkflowFilter;
window.setPayrollRecordSearch = setPayrollRecordSearch;
window.setPayrollRecordDepartmentFilter = setPayrollRecordDepartmentFilter;
window.setPayrollRecordWageFilter = setPayrollRecordWageFilter;
window.clearPayrollRecordFilters = clearPayrollRecordFilters;
window.showCalculationBreakdown = showCalculationBreakdown;
window.togglePayrollActionMenu = togglePayrollActionMenu;
window.closePayrollActionMenus = closePayrollActionMenus;
window.continueSalaryDraft = continueSalaryDraft;
window.generatePayslipsFromRecords = generatePayslipsFromRecords;
window.approveSalaryCalculation = approveSalaryCalculation;
window.recordApprovedPayrollOnBlockchain = recordApprovedPayrollOnBlockchain;
window.generatePayslipPreview = generatePayslipPreview;
window.exportPayslipPdf = exportPayslipPdf;
window.switchPayrollTab = switchPayrollTab;
window.loadOffboardingClearance = loadOffboardingClearance;
window.openPayrollClearanceReview = openPayrollClearanceReview;
window.submitPayrollClearance = submitPayrollClearance;
window.loadFinalPayApprovals = loadFinalPayApprovals;
window.openFinalPayReview = openFinalPayReview;
window.submitFinalPayApproval = submitFinalPayApproval;
window.refreshPayrollDashboard = refreshPayrollDashboard;
window.loadPayrollSettings = loadPayrollSettings;
window.savePayrollSetting = savePayrollSetting;
window.deleteDeductionSetting = deleteDeductionSetting;
window.toggleDeductionNameField = toggleDeductionNameField;
window.toggleDeductionFormSections = toggleDeductionFormSections;
window.openDeductionBracketManager = openDeductionBracketManager;
window.loadSssTableSummary = loadSssTableSummary;
window.downloadSssImportTemplate = downloadSssImportTemplate;
window.previewSssTableImport = previewSssTableImport;
window.saveSssTableDraft = saveSssTableDraft;
window.activateSssTableVersion = activateSssTableVersion;
window.viewSssTableRows = viewSssTableRows;
window.loadEmployeeDeductionAccounts = loadEmployeeDeductionAccounts;
window.saveEmployeeDeductionAccount = saveEmployeeDeductionAccount;
window.editEmployeeDeductionAccount = editEmployeeDeductionAccount;
window.updateEmployeeDeductionStatus = updateEmployeeDeductionStatus;
window.loadPayrollPolicySettings = loadPayrollPolicySettings;
window.savePayrollPolicySettings = savePayrollPolicySettings;
window.loadPayrollAttendanceConfigs = loadPayrollAttendanceConfigs;
window.savePayrollAttendanceConfig = savePayrollAttendanceConfig;
window.editPayrollAttendanceConfig = editPayrollAttendanceConfig;
window.deactivatePayrollAttendanceConfig = deactivatePayrollAttendanceConfig;
window.togglePayrollAttendanceConfigScope = togglePayrollAttendanceConfigScope;
window.renderPayrollAttendanceConfigOptions = renderPayrollAttendanceConfigOptions;
window.resetPayrollAttendanceConfigForm = resetPayrollAttendanceConfigForm;
window.loadPayrollAudit = loadPayrollAudit;
window.setPayrollAuditPage = setPayrollAuditPage;
window.initializePayrollModule = initializePayrollModule;
window.saveProductionSplit = saveProductionSplit;
window.editProductionSplit = editProductionSplit;
window.generatePiecePayrollRegister = generatePiecePayrollRegister;
window.generateWeeklyPayroll = generateWeeklyPayroll;
window.loadWeeklyPayrollRegistry = loadWeeklyPayrollRegistry;
window.renderWeeklyPayrollRegistry = renderWeeklyPayrollRegistry;
window.changeWeeklyPayrollRegistryPage = changeWeeklyPayrollRegistryPage;
window.renderWeeklyPayrollEmployeeOptions = renderWeeklyPayrollEmployeeOptions;
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
  if (typeof shouldRunProtectedPageInitializer === 'function' && !shouldRunProtectedPageInitializer('payroll')) return;
  if (typeof shouldRunProtectedPageInitializer !== 'function' && !document.getElementById('page-payroll')?.classList.contains('active')) return;
  initializePayrollModule();
  loadWeeklyPayrollFilterOptions();
  loadPayrollDashboard();
  loadSalaryCalculations();

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
