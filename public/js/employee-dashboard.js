/* ============================================================
   public/js/employee-dashboard.js — Employee Actor Controller
   Secure-by-Design: RBAC-restricted Employee-only interface
   ============================================================ */

// ── Tab Switching ────────────────────────────────────────────
function switchEmpTab(tabId, el) {
  document.querySelectorAll('.emp-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.emp-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  const panel = document.getElementById('emp-panel-' + tabId);
  if (panel) panel.classList.add('active');

  if (tabId === 'overview') loadEmpDashboard();
  if (tabId === '201file')  loadEmp201File();
  if (tabId === 'payslips') loadEmpPayslips();
  if (tabId === 'settings') loadEmpSettings();
}

// ── Initialize ───────────────────────────────────────────────
function initEmployeeDashboard() {
  loadEmpDashboard();
}

// ── Toast ────────────────────────────────────────────────────
function showEmpToast(message, type = 'info') {
  const toast = document.getElementById('emp-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `sysadmin-toast ${type}`;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

// ═══════════════════════════════════════════════════════════════
// TASK 1: EMPLOYEE DASHBOARD
// ═══════════════════════════════════════════════════════════════

async function loadEmpDashboard() {
  try {
    const res = await apiFetch('/api/employee/dashboard');
    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[EmpDashboard] Error:', err.error);
      return;
    }
    const data = await res.json();

    // Welcome
    const p = data.profile;
    const greetEl = document.getElementById('emp-greeting');
    const descEl = document.getElementById('emp-role-desc');
    if (greetEl) greetEl.textContent = `Welcome back, ${p.first_name}!`;
    if (descEl) descEl.textContent = `${p.position || 'Employee'} · ${p.department || 'Unassigned'} · ${p.employment_type || 'Full-time'}`;

    // Stats
    if (data.latest_payslip) {
      const lp = data.latest_payslip;
      const el = document.getElementById('emp-stat-netpay');
      if (el) el.textContent = `₱${Number(lp.net_pay || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
      const periodEl = document.getElementById('emp-stat-period');
      if (periodEl && lp.period_start) {
        periodEl.textContent = `${formatDate(lp.period_start)} – ${formatDate(lp.period_end)}`;
      }

      // Show payslip preview card
      const card = document.getElementById('emp-latest-payslip-card');
      if (card) {
        card.style.display = 'block';
        const psP = document.getElementById('emp-ps-period');
        const psE = document.getElementById('emp-ps-earnings');
        const psD = document.getElementById('emp-ps-deductions');
        const psN = document.getElementById('emp-ps-netpay');
        const psS = document.getElementById('emp-payslip-status-badge');
        if (psP) psP.textContent = `${formatDate(lp.period_start)} – ${formatDate(lp.period_end)}`;
        if (psE) psE.textContent = `₱${Number(lp.total_earning || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
        if (psD) psD.textContent = `₱${Number(lp.total_deduction || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
        if (psN) psN.textContent = `₱${Number(lp.net_pay || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
        if (psS) {
          psS.textContent = lp.status || 'Pending';
          psS.className = 'emp-payslip-status ' + (lp.status === 'Disbursed' ? 'badge-green' : lp.status === 'Approved' ? 'badge-blue' : 'badge-yellow');
        }
      }
    }

    const docsEl = document.getElementById('emp-stat-docs');
    if (docsEl) docsEl.textContent = data.documents_count || '0';

    const leavesEl = document.getElementById('emp-stat-leaves');
    if (leavesEl) leavesEl.textContent = data.pending_leaves || '0';

    const attEl = document.getElementById('emp-stat-attendance');
    const clockEl = document.getElementById('emp-stat-clock');
    if (data.today_attendance) {
      if (attEl) attEl.textContent = data.today_attendance.clock_out ? 'Completed' : 'Clocked In';
      if (clockEl) clockEl.textContent = `Since ${new Date(data.today_attendance.clock_in).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      if (attEl) attEl.textContent = 'Absent';
      if (clockEl) clockEl.textContent = 'Not clocked in today';
    }
  } catch (err) {
    console.error('[EmpDashboard] Load error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// TASK 2: 201-FILE VIEW (AES-256 Decrypted PII)
// ═══════════════════════════════════════════════════════════════

async function loadEmp201File() {
  try {
    const res = await apiFetch('/api/employee/201-file');
    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[Emp201] Error:', err.error);
      return;
    }
    const data = await res.json();
    const d = data.demographics;
    const s = data.statutory_ids;

    // Demographics
    setEl('emp-201-code', d.employee_code);
    setEl('emp-201-name', [d.first_name, d.middle_name, d.last_name, d.suffix].filter(Boolean).join(' '));
    setEl('emp-201-email', d.email);
    setEl('emp-201-contact', d.contact_number || '—');
    setEl('emp-201-dob', d.date_of_birth ? formatDate(d.date_of_birth) : '—');
    setEl('emp-201-gender', d.gender || '—');
    setEl('emp-201-nationality', d.nationality || '—');
    setEl('emp-201-address', d.residential_address || '—');
    setEl('emp-201-dept', d.department || '—');
    setEl('emp-201-position', d.position || '—');
    setEl('emp-201-type', d.employment_type || '—');
    setEl('emp-201-hired', d.date_hired ? formatDate(d.date_hired) : '—');
    setEl('emp-201-status', d.status || '—');

    // PII (decrypted by backend using AES-256-GCM)
    setEl('emp-201-sss', s.sss_number);
    setEl('emp-201-philhealth', s.philhealth_number);
    setEl('emp-201-pagibig', s.pagibig_number);
    setEl('emp-201-tin', s.tin);
    setEl('emp-201-bank', s.bank_name);
    setEl('emp-201-bankacct', s.bank_account);

    // Documents
    const docsEl = document.getElementById('emp-201-docs');
    if (docsEl) {
      if (data.documents.length === 0) {
        docsEl.innerHTML = '<p style="color:var(--muted); font-size:13px;">No documents uploaded yet.</p>';
      } else {
        docsEl.innerHTML = '<div class="emp-doc-list">' + data.documents.map(doc => `
          <div class="emp-doc-item">
            <div>
              <span class="doc-type">${doc.document_type.replace(/_/g, ' ')}</span>
              <br><small style="color:var(--muted)">${doc.file_name}</small>
            </div>
            <span class="doc-date">${doc.uploaded_date ? formatDate(doc.uploaded_date) : '—'}</span>
          </div>
        `).join('') + '</div>';
      }
    }
  } catch (err) {
    console.error('[Emp201] Load error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// TASK 3: DIGITAL PAYSLIPS (SHA-256 Blockchain Verification)
// ═══════════════════════════════════════════════════════════════

async function loadEmpPayslips() {
  const tbody = document.getElementById('emp-payslips-tbody');
  try {
    const res = await apiFetch('/api/employee/payslips');
    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="table-empty">${err.error || 'Failed to load.'}</td></tr>`;
      return;
    }
    const payslips = await res.json();

    if (!tbody) return;
    if (payslips.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No payslips found.</td></tr>';
      return;
    }

    tbody.innerHTML = payslips.map(ps => {
      const integrityClass = ps.integrity === 'VERIFIED' ? 'integrity-verified'
        : ps.integrity === 'TAMPERED' ? 'integrity-tampered'
        : 'integrity-unverified';
      const integrityIcon = ps.integrity === 'VERIFIED' ? '✓ Verified'
        : ps.integrity === 'TAMPERED' ? '✗ Tampered'
        : '? Unverified';
      const statusClass = ps.status === 'Disbursed' ? 'badge-green'
        : ps.status === 'Approved' ? 'badge-blue' : 'badge-yellow';

      return `
        <tr>
          <td><small>${formatDate(ps.period_start)} – ${formatDate(ps.period_end)}</small></td>
          <td>${ps.wage_type || '—'}</td>
          <td>₱${Number(ps.total_earning || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
          <td>₱${Number(ps.total_deduction || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
          <td><strong style="color:var(--accent)">₱${Number(ps.net_pay || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</strong></td>
          <td><span class="badge ${statusClass}">${ps.status}</span></td>
          <td>
            <span class="${integrityClass}">${integrityIcon}</span>
            ${ps.blockchain_hash ? `<br><small style="color:var(--muted);font-size:9px;">${ps.blockchain_hash}</small>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('[EmpPayslips] Load error:', err);
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Failed to load payslips.</td></tr>';
  }
}

// ═══════════════════════════════════════════════════════════════
// TASK 4: EMERGENCY CONTACT FORM (Input Hardening)
// ═══════════════════════════════════════════════════════════════

async function loadEmpSettings() {
  try {
    const res = await apiFetch('/api/employee/201-file');
    if (!res || !res.ok) return;
    const data = await res.json();
    const d = data.demographics;
    const nameEl = document.getElementById('emp-ec-name');
    const numEl = document.getElementById('emp-ec-num');
    if (nameEl) nameEl.value = d.emergency_contact_name || '';
    if (numEl) numEl.value = d.emergency_contact_num || '';
  } catch (err) {
    console.error('[EmpSettings] Load error:', err);
  }
}

async function submitEmergencyContact() {
  const name = document.getElementById('emp-ec-name')?.value || '';
  const num  = document.getElementById('emp-ec-num')?.value || '';
  const btn  = document.getElementById('btn-ec-submit');
  const fb   = document.getElementById('emp-ec-feedback');

  if (!name.trim() || !num.trim()) {
    showEmpToast('Both fields are required.', 'error');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  try {
    const res = await apiFetch('/api/employee/emergency-contact', {
      method: 'PUT',
      body: JSON.stringify({ emergency_contact_name: name, emergency_contact_num: num }),
    });

    const data = await res.json();
    if (res.ok) {
      showEmpToast(`✅ ${data.message}`, 'success');
      if (fb) fb.innerHTML = '<span style="color:var(--green);font-size:12px;">✅ Saved successfully</span>';
    } else {
      showEmpToast(`❌ ${data.error}`, 'error');
      if (fb) fb.innerHTML = `<span style="color:var(--red);font-size:12px;">❌ ${data.error}</span>`;
    }
  } catch (err) {
    showEmpToast('Network error.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Changes'; }
  }
}

// ── Helpers ──────────────────────────────────────────────────
function setEl(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '—';
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return dateStr; }
}

// ── Expose Globally ─────────────────────────────────────────
window.switchEmpTab           = switchEmpTab;
window.initEmployeeDashboard  = initEmployeeDashboard;
window.submitEmergencyContact = submitEmergencyContact;
