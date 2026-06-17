/* ============================================================
   BLOCKCHAIN.JS - Permissioned payroll audit ledger UI
   ============================================================ */

let BC_RECORDS = [];
let BC_INITIALIZED = false;

function bcEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function bcShortHash(value) {
  const text = String(value || '');
  if (!text) return '-';
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-8)}`;
}

function bcFormatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-PH');
}

function bcMoney(value) {
  const number = Number(value || 0);
  return number.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function bcBadge(value) {
  const text = String(value || 'UNKNOWN');
  const normalized = text.toUpperCase();
  const color = normalized.includes('RECORDED') || normalized.includes('VERIFIED') || normalized.includes('SUCCESS')
    ? 'badge-green'
    : normalized.includes('PENDING')
      ? 'badge-yellow'
      : normalized.includes('CRITICAL') || normalized.includes('FAILED') || normalized.includes('TAMPER')
        ? 'badge-red'
        : 'badge-blue';
  return `<span class="badge ${color}">${bcEsc(text)}</span>`;
}

function bcSetText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function bcShowMessage(message, type = 'info') {
  const element = document.getElementById('bc-message');
  if (!element) return;
  element.textContent = message || '';
  element.style.display = message ? 'block' : 'none';
  element.style.borderColor = type === 'critical' ? 'rgba(224,92,122,.45)' : type === 'warning' ? 'rgba(245,166,35,.45)' : 'var(--border)';
  element.style.color = type === 'critical' ? 'var(--red)' : type === 'warning' ? 'var(--yellow)' : 'var(--muted)';
}

function bcUserRole() {
  return typeof getUser === 'function' ? getUser()?.role : null;
}

function bcCanRecord() {
  return bcUserRole() === 'payroll_manager';
}

function bcCanVerify() {
  return ['system_admin', 'admin'].includes(bcUserRole());
}

async function bcRequest(url, options = {}) {
  const response = typeof apiFetch === 'function'
    ? await apiFetch(url, options)
    : await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 202) {
    const error = new Error(data.error || data.message || 'Blockchain request failed.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { response, data };
}

function renderBlockchainStats(payload) {
  const records = payload.records || [];
  const recorded = records.filter(row => String(row.Blockchain_Status).toUpperCase() === 'RECORDED').length;
  const pending = records.filter(row => String(row.Blockchain_Status).toUpperCase() === 'PENDING_ANCHOR').length;
  const critical = records.filter(row => String(row.Latest_Audit_Status).toUpperCase() === 'CRITICAL').length;
  const latest = records[0]?.Latest_Audit_At || records[0]?.Finalized_At || null;

  bcSetText('bc-stat-total', records.length);
  bcSetText('bc-stat-recorded', recorded);
  bcSetText('bc-stat-pending', pending);
  bcSetText('bc-stat-critical', critical);
  bcSetText('bc-stat-latest', latest ? bcFormatDate(latest) : '-');

  const fabric = payload.fabric || {};
  const status = fabric.enabled && fabric.ready
    ? `Fabric configured: ${fabric.channelName} / ${fabric.chaincodeName}`
    : 'Blockchain network is not currently connected. Local audit records are available, but Fabric verification is disabled.';
  bcSetText('bc-network-status', status);
  if (!fabric.enabled || !fabric.ready) bcShowMessage(status, 'warning');
}

function renderBlockchainRows() {
  const tbody = document.getElementById('tx-tbody');
  if (!tbody) return;

  if (!BC_RECORDS.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="att-empty">No finalized payroll blockchain records found.</td></tr>';
    return;
  }

  tbody.innerHTML = BC_RECORDS.map(record => {
    const payrollId = Number(record.Payroll_ID);
    const status = record.Blockchain_Status || 'PENDING';
    const auditStatus = record.Latest_Audit_Status || '-';
    const recordButton = bcCanRecord() && String(status).toUpperCase() !== 'RECORDED'
      ? `<button class="btn btn-primary btn-sm" onclick="recordPayrollHash(${payrollId})">Record Hash</button>`
      : '';
    const verifyButton = bcCanVerify()
      ? `<button class="btn btn-outline btn-sm" onclick="verifyPayrollHash(${payrollId})">Verify</button>`
      : '';

    return `<tr>
      <td class="tx-block">${bcEsc(record.Payroll_ID)}</td>
      <td>${bcEsc(record.Employee_ID)}</td>
      <td>${bcMoney(record.Gross_Pay)}</td>
      <td>${bcMoney(record.Net_Pay)}</td>
      <td>${bcBadge(status)}</td>
      <td>${bcBadge(auditStatus)}</td>
      <td class="tx-hash" title="${bcEsc(record.Transaction_Hash || record.Latest_Payload_Hash || '')}">${bcEsc(bcShortHash(record.Transaction_Hash || record.Latest_Payload_Hash))}</td>
      <td style="font-size:11px">${bcEsc(bcFormatDate(record.Finalized_At || record.Latest_Audit_At))}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${recordButton}
          ${verifyButton}
          <button class="btn btn-outline btn-sm" onclick="loadBlockchainAudit(${payrollId})">Audit</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function loadBlockchainRecords() {
  try {
    bcShowMessage('');
    const { data } = await bcRequest('/api/blockchain/payroll/finalized');
    BC_RECORDS = data.records || [];
    renderBlockchainStats(data);
    renderBlockchainRows();
  } catch (error) {
    BC_RECORDS = [];
    renderBlockchainRows();
    bcShowMessage(error.message, 'critical');
  }
}

async function recordPayrollHash(payrollId) {
  try {
    const { response, data } = await bcRequest(`/api/blockchain/payroll/finalize/${payrollId}`, { method: 'POST' });
    const warning = response.status === 202;
    bcShowMessage(data.message || 'Payroll hash recorded.', warning ? 'warning' : 'info');
    await loadBlockchainRecords();
    await loadBlockchainAudit(payrollId);
  } catch (error) {
    bcShowMessage(error.message, 'critical');
  }
}

async function verifyPayrollHash(payrollId) {
  try {
    const { response, data } = await bcRequest(`/api/blockchain/payroll/verify/${payrollId}`);
    if (response.status === 202) {
      bcShowMessage(data.message, 'warning');
    } else if (data.status === 'critical') {
      bcShowMessage(data.message, 'critical');
    } else {
      bcShowMessage(data.message || 'Payroll integrity verified.');
    }
    await loadBlockchainRecords();
    await loadBlockchainAudit(payrollId);
  } catch (error) {
    if (error.status === 409 && error.data?.status === 'critical') {
      bcShowMessage(error.data.message, 'critical');
      await loadBlockchainAudit(payrollId);
      return;
    }
    bcShowMessage(error.message, 'critical');
  }
}

async function loadBlockchainAudit(payrollId) {
  try {
    const { data } = await bcRequest(`/api/blockchain/payroll/audit/${payrollId}`);
    const title = document.getElementById('bc-audit-title');
    if (title) title.textContent = `Audit Trail - Payroll ${payrollId}`;
    const tbody = document.getElementById('bc-audit-tbody');
    if (!tbody) return;
    const logs = data.audit_logs || [];
    tbody.innerHTML = logs.length ? logs.map(log => `<tr>
      <td>${bcEsc(bcFormatDate(log.Created_At))}</td>
      <td>${bcEsc(log.Event_Type)}</td>
      <td>${bcBadge(log.Status)}</td>
      <td class="tx-hash" title="${bcEsc(log.Payload_Hash || '')}">${bcEsc(bcShortHash(log.Payload_Hash))}</td>
      <td class="tx-hash" title="${bcEsc(log.Transaction_Hash || '')}">${bcEsc(bcShortHash(log.Transaction_Hash))}</td>
      <td>${bcEsc(log.Actor_Role || '-')}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="att-empty">No audit entries for this payroll record.</td></tr>';
  } catch (error) {
    bcShowMessage(error.message, 'critical');
  }
}

function initBlockchainPage() {
  const page = document.getElementById('page-blockchain');
  if (!page || !document.getElementById('tx-tbody')) return;
  if (BC_INITIALIZED) return;
  BC_INITIALIZED = true;
  document.getElementById('bc-refresh')?.addEventListener('click', loadBlockchainRecords);
  loadBlockchainRecords();
}

function watchBlockchainActivation() {
  const page = document.getElementById('page-blockchain');
  if (!page) return;
  const initializeIfReady = () => {
    if (page.classList.contains('active') && document.getElementById('tx-tbody')) {
      initBlockchainPage();
    }
  };
  new MutationObserver(initializeIfReady).observe(page, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('partialsLoaded', initializeIfReady);
  initializeIfReady();
}

document.addEventListener('DOMContentLoaded', watchBlockchainActivation);
window.loadBlockchainRecords = loadBlockchainRecords;
window.recordPayrollHash = recordPayrollHash;
window.verifyPayrollHash = verifyPayrollHash;
window.loadBlockchainAudit = loadBlockchainAudit;
