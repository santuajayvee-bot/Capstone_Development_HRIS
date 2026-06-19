let selfServiceState = {
  profile: null,
  originalEmail: '',
  initialized: false
};

const SELF_HR_ROLES = new Set(['hr_manager', 'hr_admin', 'system_admin', 'admin']);

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function selfServiceNotify(message, type = 'info') {
  if (typeof showToast === 'function') return showToast(message, type);
  if (typeof showModal === 'function') return showModal(type === 'error' ? 'Error' : 'Notice', message);
  alert(message);
}

function selfValue(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

function setSelfValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value || '';
}

function formatSelfDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

function selfBadge(status) {
  const label = String(status || 'Pending');
  const key = label.toLowerCase().replace(/\s+/g, '-');
  return `<span class="status-badge status-${key}">${label}</span>`;
}

function isSelfHrReviewer() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return SELF_HR_ROLES.has(user?.role);
}

function initSelfServiceTabs() {
  document.querySelectorAll('[data-self-tab]').forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.dataset.selfTab;
      document.querySelectorAll('[data-self-tab]').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.self-tab-panel').forEach(panel => panel.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(`self-tab-${tab}`)?.classList.add('active');
      if (tab === 'requests') loadSelfChangeRequests();
      if (tab === 'activity') loadSelfActivityLog();
      if (tab === 'hr-requests') loadHrProfileChangeRequests();
    });
  });
}

function fillSelfServiceProfile(profile) {
  const ro = profile.readonly || {};
  const editable = profile.editable || {};
  const restricted = profile.restricted || {};
  selfServiceState.profile = profile;
  selfServiceState.originalEmail = editable.email || '';

  setSelfValue('self-employee-code', ro.employee_code);
  setSelfValue('self-full-name', ro.full_name);
  setSelfValue('self-department', ro.department);
  setSelfValue('self-position', ro.position);
  setSelfValue('self-wage-type', ro.wage_type);
  setSelfValue('self-employment-status', ro.employment_status);
  setSelfValue('self-date-hired', formatSelfDate(ro.date_hired));
  setSelfValue('self-civil-status', restricted.civil_status);
  setSelfValue('self-email', editable.email);
  setSelfValue('self-work-email', editable.work_email);
  setSelfValue('self-contact-number', editable.contact_number);
  setSelfValue('self-current-address', editable.current_address || editable.current_address_full_address);
  setSelfValue('self-mailing-address', editable.mailing_address || editable.mailing_address_full_address);
  setSelfValue('self-permanent-address', restricted.permanent_address);
  setSelfValue('self-emergency-name', editable.emergency_contact_name);
  setSelfValue('self-emergency-relationship', editable.emergency_contact_relationship);
  setSelfValue('self-emergency-number', editable.emergency_contact_num);
  setSelfValue('self-emergency-email', editable.emergency_contact_email);

  const preview = document.getElementById('self-picture-preview');
  if (preview) {
    preview.textContent = 'No Photo';
    if (editable.photo_url) loadSelfProfilePicture(editable.photo_url);
  }
}

async function loadSelfProfilePicture(url) {
  const preview = document.getElementById('self-picture-preview');
  if (!preview) return;
  try {
    const res = await apiFetch(url);
    if (!res.ok) return;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    preview.innerHTML = `<img src="${objectUrl}" alt="Profile picture">`;
  } catch (_error) {
    preview.textContent = 'No Photo';
  }
}

async function loadSelfServiceProfile() {
  const res = await apiFetch('/api/self-service/profile');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load profile.');
  fillSelfServiceProfile(data);
}

function buildSelfProfilePayload(section) {
  if (section === 'contact') {
    return {
      email: selfValue('self-email'),
      work_email: selfValue('self-work-email'),
      contact_number: selfValue('self-contact-number'),
      password_confirmation: selfValue('self-email-password')
    };
  }
  if (section === 'address') {
    return {
      current_address: selfValue('self-current-address'),
      current_address_full_address: selfValue('self-current-address'),
      mailing_address: selfValue('self-mailing-address'),
      mailing_address_full_address: selfValue('self-mailing-address')
    };
  }
  if (section === 'emergency') {
    return {
      emergency_contact_name: selfValue('self-emergency-name'),
      emergency_contact_relationship: selfValue('self-emergency-relationship'),
      emergency_contact_num: selfValue('self-emergency-number'),
      emergency_contact_email: selfValue('self-emergency-email')
    };
  }
  return {};
}

async function saveSelfProfileSection(section) {
  try {
    if (section === 'contact' && selfValue('self-email') !== selfServiceState.originalEmail && !selfValue('self-email-password')) {
      selfServiceNotify('Password confirmation is required when changing email.', 'error');
      return;
    }
    const res = await apiFetch('/api/self-service/profile', {
      method: 'PUT',
      body: JSON.stringify(buildSelfProfilePayload(section))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save profile.');
    selfServiceNotify(data.message || 'Profile saved.', 'success');
    setSelfValue('self-email-password', '');
    await loadSelfServiceProfile();
    await loadSelfActivityLog();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function changeSelfPassword() {
  try {
    const newPassword = selfValue('self-new-password');
    if (newPassword !== selfValue('self-confirm-password')) {
      selfServiceNotify('New password confirmation does not match.', 'error');
      return;
    }
    const res = await apiFetch('/api/self-service/password', {
      method: 'PUT',
      body: JSON.stringify({
        current_password: selfValue('self-current-password'),
        new_password: newPassword
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to change password.');
    ['self-current-password', 'self-new-password', 'self-confirm-password'].forEach(id => setSelfValue(id, ''));
    selfServiceNotify(data.message || 'Password changed.', 'success');
    await loadSelfActivityLog();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function uploadSelfPicture(event) {
  event.preventDefault();
  try {
    const input = document.getElementById('self-picture-input');
    if (!input?.files?.length) {
      selfServiceNotify('Choose a JPG or PNG profile picture first.', 'error');
      return;
    }
    const formData = new FormData();
    formData.append('photo', input.files[0]);
    const res = await apiFetch('/api/self-service/profile-picture', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to upload profile picture.');
    input.value = '';
    selfServiceNotify(data.message || 'Profile picture updated.', 'success');
    await loadSelfServiceProfile();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function loadSelfChangeRequests() {
  const tbody = document.getElementById('self-change-requests-body');
  if (!tbody) return;
  try {
    const res = await apiFetch('/api/self-service/change-requests');
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load requests.');
    tbody.innerHTML = rows.length ? rows.map(row => `
      <tr>
        <td>${escapeHTML(row.field_name || '')}</td>
        <td>${escapeHTML(row.requested_value || '')}</td>
        <td>${selfBadge(row.status)}</td>
        <td>${formatSelfDate(row.created_at)}</td>
        <td>${escapeHTML(row.rejection_reason || row.reason || '-')}</td>
      </tr>
    `).join('') : '<tr><td colspan="5">No change requests yet.</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="5">${escapeHTML(error.message)}</td></tr>`;
  }
}

async function submitSelfChangeRequest(event) {
  event.preventDefault();
  try {
    const res = await apiFetch('/api/self-service/change-requests', {
      method: 'POST',
      body: JSON.stringify({
        field_name: selfValue('self-request-field'),
        requested_value: selfValue('self-request-value'),
        reason: selfValue('self-request-reason')
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to submit change request.');
    document.getElementById('self-change-request-form')?.reset();
    selfServiceNotify(data.message || 'Change request submitted.', 'success');
    await loadSelfChangeRequests();
    await loadSelfActivityLog();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function loadSelfActivityLog() {
  const tbody = document.getElementById('self-activity-body');
  if (!tbody) return;
  try {
    const res = await apiFetch('/api/self-service/activity-log');
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load activity log.');
    tbody.innerHTML = rows.length ? rows.map(row => `
      <tr>
        <td>${escapeHTML(row.action || '')}</td>
        <td>${escapeHTML(row.field_changed || '-')}</td>
        <td>${formatSelfDate(row.created_at)}</td>
      </tr>
    `).join('') : '<tr><td colspan="3">No profile activity yet.</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="3">${escapeHTML(error.message)}</td></tr>`;
  }
}

async function loadHrProfileChangeRequests() {
  const tbody = document.getElementById('self-hr-requests-body');
  if (!tbody || !isSelfHrReviewer()) return;
  try {
    const res = await apiFetch('/api/hr/profile-change-requests');
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load HR requests.');
    tbody.innerHTML = rows.length ? rows.map(row => `
      <tr>
        <td>${escapeHTML(row.employee_name || row.employee_code || '')}<br><small>${escapeHTML(row.employee_code || '')}</small></td>
        <td>${escapeHTML(row.field_name || '')}</td>
        <td>${escapeHTML(row.requested_value || '')}</td>
        <td>${escapeHTML(row.reason || '-')}</td>
        <td>${selfBadge(row.status)}</td>
        <td>
          ${row.status === 'Pending' ? `
            <button type="button" class="btn btn-secondary btn-sm" onclick="approveHrProfileRequest(${row.id})">Approve</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="rejectHrProfileRequest(${row.id})">Reject</button>
          ` : '-'}
        </td>
      </tr>
    `).join('') : '<tr><td colspan="6">No employee change requests.</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="6">${escapeHTML(error.message)}</td></tr>`;
  }
}

async function approveHrProfileRequest(id) {
  try {
    const res = await apiFetch(`/api/hr/profile-change-requests/${id}/approve`, { method: 'POST', body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to approve request.');
    selfServiceNotify(data.message || 'Request approved.', 'success');
    await loadHrProfileChangeRequests();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function rejectHrProfileRequest(id) {
  const reason = prompt('Reason for rejecting this change request:');
  if (!reason || !reason.trim()) return;
  try {
    const res = await apiFetch(`/api/hr/profile-change-requests/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ rejection_reason: reason.trim() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to reject request.');
    selfServiceNotify(data.message || 'Request rejected.', 'success');
    await loadHrProfileChangeRequests();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

function wireSelfServiceEvents() {
  if (selfServiceState.initialized) return;
  selfServiceState.initialized = true;
  initSelfServiceTabs();
  document.getElementById('self-service-refresh')?.addEventListener('click', initSelfServiceProfile);
  document.querySelectorAll('[data-self-save]').forEach(button => {
    button.addEventListener('click', () => saveSelfProfileSection(button.dataset.selfSave));
  });
  document.getElementById('self-password-save')?.addEventListener('click', changeSelfPassword);
  document.getElementById('self-picture-form')?.addEventListener('submit', uploadSelfPicture);
  document.getElementById('self-change-request-form')?.addEventListener('submit', submitSelfChangeRequest);
}

async function initSelfServiceProfile() {
  wireSelfServiceEvents();
  document.querySelectorAll('.self-service-hr-only').forEach(el => {
    el.style.display = isSelfHrReviewer() ? '' : 'none';
  });
  try {
    await loadSelfServiceProfile();
    await loadSelfChangeRequests();
    await loadSelfActivityLog();
    if (isSelfHrReviewer()) await loadHrProfileChangeRequests();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

window.initSelfServiceProfile = initSelfServiceProfile;
window.approveHrProfileRequest = approveHrProfileRequest;
window.rejectHrProfileRequest = rejectHrProfileRequest;
