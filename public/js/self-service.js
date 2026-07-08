let selfServiceState = {
  profile: null,
  originalEmail: '',
  initialized: false,
  previewUrl: null,
  savedPhotoUrl: null,
  sensitiveValues: {},
  sensitiveVisible: {},
  trustedDevices: [],
  deviceHistory: [],
  deviceActivity: [],
  deviceView: 'trusted'
};

const SELF_DEVICE_ACTIVITY_PAGE_SIZE = 25;
let selfDeviceActivityPage = 0;

const SELF_HR_ROLES = new Set(['hr_manager', 'hr_admin', 'system_admin', 'admin']);
const SELF_SENSITIVE_FIELDS = [
  'civil_status',
  'permanent_address',
  'email',
  'work_email',
  'contact_number',
  'current_address',
  'mailing_address',
  'emergency_contact_name',
  'emergency_contact_relationship',
  'emergency_contact_num',
  'emergency_contact_email',
  'sss_number',
  'philhealth_number',
  'pagibig_number',
  'tin',
  'tax_status',
  'bank_name',
  'bank_account_number'
];

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
  if (typeof showAlert === 'function') {
    const title = type === 'error' ? 'Error' : type === 'success' ? 'Success' : 'Notice';
    return showAlert(message, title, type);
  }
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

function setSelfText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '-';
}

function selfSensitiveIcon(visible) {
  return visible
    ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3.8 4.2 2.6l17.2 17.2-1.2 1.2-3.1-3.1A11.8 11.8 0 0 1 12 19C6.7 19 2.7 15.9 1 12c.8-1.9 2.2-3.6 4-4.8L3 3.8Zm6.1 6.1A3.7 3.7 0 0 0 12 15.7c.8 0 1.5-.2 2.1-.7l-5-5.1ZM12 5c5.3 0 9.3 3.1 11 7-.5 1.2-1.3 2.4-2.3 3.4l-3-3A5.7 5.7 0 0 0 10.5 6c.5-.1 1-.1 1.5-.1Z"></path></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5c5.3 0 9.3 3.1 11 7-1.7 3.9-5.7 7-11 7S2.7 15.9 1 12c1.7-3.9 5.7-7 11-7Zm0 2C8 7 4.8 9 3.3 12 4.8 15 8 17 12 17s7.2-2 8.7-5C19.2 9 16 7 12 7Zm0 2.2A2.8 2.8 0 1 1 12 14.8 2.8 2.8 0 0 1 12 9.2Z"></path></svg>`;
}

function setSelfSensitiveField(field, value, visible = false) {
  const input = document.querySelector(`[data-self-sensitive-input="${field}"]`);
  const button = document.querySelector(`[data-self-sensitive-toggle="${field}"]`);
  if (input) input.value = value || '-';
  if (button) {
    button.innerHTML = selfSensitiveIcon(visible);
    button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${button.dataset.selfSensitiveLabel || field.replace(/_/g, ' ')}`);
    button.setAttribute('aria-pressed', visible ? 'true' : 'false');
    button.classList.toggle('is-visible', visible);
  }
}

function resetSelfSensitiveFields(restricted = {}) {
  selfServiceState.sensitiveValues = {};
  selfServiceState.sensitiveVisible = {};
  SELF_SENSITIVE_FIELDS.forEach(field => {
    setSelfSensitiveField(field, restricted[field] || '', false);
  });
}

async function toggleSelfSensitiveField(field) {
  if (!SELF_SENSITIVE_FIELDS.includes(field)) return;
  if (selfServiceState.sensitiveVisible[field]) {
    selfServiceState.sensitiveVisible[field] = false;
    const masked = selfServiceState.profile?.restricted?.[field] || '';
    setSelfSensitiveField(field, masked, false);
    return;
  }

  const button = document.querySelector(`[data-self-sensitive-toggle="${field}"]`);
  if (button) button.disabled = true;
  try {
    if (!Object.prototype.hasOwnProperty.call(selfServiceState.sensitiveValues, field)) {
      const res = await apiFetch(`/api/self-service/restricted-fields/${encodeURIComponent(field)}/reveal`, {
        method: 'POST',
        body: '{}'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to load restricted field.');
      selfServiceState.sensitiveValues[field] = data.value || '';
      if (field === 'email') selfServiceState.originalEmail = data.value || '';
      if (selfServiceState.profile?.restricted) selfServiceState.profile.restricted[field] = data.masked || selfServiceState.profile.restricted[field] || '';
    }
    selfServiceState.sensitiveVisible[field] = true;
    setSelfSensitiveField(field, selfServiceState.sensitiveValues[field] || '-', true);
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function revokeSelfPicturePreview() {
  if (selfServiceState.previewUrl) {
    URL.revokeObjectURL(selfServiceState.previewUrl);
    selfServiceState.previewUrl = null;
  }
}

function showSelfPictureUrl(url, temporary = false) {
  if (!url) return;
  const createImage = alt => {
    const image = document.createElement('img');
    image.src = url;
    image.alt = alt;
    return image;
  };
  document.getElementById('self-picture-preview')?.replaceChildren(createImage('Profile picture preview'));
  document.getElementById('self-mobile-avatar')?.replaceChildren(createImage('Profile picture'));
  if (temporary) selfServiceState.previewUrl = url;
}

function previewSelfPicture() {
  const input = document.getElementById('self-picture-input');
  const file = input?.files?.[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    input.value = '';
    selfServiceNotify('Profile picture must be JPG or PNG.', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    input.value = '';
    selfServiceNotify('Profile picture must be 5MB or smaller.', 'error');
    return;
  }
  revokeSelfPicturePreview();
  showSelfPictureUrl(URL.createObjectURL(file), true);
}

function formatSelfDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

function formatSelfDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function selfDeviceRiskBadge(value) {
  const risk = String(value || 'Low');
  const cls = risk === 'High' ? 'badge-red' : risk === 'Medium' ? 'badge-yellow' : 'badge-green';
  return `<span class="badge ${cls}">${escapeHTML(risk)}</span>`;
}

async function selfDeviceJson(url, options = {}) {
  const response = await apiFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Device security request failed.');
  return data;
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

function isForcedPasswordChange() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return Boolean(user?.mustChangePassword || user?.forcePasswordChange);
}

function setSelfServiceTab(tab) {
  document.querySelectorAll('[data-self-tab]').forEach(item => item.classList.remove('active'));
  document.querySelectorAll('.self-tab-panel').forEach(panel => panel.classList.remove('active'));
  document.querySelector(`[data-self-tab="${tab}"]`)?.classList.add('active');
  document.getElementById(`self-tab-${tab}`)?.classList.add('active');
  if (tab === 'devices') loadSelfDeviceDashboard();
  if (tab === 'requests') loadSelfChangeRequests();
  if (tab === 'activity') loadSelfActivityLog();
  if (tab === 'hr-requests') loadHrProfileChangeRequests();
}

function initSelfServiceTabs() {
  document.querySelectorAll('[data-self-tab]').forEach(button => {
    if (button.dataset.selfServiceBound === 'true') return;
    button.dataset.selfServiceBound = 'true';
    button.addEventListener('click', () => {
      setSelfServiceTab(button.dataset.selfTab);
    });
  });
}

function fillSelfServiceProfile(profile) {
  const ro = profile.readonly || {};
  const editable = profile.editable || {};
  const restricted = profile.restricted || {};
  selfServiceState.profile = profile;
  selfServiceState.originalEmail = '';

  setSelfValue('self-employee-code', ro.employee_code);
  setSelfValue('self-full-name', ro.full_name);
  setSelfValue('self-department', ro.department);
  setSelfValue('self-position', ro.position);
  setSelfValue('self-wage-type', ro.wage_type);
  setSelfValue('self-employment-status', ro.employment_status);
  setSelfValue('self-date-hired', formatSelfDate(ro.date_hired));
  resetSelfSensitiveFields(restricted);

  const displayName = ro.full_name || '-';
  const initial = displayName.trim().charAt(0).toUpperCase() || '-';
  setSelfText('self-mobile-avatar', initial);
  setSelfText('self-mobile-name', displayName);
  setSelfText('self-mobile-meta', [ro.position, ro.department].filter(Boolean).join(' · '));
  setSelfText('self-mobile-status', ro.employment_status || '-');
  setSelfText('self-mobile-code', ro.employee_code || '-');
  setSelfText('self-mobile-employee-code', ro.employee_code || '-');
  setSelfText('self-mobile-department', ro.department || '-');
  setSelfText('self-mobile-position', ro.position || '-');
  setSelfText('self-mobile-wage-type', ro.wage_type || '-');
  setSelfText('self-mobile-employment-status', ro.employment_status || '-');
  setSelfText('self-mobile-date-hired', formatSelfDate(ro.date_hired) || '-');

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
    revokeSelfPicturePreview();
    if (selfServiceState.savedPhotoUrl) URL.revokeObjectURL(selfServiceState.savedPhotoUrl);
    const objectUrl = URL.createObjectURL(blob);
    selfServiceState.savedPhotoUrl = objectUrl;
    showSelfPictureUrl(objectUrl);
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
    const requiredReveals = {
      contact: ['email', 'work_email', 'contact_number'],
      address: ['current_address', 'mailing_address'],
      emergency: ['emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_num', 'emergency_contact_email']
    }[section] || [];
    if (requiredReveals.some(field => !selfServiceState.sensitiveVisible[field])) {
      selfServiceNotify('Reveal all fields in this section before saving changes.', 'error');
      return;
    }
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
    const confirmPassword = selfValue('self-confirm-password');
    if (newPassword !== confirmPassword) {
      selfServiceNotify('Passwords do not match.', 'error');
      return;
    }
    const res = await apiFetch('/api/account/password', {
      method: 'PUT',
      body: JSON.stringify({
        currentPassword: selfValue('self-current-password'),
        newPassword,
        confirmPassword
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || 'Failed to change password.');
    ['self-current-password', 'self-new-password', 'self-confirm-password'].forEach(id => setSelfValue(id, ''));
    selfServiceNotify(data.message || 'Password changed.', 'success');
    if (data.requiresRelogin) {
      if (typeof clearAuth === 'function') clearAuth();
      const app = document.getElementById('app');
      const login = document.getElementById('login-screen');
      if (app) app.style.display = 'none';
      if (login) login.style.display = 'flex';
      if (typeof loginError === 'function') {
        loginError('Password changed successfully. Please log in again.', true);
      }
      return;
    }
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
    if (typeof refreshSidebarAvatar === 'function') await refreshSidebarAvatar();
    window.dispatchEvent(new CustomEvent('profilePhotoUpdated', {
      detail: { employeeId: Number(getUser()?.employeeId || 0) }
    }));
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

function selfDeviceIcon(type = 'Desktop') {
  const normalized = String(type || 'Desktop').toLowerCase();
  if (normalized === 'mobile') return 'MO';
  if (normalized === 'tablet') return 'TA';
  return 'DE';
}

function selfDeviceIconLabel(type = 'Desktop') {
  const normalized = String(type || 'Desktop').toLowerCase();
  if (normalized === 'mobile') return 'Mobile device';
  if (normalized === 'tablet') return 'Tablet';
  return 'Desktop';
}

function selfTrustedDeviceStatus(device) {
  const status = String(device?.status || (device?.isTrusted ? 'Trusted' : 'Revoked')).trim();
  const statusClass = status === 'Trusted' ? 'status-approved' : status === 'Removed' ? 'status-rejected' : 'status-pending';
  return `<span class="status-badge ${statusClass}">${escapeHTML(status || 'Trusted')}</span>`;
}

function renderSelfTrustedDevices(devices = []) {
  const container = document.getElementById('self-devices-list');
  if (!container) return;
  const registerButton = document.getElementById('self-register-device-btn');
  const currentTrusted = devices.some(device => device.currentDevice && device.isTrusted);
  if (registerButton) {
    registerButton.disabled = currentTrusted;
    registerButton.textContent = currentTrusted ? 'Current Device Registered' : 'Register Current Device';
  }
  if (!devices.length) {
    container.innerHTML = '<div class="self-devices-empty">No trusted devices are registered yet.</div>';
    return;
  }
  container.innerHTML = devices.map(device => `
    <article class="self-device-card ${device.currentDevice ? 'is-current' : ''}">
      <div class="self-device-icon" aria-label="${escapeHTML(selfDeviceIconLabel(device.deviceType))}">${selfDeviceIcon(device.deviceType)}</div>
      <div class="self-device-main">
        <div class="self-device-title-row">
          <h3>${escapeHTML(device.deviceName || 'Trusted Device')}</h3>
          <div class="self-device-badges">
            ${device.currentDevice ? '<span class="self-current-device-badge">This Device</span>' : ''}
            ${selfTrustedDeviceStatus(device)}
          </div>
        </div>
        <dl class="self-device-details">
          <div><dt>Model</dt><dd>${escapeHTML(device.deviceModel || 'Not disclosed by browser')}</dd></div>
          <div><dt>Type</dt><dd>${escapeHTML(device.deviceType || '-')}</dd></div>
          <div><dt>Browser</dt><dd>${escapeHTML(device.browser || '-')}</dd></div>
          <div><dt>Operating System</dt><dd>${escapeHTML(device.operatingSystem || '-')}</dd></div>
          <div><dt>IP Address</dt><dd>${escapeHTML(device.ipAddress || '-')}</dd></div>
          <div><dt>Date Registered</dt><dd>${escapeHTML(formatSelfDateTime(device.registeredAt))}</dd></div>
          <div><dt>Last Used</dt><dd>${escapeHTML(formatSelfDateTime(device.lastUsed))}</dd></div>
        </dl>
        <div class="self-device-actions">
          <button type="button" class="btn btn-secondary btn-sm" onclick="renameSelfTrustedDevice(${Number(device.id)})">Rename</button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="viewSelfTrustedDevice(${Number(device.id)})">Details</button>
          ${device.isTrusted ? `<button type="button" class="btn btn-secondary btn-sm" onclick="revokeSelfTrustedDevice(${Number(device.id)})">Remove</button>` : ''}
        </div>
      </div>
    </article>
  `).join('');
  selfServiceState.trustedDevices = devices;
}

async function loadSelfTrustedDevices() {
  const container = document.getElementById('self-devices-list');
  if (!container) return;
  container.innerHTML = '<div class="self-devices-empty">Loading devices...</div>';
  try {
    const fingerprint = typeof buildTrustedDeviceFingerprint === 'function'
      ? await buildTrustedDeviceFingerprint()
      : {};
    const res = await apiFetch('/api/trusted-devices', {
      method: 'POST',
      body: JSON.stringify({ fingerprint })
    });
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error(data.error || 'Failed to load trusted devices.');
    renderSelfTrustedDevices(Array.isArray(data) ? data : []);
  } catch (error) {
    container.innerHTML = `<div class="self-devices-empty">${escapeHTML(error.message)}</div>`;
  }
}

async function loadSelfDeviceSummary() {
  return null;
}

async function loadSelfDeviceDashboard() {
  await loadSelfTrustedDevices();
}

async function loadSelfDeviceActivity() {
  const body = document.getElementById('self-device-activity-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="11">Loading device activity...</td></tr>';
  try {
    const params = new URLSearchParams({
      limit: String(SELF_DEVICE_ACTIVITY_PAGE_SIZE),
      offset: String(selfDeviceActivityPage * SELF_DEVICE_ACTIVITY_PAGE_SIZE),
    });
    const search = document.getElementById('self-device-activity-search')?.value.trim();
    const risk = document.getElementById('self-device-risk-filter')?.value;
    if (search) params.set('search', search);
    if (risk) params.set('riskLevel', risk);
    const rows = await selfDeviceJson(`/api/trusted-devices/activity?${params}`);
    selfServiceState.deviceActivity = Array.isArray(rows) ? rows : [];
    if (!selfServiceState.deviceActivity.length) {
      body.innerHTML = '<tr><td colspan="11">No device activity found.</td></tr>';
    } else {
      body.innerHTML = selfServiceState.deviceActivity.map(row => `
        <tr>
          <td>${escapeHTML(formatSelfDateTime(row.createdAt))}</td>
          <td>${escapeHTML(row.user || '-')}</td>
          <td>${escapeHTML(row.deviceName || '-')}</td>
          <td>${escapeHTML(row.deviceModel || '-')}</td>
          <td>${escapeHTML(row.browser || '-')}</td>
          <td>${escapeHTML(row.operatingSystem || '-')}</td>
          <td>${escapeHTML(row.ipAddress || '-')}</td>
          <td>${escapeHTML(row.location || '-')}</td>
          <td>${escapeHTML(row.status || row.action || '-')}</td>
          <td>${selfDeviceRiskBadge(row.riskLevel)}</td>
          <td><button type="button" class="btn btn-secondary btn-sm" onclick="viewSelfDeviceActivity(${Number(row.id)})">Details</button></td>
        </tr>
      `).join('');
    }
    const pageLabel = document.getElementById('self-device-page-label');
    const prev = document.getElementById('self-device-prev');
    const next = document.getElementById('self-device-next');
    if (pageLabel) pageLabel.textContent = `Page ${selfDeviceActivityPage + 1}`;
    if (prev) prev.disabled = selfDeviceActivityPage === 0;
    if (next) next.disabled = selfServiceState.deviceActivity.length < SELF_DEVICE_ACTIVITY_PAGE_SIZE;
  } catch (error) {
    body.innerHTML = `<tr><td colspan="11">${escapeHTML(error.message)}</td></tr>`;
  }
}

function viewSelfDeviceActivity(id) {
  const event = (selfServiceState.deviceActivity || []).find(row => Number(row.id) === Number(id));
  if (!event) return;
  const message = [
    `Action: ${event.action || '-'}`,
    `Device: ${event.deviceName || '-'}`,
    `Browser: ${event.browser || '-'}`,
    `OS: ${event.operatingSystem || '-'}`,
    `IP: ${event.ipAddress || '-'}`,
    `Location: ${event.location || '-'}`,
    `Risk: ${event.riskLevel || '-'}`,
    `Time: ${formatSelfDateTime(event.createdAt)}`,
  ].join('\n');
  if (typeof showAlert === 'function') showAlert(message, 'Device Activity Details', 'info');
  else alert(message);
}

async function loadSelfDeviceNotifications() {
  const root = document.getElementById('self-devices-notifications');
  if (!root) return;
  root.innerHTML = '<div class="self-devices-empty">Loading notifications...</div>';
  try {
    const rows = await selfDeviceJson('/api/trusted-devices/notifications');
    root.innerHTML = rows.length ? rows.map(row => `
      <article class="sec-card ${row.isRead ? '' : 'is-unread'}">
        <div><h3>${escapeHTML(row.title)}</h3><p>${escapeHTML(row.message)}</p><small>${escapeHTML(formatSelfDateTime(row.createdAt))}</small></div>
        <div>${selfDeviceRiskBadge(row.riskLevel)}${row.isRead ? '' : `<button class="btn btn-secondary btn-sm" onclick="markSelfDeviceNotificationRead(${Number(row.id)})">Mark Read</button>`}</div>
      </article>
    `).join('') : '<div class="self-devices-empty">No security notifications.</div>';
  } catch (error) {
    root.innerHTML = `<div class="self-devices-empty">${escapeHTML(error.message)}</div>`;
  }
}

async function markSelfDeviceNotificationRead(id) {
  try {
    await selfDeviceJson(`/api/trusted-devices/notifications/${id}/read`, { method: 'POST' });
    await Promise.all([loadSelfDeviceNotifications(), loadSelfDeviceSummary()]);
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function loadSelfDeviceApprovals() {
  const root = document.getElementById('self-devices-approvals');
  if (!root) return;
  root.innerHTML = '<div class="self-devices-empty">Loading approval requests...</div>';
  try {
    const rows = await selfDeviceJson('/api/trusted-devices/approval-requests');
    root.innerHTML = rows.length ? rows.map(row => `
      <article class="sec-card">
        <div><h3>${escapeHTML(row.deviceName)}</h3><p>${escapeHTML(row.deviceModel || row.deviceType || 'Unknown device')} - ${escapeHTML(row.browser)} on ${escapeHTML(row.operatingSystem)} - ${escapeHTML(row.location || 'Location unavailable')} - ${escapeHTML(row.ipAddress || '-')}</p><small>${escapeHTML(formatSelfDateTime(row.requestedAt))}</small></div>
        <div>${selfDeviceRiskBadge(row.riskLevel)}<span class="status-badge status-pending">${escapeHTML(row.status)}</span>
          ${row.status === 'Pending' ? `<button class="btn btn-primary btn-sm" onclick="approveSelfDeviceRequest(${Number(row.id)})">Approve Device</button><button class="btn btn-secondary btn-sm" onclick="ignoreSelfDeviceRequest(${Number(row.id)})">Deny Access</button>` : ''}
        </div>
      </article>
    `).join('') : '<div class="self-devices-empty">No device approval requests.</div>';
  } catch (error) {
    root.innerHTML = `<div class="self-devices-empty">${escapeHTML(error.message)}</div>`;
  }
}

async function approveSelfDeviceRequest(id) {
  try {
    await selfDeviceJson(`/api/trusted-devices/approval-requests/${id}/approve`, { method: 'POST' });
    await Promise.all([loadSelfDeviceApprovals(), loadSelfTrustedDevices(), loadSelfDeviceSummary()]);
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function ignoreSelfDeviceRequest(id) {
  try {
    await selfDeviceJson(`/api/trusted-devices/approval-requests/${id}/ignore`, { method: 'POST' });
    await Promise.all([loadSelfDeviceApprovals(), loadSelfDeviceSummary()]);
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function loadSelfDeviceSessions() {
  const root = document.getElementById('self-device-sessions-list');
  if (!root) return;
  root.innerHTML = '<div class="self-devices-empty">Loading active sessions...</div>';
  try {
    const rows = await selfDeviceJson('/api/trusted-devices/active-sessions');
    root.innerHTML = rows.length ? rows.map(row => `
      <article class="sec-card">
        <div><h3>${escapeHTML(selfDeviceSessionTitle(row))}${row.isCurrent ? ' <span class="self-current-device-badge">This Session</span>' : ''}</h3><p>${escapeHTML(row.deviceModel || row.deviceType || 'Unknown device')} - ${escapeHTML(row.browser || '-')} on ${escapeHTML(row.operatingSystem || '-')} - ${escapeHTML(row.ipAddress || '-')}</p><small>Login: ${escapeHTML(formatSelfDateTime(row.loginAt))} - Last activity: ${escapeHTML(formatSelfDateTime(row.lastActivity))}</small></div>
        <div>${selfDeviceRiskBadge(row.riskLevel)}<button class="btn btn-secondary btn-sm" onclick="logoutSelfDeviceSession(${Number(row.id)}, ${row.isCurrent ? 'true' : 'false'})">Logout Session</button></div>
      </article>
    `).join('') : '<div class="self-devices-empty">No active sessions.</div>';
  } catch (error) {
    root.innerHTML = `<div class="self-devices-empty">${escapeHTML(error.message)}</div>`;
  }
}

function selfDeviceSessionTitle(row = {}) {
  const deviceName = String(row.deviceName || '').trim();
  if (deviceName && deviceName.toLowerCase() !== 'current device') return deviceName;
  return 'Active Session';
}

async function logoutSelfDeviceSession(id, isCurrent = false) {
  try {
    const result = await selfDeviceJson(`/api/trusted-devices/active-sessions/${id}/logout`, { method: 'POST' });
    if (isCurrent && (result.revoked || result.terminated)) {
      if (typeof clearAuth === 'function') clearAuth();
      if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
      if (typeof showLoginRoute === 'function') {
        showLoginRoute(true);
      } else {
        const app = document.getElementById('app');
        const login = document.getElementById('login-screen');
        if (app) app.style.display = 'none';
        if (login) login.style.display = 'flex';
      }
      if (typeof window.resetLoginFlow === 'function') window.resetLoginFlow();
      return;
    }
    await Promise.all([loadSelfDeviceSessions(), loadSelfDeviceSummary()]);
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function logoutOtherSelfDeviceSessions() {
  try {
    await selfDeviceJson('/api/trusted-devices/active-sessions/logout-others', { method: 'POST' });
    await Promise.all([loadSelfDeviceSessions(), loadSelfDeviceSummary()]);
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function exportSelfDeviceActivity() {
  const params = new URLSearchParams();
  const search = document.getElementById('self-device-activity-search')?.value.trim();
  const risk = document.getElementById('self-device-risk-filter')?.value;
  if (search) params.set('search', search);
  if (risk) params.set('riskLevel', risk);
  const response = await apiFetch(`/api/trusted-devices/activity/export?${params}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Export failed.');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'device-activity-logs.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadSelfDeviceHistory() {
  const container = document.getElementById('self-devices-history');
  if (!container) return;
  container.innerHTML = '<div class="self-devices-empty">Loading device history...</div>';
  try {
    const res = await apiFetch('/api/trusted-devices/history');
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error(data.error || 'Failed to load device history.');
    selfServiceState.deviceHistory = Array.isArray(data) ? data : [];
    if (!selfServiceState.deviceHistory.length) {
      container.innerHTML = '<div class="self-devices-empty">No device history yet.</div>';
      return;
    }
    container.innerHTML = `
      <table class="self-device-history-table">
        <thead><tr><th>Device</th><th>Model</th><th>Type</th><th>Browser</th><th>OS</th><th>Registered</th><th>Last Active</th><th>Status</th></tr></thead>
        <tbody>
          ${selfServiceState.deviceHistory.map(device => `
            <tr>
              <td>${escapeHTML(device.deviceName || '-')}</td>
              <td>${escapeHTML(device.deviceModel || '-')}</td>
              <td>${escapeHTML(device.deviceType || '-')}</td>
              <td>${escapeHTML(device.browser || '-')}</td>
              <td>${escapeHTML(device.operatingSystem || '-')}</td>
              <td>${escapeHTML(formatSelfDateTime(device.registeredAt))}</td>
              <td>${escapeHTML(formatSelfDateTime(device.lastUsed))}</td>
              <td>${selfTrustedDeviceStatus(device)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch (error) {
    container.innerHTML = `<div class="self-devices-empty">${escapeHTML(error.message)}</div>`;
  }
}

function setSelfDeviceView(view = 'trusted') {
  selfServiceState.deviceView = view;
  document.querySelectorAll('.self-device-subtab').forEach(button => button.classList.toggle('active', button.dataset.selfDeviceView === view));
  const trusted = document.getElementById('self-devices-list');
  const activity = document.getElementById('self-devices-activity');
  const notifications = document.getElementById('self-devices-notifications');
  const approvals = document.getElementById('self-devices-approvals');
  const sessions = document.getElementById('self-devices-sessions');
  const history = document.getElementById('self-devices-history');
  if (trusted) trusted.hidden = view !== 'trusted';
  if (activity) activity.hidden = view !== 'activity';
  if (notifications) notifications.hidden = view !== 'notifications';
  if (approvals) approvals.hidden = view !== 'approvals';
  if (sessions) sessions.hidden = view !== 'sessions';
  if (history) history.hidden = view !== 'history';
  if (view === 'trusted') loadSelfTrustedDevices();
  if (view === 'activity') loadSelfDeviceActivity();
  if (view === 'notifications') loadSelfDeviceNotifications();
  if (view === 'approvals') loadSelfDeviceApprovals();
  if (view === 'sessions') loadSelfDeviceSessions();
  if (view === 'history') loadSelfDeviceHistory();
}

async function registerSelfCurrentDevice() {
  try {
    const fingerprint = typeof buildTrustedDeviceFingerprint === 'function'
      ? await buildTrustedDeviceFingerprint()
      : {};
    const defaultName = typeof trustedDeviceDefaultName === 'function' ? trustedDeviceDefaultName(fingerprint) : 'Trusted Device';
    const registration = typeof showTrustedDeviceRegistrationModal === 'function'
      ? await showTrustedDeviceRegistrationModal(defaultName)
      : {
        password: await showPrompt('Confirm your account password', 'Register Trusted Device', ''),
        deviceName: defaultName,
      };
    if (!registration?.password) return;
    const res = await apiFetch('/api/trusted-devices/register', {
      method: 'POST',
      body: JSON.stringify({
        password: registration.password,
        fingerprint,
        deviceName: registration.deviceName || defaultName,
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.restoreRequired) {
        const restore = await showConfirm('This device was previously registered. Would you like to restore it instead?', 'Restore Trusted Device', 'Restore Device', 'Cancel');
        if (restore) {
          const restoreRes = await apiFetch('/api/trusted-devices/restore', {
            method: 'POST',
            body: JSON.stringify({ deviceId: data.deviceId })
          });
          const restoreData = await restoreRes.json().catch(() => ({}));
          if (!restoreRes.ok) throw new Error(restoreData.error || 'Failed to restore device.');
          selfServiceNotify(restoreData.message || 'Device restored.', 'success');
        }
        return;
      }
      throw new Error(data.error || 'Failed to register device.');
    }
    selfServiceNotify(data.message || 'Device registered.', 'success');
    await Promise.all([loadSelfTrustedDevices(), loadSelfDeviceSummary()]);
    await loadSelfActivityLog();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

async function renameSelfTrustedDevice(id, currentName = '') {
  if (!currentName) {
    const device = (selfServiceState.trustedDevices || []).find(item => Number(item.id) === Number(id));
    currentName = device?.deviceName || '';
  }
  const deviceName = typeof showPrompt === 'function'
    ? await showPrompt('New device name:', 'Rename Trusted Device', currentName)
    : prompt('New device name:', currentName);
  if (!deviceName) return;
  try {
    const res = await apiFetch(`/api/trusted-devices/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ deviceName })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to rename device.');
    selfServiceNotify(data.message || 'Device renamed.', 'success');
    await loadSelfTrustedDevices();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

function viewSelfTrustedDevice(id) {
  const device = (selfServiceState.trustedDevices || []).find(item => Number(item.id) === Number(id));
  if (!device) return;
  const message = [
    `Device Name: ${device.deviceName || '-'}`,
    `Status: ${device.status || (device.isTrusted ? 'Trusted' : 'Revoked')}`,
    `Model: ${device.deviceModel || 'Not disclosed by browser'}`,
    `Type: ${device.deviceType || '-'}`,
    `Browser: ${device.browser || '-'}`,
    `Operating System: ${device.operatingSystem || '-'}`,
    `IP Address: ${device.ipAddress || '-'}`,
    `Registered: ${formatSelfDateTime(device.registeredAt)}`,
    `Last Used: ${formatSelfDateTime(device.lastUsed)}`,
  ].join('\n');
  if (typeof showAlert === 'function') showAlert(message, 'Device Details', 'info');
  else alert(message);
}

async function revokeSelfTrustedDevice(id) {
  const password = await showPrompt('Confirm your account password', 'Remove Trusted Device', 'Enter your password');
  if (!password) return;
  try {
    const res = await apiFetch(`/api/trusted-devices/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to remove device.');
    selfServiceNotify(data.message || 'Device revoked.', 'success');
    await Promise.all([loadSelfTrustedDevices(), loadSelfDeviceSummary()]);
    await loadSelfActivityLog();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
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
  const reason = typeof showPrompt === 'function'
    ? await showPrompt('Reason for rejecting this change request:', 'Reject Change Request', '')
    : prompt('Reason for rejecting this change request:');
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
  initSelfServiceTabs();
  document.getElementById('self-service-refresh')?.addEventListener('click', initSelfServiceProfile);
  document.querySelectorAll('[data-self-save]').forEach(button => {
    if (button.dataset.selfServiceSaveBound === 'true') return;
    button.dataset.selfServiceSaveBound = 'true';
    button.addEventListener('click', () => saveSelfProfileSection(button.dataset.selfSave));
  });
  document.querySelectorAll('[data-self-sensitive-toggle]').forEach(button => {
    if (button.dataset.selfServiceSensitiveBound === 'true') return;
    button.dataset.selfSensitiveLabel = button.getAttribute('aria-label')?.replace(/^Show\s+/i, '') || '';
    button.dataset.selfServiceSensitiveBound = 'true';
    button.addEventListener('click', () => toggleSelfSensitiveField(button.dataset.selfSensitiveToggle));
  });
  document.getElementById('self-password-save')?.addEventListener('click', changeSelfPassword);
  document.getElementById('self-register-device-btn')?.addEventListener('click', registerSelfCurrentDevice);
  document.getElementById('self-picture-form')?.addEventListener('submit', uploadSelfPicture);
  document.getElementById('self-picture-input')?.addEventListener('change', previewSelfPicture);
  document.getElementById('self-change-request-form')?.addEventListener('submit', submitSelfChangeRequest);
  document.querySelectorAll('[data-self-mobile-tab]').forEach(button => {
    if (button.dataset.selfServiceMobileBound === 'true') return;
    button.dataset.selfServiceMobileBound = 'true';
    button.addEventListener('click', () => {
      setSelfServiceTab(button.dataset.selfMobileTab);
      document.querySelector('.self-service-tabs')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  });
  document.querySelectorAll('.self-device-subtab').forEach(button => {
    if (button.dataset.selfDevicesBound === 'true') return;
    button.dataset.selfDevicesBound = 'true';
    button.addEventListener('click', () => setSelfDeviceView(button.dataset.selfDeviceView));
  });
  const logoutOthersButton = document.getElementById('self-device-logout-others');
  if (logoutOthersButton && logoutOthersButton.dataset.selfDevicesBound !== 'true') {
    logoutOthersButton.dataset.selfDevicesBound = 'true';
    logoutOthersButton.addEventListener('click', logoutOtherSelfDeviceSessions);
  }
  const exportButton = document.getElementById('self-device-export');
  if (exportButton && exportButton.dataset.selfDevicesBound !== 'true') {
    exportButton.dataset.selfDevicesBound = 'true';
    exportButton.addEventListener('click', () => exportSelfDeviceActivity().catch(error => selfServiceNotify(error.message, 'error')));
  }
  const prevButton = document.getElementById('self-device-prev');
  if (prevButton && prevButton.dataset.selfDevicesBound !== 'true') {
    prevButton.dataset.selfDevicesBound = 'true';
    prevButton.addEventListener('click', () => {
      selfDeviceActivityPage = Math.max(selfDeviceActivityPage - 1, 0);
      loadSelfDeviceActivity();
    });
  }
  const nextButton = document.getElementById('self-device-next');
  if (nextButton && nextButton.dataset.selfDevicesBound !== 'true') {
    nextButton.dataset.selfDevicesBound = 'true';
    nextButton.addEventListener('click', () => {
      selfDeviceActivityPage += 1;
      loadSelfDeviceActivity();
    });
  }
  const searchInput = document.getElementById('self-device-activity-search');
  if (searchInput && searchInput.dataset.selfDevicesBound !== 'true') {
    searchInput.dataset.selfDevicesBound = 'true';
    searchInput.addEventListener('input', () => {
      selfDeviceActivityPage = 0;
      clearTimeout(window.SELF_DEVICE_SEARCH_TIMER);
      window.SELF_DEVICE_SEARCH_TIMER = setTimeout(loadSelfDeviceActivity, 250);
    });
  }
  const riskFilter = document.getElementById('self-device-risk-filter');
  if (riskFilter && riskFilter.dataset.selfDevicesBound !== 'true') {
    riskFilter.dataset.selfDevicesBound = 'true';
    riskFilter.addEventListener('change', () => {
      selfDeviceActivityPage = 0;
      loadSelfDeviceActivity();
    });
  }
}

async function initSelfServiceProfile() {
  wireSelfServiceEvents();
  const forced = isForcedPasswordChange();
  document.querySelectorAll('.self-service-hr-only').forEach(el => {
    el.style.display = !forced && isSelfHrReviewer() ? '' : 'none';
  });
  document.querySelectorAll('[data-self-tab]').forEach(button => {
    if (button.classList.contains('self-service-hr-only')) return;
    button.style.display = forced && button.dataset.selfTab !== 'security' ? 'none' : '';
  });
  document.querySelectorAll('.self-tab-panel').forEach(panel => {
    if (panel.classList.contains('self-service-hr-only')) return;
    panel.style.display = forced && panel.id !== 'self-tab-security' ? 'none' : '';
  });
  const forceNote = document.getElementById('self-password-required-note');
  if (forceNote) forceNote.style.display = forced ? '' : 'none';
  if (forced) {
    setSelfServiceTab('security');
    return;
  }
  try {
    await loadSelfServiceProfile();
    await loadSelfChangeRequests();
    await loadSelfActivityLog();
    await loadSelfDeviceDashboard();
    if (isSelfHrReviewer()) await loadHrProfileChangeRequests();
  } catch (error) {
    selfServiceNotify(error.message, 'error');
  }
}

document.addEventListener('partialsLoaded', () => {
  if (document.querySelector('.self-service-page')
    && typeof initSelfServiceProfile === 'function'
    && (typeof shouldRunProtectedPageInitializer !== 'function' || shouldRunProtectedPageInitializer('self-service'))) {
    initSelfServiceProfile();
  }
});

window.initSelfServiceProfile = initSelfServiceProfile;
window.approveHrProfileRequest = approveHrProfileRequest;
window.rejectHrProfileRequest = rejectHrProfileRequest;
window.renameSelfTrustedDevice = renameSelfTrustedDevice;
window.revokeSelfTrustedDevice = revokeSelfTrustedDevice;
window.viewSelfTrustedDevice = viewSelfTrustedDevice;
window.setSelfServiceTab = setSelfServiceTab;
window.viewSelfDeviceActivity = viewSelfDeviceActivity;
window.markSelfDeviceNotificationRead = markSelfDeviceNotificationRead;
window.approveSelfDeviceRequest = approveSelfDeviceRequest;
window.ignoreSelfDeviceRequest = ignoreSelfDeviceRequest;
window.logoutSelfDeviceSession = logoutSelfDeviceSession;
window.setSelfDeviceView = setSelfDeviceView;
