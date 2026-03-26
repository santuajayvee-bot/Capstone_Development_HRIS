/* ============================================================
   BLOCKCHAIN.JS — Blockchain page logic
   ============================================================ */

const TX_LOGS = [
  { block:'#BC-01L21', hash:'0xAa4f0c...#975ef', type:'Payroll Disbursement',  employee:'Serjo Justine',  amount:'₱25.0', time:'Feb 7, 2026 4:55 PM', status:'Confirmed' },
  { block:'#BC-0xA6f', hash:'0xBaBe4b...#e7fa7', type:'Salary Computation',    employee:'Serjo Justine',  amount:'₱25.0', time:'Feb 7, 2026 4:55 PM', status:'Confirmed' },
  { block:'#BC-0x9d4', hash:'0xD5hm4a...#7e01',  type:'Employee Onboarding',   employee:'Maya Reyes',     amount:'₱0.05', time:'Feb 7, 2026 4:55 PM', status:'Pending'   },
  { block:'#BC-07xA',  hash:'0xF4ce4c...#87t0',  type:'Payroll Disbursement',  employee:'Flynn Dansmore', amount:'₱25.0', time:'Feb 7, 2026 4:55 PM', status:'Confirmed' },
  { block:'#BC-04xB',  hash:'0xJm0pK0...#gf4l',  type:'Payroll Disbursement',  employee:'Sam Angela',     amount:'₱25.0', time:'Feb 7, 2026 4:55 PM', status:'Confirmed' },
  { block:'#BC-0xA6f', hash:'0xBaBe4b...#e7fa7', type:'Payroll Disbursement',  employee:'Sam Angela',     amount:'₱25.0', time:'Feb 7, 2026 4:55 PM', status:'Confirmed' },
];

function renderTxLogs(list) {
  const tbody = document.getElementById('tx-tbody');
  if (!tbody) return;

  tbody.innerHTML = list.map(tx => {
    const badgeClass = tx.status === 'Confirmed' ? 'badge-green' : 'badge-yellow';
    return `
      <tr>
        <td class="tx-block">${tx.block}</td>
        <td class="tx-hash">${tx.hash}</td>
        <td>${tx.type}</td>
        <td>${tx.employee}</td>
        <td>${tx.amount}</td>
        <td style="font-size:11px">${tx.time}</td>
        <td><span class="badge ${badgeClass}">${tx.status}</span></td>
        <td style="cursor:pointer">👁</td>
      </tr>`;
  }).join('');
}

function filterTxLogs() {
  const search = document.getElementById('tx-search')?.value.toLowerCase() || '';
  const type   = document.getElementById('tx-type')?.value   || '';
  const status = document.getElementById('tx-status')?.value || '';

  const filtered = TX_LOGS.filter(tx => {
    const matchSearch = tx.employee.toLowerCase().includes(search) || tx.hash.toLowerCase().includes(search);
    const matchType   = !type   || type   === 'All Types'   || tx.type   === type;
    const matchStatus = !status || status === 'All Status'  || tx.status === status;
    return matchSearch && matchType && matchStatus;
  });
  renderTxLogs(filtered);
}

document.addEventListener('DOMContentLoaded', () => {
  renderTxLogs(TX_LOGS);
  document.getElementById('tx-search') ?.addEventListener('input',  filterTxLogs);
  document.getElementById('tx-type')   ?.addEventListener('change', filterTxLogs);
  document.getElementById('tx-status') ?.addEventListener('change', filterTxLogs);
});
