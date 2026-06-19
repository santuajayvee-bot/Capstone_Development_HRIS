/* ============================================================
   PAYROLL.JS — Payroll page logic with real database data
   ============================================================ */

let currentPayrollData = [];
let currentMonthYear = null;
let currentSalaryCalculationRecords = [];
let payrollReportPage = 1;
let selectedPayrollReport = null;
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

function money(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Open Run Payroll Modal
function openRunPayrollModal() {
  // Get current date for default values
  const today = new Date();
  const currentMonth = String(today.getMonth() + 1).padStart(2, '0');
  const currentYear = today.getFullYear();
  const defaultMonthYear = `${currentYear}-${currentMonth}`;
  
  // First day and last day of month
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const startDate = firstDay.toISOString().split('T')[0];
  const endDate = lastDay.toISOString().split('T')[0];
  
  const modalHTML = `
    <div id="run-payroll-modal" style="
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); display: flex; align-items: center;
      justify-content: center; z-index: 10000;
    ">
      <div style="
        background: var(--bg); border-radius: 14px; max-width: 450px;
        width: 90%; padding: 24px; border: 1px solid var(--border);
      ">
        <h2 style="margin: 0 0 20px 0; font-size: 18px; font-weight: 700;">Run Payroll</h2>
        
        <div style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 20px;">
          <p style="margin: 0 0 12px 0; font-size: 13px; color: var(--muted);">Select the payroll period you want to generate.</p>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <div>
              <label style="display: block; font-size: 11px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; font-weight: 600;">Month & Year</label>
              <input id="payroll-month-year" type="month" value="${defaultMonthYear}" style="
                width: 100%; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border);
                border-radius: 8px; color: var(--text); font-size: 13px; font-family: 'DM Sans', sans-serif;
              " />
            </div>
          </div>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-size: 11px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; font-weight: 600;">Start Date</label>
              <input id="payroll-start-date" type="date" value="${startDate}" style="
                width: 100%; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border);
                border-radius: 8px; color: var(--text); font-size: 13px; font-family: 'DM Sans', sans-serif;
              " />
            </div>
            <div>
              <label style="display: block; font-size: 11px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; font-weight: 600;">End Date</label>
              <input id="payroll-end-date" type="date" value="${endDate}" style="
                width: 100%; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border);
                border-radius: 8px; color: var(--text); font-size: 13px; font-family: 'DM Sans', sans-serif;
              " />
            </div>
          </div>
        </div>
        
        <div id="payroll-warning" style="
          background: rgba(245, 166, 35, 0.1); border-left: 4px solid var(--yellow);
          padding: 12px; border-radius: 4px; font-size: 12px; color: var(--yellow);
          margin-bottom: 20px; display: none;
        "></div>
        
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button onclick="document.getElementById('run-payroll-modal')?.remove()" class="btn btn-outline" style="font-size: 13px; padding: 10px 20px;">Cancel</button>
          <button onclick="runPayroll()" id="run-payroll-btn" class="btn btn-primary" style="font-size: 13px; padding: 10px 20px;">Generate Payroll</button>
        </div>
      </div>
    </div>
  `;
  
  const modalDiv = document.createElement('div');
  modalDiv.innerHTML = modalHTML;
  document.body.appendChild(modalDiv.firstElementChild);
}

// Run the payroll generation
async function runPayroll() {
  const monthYearInput = document.getElementById('payroll-month-year');
  const startDateInput = document.getElementById('payroll-start-date');
  const endDateInput = document.getElementById('payroll-end-date');
  const warningDiv = document.getElementById('payroll-warning');
  const runBtn = document.getElementById('run-payroll-btn');
  
  if (!monthYearInput?.value || !startDateInput?.value || !endDateInput?.value) {
    warningDiv.textContent = '⚠️ Please fill in all required fields';
    warningDiv.style.display = 'block';
    return;
  }
  
  const monthYear = monthYearInput.value; // Format: YYYY-MM
  const startDate = startDateInput.value; // Format: YYYY-MM-DD
  const endDate = endDateInput.value;     // Format: YYYY-MM-DD
  
  // Validate dates
  if (startDate >= endDate) {
    warningDiv.textContent = '⚠️ Start date must be before end date';
    warningDiv.style.display = 'block';
    return;
  }
  
  // Disable button and show loading
  runBtn.disabled = true;
  runBtn.innerHTML = '⏳ Generating...';
  warningDiv.style.display = 'none';
  
  try {
    const response = await apiFetch('/api/payroll/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month_year: monthYear, start_date: startDate, end_date: endDate })
    });
    
    if (!response.ok) {
      // Try to parse as JSON first
      let errorMsg = 'Failed to generate payroll';
      try {
        const errorData = await response.json();
        errorMsg = errorData.details || errorData.message || errorData.error || errorMsg;
      } catch (parseErr) {
        // If not JSON, try to get text
        try {
          const text = await response.text();
          if (text.includes('<!DOCTYPE')) {
            errorMsg = 'Server error: Database tables may not exist. Please run the database migration.';
          } else {
            errorMsg = text;
          }
        } catch (textErr) {
          errorMsg = `HTTP ${response.status}: ${response.statusText}`;
        }
      }
      throw new Error(errorMsg);
    }
    
    const result = await response.json();
    
    // Show success message
    warningDiv.style.backgroundColor = 'rgba(34, 211, 165, 0.1)';
    warningDiv.style.borderColor = 'var(--green)';
    warningDiv.style.color = 'var(--green)';
    warningDiv.textContent = `✅ Payroll generated successfully! Processed ${result.employeesProcessed || result.totalEmployees || 0} employees for ${monthYear}`;
    warningDiv.style.display = 'block';
    
    console.log('✅ Payroll generation result:', result);
    
    // Close modal and reload data
    setTimeout(() => {
      document.getElementById('run-payroll-modal')?.remove();
      loadPayrollRecords(monthYear);
    }, 2000);
    
  } catch (err) {
    console.error('Error generating payroll:', err);
    warningDiv.style.backgroundColor = 'rgba(224, 92, 122, 0.1)';
    warningDiv.style.borderColor = 'var(--red)';
    warningDiv.style.color = 'var(--red)';
    warningDiv.textContent = `❌ ${err.message}`;
    warningDiv.style.display = 'block';
    runBtn.disabled = false;
    runBtn.innerHTML = 'Generate Payroll';
  }
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

  if (currentPayrollData.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px 20px; text-align: center;">
        <div style="font-size: 14px; color: var(--muted);">
          📊 No payroll records found. Click "Process Payroll" to generate payroll.
        </div>
      </div>
    `;
    return;
  }

  const table = `
    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
      <thead>
        <tr style="border-bottom: 2px solid var(--border); background: var(--card);">
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Payroll ID</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Employee</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Period</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--muted);">Basic Salary</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--muted);">Allowances</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--muted);">Deductions</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--muted);">Tax</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--text);">Net Pay</th>
          <th style="padding: 12px; text-align: center; font-weight: 600; color: var(--muted);">Status</th>
          <th style="padding: 12px; text-align: center; font-weight: 600; color: var(--muted);">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${currentPayrollData.map(p => {
          const tax = (p.total_earning * 0.06).toFixed(2); // 6% tax
          const statusBadge = p.status === 'Disbursed' 
            ? `<span style="background: rgba(34, 211, 165, 0.2); color: var(--green); padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">paid</span>`
            : p.status === 'Pending'
            ? `<span style="background: rgba(245, 166, 35, 0.2); color: var(--yellow); padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">processed</span>`
            : `<span style="background: rgba(224, 92, 122, 0.2); color: var(--red); padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">pending</span>`;
          
          return `
            <tr style="border-bottom: 1px solid var(--border); hover: {background: var(--card)};">
              <td style="padding: 12px; color: var(--muted); font-family: 'Courier New', monospace; font-weight: 600;">${p.payroll_run_id || 'PAY001'}</td>
              <td style="padding: 12px; color: var(--text); font-weight: 500;">${p.employee_name}</td>
              <td style="padding: 12px; color: var(--muted);">${p.month_year || 'N/A'}</td>
              <td style="padding: 12px; text-align: right; color: var(--text); font-weight: 600;">₱${parseFloat(p.total_earning || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
              <td style="padding: 12px; text-align: right; color: var(--text);">₱${(parseFloat(p.total_earning || 0) * 0.1).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
              <td style="padding: 12px; text-align: right; color: var(--red);">₱${parseFloat(p.total_deduction || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
              <td style="padding: 12px; text-align: right; color: var(--muted);">₱${tax}</td>
              <td style="padding: 12px; text-align: right; color: var(--accent); font-weight: 700;">₱${parseFloat(p.net_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
              <td style="padding: 12px; text-align: center;">${statusBadge}</td>
              <td style="padding: 12px; text-align: center;">
                <button onclick="viewPayslipDetails(${p.employee_id}, '${p.employee_name}', '${p.month_year}')" style="
                  background: none; border: none; color: var(--accent); cursor: pointer; font-size: 16px; padding: 4px 8px;
                " title="View Details">📥</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  grid.innerHTML = table;
  renderPayrollRecords(currentSalaryCalculationRecords || []);
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
        ${records.map(r => `
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
            <td>${payrollBadge(r.status || 'Draft')}</td>
            <td><button class="btn btn-outline btn-sm" onclick="showCalculationBreakdown(${JSON.stringify(r).replace(/"/g, '&quot;')})">View</button></td>
          </tr>
        `).join('')}
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
        updatePayrollStats({});
      } else {
        throw new Error('Failed to load payroll records');
      }
    } else {
      const data = await response.json();
      currentPayrollData = data.payslips || [];
      updatePayrollStats(data.summary || {});
    }
  } catch (err) {
    console.error('Error loading payroll records:', err);
    currentPayrollData = [];
    updatePayrollStats({});
  }

  renderPayroll();
}

// Update stats cards at the top
function updatePayrollStats(summary) {
  const money = value => `PHP ${parseFloat(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('payroll-total-payroll', money(summary.totalPayroll));
  setText('payroll-employees-paid', summary.employeesPaid || '0');
  setText('payroll-average-salary', money(summary.avgSalary));
  setText('payroll-total-deductions', money(summary.totalDeductions));
  setText('payroll-pending-count', summary.pendingCount || '0');
  setText('payroll-period-label', summary.monthYear || 'Current period');
  setText('payroll-employees-label', `${summary.totalEmployees || 0} employees processed`);
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
        ${records.map(r => {
          const calcDate = new Date(r.calculation_date).toLocaleDateString('en-US', { 
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
              <td>${payrollBadge(r.status || 'Draft')}</td>
              <td>
                <button class="btn btn-outline btn-sm" onclick="showCalculationBreakdown(${JSON.stringify(r).replace(/"/g, '&quot;')})">View</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  grid.innerHTML = table;
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
        background: var(--bg); border-radius: 14px; max-width: 600px;
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
        <label>Base Rate<input value="${fmt(record.base_rate)}" readonly /></label>
        <label>Work Output<input value="${workOutput}" readonly /></label>
        <label>Payroll Date<input value="${calculationDate}" readonly /></label>
      </div>

      <div class="payroll-breakdown-section">
        <h3>Calculation Summary</h3>
        <table class="payroll-breakdown-table">
          <tbody>
            ${row('Base Pay', fmt(basePay))}
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
        <button class="btn btn-primary" type="button" onclick="exportPayrollReport('employee','pdf')">Generate Payslip</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target.id === modalId) modal.remove();
  });
  document.body.appendChild(modal);
}

function switchPayrollTab(tab) {
  document.querySelectorAll('.payroll-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.payrollTab === tab);
  });
  document.querySelectorAll('.payroll-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `payroll-tab-${tab}`);
  });

  if (tab === 'salary' && typeof loadSalaryCalculationPage === 'function') loadSalaryCalculationPage();
  if (tab === 'piece-config') loadPieceRateConfig();
  if (tab === 'deductions') loadPayrollSettings('deduction');
  if (tab === 'allowances') loadPayrollSettings('allowance');
  if (tab === 'policies') loadPayrollPolicySettings();
  if (tab === 'reports') {
    loadPayrollAudit();
    renderPayrollReportLibrary();
  }
  if (tab === 'records') loadSalaryCalculations();
}

async function loadPieceRateConfig() {
  const grid = document.getElementById('piece-rate-config-grid');
  try {
    const res = await apiFetch('/api/payroll/piece-rate-config');
    if (!res.ok) throw new Error('Failed to load piece-rate configuration');
    pieceRateConfig = await res.json();
    window.pieceRateConfig = pieceRateConfig;
    populatePieceRateDropdowns();
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
  const target = document.getElementById('piece-rate-record-table');
  if (target) target.innerHTML = renderPieceRateRecordTable(pieceRateConfig, pieceRateRecordsView);
}

function renderPieceRateRecordTable(config, view) {
  const limit = 12;
  if (view === 'sew') {
    const rows = (config.sew_types || []).slice(0, limit);
    return `
      <table><thead><tr><th>Code</th><th>Description</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${row.code}</td><td>${row.description || '-'}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td><button class="btn btn-outline btn-sm" onclick='editSewType(${JSON.stringify(row)})'>Edit</button></td></tr>`).join('') || '<tr><td colspan="4">No Type of Sew configured.</td></tr>'}</tbody></table>`;
  }
  if (view === 'sizes') {
    const rows = (config.size_ranges || []).slice(0, limit);
    return `
      <table><thead><tr><th>Size Range</th><th>Description</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${row.size_range}</td><td>${row.description || '-'}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td><button class="btn btn-outline btn-sm" onclick='editSizeRange(${JSON.stringify(row)})'>Edit</button></td></tr>`).join('') || '<tr><td colspan="4">No size ranges configured.</td></tr>'}</tbody></table>`;
  }
  if (view === 'rules') {
    const rows = (config.production_share_rules || []).slice(0, limit);
    return `
      <table><thead><tr><th>Pairing Type</th><th>Worker 1</th><th>Worker 2</th><th>Effective</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${row.pairing_type}</td><td>${Number(row.worker1_share || 0)}%</td><td>${Number(row.worker2_share || 0)}%</td><td>${(row.effective_date || '').slice(0, 10)}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td><button class="btn btn-outline btn-sm" onclick='editProductionShareRule(${JSON.stringify(row)})'>Edit</button></td></tr>`).join('') || '<tr><td colspan="6">No sharing rules configured.</td></tr>'}</tbody></table>`;
  }
  if (view === 'splits') {
    const rows = (config.production_split_configs || []).slice(0, limit);
    return `
      <table><thead><tr><th>Split Name</th><th>Sewer %</th><th>Fixer %</th><th>Total</th><th>Effective</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows.map(row => {
        const total = Number(row.sewer_percentage || 0) + Number(row.fixer_percentage || 0);
        return `<tr><td>${row.split_name}</td><td>${Number(row.sewer_percentage || 0)}%</td><td>${Number(row.fixer_percentage || 0)}%</td><td>${total}%</td><td>${(row.effective_date || '').slice(0, 10)}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td><button class="btn btn-outline btn-sm" onclick='editProductionSplit(${JSON.stringify(row)})'>Edit</button></td></tr>`;
      }).join('') || '<tr><td colspan="7">No production split configured.</td></tr>'}</tbody></table>`;
  }
  if (view === 'incentives') {
    const rows = (config.incentives || []).slice(0, limit);
    return `
      <table><thead><tr><th>Name</th><th>Category</th><th>Amount</th><th>Effective</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${row.incentive_name}</td><td>${row.incentive_category}</td><td>${money(row.amount)}</td><td>${(row.effective_date || '').slice(0, 10)}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td><button class="btn btn-outline btn-sm" onclick='editPieceIncentive(${JSON.stringify(row)})'>Edit</button></td></tr>`).join('') || '<tr><td colspan="6">No incentive rules configured.</td></tr>'}</tbody></table>`;
  }
  if (view === 'production') {
    const rows = (config.production_pairs || []).slice(0, limit);
    return `
      <table><thead><tr><th>Date</th><th>Pairing</th><th>Sewer</th><th>Partner</th><th>Sew / Size</th><th>Qty</th><th>Raw Earnings</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${(row.production_date || '').slice(0, 10)}</td><td>${row.pairing_type}</td><td>${row.worker1_name || row.worker1_employee_id}</td><td>${row.worker2_name || row.worker2_employee_id}</td><td>${row.sew_type_code || row.product_type} / ${row.size_range || row.product_category || '-'}</td><td>${row.quantity_produced}</td><td>${money(row.production_value)}</td></tr>`).join('') || '<tr><td colspan="7">No production encodings yet.</td></tr>'}</tbody></table>`;
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
    const rows = (config.incentive_entries || []).slice(0, limit);
    return `
      <table><thead><tr><th>Employee</th><th>Period</th><th>Type</th><th>Amount</th><th>Remarks</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${row.employee_name || row.employee_code || row.employee_id}</td><td>${row.payroll_period}</td><td>${row.incentive_type}</td><td>${money(row.amount)}</td><td>${row.remarks || '-'}</td></tr>`).join('') || '<tr><td colspan="5">No incentive encodings yet.</td></tr>'}</tbody></table>`;
  }
  const rows = (config.piece_rates || []).slice(0, limit);
  return `
    <table><thead><tr><th>Type of Sew</th><th>Size Range</th><th>Rate</th><th>Effective</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${rows.map(row => `<tr><td>${row.sew_type_code || row.product_type}</td><td>${row.size_range || row.product_category || '-'}</td><td>${money(row.piece_rate)}</td><td>${(row.effective_date || '').slice(0, 10)}</td><td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td><td><button class="btn btn-outline btn-sm" onclick='editPieceRate(${JSON.stringify(row)})'>Edit</button></td></tr>`).join('') || '<tr><td colspan="6">No piece rates configured.</td></tr>'}</tbody></table>`;
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
  const pairingType = form.elements.pairing_type?.value || '';
  const rate = getConfiguredPieceRate(sewType, sizeRange);
  const rule = getConfiguredPairRule(pairingType);
  const pieceRate = Number(rate?.piece_rate || 0);
  const raw = quantity * pieceRate;
  const worker1Share = Number(rule?.worker1_share || 0);
  const worker2Share = Number(rule?.worker2_share || 0);
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
  if (String(data.worker1_employee_id || '') === String(data.worker2_employee_id || '')) {
    if (status) status.textContent = 'Sewer and partner cannot be the same employee.';
    return;
  }
  const rate = getConfiguredPieceRate(data.sew_type_code, data.size_range);
  if (!rate) {
    if (status) status.textContent = 'No active rate found for this Type of Sew and Size Range.';
    return;
  }
  try {
    const res = await apiFetch('/api/payroll/production-pairs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Failed to encode production pair');
    if (status) status.textContent = `Saved. Worker 1: ${money(result.worker1_earnings)} | Worker 2: ${money(result.worker2_earnings)}`;
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
  loadPayrollRecords(month || null);
  loadSalaryCalculations();
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
      <thead><tr><th>Name</th><th>Category</th><th>Computation</th><th>Rate/Amount</th><th>Schedule</th><th>Status</th><th>Effective</th></tr></thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${row.name}</td>
            <td>${row.category}</td>
            <td>${row.computation_type}</td>
            <td>${row.rate_or_amount}</td>
            <td>${row.apply_schedule}</td>
            <td>${payrollBadge(row.is_active ? 'Active' : 'Inactive')}</td>
            <td>${(row.effective_date || '').slice(0, 10)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderAllowanceSettings(rows) {
  return `
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Amount/Rate</th><th>Taxable</th><th>Status</th><th>Effective</th></tr></thead>
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
      : data.custom_name;
    delete data.government_name;
    delete data.custom_name;
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
  const customGroup = document.getElementById('deduction-custom-name-group');
  const governmentName = document.getElementById('deduction-government-name');
  const customName = document.getElementById('deduction-custom-name');
  const isGovernment = category === 'Government';

  if (governmentGroup) governmentGroup.style.display = isGovernment ? 'block' : 'none';
  if (customGroup) customGroup.style.display = isGovernment ? 'none' : 'block';
  if (governmentName) governmentName.required = isGovernment;
  if (customName) customName.required = !isGovernment;
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
  { id: 'daily-rate-register', name: 'Daily Rate Payroll Register', category: 'Attendance', description: 'Daily-rate calculations with days worked and payroll-ready attendance validation.', formats: ['CSV', 'Excel'] },
  { id: 'per-hour-register', name: 'Per-Hour Payroll Register', category: 'Attendance', description: 'Hourly calculations with hours worked, overtime, and attendance validation.', formats: ['CSV', 'Excel'] },
  { id: 'attendance-payroll-validation', name: 'Attendance-to-Payroll Validation', category: 'Attendance', description: 'Validation status, excluded attendance, warnings, and blocking errors.', formats: ['CSV', 'Excel'] },
  { id: 'piece-production-register', name: 'Production Register', category: 'Production', description: 'Production date, sewer, fixer, quantity, rate and production amount.', formats: ['CSV', 'Excel'] },
  { id: 'piece-sewer-register', name: 'Sewer Payroll Register', category: 'Production', description: 'Sewer production amount and payroll share.', formats: ['CSV', 'Excel'] },
  { id: 'piece-fixer-register', name: 'Fixer Payroll Register', category: 'Production', description: 'Fixer production amount and payroll share.', formats: ['CSV', 'Excel'] },
  { id: 'piece-combined-register', name: 'SWR-FXR-SUM', category: 'Production', description: 'Combined per-piece payroll register by employee and role.', formats: ['CSV', 'Excel'] },
  { id: 'deductions', name: 'Deduction Report', category: 'Government', description: 'Configured deductions and deduction totals.', formats: ['CSV', 'Excel', 'PDF'] },
  { id: 'government', name: 'Government Contribution Report', category: 'Government', description: 'SSS, PhilHealth, Pag-IBIG and withholding tax summary.', formats: ['CSV', 'Excel', 'PDF'] },
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
      <button class="btn btn-outline btn-sm" type="button" ${payrollReportPage <= 1 ? 'disabled' : ''} onclick="changePayrollReportPage(-1)">Previous</button>
      <button class="btn btn-outline btn-sm" type="button" ${payrollReportPage >= pages ? 'disabled' : ''} onclick="changePayrollReportPage(1)">Next</button>
    `;
  }
}

function changePayrollReportPage(delta) {
  payrollReportPage += delta;
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

  const deductionDate = document.querySelector('#deduction-setting-form [name="effective_date"]');
  const allowanceDate = document.querySelector('#allowance-setting-form [name="effective_date"]');
  const splitDate = document.querySelector('#production-split-form [name="effective_date"]');
  const today = new Date().toISOString().split('T')[0];
  if (deductionDate && !deductionDate.value) deductionDate.value = today;
  if (allowanceDate && !allowanceDate.value) allowanceDate.value = today;
  if (splitDate && !splitDate.value) splitDate.value = today;
  toggleDeductionNameField();
}

// Export functions to global scope FIRST
window.loadPayrollRecords = loadPayrollRecords;
window.renderPayroll = renderPayroll;
window.updatePayrollStats = updatePayrollStats;
window.openRunPayrollModal = openRunPayrollModal;
window.runPayroll = runPayroll;
window.loadSalaryCalculations = loadSalaryCalculations;
window.renderSalaryCalculations = renderSalaryCalculations;
window.showCalculationBreakdown = showCalculationBreakdown;
window.generatePayslipsFromRecords = generatePayslipsFromRecords;
window.switchPayrollTab = switchPayrollTab;
window.refreshPayrollDashboard = refreshPayrollDashboard;
window.loadPayrollSettings = loadPayrollSettings;
window.savePayrollSetting = savePayrollSetting;
window.toggleDeductionNameField = toggleDeductionNameField;
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

// Load data when DOM is ready or if already ready
function initializePayroll() {
  initializePayrollModule();
  loadPayrollRecords();
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
