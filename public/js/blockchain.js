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
  return typeof getUser === 'function'
    ? String(getUser()?.role || '').trim().toLowerCase()
    : '';
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
  const pending = records.filter(row => ['PENDING_APPROVAL', 'PENDING', 'PENDING_ANCHOR'].includes(String(row.Blockchain_Status).toUpperCase())).length;
  const critical = records.filter(row => String(row.Latest_Audit_Status).toUpperCase() === 'CRITICAL').length;
  const latest = records[0]?.Latest_Audit_At || records[0]?.Finalized_At || null;

  bcSetText('bc-stat-total', records.length);
  bcSetText('bc-stat-recorded', recorded);
  bcSetText('bc-stat-pending', pending);
  bcSetText('bc-stat-critical', critical);
  bcSetText('bc-stat-latest', latest ? bcFormatDate(latest) : '-');

  const fabric = payload.fabric || {};
  const status = !fabric.enabled
    ? 'Fabric recording is disabled. Local audit records remain available.'
    : fabric.ready
      ? `Fabric Gateway credentials are configured: ${fabric.channelName} / ${fabric.chaincodeName}`
      : 'Fabric Gateway credentials are incomplete. Local audit records are available, but Fabric recording and verification are disabled.';
  bcSetText('bc-network-status', status);
  if (!fabric.enabled || !fabric.ready) bcShowMessage(status, 'warning');
}

function renderBlockchainRows() {
  const tbody = document.getElementById('tx-tbody');
  if (!tbody) return;

  if (!BC_RECORDS.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="att-empty">No payroll integrity records found.</td></tr>';
    return;
  }

  tbody.innerHTML = BC_RECORDS.map(record => {
    const payrollId = Number(record.Payroll_ID);
    const status = record.Blockchain_Status || 'PENDING';
    const auditStatus = record.Latest_Audit_Status || '-';
    const integrityHash = record.Transaction_Hash || record.Latest_Payload_Hash || record.local_hash || '';
    // A Fabric receipt is issued only after finalization. Keep the client rule
    // resilient to payroll-label changes; the API repeats the finalization and RBAC checks.
    const verifyButton = bcCanVerify() && String(status).toUpperCase() === 'RECORDED'
      ? `<button class="btn btn-outline btn-sm" onclick="verifyPayrollHash(${payrollId})">Verify</button>`
      : '';

    return `<tr>
      <td class="tx-block">${bcEsc(record.Payroll_ID)}</td>
      <td>${bcEsc(record.Employee_ID)}</td>
      <td>${bcMoney(record.Gross_Pay)}</td>
      <td>${bcMoney(record.Net_Pay)}</td>
      <td>${bcBadge(status)}</td>
      <td>${bcBadge(auditStatus)}</td>
      <td class="tx-hash" title="${bcEsc(integrityHash)}">${bcEsc(bcShortHash(integrityHash))}</td>
      <td style="font-size:11px">${bcEsc(bcFormatDate(record.Finalized_At || record.Latest_Audit_At))}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${verifyButton}
          <button class="btn btn-outline btn-sm" type="button" onclick="loadBlockchainAudit(${payrollId})">View audit</button>
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

function closeBlockchainAuditModal() {
  const modal = document.getElementById('bc-audit-modal');
  if (modal) modal.style.display = 'none';
}

function openBlockchainAuditModal(payrollId) {
  let modal = document.getElementById('bc-audit-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'bc-audit-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'bc-audit-modal-title');
    modal.innerHTML = `
      <div class="modal-content" style="width:min(1100px,94vw);max-width:1100px;max-height:82vh;padding:0;border-radius:8px;overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border);">
          <div id="bc-audit-modal-title" style="font-size:16px;font-weight:700;">Audit Trail</div>
          <button id="bc-audit-modal-close" class="btn btn-outline btn-sm" type="button">Close</button>
        </div>
        <div style="padding:16px 18px;overflow:auto;max-height:68vh;">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Payload Hash</th>
                  <th>Transaction Hash</th>
                  <th>Actor Role</th>
                </tr>
              </thead>
              <tbody id="bc-audit-modal-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#bc-audit-modal-close')?.addEventListener('click', closeBlockchainAuditModal);
    modal.addEventListener('click', event => {
      if (event.target === modal) closeBlockchainAuditModal();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modal.style.display !== 'none') closeBlockchainAuditModal();
    });
  }

  modal.querySelector('#bc-audit-modal-title').textContent = `Audit Trail - Payroll ${payrollId}`;
  modal.querySelector('#bc-audit-modal-tbody').innerHTML = '<tr><td colspan="6" class="att-empty">Loading audit trail...</td></tr>';
  modal.style.display = 'flex';
  modal.querySelector('#bc-audit-modal-close')?.focus();
  return modal;
}

function renderAuditRows(logs) {
  return logs.length ? logs.map(log => `<tr>
    <td>${bcEsc(bcFormatDate(log.Created_At))}</td>
    <td>${bcEsc(log.Event_Type)}</td>
    <td>${bcBadge(log.Status)}</td>
    <td class="tx-hash" title="${bcEsc(log.Payload_Hash || '')}">${bcEsc(bcShortHash(log.Payload_Hash))}</td>
    <td class="tx-hash" title="${bcEsc(log.Transaction_Hash || '')}">${bcEsc(bcShortHash(log.Transaction_Hash))}</td>
    <td>${bcEsc(log.Actor_Role || '-')}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="att-empty">No audit entries for this payroll record.</td></tr>';
}

async function loadBlockchainAudit(payrollId) {
  const title = document.getElementById('bc-audit-title');
  const tbody = document.getElementById('bc-audit-tbody');
  const modal = openBlockchainAuditModal(payrollId);
  const modalBody = modal.querySelector('#bc-audit-modal-tbody');

  if (title) title.textContent = `Audit Trail - Payroll ${payrollId}`;
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="att-empty">Loading audit trail...</td></tr>';

  try {
    const { data } = await bcRequest(`/api/blockchain/payroll/audit/${payrollId}`);
    const logs = data.audit_logs || [];
    const rows = renderAuditRows(logs);
    if (tbody) tbody.innerHTML = rows;
    if (modalBody) modalBody.innerHTML = rows;
    bcShowMessage(logs.length
      ? `Loaded ${logs.length} audit event${logs.length === 1 ? '' : 's'} for payroll ${payrollId}.`
      : `No audit entries were found for payroll ${payrollId}.`);
  } catch (error) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="att-empty">Unable to load the audit trail.</td></tr>';
    if (modalBody) modalBody.innerHTML = '<tr><td colspan="6" class="att-empty">Unable to load the audit trail.</td></tr>';
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
window.verifyPayrollHash = verifyPayrollHash;
window.loadBlockchainAudit = loadBlockchainAudit;
window.closeBlockchainAuditModal = closeBlockchainAuditModal;
