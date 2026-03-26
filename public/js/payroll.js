/* ============================================================
   PAYROLL.JS — Payroll page logic
   ============================================================ */

const PAYROLL_DATA = [
  { name:'Serjo Justine', dept:'HR',        basic: 25000, ot: 1500, deductions: 3200, status:'Disbursed' },
  { name:'Chris Brown',   dept:'Production',basic: 22000, ot: 2100, deductions: 2800, status:'Disbursed' },
  { name:'LeBron James',  dept:'HR',        basic: 30000, ot: 0,    deductions: 3800, status:'Pending'   },
  { name:'Nikki Minaj',   dept:'Executive', basic: 45000, ot: 0,    deductions: 5500, status:'Disbursed' },
];

function renderPayroll() {
  const tbody = document.getElementById('payroll-tbody');
  if (!tbody) return;

  tbody.innerHTML = PAYROLL_DATA.map(p => {
    const net = p.basic + p.ot - p.deductions;
    const badgeClass = p.status === 'Disbursed' ? 'badge-green' : 'badge-yellow';
    return `
      <tr>
        <td>${p.name}</td>
        <td>${p.dept}</td>
        <td>₱${p.basic.toLocaleString()}</td>
        <td>₱${p.ot.toLocaleString()}</td>
        <td>₱${p.deductions.toLocaleString()}</td>
        <td>₱${net.toLocaleString()}</td>
        <td><span class="badge ${badgeClass}">${p.status}</span></td>
      </tr>`;
  }).join('');
}

document.addEventListener('DOMContentLoaded', renderPayroll);
