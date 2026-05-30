/* ============================================================
   PAYROLL.JS — Payroll page logic with real database data
   ============================================================ */

let currentPayrollData = [];
let currentMonthYear = null;

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
  renderPayrollRecords(records);
  renderPayslipManagement(records);
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
            <td>PHP ${parseFloat(r.total_deductions || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
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
    renderSalaryCalculations(data.records || []);
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
    renderPayrollRecords([]);
    renderPayslipManagement([]);
    grid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px 20px; text-align: center;">
        <div style="font-size: 14px; color: var(--muted);">
          📋 No salary calculation records found.
        </div>
      </div>
    `;
    return;
  }

  const table = `
    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
      <thead>
        <tr style="border-bottom: 2px solid var(--border); background: var(--card);">
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Date</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Employee</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Code</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Department</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Wage Type</th>
          <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--muted);">Calculation Details</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--muted);">Base Rate</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--muted);">Gross Pay</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--muted);">Deductions</th>
          <th style="padding: 12px; text-align: right; font-weight: 600; color: var(--text);">Net Pay</th>
          <th style="padding: 12px; text-align: center; font-weight: 600; color: var(--muted);">Status</th>
        </tr>
      </thead>
      <tbody>
        ${records.map(r => {
          const statusColor = r.status === 'Approved' ? 'var(--green)' : 
                             r.status === 'Submitted' ? 'var(--yellow)' : 'var(--muted)';
          const statusBg = r.status === 'Approved' ? 'rgba(34, 211, 165, 0.2)' :
                          r.status === 'Submitted' ? 'rgba(245, 166, 35, 0.2)' : 'rgba(128, 128, 128, 0.2)';
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
            <tr style="border-bottom: 1px solid var(--border); cursor: pointer; transition: background-color 0.2s;" 
                onmouseover="this.style.background='var(--card)'" 
                onmouseout="this.style.background='transparent'"
                onclick="showCalculationBreakdown(${JSON.stringify(r).replace(/"/g, '&quot;')})">
              <td style="padding: 12px; color: var(--text); font-size: 12px;">${calcDate}</td>
              <td style="padding: 12px; color: var(--text); font-weight: 500;">${r.employee_name}</td>
              <td style="padding: 12px; color: var(--muted); font-family: 'Courier New', monospace; font-size: 12px;">${r.employee_code}</td>
              <td style="padding: 12px; color: var(--muted);">${r.department || 'N/A'}</td>
              <td style="padding: 12px; color: var(--text);">${r.wage_type || 'N/A'}</td>
              <td style="padding: 12px; color: var(--accent); font-size: 12px; font-weight: 500;">${calcDetails}</td>
              <td style="padding: 12px; text-align: right; color: var(--text);">₱${parseFloat(r.base_rate || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
              <td style="padding: 12px; text-align: right; color: var(--text); font-weight: 600;">₱${parseFloat(r.gross_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
              <td style="padding: 12px; text-align: right; color: var(--red);">₱${parseFloat(r.total_deductions || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
              <td style="padding: 12px; text-align: right; color: var(--accent); font-weight: 700;">₱${parseFloat(r.net_pay || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
              <td style="padding: 12px; text-align: center;">
                <span style="background: ${statusBg}; color: ${statusColor}; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">
                  ${r.status || 'Draft'}
                </span>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  grid.innerHTML = table;
}

// Show calculation breakdown in modal
function showCalculationBreakdown(record) {
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
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);">
              <span style="color: var(--muted);">SSS (4.5%)</span>
              <span style="color: var(--red);">- ₱${parseFloat(record.sss_deduction || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);">
              <span style="color: var(--muted);">Pag-IBIG (2%)</span>
              <span style="color: var(--red);">- ₱${parseFloat(record.pagibig_deduction || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);">
              <span style="color: var(--muted);">PhilHealth (2.75%)</span>
              <span style="color: var(--red);">- ₱${parseFloat(record.philhealth_deduction || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
            </div>

            <!-- Total Deductions -->
            <div style="display: flex; justify-content: space-between; padding: 12px 0; background: rgba(239, 68, 68, 0.1); padding: 12px; border-radius: 6px; margin: 8px 0; border-left: 3px solid var(--red);">
              <span style="font-weight: 600; color: var(--text);">Total Deductions</span>
              <span style="font-weight: 700; color: var(--red); font-size: 14px;">₱${parseFloat(record.total_deductions).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
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

function switchPayrollTab(tab) {
  document.querySelectorAll('.payroll-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.payrollTab === tab);
  });
  document.querySelectorAll('.payroll-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `payroll-tab-${tab}`);
  });

  if (tab === 'salary' && typeof loadSalaryCalculationPage === 'function') loadSalaryCalculationPage();
  if (tab === 'deductions') loadPayrollSettings('deduction');
  if (tab === 'allowances') loadPayrollSettings('allowance');
  if (tab === 'reports') loadPayrollAudit();
  if (tab === 'records' || tab === 'payslips') loadSalaryCalculations();
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
    loadPayrollSettings(type);
    loadPayrollAudit();
    if (typeof showAlert === 'function') {
      await showAlert(`${type === 'deduction' ? 'Deduction' : 'Allowance'} setting saved.`, 'Saved', 'success');
    }
  } catch (err) {
    if (typeof showAlert === 'function') await showAlert(err.message, 'Error', 'error');
    else alert(err.message);
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

function exportPayrollReport(type, format) {
  const month = document.getElementById('payroll-filter-month')?.value || '';
  const url = `/api/payroll/reports/${encodeURIComponent(type)}.${encodeURIComponent(format)}${month ? `?month_year=${encodeURIComponent(month)}` : ''}`;
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
  const today = new Date().toISOString().split('T')[0];
  if (deductionDate && !deductionDate.value) deductionDate.value = today;
  if (allowanceDate && !allowanceDate.value) allowanceDate.value = today;
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
window.switchPayrollTab = switchPayrollTab;
window.refreshPayrollDashboard = refreshPayrollDashboard;
window.loadPayrollSettings = loadPayrollSettings;
window.savePayrollSetting = savePayrollSetting;
window.loadPayrollAudit = loadPayrollAudit;
window.exportPayrollReport = exportPayrollReport;
window.initializePayrollModule = initializePayrollModule;

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
