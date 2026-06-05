/* ============================================================
   HR Admin pre-employment onboarding workspace
   ============================================================ */

let ONB_LOOKUPS = { departments: [], wage_types: [], biometric_devices: [], document_types: [] };
let ONB_POSITIONS = [];
let ONB_ACTIVE_APPLICANT = null;
let ONB_REFRESH_TIMER = null;

const ONB_SCREENING = ['Pending Screening', 'For Interview', 'For Requirements Checking', 'Passed Screening', 'Failed Screening', 'Not Required'];
const ONB_TRAINING = ['Not Yet Started', 'In Training', 'Completed Training', 'Failed Training', 'For Final Evaluation', 'Not Required'];
const ONB_DECISIONS = ['Approved', 'Rejected', 'For Re-evaluation', 'On Hold'];
const ONB_APPLIED_POSITIONS = [
  'Accounting Staff',
  'Driver',
  'HR Staff',
  'Logistics Helper',
  'Machine Operator',
  'Manager',
  'Office Staff',
  'Operator',
  'Production Staff',
  'Supervisor',
];
const ONB_WAGE_STYLE_POSITIONS = ['Base Salary Worker', 'Hourly Worker', 'Per-Trip Worker', 'Piece-Rate Worker'];

function onbCanFinalApprove() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return user?.role === 'hr_manager';
}

function onbEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function onbBadge(value) {
  const label = String(value || 'Pending');
  const className = /Approved|Passed|Completed|Transferred|Verified|Direct/.test(label)
    ? 'badge-green'
    : /Rejected|Failed/.test(label)
      ? 'badge-red'
      : /Training|Interview|Screening|Pending/.test(label)
        ? 'badge-yellow'
        : 'badge-blue';
  return `<span class="badge ${className}">${onbEscape(label)}</span>`;
}

function onbOptions(values, selected, placeholder = '') {
  const first = placeholder ? `<option value="">${onbEscape(placeholder)}</option>` : '';
  return first + values.map(value => {
    const normalized = typeof value === 'object' ? value.value : value;
    const label = typeof value === 'object' ? value.label : value;
    return `<option value="${onbEscape(normalized)}" ${String(normalized) === String(selected ?? '') ? 'selected' : ''}>${onbEscape(label)}</option>`;
  }).join('');
}

async function onbJson(url, options = {}) {
  const response = await apiFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function onbToast(message, type = 'success') {
  const toast = document.getElementById('onb-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `onb-toast ${type === 'error' ? 'error' : ''}`;
  toast.style.display = 'block';
  clearTimeout(ONB_REFRESH_TIMER);
  ONB_REFRESH_TIMER = setTimeout(() => { toast.style.display = 'none'; }, 3500);
}

function onbOpenModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function onbCloseModals() {
  document.querySelectorAll('.onb-modal.open').forEach(modal => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  });
}

function onbSwitchTab(tab) {
  document.querySelectorAll('.onb-tab').forEach(button => button.classList.toggle('active', button.dataset.onbTab === tab));
  document.querySelectorAll('.onb-panel').forEach(panel => panel.classList.toggle('active', panel.id === `onb-panel-${tab}`));
}

function onbRenderStats(stats) {
  const root = document.getElementById('onb-stats');
  if (!root) return;
  const values = [
    ['Total applicants', stats.total],
    ['Active workflow', stats.active],
    ['In screening', stats.screening],
    ['In training', stats.training],
    ['Ready to transfer', stats.ready_for_transfer],
    ['Transferred', stats.transferred],
  ];
  root.innerHTML = values.map(([label, value], index) => `
    <div class="onb-stat ${index === 4 ? 'onb-stat-ready' : ''}">
      <span>${onbEscape(label)}</span><strong>${Number(value || 0)}</strong>
    </div>
  `).join('');
}

function onbRenderApplicants(applicants) {
  const body = document.getElementById('onb-applicant-rows');
  if (!body) return;
  if (!applicants.length) {
    body.innerHTML = '<tr><td colspan="9" class="onb-empty">No onboarding applicants match this view.</td></tr>';
    return;
  }
  body.innerHTML = applicants.map(applicant => `
    <tr>
      <td><div class="onb-person"><strong>${onbEscape(`${applicant.first_name} ${applicant.last_name}`)}</strong><small>${onbEscape(applicant.applicant_code)}</small></div></td>
      <td>${onbBadge(applicant.hiring_type)}${applicant.agency_name ? `<div class="onb-muted">${onbEscape(applicant.agency_name)}</div>` : ''}</td>
      <td>${onbEscape(applicant.applied_position)}<div class="onb-muted">${onbEscape(applicant.department || 'Department unassigned')}</div></td>
      <td><div class="onb-route"><b>${applicant.requires_onboarding ? 'Screen' : 'Direct approval'}</b>${applicant.requires_training ? ' + Training' : ''}</div></td>
      <td>${onbBadge(applicant.workflow_status)}</td>
      <td>${onbEscape(applicant.screening_status)}</td>
      <td>${onbEscape(applicant.training_status)}</td>
      <td>${Number(applicant.document_count || 0)} prepared</td>
      <td><button class="onb-mini" type="button" onclick="onbOpenApplicant(${Number(applicant.applicant_id)})">Review</button></td>
    </tr>
  `).join('');
}

function onbRenderPositions(routes) {
  const body = document.getElementById('onb-position-rows');
  const positionSelect = document.getElementById('onb-applied-position');
  if (positionSelect) {
    const selected = positionSelect.value;
    const routePositions = routes
      .map(route => route.position_name)
      .filter(position => position && !ONB_WAGE_STYLE_POSITIONS.includes(position));
    const positions = [...new Set([...ONB_APPLIED_POSITIONS, ...routePositions])].sort((a, b) => a.localeCompare(b));
    positionSelect.innerHTML = onbOptions(positions, positions.includes(selected) ? selected : '', 'Select applied position');
  }
  if (!body) return;
  body.innerHTML = routes.length ? routes.map(route => `
    <tr>
      <td><strong>${onbEscape(route.position_name)}</strong></td>
      <td>${onbEscape(route.department || 'Any department')}</td>
      <td>${onbBadge(route.requires_onboarding ? 'Required' : 'Not required')}</td>
      <td>${onbBadge(route.requires_training ? 'Required' : 'Not required')}</td>
      <td>${route.requires_onboarding ? 'Screening workflow' : 'Direct HR approval'}${route.requires_training ? ', then training' : ''}</td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="onb-empty">No position routes configured.</td></tr>';
}

function onbPopulateLookups() {
  const departments = ONB_LOOKUPS.departments.map(item => ({ value: item.id, label: item.name }));
  const wages = ONB_LOOKUPS.wage_types.map(item => ({ value: item.id, label: item.name }));
  const devices = ONB_LOOKUPS.biometric_devices.map(item => ({ value: item.device_id, label: item.device_name }));
  const routeDepartment = document.getElementById('onb-route-department');
  const department = document.getElementById('onb-department');
  const wage = document.getElementById('onb-wage-type');
  const device = document.getElementById('onb-device');
  const gender = document.getElementById('onb-gender');
  const civilStatus = document.getElementById('onb-civil-status');
  const bloodType = document.getElementById('onb-blood-type');
  const employmentType = document.getElementById('onb-employment-type');
  const shiftSchedule = document.getElementById('onb-shift-schedule');
  const employeeLevel = document.getElementById('onb-employee-level');
  const payrollSchedule = document.getElementById('onb-payroll-schedule');
  if (routeDepartment) routeDepartment.innerHTML = onbOptions(departments, '', 'Any department');
  if (department) department.innerHTML = onbOptions(departments, '', 'Unassigned');
  if (wage) wage.innerHTML = onbOptions(wages, '', 'Configure after transfer');
  if (device) device.innerHTML = onbOptions(devices, '', 'Prepare later');
  if (gender) gender.innerHTML = onbOptions(ONB_LOOKUPS.genders || [], '', 'Select gender');
  if (civilStatus) civilStatus.innerHTML = onbOptions(ONB_LOOKUPS.civil_statuses || [], '', 'Select civil status');
  if (bloodType) bloodType.innerHTML = onbOptions(ONB_LOOKUPS.blood_types || [], '', 'Select blood type');
  if (employmentType) employmentType.innerHTML = onbOptions(ONB_LOOKUPS.employment_types || [], 'Full-time', 'Select employment type');
  if (shiftSchedule) shiftSchedule.innerHTML = onbOptions(ONB_LOOKUPS.shift_schedules || [], '', 'Select shift');
  if (employeeLevel) employeeLevel.innerHTML = onbOptions(ONB_LOOKUPS.employee_levels || [], '', 'Select level');
  if (payrollSchedule) payrollSchedule.innerHTML = onbOptions(ONB_LOOKUPS.payroll_schedules || [], '', 'Configure after transfer');
  onbUpdateRateHelp();
}

async function onbLoadDashboard() {
  const [stats, positions] = await Promise.all([
    onbJson('/api/onboarding/dashboard'),
    onbJson('/api/onboarding/positions'),
  ]);
  ONB_POSITIONS = positions;
  onbRenderStats(stats);
  onbRenderPositions(positions);
}

async function onbLoadApplicants() {
  const search = document.getElementById('onb-search')?.value.trim() || '';
  const workflow = document.getElementById('onb-status-filter')?.value || '';
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (workflow) params.set('workflow_status', workflow);
  const applicants = await onbJson(`/api/onboarding/applicants${params.toString() ? `?${params}` : ''}`);
  onbRenderApplicants(applicants);
}

async function onbRefresh() {
  try {
    await Promise.all([onbLoadDashboard(), onbLoadApplicants()]);
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

function onbToggleAgency() {
  const isAgency = document.getElementById('onb-hiring-type')?.value === 'Agency-Hired';
  const section = document.getElementById('onb-agency-fields');
  const employmentType = document.getElementById('onb-employment-type');
  if (!section) return;
  section.hidden = !isAgency;
  section.querySelectorAll('input[name^="agency_"]').forEach(input => { input.required = isAgency; });
  if (employmentType) {
    if (isAgency) employmentType.value = 'Contractual';
    employmentType.disabled = isAgency;
  }
}

const ONB_ADDRESS_PARTS = ['street', 'barangay', 'city', 'province', 'postal', 'country'];
const ONB_ADDRESS_GROUPS = {
  home: { key: 'home', inputId: 'onb-home-address', label: 'Residential address', requiredParts: ['street', 'barangay', 'city', 'province'] },
  current: { key: 'current', inputId: 'onb-current-address', label: 'Current address', requiredParts: ['street', 'barangay', 'city', 'province'] },
  mailing: { key: 'mailing', inputId: 'onb-mailing-address', label: 'Mailing address', requiredParts: ['street', 'barangay', 'city', 'province'] },
};

function onbAddressGroupByInput(inputId) {
  return Object.values(ONB_ADDRESS_GROUPS).find(group => group.inputId === inputId);
}

function onbAddressPart(groupKey, part) {
  return document.querySelector(`[data-onb-address="${groupKey}"] [data-onb-address-part="${part}"]`);
}

function onbComposeAddress(groupKey) {
  return ONB_ADDRESS_PARTS
    .map(part => onbAddressPart(groupKey, part)?.value.trim())
    .filter(Boolean)
    .join(', ');
}

function onbUpdateAddressGroup(groupKey) {
  const group = ONB_ADDRESS_GROUPS[groupKey];
  const hidden = group ? document.getElementById(group.inputId) : null;
  if (!group || !hidden) return '';
  const value = onbComposeAddress(groupKey);
  hidden.value = value;
  hidden.dataset.latitude = '';
  hidden.dataset.longitude = '';
  hidden.dataset.addressSelected = value ? '1' : '0';
  return value;
}

function onbCopyAddressGroup(sourceKey, targetKey) {
  ONB_ADDRESS_PARTS.forEach(part => {
    const source = onbAddressPart(sourceKey, part);
    const target = onbAddressPart(targetKey, part);
    if (source && target) target.value = source.value;
  });
  onbUpdateAddressGroup(targetKey);
}

function onbSetAddressGroupLocked(groupKey, locked) {
  ONB_ADDRESS_PARTS.forEach(part => {
    const field = onbAddressPart(groupKey, part);
    if (!field) return;
    field.disabled = locked;
    if ('readOnly' in field) field.readOnly = locked;
    field.classList.toggle('onb-address-locked', locked);
  });
}

function onbSyncAddress(sourceId, checkboxId, targetId) {
  const sourceGroup = onbAddressGroupByInput(sourceId);
  const targetGroup = onbAddressGroupByInput(targetId);
  const checkbox = document.getElementById(checkboxId);
  if (!sourceGroup || !targetGroup || !checkbox) return;
  onbUpdateAddressGroup(sourceGroup.key);
  if (checkbox.checked) onbCopyAddressGroup(sourceGroup.key, targetGroup.key);
  onbSetAddressGroupLocked(targetGroup.key, checkbox.checked);
  onbUpdateAddressGroup(targetGroup.key);
}

function onbRefreshAddressPayloads() {
  onbUpdateAddressGroup('home');
  onbSyncAddress('onb-home-address', 'onb-current-same-home', 'onb-current-address');
  onbSyncAddress('onb-home-address', 'onb-mailing-same-home', 'onb-mailing-address');
}

function onbAddressPartLabel(part) {
  return {
    street: 'house no. / street',
    barangay: 'barangay',
    city: 'city / municipality',
    province: 'province',
  }[part] || part;
}

function onbValidateAddressGroup(groupKey, errors) {
  const group = ONB_ADDRESS_GROUPS[groupKey];
  if (!group) return;
  const missing = group.requiredParts
    .filter(part => !onbAddressPart(groupKey, part)?.value.trim())
    .map(onbAddressPartLabel);
  if (missing.length) errors.push(`${group.label} is missing ${missing.join(', ')}.`);
}

function onbBindStandardAddressInputs() {
  Object.keys(ONB_ADDRESS_GROUPS).forEach(groupKey => {
    ONB_ADDRESS_PARTS.forEach(part => {
      const field = onbAddressPart(groupKey, part);
      if (!field || field.dataset.onbAddressBound === 'true') return;
      field.dataset.onbAddressBound = 'true';
      const handler = () => {
        onbUpdateAddressGroup(groupKey);
        if (groupKey === 'home') {
          onbSyncAddress('onb-home-address', 'onb-current-same-home', 'onb-current-address');
          onbSyncAddress('onb-home-address', 'onb-mailing-same-home', 'onb-mailing-address');
        }
      };
      field.addEventListener('input', handler);
      field.addEventListener('change', handler);
    });
  });
  onbRefreshAddressPayloads();
}

function onbResetStandardAddresses() {
  Object.keys(ONB_ADDRESS_GROUPS).forEach(groupKey => {
    onbSetAddressGroupLocked(groupKey, false);
    ONB_ADDRESS_PARTS.forEach(part => {
      const field = onbAddressPart(groupKey, part);
      if (!field) return;
      if (field.tagName === 'SELECT') field.selectedIndex = 0;
      else field.value = '';
    });
    onbUpdateAddressGroup(groupKey);
  });
  const currentSame = document.getElementById('onb-current-same-home');
  const mailingSame = document.getElementById('onb-mailing-same-home');
  if (currentSame) currentSame.checked = false;
  if (mailingSame) mailingSame.checked = false;
}

function onbLocationPayload() {
  onbRefreshAddressPayloads();
  const home = document.getElementById('onb-home-address');
  const current = document.getElementById('onb-current-address');
  const mailing = document.getElementById('onb-mailing-address');
  const placeOfBirth = document.getElementById('onb-place-of-birth');
  const currentSame = document.getElementById('onb-current-same-home')?.checked;
  const mailingSame = document.getElementById('onb-mailing-same-home')?.checked;
  const errors = [];

  onbValidateAddressGroup('home', errors);
  if (!currentSame) onbValidateAddressGroup('current', errors);
  if (!mailingSame) onbValidateAddressGroup('mailing', errors);

  return {
    errors,
    payload: {
      residential_address: home?.value || '',
      residential_address_lat: '',
      residential_address_lng: '',
      current_address: currentSame ? home?.value || '' : current?.value || '',
      current_address_lat: '',
      current_address_lng: '',
      current_address_same_as_home: currentSame ? 1 : 0,
      mailing_address: mailingSame ? home?.value || '' : mailing?.value || '',
      mailing_address_lat: '',
      mailing_address_lng: '',
      mailing_address_same_as_home: mailingSame ? 1 : 0,
      place_of_birth: placeOfBirth?.value.trim() || '',
      place_of_birth_lat: '',
      place_of_birth_lng: '',
    },
  };
}

function onbInitializeLocationDropdowns() {
  onbBindStandardAddressInputs();
}

function onbDateToParts(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
}

function onbDateValue(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function onbDateLabel(value) {
  const parts = onbDateToParts(value);
  if (!parts) return 'Select date';
  return new Date(parts.year, parts.month, parts.day).toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function onbDateDefaultView(input) {
  const selected = onbDateToParts(input.value);
  if (selected) return new Date(selected.year, selected.month, selected.day);
  return input.name === 'date_of_birth' ? new Date(2005, 0, 1) : new Date();
}

function onbDateYearBounds() {
  return { min: 1900, max: new Date().getFullYear() + 20 };
}

function onbDateMonthOptions(selectedMonth) {
  return Array.from({ length: 12 }, (_, index) => {
    const label = new Date(2000, index, 1).toLocaleDateString('en-US', { month: 'long' });
    return `<option value="${index}" ${index === selectedMonth ? 'selected' : ''}>${onbEscape(label)}</option>`;
  }).join('');
}

function onbDateYearOptions(selectedYear) {
  const bounds = onbDateYearBounds();
  let options = '';
  for (let year = bounds.max; year >= bounds.min; year -= 1) {
    options += `<option value="${year}" ${year === selectedYear ? 'selected' : ''}>${year}</option>`;
  }
  return options;
}

function onbCloseDatePickers(except = null) {
  document.querySelectorAll('.onb-date-field.open').forEach(field => {
    if (field !== except) field.classList.remove('open');
  });
}

function onbRenderDatePicker(field, year, month) {
  const input = field.querySelector('input[type="date"]');
  const panel = field.querySelector('.onb-date-panel');
  const bounds = onbDateYearBounds();
  const viewDate = new Date(year, month, 1);
  year = Math.min(Math.max(viewDate.getFullYear(), bounds.min), bounds.max);
  month = year === viewDate.getFullYear() ? viewDate.getMonth() : (year === bounds.min ? 0 : 11);
  const selected = onbDateToParts(input.value);
  const today = new Date();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const previousDays = new Date(year, month, 0).getDate();
  let cells = '';

  for (let index = 0; index < 42; index += 1) {
    const dayOffset = index - firstDay + 1;
    const inMonth = dayOffset >= 1 && dayOffset <= daysInMonth;
    const cellDay = inMonth ? dayOffset : (dayOffset < 1 ? previousDays + dayOffset : dayOffset - daysInMonth);
    const cellMonth = inMonth ? month : (dayOffset < 1 ? month - 1 : month + 1);
    const cellDate = new Date(year, cellMonth, cellDay);
    const value = onbDateValue(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate());
    const isSelected = selected && selected.year === cellDate.getFullYear() && selected.month === cellDate.getMonth() && selected.day === cellDate.getDate();
    const isToday = today.getFullYear() === cellDate.getFullYear() && today.getMonth() === cellDate.getMonth() && today.getDate() === cellDate.getDate();
    cells += `<button class="onb-date-day ${inMonth ? '' : 'is-outside'} ${isSelected ? 'is-selected' : ''} ${isToday ? 'is-today' : ''}" type="button" data-date="${value}">${cellDay}</button>`;
  }

  panel.innerHTML = `
    <div class="onb-date-head">
      <button type="button" class="onb-date-nav" data-month-step="-1" aria-label="Previous month">&lt;</button>
      <div class="onb-date-jump">
        <select class="onb-date-month" aria-label="Month">${onbDateMonthOptions(month)}</select>
        <select class="onb-date-year" aria-label="Year">${onbDateYearOptions(year)}</select>
      </div>
      <button type="button" class="onb-date-nav" data-month-step="1" aria-label="Next month">&gt;</button>
    </div>
    <div class="onb-date-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
    <div class="onb-date-grid">${cells}</div>
    <div class="onb-date-foot">
      <button type="button" data-date-today>Today</button>
      <button type="button" data-date-clear>Clear</button>
    </div>
  `;
  field.dataset.year = String(year);
  field.dataset.month = String(month);
}

function onbSyncDateTrigger(field) {
  const input = field.querySelector('input[type="date"]');
  const value = field.querySelector('.onb-date-value');
  if (!input || !value) return;
  value.textContent = onbDateLabel(input.value);
  value.classList.toggle('is-empty', !input.value);
}

function onbRefreshDateDisplays() {
  document.querySelectorAll('.onb-date-field').forEach(onbSyncDateTrigger);
}

function onbEnhanceDateInputs() {
  document.querySelectorAll('.onb-form-grid input[type="date"]').forEach(input => {
    if (input.dataset.onbDateEnhanced === '1') return;
    input.dataset.onbDateEnhanced = '1';
    input.classList.add('onb-date-native');
    input.tabIndex = -1;

    const field = document.createElement('div');
    field.className = 'onb-date-field';
    const trigger = document.createElement('button');
    trigger.className = 'onb-date-trigger';
    trigger.type = 'button';
    trigger.innerHTML = '<span class="onb-date-value is-empty">Select date</span>';
    const panel = document.createElement('div');
    panel.className = 'onb-date-panel';

    input.parentNode.insertBefore(field, input);
    field.appendChild(input);
    field.appendChild(trigger);
    field.appendChild(panel);
    onbSyncDateTrigger(field);

    trigger.addEventListener('click', event => {
      event.stopPropagation();
      const base = onbDateDefaultView(input);
      const year = Number(field.dataset.year || base.getFullYear());
      const month = Number(field.dataset.month || base.getMonth());
      onbCloseDatePickers(field);
      onbRenderDatePicker(field, year, month);
      field.classList.toggle('open');
    });

    panel.addEventListener('click', event => {
      event.stopPropagation();
      const target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.monthStep) {
        const next = new Date(Number(field.dataset.year), Number(field.dataset.month) + Number(target.dataset.monthStep), 1);
        onbRenderDatePicker(field, next.getFullYear(), next.getMonth());
        return;
      }
      if (target.dataset.date) input.value = target.dataset.date;
      if (target.hasAttribute('data-date-today')) {
        const today = new Date();
        input.value = onbDateValue(today.getFullYear(), today.getMonth(), today.getDate());
      }
      if (target.hasAttribute('data-date-clear')) input.value = '';
      onbSyncDateTrigger(field);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      field.classList.remove('open');
    });

    panel.addEventListener('change', event => {
      event.stopPropagation();
      if (!event.target.matches('.onb-date-month, .onb-date-year')) return;
      const nextYear = Number(panel.querySelector('.onb-date-year')?.value || field.dataset.year);
      const nextMonth = Number(panel.querySelector('.onb-date-month')?.value || field.dataset.month);
      onbRenderDatePicker(field, nextYear, nextMonth);
    });
  });
}

function onbUpdateRateHelp() {
  const wageSelect = document.getElementById('onb-wage-type');
  const label = document.getElementById('onb-rate-label');
  const help = document.getElementById('onb-rate-help');
  if (!wageSelect || !label || !help) return;
  const wageType = wageSelect.options[wageSelect.selectedIndex]?.text || '';
  const copy = {
    'Base Salary': ['Initial monthly salary', 'The fixed monthly salary used to initialize payroll after transfer.'],
    Hourly: ['Initial hourly rate', 'The default amount paid per hour. Overtime settings can be refined in Payroll after transfer.'],
    'Per-Piece': ['Default per-piece rate', 'The fallback amount paid per produced item. Sewing-type rates can be refined in Payroll after transfer.'],
    'Per-Trip': ['Default per-trip rate', 'The fallback amount paid per delivery trip. Region-specific rates can be refined in Payroll after transfer.'],
  }[wageType] || ['Initial payroll rate', 'Choose a wage type to see how this starting rate will be used. Detailed payroll rates can still be completed after transfer.'];
  label.textContent = copy[0];
  help.textContent = copy[1];
}

function onbValidatePositionAndWage() {
  const position = document.getElementById('onb-applied-position')?.value || '';
  if (ONB_WAGE_STYLE_POSITIONS.includes(position)) {
    throw new Error('Applied position must be a job title. Choose Hourly, Base Salary, Per-Piece, or Per-Trip from Wage type instead.');
  }
}

function onbApplicantDetails(applicant) {
  const items = [
    ['Hiring source', applicant.hiring_type],
    ['Applied position', applicant.applied_position],
    ['Department', applicant.department || 'Unassigned'],
    ['Branch', applicant.branch],
    ['Email', applicant.email],
    ['Work email', applicant.work_email || 'Not prepared'],
    ['Contact number', applicant.contact_number],
    ['Birth details', [applicant.date_of_birth, applicant.place_of_birth].filter(Boolean).join(' / ') || 'Not provided'],
    ['Personal profile', [applicant.gender, applicant.civil_status, applicant.blood_type].filter(Boolean).join(' / ') || 'Not provided'],
    ['Residential address', applicant.residential_address],
    ['Emergency contact', applicant.emergency_contact_name ? `${applicant.emergency_contact_name} / ${applicant.emergency_contact_number || 'number pending'}` : 'Not provided'],
    ['Employment type', applicant.desired_employment_type || 'Full-time'],
    ['Shift', applicant.shift_schedule || 'Not prepared'],
    ['Payroll setup', applicant.expected_wage_type ? `${applicant.expected_wage_type}: ${applicant.expected_base_rate ?? 'rate pending'}` : 'Configure after transfer'],
    ['Government IDs', applicant.sss_number || applicant.philhealth_number || applicant.pagibig_number || applicant.tin ? 'Prepared securely' : 'Not provided'],
    ['Bank details', applicant.bank_name || applicant.bank_account ? 'Prepared securely' : 'Not provided'],
    ['Biometric reference', applicant.biometric_prepared ? `${applicant.biometric_reference} (${applicant.biometric_device_name || 'device prepared'})` : 'Not prepared'],
  ];
  if (applicant.hiring_type === 'Agency-Hired') {
    items.push(
      ['Agency', applicant.agency_name],
      ['Agency contact', `${applicant.agency_contact_person} / ${applicant.agency_contact_number}`],
      ['Deployment', applicant.deployment_status],
      ['Contract', `${applicant.contract_start_date || 'Not set'} to ${applicant.contract_end_date || 'Not set'}`],
    );
  }
  return items.map(([label, value]) => `<div class="onb-review-item"><span>${onbEscape(label)}</span><strong>${onbEscape(value || '-')}</strong></div>`).join('');
}

function onbDocumentRows(documents) {
  if (!documents.length) return '<div class="onb-muted">No prepared 201-file documents yet.</div>';
  return documents.map(document => `
    <div class="onb-doc">
      <div><strong>${onbEscape(document.document_type)}</strong><div class="onb-muted">${onbEscape(document.original_file_name)} · ${onbEscape(document.verification_status)}</div></div>
      <div class="onb-doc-actions">
        <button class="onb-mini" type="button" onclick="onbDownloadDocument(${Number(document.document_id)})">Download</button>
        <button class="onb-mini" type="button" onclick="onbVerifyDocument(${Number(document.document_id)}, 'Verified')">Verify</button>
        <button class="onb-mini" type="button" onclick="onbVerifyDocument(${Number(document.document_id)}, 'Rejected')">Reject</button>
      </div>
    </div>
  `).join('');
}

function onbAuditRows(audit) {
  if (!audit.length) return '<div class="onb-muted">No workflow activity recorded.</div>';
  return audit.map(item => `
    <div class="onb-audit">
      <div><strong>${onbEscape(item.action.replace(/_/g, ' '))}</strong><div class="onb-muted">${onbEscape(item.reason || 'System-recorded action')}</div></div>
      <small class="onb-muted">${onbEscape(item.actor)}<br>${onbEscape(new Date(item.created_at).toLocaleString())}</small>
    </div>
  `).join('');
}

function onbRenderReview(applicant, documents, audit, integrity) {
  const body = document.getElementById('onb-review-body');
  if (!body) return;
  const locked = applicant.workflow_status === 'Transferred';
  const canFinalApprove = onbCanFinalApprove();
  const canTransfer = canFinalApprove && applicant.approval_status === 'Approved' && applicant.workflow_status === 'Approved';
  const documentTypes = ONB_LOOKUPS.document_types.map(value => ({ value, label: value }));
  body.innerHTML = `
    <div class="onb-review-grid">${onbApplicantDetails(applicant)}</div>
    <div class="onb-review-columns">
      <section class="onb-review-section">
        <h4>Workflow Status</h4>
        <div class="onb-review-grid">
          <div class="onb-review-item"><span>Workflow</span><strong>${onbBadge(applicant.workflow_status)}</strong></div>
          <div class="onb-review-item"><span>Approval</span><strong>${onbBadge(applicant.approval_status)}</strong></div>
          <div class="onb-review-item"><span>Screening route</span><strong>${applicant.requires_onboarding ? 'Required' : 'Not required'}</strong></div>
          <div class="onb-review-item"><span>Training route</span><strong>${applicant.requires_training ? 'Required' : 'Not required'}</strong></div>
        </div>
        ${locked ? '' : `
          <h4>Update Screening and Training</h4>
          <div class="onb-workflow-grid">
            <select id="onb-screening-status">${onbOptions(ONB_SCREENING, applicant.screening_status)}</select>
            <select id="onb-training-status">${onbOptions(ONB_TRAINING, applicant.training_status)}</select>
            <textarea id="onb-progress-reason" rows="2" placeholder="Required reason for this workflow change"></textarea>
          </div>
          <div class="onb-modal-actions"><button class="btn btn-secondary" type="button" onclick="onbUpdateProgress()">Save Progress</button></div>
          ${canFinalApprove ? `
            <h4>HR Manager Decision</h4>
            <div class="onb-workflow-grid">
              <select id="onb-decision">${onbOptions(ONB_DECISIONS, applicant.approval_status)}</select>
              <textarea id="onb-decision-reason" rows="2" placeholder="Required reason for this decision"></textarea>
            </div>
            <div class="onb-modal-actions"><button class="btn btn-primary" type="button" onclick="onbSaveDecision()">Record Decision</button></div>
          ` : ''}
        `}
      </section>
      <section class="onb-review-section">
        <h4>Prepared 201-File Documents</h4>
        <div class="onb-doc-list">${onbDocumentRows(documents)}</div>
        ${locked ? '' : `
          <div class="onb-upload">
            <select id="onb-document-type">${onbOptions(documentTypes, 'Application Form')}</select>
            <input id="onb-document-file" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" />
            <button class="onb-mini" type="button" onclick="onbUploadDocument()">Encrypt and Upload</button>
          </div>
        `}
      </section>
    </div>
    ${canTransfer ? `
      <section class="onb-review-section onb-transfer">
        <h4>Transfer Approved Hire</h4>
        <p class="onb-muted">Creates the official Employee Directory record and payroll-ready wage row, carries prepared documents forward, and activates the biometric reference mapping when configured.</p>
        <div class="onb-upload">
          <input id="onb-transfer-code" placeholder="Optional employee code (auto-generated when blank)" />
          <input id="onb-transfer-reason" placeholder="Required transfer reason" />
          <button class="btn btn-primary" type="button" onclick="onbTransferApplicant()">Transfer to Employee Directory</button>
        </div>
      </section>
    ` : ''}
    ${locked ? '' : `
      <section class="onb-review-section onb-danger-zone">
        <h4>Remove Applicant</h4>
        <p class="onb-muted">Removes this pre-employment record from the active onboarding list. The deletion reason and integrity audit trail are retained. Transferred hires cannot be removed here.</p>
        <div class="onb-upload">
          <input id="onb-delete-reason" placeholder="Required reason for removal" />
          <button class="btn onb-btn-danger" type="button" onclick="onbDeleteApplicant()">Delete Applicant</button>
        </div>
      </section>
    `}
    <section class="onb-review-section">
      <h4>Audit Trail</h4>
      <p class="onb-muted">Integrity ledger: ${integrity.chain_valid ? 'verified' : 'verification failed'} · ${Number(integrity.records.length)} chained actions · ${Number(integrity.pending_anchor_count)} pending permissioned-ledger anchors</p>
      <div class="onb-audit-list">${onbAuditRows(audit)}</div>
    </section>
  `;
}

async function onbOpenApplicant(applicantId) {
  ONB_ACTIVE_APPLICANT = Number(applicantId);
  onbOpenModal('onb-review-modal');
  document.getElementById('onb-review-body').innerHTML = '<div class="onb-empty">Loading applicant record...</div>';
  try {
    const [applicant, documents, audit, integrity] = await Promise.all([
      onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}`),
      onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/documents`),
      onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/audit`),
      onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/integrity`),
    ]);
    document.getElementById('onb-review-title').textContent = `${applicant.first_name} ${applicant.last_name}`;
    const wageSummary = applicant.expected_wage_type
      ? `Wage: ${applicant.expected_wage_type}${applicant.expected_base_rate != null ? ` at ${applicant.expected_base_rate}` : ''}`
      : 'Wage: not set';
    document.getElementById('onb-review-subtitle').textContent = `${applicant.applicant_code} · Position: ${applicant.applied_position} · ${wageSummary}`;
    onbRenderReview(applicant, documents, audit, integrity);
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbUpdateProgress() {
  try {
    await onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/progress`, {
      method: 'PATCH',
      body: JSON.stringify({
        screening_status: document.getElementById('onb-screening-status').value,
        training_status: document.getElementById('onb-training-status').value,
        reason: document.getElementById('onb-progress-reason').value,
      }),
    });
    onbToast('Screening and training progress saved.');
    await Promise.all([onbRefresh(), onbOpenApplicant(ONB_ACTIVE_APPLICANT)]);
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbSaveDecision() {
  if (!onbCanFinalApprove()) return onbToast('Only HR Manager can record the final decision.', 'error');
  try {
    await onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/decision`, {
      method: 'PATCH',
      body: JSON.stringify({
        approval_status: document.getElementById('onb-decision').value,
        reason: document.getElementById('onb-decision-reason').value,
      }),
    });
    onbToast('HR decision recorded.');
    await Promise.all([onbRefresh(), onbOpenApplicant(ONB_ACTIVE_APPLICANT)]);
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbTransferApplicant() {
  if (!onbCanFinalApprove()) return onbToast('Only HR Manager can transfer approved hires.', 'error');
  if (!confirm('Transfer this approved hire into the official Employee Directory?')) return;
  try {
    const data = await onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/transfer`, {
      method: 'POST',
      body: JSON.stringify({
        employee_code: document.getElementById('onb-transfer-code').value,
        reason: document.getElementById('onb-transfer-reason').value,
      }),
    });
    onbToast(`${data.employee_code} created in the Employee Directory.`);
    await Promise.all([onbRefresh(), onbOpenApplicant(ONB_ACTIVE_APPLICANT)]);
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbDeleteApplicant() {
  const reason = document.getElementById('onb-delete-reason')?.value.trim() || '';
  if (reason.length < 8) return onbToast('Enter a deletion reason of at least 8 characters.', 'error');
  if (!confirm('Delete this applicant from active onboarding? This cannot be undone from the dashboard.')) return;
  try {
    const data = await onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    });
    onbCloseModals();
    ONB_ACTIVE_APPLICANT = null;
    onbToast(data.message);
    await onbRefresh();
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbUploadDocument() {
  const file = document.getElementById('onb-document-file')?.files[0];
  if (!file) return onbToast('Select a document to upload.', 'error');
  try {
    const form = new FormData();
    form.append('document_type', document.getElementById('onb-document-type').value);
    form.append('file', file);
    await onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/documents`, { method: 'POST', body: form });
    onbToast('Document encrypted and prepared for the 201-file.');
    await Promise.all([onbRefresh(), onbOpenApplicant(ONB_ACTIVE_APPLICANT)]);
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbDownloadDocument(documentId) {
  try {
    const response = await apiFetch(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/documents/${documentId}/download`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Download failed.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'onboarding-document';
    anchor.click();
    URL.revokeObjectURL(url);
    await onbOpenApplicant(ONB_ACTIVE_APPLICANT);
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbVerifyDocument(documentId, verificationStatus) {
  const reason = verificationStatus === 'Rejected' ? prompt('Enter the document rejection reason:') : '';
  if (verificationStatus === 'Rejected' && !reason) return;
  try {
    await onbJson(`/api/onboarding/applicants/${ONB_ACTIVE_APPLICANT}/documents/${documentId}/verify`, {
      method: 'PATCH',
      body: JSON.stringify({ verification_status: verificationStatus, reason }),
    });
    onbToast(`Document marked ${verificationStatus}.`);
    await onbOpenApplicant(ONB_ACTIVE_APPLICANT);
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbCreateApplicant(event) {
  event.preventDefault();
  try {
    const form = event.currentTarget;
    const locations = onbLocationPayload();
    if (locations.errors.length) throw new Error(locations.errors.join(' '));
    onbValidatePositionAndWage();
    const body = { ...Object.fromEntries(new FormData(form).entries()), ...locations.payload };
    await onbJson('/api/onboarding/applicants', { method: 'POST', body: JSON.stringify(body) });
    form.reset();
    onbResetStandardAddresses();
    onbRefreshDateDisplays();
    onbToggleAgency();
    onbUpdateRateHelp();
    onbCloseModals();
    onbToast('Applicant added to the pre-employment workflow.');
    await onbRefresh();
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function onbSavePositionRoute(event) {
  event.preventDefault();
  try {
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    data.requires_onboarding = form.elements.requires_onboarding.checked;
    data.requires_training = form.elements.requires_training.checked;
    await onbJson('/api/onboarding/positions', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    form.elements.requires_onboarding.checked = true;
    form.elements.requires_training.checked = true;
    onbToast('Position routing rule saved.');
    await onbLoadDashboard();
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

async function initOnboarding() {
  const root = document.querySelector('.onb-shell');
  if (!root) return;
  if (!root.dataset.bound) {
    root.dataset.bound = 'true';
    document.getElementById('onb-add-applicant')?.addEventListener('click', () => onbOpenModal('onb-create-modal'));
    document.getElementById('onb-refresh')?.addEventListener('click', onbRefresh);
    document.getElementById('onb-status-filter')?.addEventListener('change', onbLoadApplicants);
    document.getElementById('onb-search')?.addEventListener('input', event => {
      clearTimeout(event.currentTarget._onbTimer);
      event.currentTarget._onbTimer = setTimeout(onbLoadApplicants, 250);
    });
    document.getElementById('onb-create-form')?.addEventListener('submit', onbCreateApplicant);
    document.getElementById('onb-route-form')?.addEventListener('submit', onbSavePositionRoute);
    document.getElementById('onb-hiring-type')?.addEventListener('change', onbToggleAgency);
    document.getElementById('onb-wage-type')?.addEventListener('change', onbUpdateRateHelp);
    document.getElementById('onb-current-same-home')?.addEventListener('change', () => onbSyncAddress('onb-home-address', 'onb-current-same-home', 'onb-current-address'));
    document.getElementById('onb-mailing-same-home')?.addEventListener('change', () => onbSyncAddress('onb-home-address', 'onb-mailing-same-home', 'onb-mailing-address'));
    document.querySelectorAll('[data-onb-close]').forEach(button => button.addEventListener('click', onbCloseModals));
    document.querySelectorAll('.onb-tab').forEach(button => button.addEventListener('click', () => onbSwitchTab(button.dataset.onbTab)));
    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!target?.closest('.onb-date-field')) onbCloseDatePickers();
    });
  }
  try {
    ONB_LOOKUPS = await onbJson('/api/onboarding/lookups');
    onbPopulateLookups();
    onbToggleAgency();
    onbInitializeLocationDropdowns();
    onbEnhanceDateInputs();
    await onbRefresh();
  } catch (error) {
    onbToast(error.message, 'error');
  }
}

document.addEventListener('partialsLoaded', () => {
  if (document.getElementById('page-onboarding')?.classList.contains('active')) initOnboarding();
});

window.initOnboarding = initOnboarding;
window.onbOpenApplicant = onbOpenApplicant;
window.onbUpdateProgress = onbUpdateProgress;
window.onbSaveDecision = onbSaveDecision;
window.onbTransferApplicant = onbTransferApplicant;
window.onbDeleteApplicant = onbDeleteApplicant;
window.onbUploadDocument = onbUploadDocument;
window.onbDownloadDocument = onbDownloadDocument;
window.onbVerifyDocument = onbVerifyDocument;
