/* ============================================================
   public/js/dpa.js - Data Privacy Agreement gate
   ============================================================ */

let dpaGateAfterAccept = null;
let dpaGateStatusLoading = false;

function requiresDpaGate(user = null) {
  const currentUser = user || (typeof getUser === 'function' ? getUser() : null);
  return Boolean(currentUser && (currentUser.dpaRequired === true || currentUser.dpaAccepted === false));
}

function updateStoredDpaState(accepted, agreementVersion = null) {
  if (typeof getUser !== 'function') return null;
  const user = getUser();
  if (!user) return null;
  const updated = {
    ...user,
    dpaAccepted: Boolean(accepted),
    dpaRequired: !accepted,
    dpaAgreementVersion: agreementVersion || user.dpaAgreementVersion || null,
  };
  sessionStorage.setItem('vp_user', JSON.stringify(updated));
  return updated;
}

function dpaAgreementMarkup() {
  return `
    <div class="dpa-modal" role="dialog" aria-modal="true" aria-labelledby="dpa-title">
      <div class="dpa-modal-header">
        <div>
          <div class="dpa-kicker">Required before system access</div>
          <h2 id="dpa-title">Data Privacy Agreement</h2>
        </div>
        <div class="dpa-version" id="dpa-version-label">Loading</div>
      </div>
      <div class="dpa-modal-body">
        <p>
          LGSV HR collects and processes personal and employment-related data needed for secure HR,
          attendance, payroll, payslip, onboarding, audit, and system administration operations.
        </p>
        <p>
          The system may process employee and applicant profile data, 201-file records, contact and
          government identifier details, attendance and biometric attendance references, leave records,
          payroll computation records, payslip data, account activity, audit logs, and blockchain
          integrity verification metadata.
        </p>
        <p>
          Full personally identifiable information and payroll details are stored off-chain in the
          protected HRIS database. The permissioned blockchain layer stores only hashes, references,
          approval metadata, transaction records, and integrity proofs for finalized payroll and DTR
          verification.
        </p>
        <p>
          Access is limited by role-based access control. Sensitive actions such as login attempts,
          account creation, role changes, attendance correction, payroll approval, payslip release,
          and blockchain verification are logged for security and accountability.
        </p>
        <p>
          Your DPA decision is also logged. Acceptance or refusal records include your user account,
          linked employee ID when available, agreement version, timestamp, IP address, and browser
          user-agent for compliance and audit review.
        </p>
        <label class="dpa-consent-row">
          <input type="checkbox" id="dpa-consent-checkbox" />
          <span>I have read and agree to the processing of my data for authorized LGSV HR operations.</span>
        </label>
        <div class="dpa-error" id="dpa-error" hidden></div>
      </div>
      <div class="dpa-modal-actions">
        <button type="button" class="dpa-btn dpa-btn-secondary" id="dpa-decline-btn">Decline</button>
        <button type="button" class="dpa-btn dpa-btn-primary" id="dpa-accept-btn" disabled>Accept and Continue</button>
      </div>
    </div>
  `;
}

function ensureDpaModal() {
  let overlay = document.getElementById('dpa-gate-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'dpa-gate-overlay';
  overlay.className = 'dpa-gate-overlay';
  overlay.hidden = true;
  overlay.innerHTML = dpaAgreementMarkup();
  document.body.appendChild(overlay);

  const checkbox = overlay.querySelector('#dpa-consent-checkbox');
  const acceptButton = overlay.querySelector('#dpa-accept-btn');
  const declineButton = overlay.querySelector('#dpa-decline-btn');

  checkbox?.addEventListener('change', () => {
    if (acceptButton) acceptButton.disabled = !checkbox.checked || dpaGateStatusLoading;
  });
  acceptButton?.addEventListener('click', acceptDpaAgreement);
  declineButton?.addEventListener('click', declineDpaAgreement);

  return overlay;
}

function setDpaError(message = '') {
  const error = document.getElementById('dpa-error');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function setDpaLoading(loading) {
  dpaGateStatusLoading = Boolean(loading);
  const acceptButton = document.getElementById('dpa-accept-btn');
  const declineButton = document.getElementById('dpa-decline-btn');
  const checkbox = document.getElementById('dpa-consent-checkbox');
  if (acceptButton) acceptButton.disabled = loading || !checkbox?.checked;
  if (declineButton) declineButton.disabled = loading;
}

async function refreshDpaStatus() {
  setDpaLoading(true);
  setDpaError('');
  try {
    const response = await apiFetch('/api/dpa/status');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load Data Privacy Agreement status.');

    const versionLabel = document.getElementById('dpa-version-label');
    if (versionLabel) versionLabel.textContent = data.agreement_version || 'Current version';

    updateStoredDpaState(Boolean(data.accepted), data.agreement_version);
    if (data.accepted) {
      hideDpaAgreementGate();
      runDpaAfterAccept();
    }
  } catch (error) {
    setDpaError(error.message || 'Unable to load Data Privacy Agreement status.');
  } finally {
    setDpaLoading(false);
  }
}

function runDpaAfterAccept() {
  const callback = dpaGateAfterAccept;
  dpaGateAfterAccept = null;
  if (typeof callback === 'function') callback();
}

function showDpaAgreementGate(options = {}) {
  const overlay = ensureDpaModal();
  if (typeof options.afterAccept === 'function') dpaGateAfterAccept = options.afterAccept;
  overlay.hidden = false;
  document.body.classList.add('dpa-gate-open');
  setDpaError('');
  refreshDpaStatus();
  requestAnimationFrame(() => document.getElementById('dpa-consent-checkbox')?.focus());
}

function hideDpaAgreementGate() {
  const overlay = document.getElementById('dpa-gate-overlay');
  if (overlay) overlay.hidden = true;
  document.body.classList.remove('dpa-gate-open');
}

async function acceptDpaAgreement() {
  const checkbox = document.getElementById('dpa-consent-checkbox');
  if (!checkbox?.checked) {
    setDpaError('Please confirm that you have read and accept the agreement.');
    return;
  }

  const user = typeof getUser === 'function' ? getUser() : null;
  const agreementVersion = user?.dpaAgreementVersion || document.getElementById('dpa-version-label')?.textContent || undefined;
  setDpaLoading(true);
  setDpaError('');

  try {
    const response = await apiFetch('/api/dpa/accept', {
      method: 'POST',
      body: JSON.stringify({
        agreement_version: agreementVersion,
        consent: true,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to save Data Privacy Agreement acceptance.');

    updateStoredDpaState(true, data.agreement_version || agreementVersion);
    hideDpaAgreementGate();
    runDpaAfterAccept();
  } catch (error) {
    setDpaError(error.message || 'Unable to save Data Privacy Agreement acceptance.');
  } finally {
    setDpaLoading(false);
  }
}

async function declineDpaAgreement() {
  setDpaLoading(true);
  try {
    const response = await apiFetch('/api/dpa/decline', { method: 'POST', body: JSON.stringify({ declined: true }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && data.error) console.warn('[DPA] Decline audit response:', data.error);
  } catch (_error) {
    // The user is still blocked locally even if the refusal audit request fails.
  } finally {
    setDpaLoading(false);
    closeDpaDeclinedTab();
  }
}

function closeDpaDeclinedTab() {
  dpaGateAfterAccept = null;
  hideDpaAgreementGate();
  if (typeof stopAttendanceAjaxRefresh === 'function') stopAttendanceAjaxRefresh();
  if (typeof clearAuth === 'function') {
    clearAuth();
  } else {
    sessionStorage.removeItem('vp_token');
    sessionStorage.removeItem('vp_session_binding');
    sessionStorage.removeItem('vp_user');
  }

  try {
    window.open('', '_self');
    window.close();
  } catch (_error) {
    // Browsers may block scripts from closing tabs they did not open.
  }

  setTimeout(() => {
    if (document.visibilityState === 'hidden' || window.closed) return;
    document.title = 'DPA Declined';
    document.body.className = '';
    document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#1f2937;font-family:Arial,sans-serif;text-align:center;padding:24px;">
        <section>
          <h1 style="font-size:22px;margin:0 0 8px;">Data Privacy Agreement Declined</h1>
          <p style="margin:0;color:#64748b;">Your session has been ended.</p>
        </section>
      </main>
    `;
    setTimeout(() => {
      try {
        window.location.replace('about:blank');
      } catch (_error) {}
    }, 900);
  }, 250);
}

window.requiresDpaGate = requiresDpaGate;
window.showDpaAgreementGate = showDpaAgreementGate;
window.hideDpaAgreementGate = hideDpaAgreementGate;
