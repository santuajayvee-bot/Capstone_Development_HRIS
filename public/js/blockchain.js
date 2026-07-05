/* ============================================================
   BLOCKCHAIN.JS - Permissioned payroll + attendance DTR audit UI
   ============================================================ */

let BC_RECORDS = [];
let BC_DTR_RECORDS = [];
let BC_INITIALIZED = false;
let BC_PAGE = 1;
let BC_DTR_PAGE = 1;
let BC_CURRENT_VIEW = 'integrity';
let BC_SUPPORT_LOADED = false;
const BC_PAGE_SIZE = 10;

const BC_ROLE_LABELS = {
  admin: 'System Administrator',
  system_admin: 'System Administrator',
  hr_admin: 'HR Admin',
  hr_manager: 'HR Manager',
  payroll_officer: 'Payroll Officer',
  payroll_manager: 'Payroll Manager',
};

const BC_LEDGER_STATUS_COPY = {
  PENDING_APPROVAL: {
    label: 'Waiting for Approval',
    help: 'Not final yet',
    color: 'badge-blue',
  },
  PENDING: {
    label: 'Waiting',
    help: 'Audit is queued',
    color: 'badge-yellow',
  },
  PENDING_ANCHOR: {
    label: 'Waiting for Fabric',
    help: 'Finalized locally, anchor queued',
    color: 'badge-yellow',
  },
  RECORDED: {
    label: 'Recorded on Fabric',
    help: 'Transaction receipt exists',
    color: 'badge-green',
  },
  VERIFIED: {
    label: 'Verified',
    help: 'Hash matched Fabric',
    color: 'badge-green',
  },
  FAILED: {
    label: 'Failed',
    help: 'Needs retry or review',
    color: 'badge-red',
  },
  CRITICAL: {
    label: 'Mismatch Detected',
    help: 'Possible tampering',
    color: 'badge-red',
  },
  FABRIC_UNAVAILABLE: {
    label: 'Fabric Unavailable',
    help: 'Verification not completed',
    color: 'badge-yellow',
  },
  VERIFICATION_UNAVAILABLE: {
    label: 'Fabric Unavailable',
    help: 'Verification not completed',
    color: 'badge-yellow',
  },
  NOT_FINALIZED: {
    label: 'Not Finalized',
    help: 'Cannot verify yet',
    color: 'badge-blue',
  },
  NOT_FOUND: {
    label: 'Missing',
    help: 'Record not found',
    color: 'badge-red',
  },
  SUCCESS: {
    label: 'Success',
    help: 'Completed',
    color: 'badge-green',
  },
};

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
  if (typeof formatPhilippineDateTime === 'function') {
    return formatPhilippineDateTime(date, { timeStyle: 'short' });
  }
  return `${date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })} PHT`;
}

function bcMoney(value) {
  const number = Number(value || 0);
  return number.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function bcBadge(value) {
  const text = String(value || 'UNKNOWN');
  const normalized = text.toUpperCase();
  const mapped = BC_LEDGER_STATUS_COPY[normalized];
  const label = mapped?.label || text;
  const color = mapped?.color || (normalized.includes('RECORDED') || normalized.includes('VERIFIED') || normalized.includes('SUCCESS')
    ? 'badge-green'
    : normalized.includes('PENDING')
      ? 'badge-yellow'
      : normalized.includes('CRITICAL') || normalized.includes('FAILED') || normalized.includes('TAMPER')
        ? 'badge-red'
        : 'badge-blue');
  return `<span class="badge ${color}" title="${bcEsc(text)}">${bcEsc(label)}</span>`;
}

function bcStatusCell(value) {
  const text = String(value || 'PENDING');
  const normalized = text.toUpperCase();
  const mapped = BC_LEDGER_STATUS_COPY[normalized] || {
    label: text.replace(/_/g, ' '),
    help: 'See audit trail',
    color: null,
  };
  return `
    <div class="bc-status-stack" title="${bcEsc(text)}">
      ${bcBadge(text)}
      <span class="bc-status-help">${bcEsc(mapped.help)}</span>
    </div>
  `;
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

function bcShowSupportMessage(message, type = 'info') {
  const element = document.getElementById('bc-support-message');
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

function bcRoleLabel() {
  const role = bcUserRole();
  return BC_ROLE_LABELS[role] || role.replace(/_/g, ' ') || 'Current user';
}

function bcCanVerify() {
  return ['system_admin', 'admin'].includes(bcUserRole());
}

function bcCanViewPayrollRecords() {
  return ['system_admin', 'admin', 'payroll_officer', 'payroll_manager'].includes(bcUserRole());
}

function bcCanRetryDtrAnchor() {
  return ['hr_admin', 'hr_manager', 'system_admin', 'admin'].includes(bcUserRole());
}

function bcAccessSummary() {
  const role = bcUserRole();
  if (['system_admin', 'admin'].includes(role)) {
    return `${bcRoleLabel()}: can view audit evidence, verify recorded hashes, inspect ledger history, and retry technical anchors.`;
  }
  if (role === 'payroll_manager') {
    return 'Payroll Manager: can view payroll integrity evidence after approval. Final integrity verification is reserved for System Admin.';
  }
  if (role === 'payroll_officer') {
    return 'Payroll Officer: can view payroll integrity status for audit awareness. Approval and verification are separated.';
  }
  if (role === 'hr_admin' || role === 'hr_manager') {
    return `${bcRoleLabel()}: can view attendance DTR integrity evidence. System Admin performs final verification.`;
  }
  return `${bcRoleLabel()}: blockchain integrity access is limited by backend RBAC.`;
}

function bcVerificationSummary() {
  return bcCanVerify()
    ? 'Verification controls are enabled for your System Admin role.'
    : 'Verify actions are locked to System Admin to separate approval from integrity checking.';
}

function switchBlockchainView(view = 'integrity', options = {}) {
  const nextView = view === 'support' && bcCanVerify() ? 'support' : 'integrity';
  if (view === 'support' && nextView !== 'support') {
    bcShowMessage('Blockchain support is restricted to System Admin. Showing integrity records instead.', 'warning');
  }

  BC_CURRENT_VIEW = nextView;
  document.querySelectorAll('#page-blockchain .bc-view').forEach(panel => {
    const active = panel.id === `bc-view-${nextView}`;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  document.querySelectorAll('#page-blockchain .bc-view-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.bcView === nextView);
  });

  if (!options.skipRouteUpdate && typeof syncRouteForPage === 'function') {
    syncRouteForPage('blockchain', nextView === 'support' ? { blockchainView: 'support' } : null);
  }

  if (nextView === 'support') {
    loadBlockchainSupportStatus();
  } else {
    loadBlockchainRecords();
  }
}

function bcTotalPages() {
  return Math.max(1, Math.ceil(BC_RECORDS.length / BC_PAGE_SIZE));
}

function bcDtrTotalPages() {
  return Math.max(1, Math.ceil(BC_DTR_RECORDS.length / BC_PAGE_SIZE));
}

function renderBlockchainPagination() {
  const pager = document.getElementById('bc-pagination');
  if (!pager) return;

  if (BC_RECORDS.length <= BC_PAGE_SIZE) {
    pager.style.display = 'none';
    pager.innerHTML = '';
    return;
  }

  const totalPages = bcTotalPages();
  BC_PAGE = Math.min(Math.max(BC_PAGE, 1), totalPages);
  const start = (BC_PAGE - 1) * BC_PAGE_SIZE;
  const end = Math.min(start + BC_PAGE_SIZE, BC_RECORDS.length);

  pager.style.display = '';
  pager.innerHTML = `
    <div class="bc-pagination-info">Showing ${start + 1}-${end} of ${BC_RECORDS.length}</div>
    <div class="bc-pagination-controls">
      <button class="btn btn-outline btn-sm" type="button" data-bc-page="prev" ${BC_PAGE <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${BC_PAGE} of ${totalPages}</span>
      <button class="btn btn-outline btn-sm" type="button" data-bc-page="next" ${BC_PAGE >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;

  pager.querySelector('[data-bc-page="prev"]')?.addEventListener('click', () => changeBlockchainPage(-1));
  pager.querySelector('[data-bc-page="next"]')?.addEventListener('click', () => changeBlockchainPage(1));
}

function changeBlockchainPage(direction) {
  BC_PAGE = Math.min(Math.max(BC_PAGE + direction, 1), bcTotalPages());
  renderBlockchainRows({ preservePage: true });
}

function renderDtrPagination() {
  const pager = document.getElementById('bc-dtr-pagination');
  if (!pager) return;

  if (BC_DTR_RECORDS.length <= BC_PAGE_SIZE) {
    pager.style.display = 'none';
    pager.innerHTML = '';
    return;
  }

  const totalPages = bcDtrTotalPages();
  BC_DTR_PAGE = Math.min(Math.max(BC_DTR_PAGE, 1), totalPages);
  const start = (BC_DTR_PAGE - 1) * BC_PAGE_SIZE;
  const end = Math.min(start + BC_PAGE_SIZE, BC_DTR_RECORDS.length);

  pager.style.display = '';
  pager.innerHTML = `
    <div class="bc-pagination-info">Showing ${start + 1}-${end} of ${BC_DTR_RECORDS.length}</div>
    <div class="bc-pagination-controls">
      <button class="btn btn-outline btn-sm" type="button" data-bc-dtr-page="prev" ${BC_DTR_PAGE <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${BC_DTR_PAGE} of ${totalPages}</span>
      <button class="btn btn-outline btn-sm" type="button" data-bc-dtr-page="next" ${BC_DTR_PAGE >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;

  pager.querySelector('[data-bc-dtr-page="prev"]')?.addEventListener('click', () => changeDtrBlockchainPage(-1));
  pager.querySelector('[data-bc-dtr-page="next"]')?.addEventListener('click', () => changeDtrBlockchainPage(1));
}

function changeDtrBlockchainPage(direction) {
  BC_DTR_PAGE = Math.min(Math.max(BC_DTR_PAGE + direction, 1), bcDtrTotalPages());
  renderDtrBlockchainRows({ preservePage: true });
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

function renderCriticalPanel(records) {
  const panel = document.getElementById('bc-critical-panel');
  if (!panel) return 0;
  const criticalRecords = records.filter(bcIsCriticalRecord);
  if (!criticalRecords.length) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return 0;
  }

  panel.innerHTML = `
    <div class="bc-critical-panel-title">CRITICAL ALERT</div>
    <div class="bc-critical-panel-copy">Possible tampering or failed integrity verification was detected. Review the audit trail before approving or relying on this record.</div>
    <div class="bc-critical-list">
      ${criticalRecords.slice(0, 6).map(record => {
        const recordId = record.Payroll_ID || record.DTR_ID || '-';
        const recordType = record.Payroll_ID ? 'Payroll' : 'Attendance DTR';
        return `
          <div class="bc-critical-item">
            <div>
              <strong>${bcEsc(recordType)} ${bcEsc(recordId)}</strong><br>
              <span class="tx-hash">${bcEsc(bcShortHash(record.Latest_Payload_Hash || record.Transaction_Hash || record.local_hash || ''))}</span>
            </div>
            ${bcBadge(record.Latest_Audit_Status)}
          </div>`;
      }).join('')}
    </div>
  `;
  panel.style.display = 'block';
  return criticalRecords.length;
}

function bcIsCriticalRecord(record) {
  return ['CRITICAL', 'FAILED'].includes(String(record?.Latest_Audit_Status).toUpperCase())
    || Number(record?.Critical_Audit_Count || 0) > 0;
}

function renderBlockchainStats(payload) {
  const payrollRecords = payload.records || [];
  const dtrRecords = payload.dtr_records || [];
  const records = [...payrollRecords, ...dtrRecords];
  const recorded = records.filter(row => String(row.Blockchain_Status).toUpperCase() === 'RECORDED').length;
  const pending = records.filter(row => ['PENDING_APPROVAL', 'PENDING', 'PENDING_ANCHOR'].includes(String(row.Blockchain_Status).toUpperCase())).length;
  const critical = renderCriticalPanel(records);
  const latest = records
    .map(row => row.Latest_Audit_At || row.Finalized_At || row.updated_at || row.created_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;

  bcSetText('bc-role-scope', bcAccessSummary());
  bcSetText('bc-verify-owner', bcVerificationSummary());
  bcSetText('bc-stat-total', records.length);
  bcSetText('bc-stat-recorded', recorded);
  bcSetText('bc-stat-pending', pending);
  bcSetText('bc-stat-critical', critical);
  bcSetText('bc-stat-latest', latest ? bcFormatDate(latest) : '-');
  bcSetText('bc-dtr-count', dtrRecords.length);

  const fabric = payload.fabric || {};
  const status = !fabric.enabled
    ? 'Fabric recording is disabled. Local audit records remain available.'
    : fabric.ready
      ? `Fabric Gateway credentials are configured: ${fabric.channelName} / ${fabric.chaincodeName}`
      : 'Fabric Gateway credentials are incomplete. Local audit records are available, but Fabric recording and verification are disabled.';
  bcSetText('bc-network-status', status);
  if (critical) {
    bcShowMessage(`${critical} blockchain integrity alert${critical === 1 ? '' : 's'} need review.`, 'critical');
  } else if (!fabric.enabled || !fabric.ready) {
    bcShowMessage(status, 'warning');
  }
}

function renderBlockchainRows(options = {}) {
  const tbody = document.getElementById('tx-tbody');
  if (!tbody) return;

  if (!bcCanViewPayrollRecords()) {
    tbody.innerHTML = '<tr><td colspan="9" class="att-empty">Payroll blockchain records are restricted to Payroll and System Administrator roles.</td></tr>';
    renderBlockchainPagination();
    if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(document.getElementById('page-blockchain') || document);
    return;
  }

  if (!BC_RECORDS.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="att-empty">No payroll integrity records found.</td></tr>';
    renderBlockchainPagination();
    if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(document.getElementById('page-blockchain') || document);
    return;
  }

  if (!options.preservePage) BC_PAGE = 1;
  BC_PAGE = Math.min(Math.max(BC_PAGE, 1), bcTotalPages());
  const pageRows = BC_RECORDS.slice((BC_PAGE - 1) * BC_PAGE_SIZE, BC_PAGE * BC_PAGE_SIZE);

  tbody.innerHTML = pageRows.map(record => {
    const payrollId = Number(record.Payroll_ID);
    const status = record.Blockchain_Status || 'PENDING';
    const auditStatus = record.Latest_Audit_Status || '-';
    const isCritical = bcIsCriticalRecord(record);
    const integrityHash = record.Transaction_Hash || record.Latest_Payload_Hash || record.local_hash || '';
    // A Fabric receipt is issued only after finalization. Keep the client rule
    // resilient to payroll-label changes; the API repeats the finalization and RBAC checks.
    const verifyButton = bcCanVerify() && String(status).toUpperCase() === 'RECORDED'
      ? `<button class="btn btn-outline btn-sm" onclick="verifyPayrollHash(${payrollId})">Verify integrity</button>`
      : '';

    return `<tr class="${isCritical ? 'blockchain-row-critical' : ''}">
      <td class="tx-block">${bcEsc(record.Payroll_ID)}</td>
      <td>${bcEsc(record.Employee_ID)}</td>
      <td>${bcMoney(record.Gross_Pay)}</td>
      <td>${bcMoney(record.Net_Pay)}</td>
      <td>${bcStatusCell(status)}</td>
      <td>${bcStatusCell(isCritical && String(auditStatus).toUpperCase() !== 'CRITICAL' ? 'CRITICAL' : auditStatus)}</td>
      <td class="tx-hash" title="${bcEsc(integrityHash)}">${bcEsc(bcShortHash(integrityHash))}</td>
      <td style="font-size:11px">${bcEsc(bcFormatDate(record.Finalized_At || record.Latest_Audit_At))}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${verifyButton}
          <button class="btn btn-outline btn-sm" type="button" onclick="loadBlockchainAudit(${payrollId})">Audit trail</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  renderBlockchainPagination();
  if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(document.getElementById('page-blockchain') || document);
}

function renderDtrBlockchainRows(options = {}) {
  const tbody = document.getElementById('bc-dtr-tbody');
  if (!tbody) return;

  bcSetText('bc-dtr-count', BC_DTR_RECORDS.length);

  if (!BC_DTR_RECORDS.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="att-empty">No attendance DTR blockchain records found.</td></tr>';
    renderDtrPagination();
    if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(document.getElementById('page-blockchain') || document);
    return;
  }

  if (!options.preservePage) BC_DTR_PAGE = 1;
  BC_DTR_PAGE = Math.min(Math.max(BC_DTR_PAGE, 1), bcDtrTotalPages());
  const pageRows = BC_DTR_RECORDS.slice((BC_DTR_PAGE - 1) * BC_PAGE_SIZE, BC_DTR_PAGE * BC_PAGE_SIZE);

  tbody.innerHTML = pageRows.map(record => {
    const dtrId = Number(record.DTR_ID);
    const status = record.Blockchain_Status || 'PENDING';
    const auditStatus = record.Latest_Audit_Status || '-';
    const isCritical = bcIsCriticalRecord(record);
    const integrityHash = record.Transaction_Hash || record.Latest_Payload_Hash || record.DTR_Hash || record.local_hash || '';
    const isRecorded = String(status).toUpperCase() === 'RECORDED';
    const isPendingAnchor = String(status).toUpperCase() === 'PENDING_ANCHOR';
    const verifyButton = bcCanVerify() && isRecorded
      ? `<button class="btn btn-outline btn-sm" onclick="verifyDtrHash(${dtrId})">Verify integrity</button>`
      : '';
    const retryButton = bcCanRetryDtrAnchor() && isPendingAnchor
      ? `<button class="btn btn-outline btn-sm" onclick="retryDtrAnchor(${dtrId})">Retry Fabric</button>`
      : '';

    return `<tr class="${isCritical ? 'blockchain-row-critical' : ''}">
      <td class="tx-block">${bcEsc(record.DTR_ID)}</td>
      <td>${bcEsc(record.Employee_Ref || record.Employee_Code || record.Employee_ID || '-')}</td>
      <td>${bcEsc(record.Date_Range_Start || '-')}<br><span class="tx-hash">to ${bcEsc(record.Date_Range_End || '-')}</span></td>
      <td>${bcEsc(record.Total_Work_Hours ?? '0.00')} hrs<br><span class="tx-hash">OT ${bcEsc(record.Total_Overtime_Hours ?? '0.00')}</span></td>
      <td>${bcEsc(record.Total_Late_Minutes ?? 0)} min<br><span class="tx-hash">UT ${bcEsc(record.Total_Undertime_Minutes ?? 0)} min</span></td>
      <td>${bcStatusCell(status)}</td>
      <td>${bcStatusCell(isCritical && String(auditStatus).toUpperCase() !== 'CRITICAL' ? 'CRITICAL' : auditStatus)}</td>
      <td class="tx-hash" title="${bcEsc(integrityHash)}">${bcEsc(bcShortHash(integrityHash))}</td>
      <td style="font-size:11px">${bcEsc(bcFormatDate(record.Finalized_At || record.Latest_Audit_At))}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${verifyButton}
          ${retryButton}
          <button class="btn btn-outline btn-sm" type="button" onclick="loadDtrBlockchainAudit(${dtrId})">Audit trail</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  renderDtrPagination();
  if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(document.getElementById('page-blockchain') || document);
}

async function loadBlockchainRecords() {
  try {
    bcShowMessage('');
    const payrollRequest = bcCanViewPayrollRecords()
      ? bcRequest('/api/blockchain/payroll/finalized').catch(error => ({ error, data: { records: [] } }))
      : Promise.resolve({ data: { records: [] } });
    const [payrollResult, dtrResult] = await Promise.all([
      payrollRequest,
      bcRequest('/api/blockchain/dtr/finalized').catch(error => ({ error, data: { records: [] } })),
    ]);
    BC_RECORDS = payrollResult.data.records || [];
    BC_DTR_RECORDS = dtrResult.data.records || [];
    renderBlockchainStats({
      fabric: payrollResult.data.fabric || dtrResult.data.fabric || {},
      records: BC_RECORDS,
      dtr_records: BC_DTR_RECORDS,
    });
    renderBlockchainRows();
    renderDtrBlockchainRows();
    const errors = [payrollResult.error, dtrResult.error].filter(Boolean);
    if (errors.length) {
      bcShowMessage(errors.map(error => error.message).join(' '), 'warning');
    }
  } catch (error) {
    BC_RECORDS = [];
    BC_DTR_RECORDS = [];
    renderBlockchainRows();
    renderDtrBlockchainRows();
    bcShowMessage(error.message, 'critical');
  }
}

async function loadBlockchainSupportStatus() {
  if (!bcCanVerify()) {
    bcShowSupportMessage('Blockchain support is restricted to System Admin.', 'warning');
    return;
  }
  try {
    bcShowSupportMessage('');
    const { data } = await bcRequest('/api/admin/blockchain-support/status');
    BC_SUPPORT_LOADED = true;
    const fabric = data.fabric || {};
    const payroll = data.payroll_records || {};
    const audit = data.audit || {};

    bcSetText('bc-support-fabric-ready', fabric.ready ? 'Ready' : 'Not Ready');
    bcSetText('bc-support-fabric-channel', fabric.channelName || '-');
    bcSetText('bc-support-total-records', Number(payroll.total || 0));
    bcSetText('bc-support-pending-anchor', Number(payroll.pending_anchor || 0));
    bcSetText('bc-support-critical-count', Number(audit.critical || 0));
    renderBlockchainSupportRows((audit.recent || []).slice(0, 8));
  } catch (error) {
    bcShowSupportMessage(error.message || 'Failed to load blockchain support status.', 'critical');
    renderBlockchainSupportRows([]);
  }
}

function renderBlockchainSupportRows(rows) {
  const tbody = document.getElementById('bc-support-tbody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="att-empty">No recent blockchain support events.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${Number(row.Audit_ID || 0)}</td>
      <td>${Number(row.Payroll_ID || 0)}</td>
      <td>${bcEsc(row.Event_Type || '-')}</td>
      <td>${bcBadge(row.Status)}</td>
      <td class="tx-hash" title="${bcEsc(row.Transaction_Hash || row.Payload_Hash || '')}">${bcEsc(bcShortHash(row.Transaction_Hash || row.Payload_Hash))}</td>
      <td>${bcEsc(bcFormatDate(row.Created_At))}</td>
    </tr>
  `).join('');
  if (typeof enhanceResponsiveTables === 'function') enhanceResponsiveTables(document.getElementById('bc-view-support') || document);
}

async function verifyPayrollHash(payrollId) {
  if (!bcCanVerify()) {
    bcShowMessage('Integrity verification is restricted to System Admin. Your role can view the audit trail.', 'warning');
    return;
  }
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
    if (error.data?.status === 'verification_unavailable') {
      bcShowMessage(error.data.message, 'warning');
      await loadBlockchainAudit(payrollId);
      return;
    }
    bcShowMessage(error.message, 'critical');
  }
}

async function verifyDtrHash(dtrId) {
  if (!bcCanVerify()) {
    bcShowMessage('Integrity verification is restricted to System Admin. Your role can view the audit trail.', 'warning');
    return;
  }
  try {
    const { response, data } = await bcRequest(`/api/blockchain/dtr/verify/${dtrId}`);
    if (response.status === 202) {
      bcShowMessage(data.message, 'warning');
    } else if (data.status === 'critical') {
      bcShowMessage(data.message, 'critical');
    } else {
      bcShowMessage(data.message || 'Attendance DTR integrity verified.');
    }
    await loadBlockchainRecords();
    await loadDtrBlockchainAudit(dtrId);
  } catch (error) {
    if (error.status === 409 && error.data?.status === 'critical') {
      bcShowMessage(error.data.message, 'critical');
      await loadDtrBlockchainAudit(dtrId);
      return;
    }
    bcShowMessage(error.message, 'critical');
  }
}

async function retryDtrAnchor(dtrId) {
  try {
    const { response, data } = await bcRequest(`/api/blockchain/dtr/anchor/${dtrId}`, {
      method: 'POST',
    });
    bcShowMessage(data.message || (response.status === 202 ? 'DTR remains queued for Fabric anchoring.' : 'Attendance DTR hash recorded on Fabric.'), response.status === 202 ? 'warning' : 'info');
    await loadBlockchainRecords();
    await loadDtrBlockchainAudit(dtrId);
  } catch (error) {
    bcShowMessage(error.message, 'critical');
  }
}

function closeBlockchainAuditModal() {
  const modal = document.getElementById('bc-audit-modal');
  if (modal) modal.style.display = 'none';
}

function openBlockchainAuditModal(recordType, recordId) {
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

  modal.querySelector('#bc-audit-modal-title').textContent = `Audit Trail - ${recordType} ${recordId}`;
  modal.querySelector('#bc-audit-modal-tbody').innerHTML = '<tr><td colspan="6" class="att-empty">Loading audit trail...</td></tr>';
  modal.style.display = 'flex';
  modal.querySelector('#bc-audit-modal-close')?.focus();
  return modal;
}

function renderAuditRows(logs, emptyLabel = 'record') {
  return logs.length ? logs.map(log => `<tr>
    <td>${bcEsc(bcFormatDate(log.Created_At))}</td>
    <td>${bcEsc(log.Event_Type)}</td>
    <td>${bcBadge(log.Status)}</td>
    <td class="tx-hash" title="${bcEsc(log.Payload_Hash || '')}">${bcEsc(bcShortHash(log.Payload_Hash))}</td>
    <td class="tx-hash" title="${bcEsc(log.Transaction_Hash || '')}">${bcEsc(bcShortHash(log.Transaction_Hash))}</td>
    <td>${bcEsc(log.Actor_Role || '-')}</td>
  </tr>`).join('') : `<tr><td colspan="6" class="att-empty">No audit entries for this ${bcEsc(emptyLabel)}.</td></tr>`;
}

async function loadBlockchainAudit(payrollId) {
  const title = document.getElementById('bc-audit-title');
  const tbody = document.getElementById('bc-audit-tbody');
  const modal = openBlockchainAuditModal('Payroll', payrollId);
  const modalBody = modal.querySelector('#bc-audit-modal-tbody');

  if (title) title.textContent = `Audit Trail - Payroll ${payrollId}`;
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="att-empty">Loading audit trail...</td></tr>';

  try {
    const { data } = await bcRequest(`/api/blockchain/payroll/audit/${payrollId}`);
    const logs = data.audit_logs || [];
    const rows = renderAuditRows(logs, 'payroll record');
    if (tbody) tbody.innerHTML = rows;
    if (modalBody) modalBody.innerHTML = rows;
    if (typeof enhanceResponsiveTables === 'function') {
      enhanceResponsiveTables(document.getElementById('bc-audit-panel') || document);
      enhanceResponsiveTables(modal);
    }
    bcShowMessage(logs.length
      ? `Loaded ${logs.length} audit event${logs.length === 1 ? '' : 's'} for payroll ${payrollId}.`
      : `No audit entries were found for payroll ${payrollId}.`);
  } catch (error) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="att-empty">Unable to load the audit trail.</td></tr>';
    if (modalBody) modalBody.innerHTML = '<tr><td colspan="6" class="att-empty">Unable to load the audit trail.</td></tr>';
    if (typeof enhanceResponsiveTables === 'function') {
      enhanceResponsiveTables(document.getElementById('bc-audit-panel') || document);
      enhanceResponsiveTables(modal);
    }
    bcShowMessage(error.message, 'critical');
  }
}

async function loadDtrBlockchainAudit(dtrId) {
  const title = document.getElementById('bc-audit-title');
  const tbody = document.getElementById('bc-audit-tbody');
  const modal = openBlockchainAuditModal('Attendance DTR', dtrId);
  const modalBody = modal.querySelector('#bc-audit-modal-tbody');

  if (title) title.textContent = `Audit Trail - Attendance DTR ${dtrId}`;
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="att-empty">Loading audit trail...</td></tr>';

  try {
    const { data } = await bcRequest(`/api/blockchain/dtr/audit/${dtrId}`);
    const logs = data.audit_logs || [];
    const rows = renderAuditRows(logs, 'attendance DTR record');
    if (tbody) tbody.innerHTML = rows;
    if (modalBody) modalBody.innerHTML = rows;
    if (typeof enhanceResponsiveTables === 'function') {
      enhanceResponsiveTables(document.getElementById('bc-audit-panel') || document);
      enhanceResponsiveTables(modal);
    }
    bcShowMessage(logs.length
      ? `Loaded ${logs.length} audit event${logs.length === 1 ? '' : 's'} for Attendance DTR ${dtrId}.`
      : `No audit entries were found for Attendance DTR ${dtrId}.`);
  } catch (error) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="att-empty">Unable to load the audit trail.</td></tr>';
    if (modalBody) modalBody.innerHTML = '<tr><td colspan="6" class="att-empty">Unable to load the audit trail.</td></tr>';
    if (typeof enhanceResponsiveTables === 'function') {
      enhanceResponsiveTables(document.getElementById('bc-audit-panel') || document);
      enhanceResponsiveTables(modal);
    }
    bcShowMessage(error.message, 'critical');
  }
}

function initBlockchainPage() {
  const page = document.getElementById('page-blockchain');
  if (!page || !document.getElementById('tx-tbody')) return;
  const supportTab = document.getElementById('bc-support-view-tab');
  if (supportTab) supportTab.style.display = bcCanVerify() ? '' : 'none';

  if (BC_INITIALIZED) {
    switchBlockchainView(window.ROUTE_PARAMS?.blockchainView || BC_CURRENT_VIEW, { skipRouteUpdate: true });
    return;
  }
  BC_INITIALIZED = true;
  bcSetText('bc-role-scope', bcAccessSummary());
  bcSetText('bc-verify-owner', bcVerificationSummary());
  document.getElementById('bc-refresh')?.addEventListener('click', loadBlockchainRecords);
  switchBlockchainView(window.ROUTE_PARAMS?.blockchainView || 'integrity', { skipRouteUpdate: true });
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
window.loadBlockchainSupportStatus = loadBlockchainSupportStatus;
window.initBlockchainPage = initBlockchainPage;
window.switchBlockchainView = switchBlockchainView;
window.verifyPayrollHash = verifyPayrollHash;
window.verifyDtrHash = verifyDtrHash;
window.retryDtrAnchor = retryDtrAnchor;
window.loadBlockchainAudit = loadBlockchainAudit;
window.loadDtrBlockchainAudit = loadDtrBlockchainAudit;
window.closeBlockchainAuditModal = closeBlockchainAuditModal;
