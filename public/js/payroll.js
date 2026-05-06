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
    `;
    
    // Add modal to page
    const modalDiv = document.createElement('div');
    modalDiv.innerHTML = modalHTML;
    document.body.appendChild(modalDiv.firstElementChild);
    
  } catch (err) {
    console.error('Error viewing employee details:', err);
    alert('Failed to load employee details');
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
  const statsCards = document.querySelectorAll('.stat-val');
  if (statsCards.length >= 4) {
    statsCards[0].textContent = summary.totalPayroll ? `₱${(summary.totalPayroll / 1000).toFixed(0)}K` : '₱0';
    statsCards[1].textContent = summary.employeesPaid || '0';
    statsCards[2].textContent = summary.avgSalary ? `₱${(summary.avgSalary / 1000).toFixed(0)}K` : '₱0';
    statsCards[3].textContent = summary.totalDeductions ? `₱${(summary.totalDeductions / 1000).toFixed(0)}K` : '₱0';
  }

  const subCards = document.querySelectorAll('.stat-sub');
  if (subCards.length >= 2) {
    subCards[0].textContent = summary.monthYear || 'N/A';
    subCards[1].textContent = `${summary.totalEmployees || 0} employees processed`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadPayrollRecords();
});
