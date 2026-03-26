/* ============================================================
   PAYROLL.JS — Payroll page logic
   ============================================================ */

const PAYROLL_DATA = [
  { id: 1, name:'Serjo Justine', dept:'HR',        basic: 25000, ot: 1500, deductions: 3200, status:'Disbursed' },
  { id: 2, name:'Chris Brown',   dept:'Production',basic: 22000, ot: 2100, deductions: 2800, status:'Disbursed' },
  { id: 3, name:'LeBron James',  dept:'HR',        basic: 30000, ot: 0,    deductions: 3800, status:'Pending'   },
  { id: 4, name:'Nikki Minaj',   dept:'Executive', basic: 45000, ot: 0,    deductions: 5500, status:'Disbursed' },
];

async function viewEmployeeDetails(employeeId, employeeName) {
  try {
    // Fetch employee details (read-only)
    const detailsRes = await apiFetch(`/api/payroll/employees/${employeeId}/readonly`);
    const contributionsRes = await apiFetch(`/api/payroll/employees/${employeeId}/government-contributions`);
    
    if (!detailsRes.ok || !contributionsRes.ok) {
      alert('Failed to load employee details');
      return;
    }
    
    const details = await detailsRes.json();
    const contributions = await contributionsRes.json();
    
    // Create modal HTML
    const modalHTML = `
      <div id="employee-details-modal" style="
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5); display: flex; align-items: center;
        justify-content: center; z-index: 10000;
      ">
        <div style="
          background: var(--bg); border-radius: 14px; max-width: 600px;
          width: 90%; max-height: 80vh; overflow-y: auto; padding: 24px;
          border: 1px solid var(--border);
        ">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <h2 style="margin: 0; font-size: 18px; font-weight: 700;">${employeeName}</h2>
            <button onclick="document.getElementById('employee-details-modal')?.remove()" style="
              background: none; border: none; font-size: 24px; cursor: pointer; color: var(--muted);
            ">×</button>
          </div>
          
          <!-- Personal Information -->
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
            <h4 style="margin: 0 0 12px 0; font-weight: 600; font-size: 13px; text-transform: uppercase; color: var(--muted);">Personal Information</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
              <div>
                <label style="color: var(--muted); font-size: 11px;">Email</label>
                <div style="font-weight: 600; color: var(--text);">${details.email || '—'}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px;">Contact Number</label>
                <div style="font-weight: 600; color: var(--text);">${details.contact_number || '—'}</div>
              </div>
              <div style="grid-column: 1/-1;">
                <label style="color: var(--muted); font-size: 11px;">Address</label>
                <div style="font-weight: 600; color: var(--text);">${details.residential_address || '—'}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px;">Birth Date</label>
                <div style="font-weight: 600; color: var(--text);">${details.birth_date ? new Date(details.birth_date).toLocaleDateString() : '—'}</div>
              </div>
            </div>
          </div>
          
          <!-- Employment Details -->
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
            <h4 style="margin: 0 0 12px 0; font-weight: 600; font-size: 13px; text-transform: uppercase; color: var(--muted);">Employment Details</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
              <div>
                <label style="color: var(--muted); font-size: 11px;">Department</label>
                <div style="font-weight: 600; color: var(--text);">${details.department || '—'}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px;">Position</label>
                <div style="font-weight: 600; color: var(--text);">${details.position || '—'}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px;">Wage Type</label>
                <div style="font-weight: 600; color: var(--text);">${details.wage_type || '—'}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px;">Date Hired</label>
                <div style="font-weight: 600; color: var(--text);">${details.date_hired ? new Date(details.date_hired).toLocaleDateString() : '—'}</div>
              </div>
              <div style="grid-column: 1/-1;">
                <label style="color: var(--muted); font-size: 11px;">Supervisor</label>
                <div style="font-weight: 600; color: var(--text);">${details.supervisor_name || '—'}</div>
              </div>
            </div>
          </div>
          
          <!-- Government Contributions -->
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;">
            <h4 style="margin: 0 0 12px 0; font-weight: 600; font-size: 13px; text-transform: uppercase; color: var(--muted);">Government Contributions</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
              <div>
                <label style="color: var(--muted); font-size: 11px;">SSS #</label>
                <div style="font-weight: 600; color: var(--text);">${contributions.government_ids.sss_number}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px;">PhilHealth #</label>
                <div style="font-weight: 600; color: var(--text);">${contributions.government_ids.philhealth_number}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px;">Pag-IBIG #</label>
                <div style="font-weight: 600; color: var(--text);">${contributions.government_ids.pagibig_number}</div>
              </div>
              <div>
                <label style="color: var(--muted); font-size: 11px;">TIN</label>
                <div style="font-weight: 600; color: var(--text);">${contributions.government_ids.tin}</div>
              </div>
            </div>
            ${contributions.deductions.length > 0 ? `
              <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
                <h5 style="margin: 0 0 8px 0; font-size: 12px; font-weight: 600; color: var(--text);">Active Deductions</h5>
                <div style="display: flex; flex-direction: column; gap: 6px;">
                  ${contributions.deductions.map(d => `
                    <div style="display: flex; justify-content: space-between; font-size: 12px;">
                      <span style="color: var(--muted);">${d.deduction_type}</span>
                      <span style="font-weight: 600; color: var(--accent);">₱${parseFloat(d.amount).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>
          
          <div style="display: flex; justify-content: flex-end;">
            <button onclick="document.getElementById('employee-details-modal')?.remove()" class="btn btn-primary" style="font-size: 13px;">Close</button>
          </div>
        </div>
      </div>
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

  grid.innerHTML = PAYROLL_DATA.map(p => {
    const net = p.basic + p.ot - p.deductions;
    const badgeClass = p.status === 'Disbursed' ? 'badge-green' : 'badge-yellow';
    return `
      <div class="payroll-card">
        <div class="payroll-card-header">
          <div class="payroll-card-name">${p.name}</div>
          <span class="badge ${badgeClass}">${p.status}</span>
        </div>
        <div class="payroll-card-dept">${p.dept}</div>
        <div class="payroll-card-divider"></div>
        <div class="payroll-card-rows">
          <div class="payroll-card-row">
            <span class="payroll-card-label">Basic Pay</span>
            <span class="payroll-card-value">₱${p.basic.toLocaleString()}</span>
          </div>
          <div class="payroll-card-row">
            <span class="payroll-card-label">Overtime</span>
            <span class="payroll-card-value">₱${p.ot.toLocaleString()}</span>
          </div>
          <div class="payroll-card-row">
            <span class="payroll-card-label">Deductions</span>
            <span class="payroll-card-value">₱${p.deductions.toLocaleString()}</span>
          </div>
          <div class="payroll-card-row payroll-card-net">
            <span class="payroll-card-label">Net Pay</span>
            <span class="payroll-card-value-net">₱${net.toLocaleString()}</span>
          </div>
        </div>
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
          <button onclick="viewEmployeeDetails(${p.id}, '${p.name}')" class="btn btn-sm btn-outline" style="width: 100%; font-size: 12px;">👁 View Details & Contributions</button>
        </div>
      </div>`;
  }).join('');
}

document.addEventListener('DOMContentLoaded', renderPayroll);
