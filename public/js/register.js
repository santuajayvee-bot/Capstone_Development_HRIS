/* ============================================================
   REGISTER.JS — Register Employee form tab switching & save
   ============================================================ */

const FORM_SECTIONS = ['personal', 'contact', 'employment', 'payroll', 'documents'];
const EMPLOYEE_WIZARD_REQUIRED_SECTIONS = ['personal', 'contact', 'employment', 'payroll'];
let EDIT_MODE = false;
let EDIT_EMPLOYEE_ID = null;           // Stores the employee_code (e.g. "EMP00001")
let EDIT_EMPLOYEE_NUMERIC_ID = null;   // Stores the numeric database ID (for API calls)
let IS_SAVING = false;                 // Prevent double-submit
let SELECTED_EMPLOYEE_PHOTO = null;
let EMPLOYEE_PHOTO_PREVIEW_URL = null;
let ACTIVE_EMPLOYEE_DRAFT_ID = null;
let LAST_EMPLOYEE_WIZARD_REQUIRED_SECTION = 'personal';
const EMPLOYEE_DRAFT_STORAGE_PREFIX = 'lgsv_employee_intake_drafts';

// Store uploaded files temporarily (in memory before save)
const UPLOADED_FILES = {
  resume: [],
  govid: [],
  nbi: [],
  other: []
};

// Document type mappings
const DOC_TYPES = {
  resume: 'Resume',
  govid: 'Government_ID',
  nbi: 'NBI_Clearance',
  other: 'Other'
};

const DEFAULT_DEPARTMENT_POSITIONS = {
  HR: ['HR Officer', 'HR Manager', 'Recruitment Officer', 'HR Assistant'],
  Accounting: ['Finance Manager', 'Accounting Staff', 'Payroll Officer', 'Bookkeeper'],
  Production: ['Assembly Worker', 'Machine Operator', 'Quality Inspector', 'Production Supervisor'],
  Logistics: ['Deliver Driver', 'Delivery Helper', 'Warehouse Staff', 'Logistics Coordinator'],
  Personnel: ['Personnel Officer', 'Personnel Assistant', 'Admin Staff'],
};
const PH_BANK_ACCOUNT_FORMATS = [
  { label: 'BPI', aliases: ['bpi', 'bank of the philippine islands'], lengths: [10] },
  { label: 'BDO Unibank', aliases: ['bdo', 'bdo unibank'], lengths: [12] },
  { label: 'Metrobank', aliases: ['metrobank', 'metropolitan bank and trust company'], lengths: [13] },
  { label: 'Security Bank', aliases: ['security bank'], lengths: [13] },
  { label: 'PNB', aliases: ['pnb', 'philippine national bank'], lengths: [12] },
  { label: 'LandBank', aliases: ['landbank', 'land bank', 'land bank of the philippines'], lengths: [10, 16] },
  { label: 'RCBC', aliases: ['rcbc', 'rizal commercial banking corporation'], lengths: [10, 16] },
];

let EMPLOYEE_POSITION_ROUTES = [];
let EMPLOYEE_DEPARTMENTS = [];
let EMPLOYEE_POSITION_OPTIONS_PROMISE = null;
let EMPLOYEE_ID_CONFIG = null;

function canOverrideEmployeeId() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return ['hr_manager', 'hr_admin', 'admin', 'system_admin'].includes(user?.role);
}

function sanitizeEmployeeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidManualEmployeeCode(value) {
  return /^[A-Z0-9_-]+$/i.test(String(value || '').trim());
}

function normalizeBankName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findPhilippineBankAccountFormat(bankName) {
  const normalized = normalizeBankName(bankName);
  if (!normalized) return null;
  return PH_BANK_ACCOUNT_FORMATS.find(rule => rule.aliases.some(alias => {
    const normalizedAlias = normalizeBankName(alias);
    return normalized === normalizedAlias || normalized.includes(normalizedAlias);
  })) || null;
}

function describeDigitLengths(lengths) {
  return lengths.map(length => `${length} digits`).join(' or ');
}

function applyBankAccountFormatHint() {
  const bankInput = document.getElementById('emp-bank');
  const accountInput = document.getElementById('emp-bank-account');
  const hint = document.getElementById('emp-bank-account-hint');
  if (!bankInput || !accountInput) return;

  const rule = findPhilippineBankAccountFormat(bankInput.value);
  delete accountInput.dataset.digits;
  delete accountInput.dataset.digitsOptions;
  delete accountInput.dataset.minDigits;
  delete accountInput.dataset.maxDigits;
  accountInput.maxLength = '20';

  if (rule) {
    accountInput.dataset.digitsOptions = rule.lengths.join(',');
    accountInput.maxLength = String(Math.max(...rule.lengths));
    accountInput.placeholder = `${rule.label}: ${describeDigitLengths(rule.lengths)}`;
    accountInput.title = `${rule.label} account numbers must contain ${describeDigitLengths(rule.lengths)}.`;
    if (hint) hint.textContent = `${rule.label}: account number must contain ${describeDigitLengths(rule.lengths)}.`;
  } else {
    accountInput.dataset.minDigits = '6';
    accountInput.dataset.maxDigits = '20';
    accountInput.placeholder = 'Account number';
    accountInput.title = 'Digits only. Select a configured bank to enforce its exact account number length.';
    if (hint) hint.textContent = bankInput.value.trim()
      ? 'Bank is not configured yet; digits only will be accepted.'
      : 'Select a configured bank to apply its account number length.';
  }

  if (accountInput.value && window.LGSVValidation?.validateElement) {
    window.LGSVValidation.validateElement(accountInput, { commit: false });
  }
}

function initializeBankAccountFormatControls() {
  const bankInput = document.getElementById('emp-bank');
  const accountInput = document.getElementById('emp-bank-account');
  if (!bankInput || !accountInput) return;

  bankInput.removeEventListener('input', applyBankAccountFormatHint);
  bankInput.removeEventListener('change', applyBankAccountFormatHint);
  bankInput.addEventListener('input', applyBankAccountFormatHint);
  bankInput.addEventListener('change', applyBankAccountFormatHint);
  applyBankAccountFormatHint();
}

function employeeOptionEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function getEmployeeDraftStorageKey() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return `${EMPLOYEE_DRAFT_STORAGE_PREFIX}_${user?.id || user?.username || user?.role || 'local'}`;
}

function readEmployeeDrafts() {
  try {
    const raw = localStorage.getItem(getEmployeeDraftStorageKey());
    const drafts = raw ? JSON.parse(raw) : [];
    return Array.isArray(drafts) ? drafts : [];
  } catch (error) {
    console.warn('Unable to read employee drafts:', error.message);
    return [];
  }
}

function writeEmployeeDrafts(drafts) {
  localStorage.setItem(getEmployeeDraftStorageKey(), JSON.stringify(drafts.slice(0, 30)));
}

function employeeDraftEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function currentEmployeeDraftTab() {
  return document.querySelector('.employee-form-tabs .form-tab.active')?.dataset?.formSection || 'personal';
}

function collectEmployeeDraftValues() {
  const values = {};
  document.querySelectorAll('#register-form-view input, #register-form-view select, #register-form-view textarea').forEach(field => {
    if (!field.id || field.type === 'file') return;
    values[field.id] = field.type === 'checkbox' ? Boolean(field.checked) : field.value;
  });
  return values;
}

function employeeDraftTitle(values) {
  const firstName = String(values['emp-first-name'] || '').trim();
  const lastName = String(values['emp-last-name'] || '').trim();
  const employeeCode = String(values['emp-id'] || '').trim();
  const position = String(values['emp-position'] || '').trim();
  const name = [firstName, lastName].filter(Boolean).join(' ');
  if (name && employeeCode && employeeCode !== 'Generating...') return `${name} (${employeeCode})`;
  if (name) return name;
  if (position) return `Draft for ${position}`;
  if (employeeCode && employeeCode !== 'Generating...') return employeeCode;
  return 'Untitled employee draft';
}

function updateEmployeeDraftStatus(message) {
  const status = document.getElementById('employee-draft-status');
  if (status) status.textContent = message || 'No draft loaded.';
}

function renderEmployeeDraftArchive() {
  const archive = document.getElementById('employee-draft-archive');
  if (!archive) return;

  const drafts = readEmployeeDrafts().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (!drafts.length) {
    archive.innerHTML = '<div class="employee-draft-meta">No saved drafts yet.</div>';
    updateEmployeeDraftStatus(ACTIVE_EMPLOYEE_DRAFT_ID ? 'Draft archive is empty.' : 'No draft loaded.');
    return;
  }

  archive.innerHTML = drafts.map(draft => {
    const updated = draft.updated_at ? new Date(draft.updated_at).toLocaleString('en-PH') : 'Unknown date';
    const subtitle = [draft.values?.['emp-position'], draft.values?.['emp-dept']].filter(Boolean).join(' - ') || 'Partial employee intake';
    const activeLabel = draft.id === ACTIVE_EMPLOYEE_DRAFT_ID ? 'Loaded' : 'Load';
    return `
      <div class="employee-draft-row" data-draft-id="${employeeDraftEscape(draft.id)}">
        <div>
          <strong>${employeeDraftEscape(draft.title)}</strong>
          <span>${employeeDraftEscape(subtitle)} | Updated ${employeeDraftEscape(updated)}</span>
        </div>
        <div class="employee-draft-row-actions">
          <button class="btn btn-outline" type="button" onclick="loadEmployeeDraft('${employeeDraftEscape(draft.id)}')">${activeLabel}</button>
          <button class="btn btn-outline" type="button" onclick="deleteEmployeeDraft('${employeeDraftEscape(draft.id)}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function saveEmployeeDraft() {
  const values = collectEmployeeDraftValues();
  const now = new Date().toISOString();
  const id = ACTIVE_EMPLOYEE_DRAFT_ID || `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const title = employeeDraftTitle(values);
  const drafts = readEmployeeDrafts().filter(draft => draft.id !== id);
  drafts.unshift({
    id,
    title,
    values,
    active_tab: currentEmployeeDraftTab(),
    created_at: readEmployeeDrafts().find(draft => draft.id === id)?.created_at || now,
    updated_at: now
  });
  ACTIVE_EMPLOYEE_DRAFT_ID = id;
  writeEmployeeDrafts(drafts);
  renderEmployeeDraftArchive();
  updateEmployeeDraftStatus(`Saved draft: ${title}`);
}

async function loadEmployeeDraft(draftId) {
  const draft = readEmployeeDrafts().find(item => item.id === draftId);
  if (!draft) {
    alert('Draft not found.');
    renderEmployeeDraftArchive();
    return;
  }

  if (typeof clearEmployeeForm === 'function') clearEmployeeForm();
  ACTIVE_EMPLOYEE_DRAFT_ID = draft.id;

  const values = draft.values || {};
  await loadEmployeePositionOptions();

  Object.entries(values).forEach(([id, value]) => {
    const field = document.getElementById(id);
    if (!field || field.type === 'file') return;
    if (field.type === 'checkbox') {
      field.checked = Boolean(value);
    } else {
      field.value = value ?? '';
    }
  });

  const dept = document.getElementById('emp-dept')?.value || '';
  const position = values['emp-position'] || '';
  if (typeof bindDepartmentPositionDropdown === 'function') {
    bindDepartmentPositionDropdown('emp-dept', 'emp-position', position);
  } else {
    renderEmployeePositionOptions(document.getElementById('emp-position'), dept, position);
  }

  document.getElementById('emp-current-same-home')?.dispatchEvent(new Event('change'));
  document.getElementById('emp-mailing-same-home')?.dispatchEvent(new Event('change'));
  if (typeof updateWageTypeUI === 'function') updateWageTypeUI();
  if (typeof toggleEmployeeAgencyFields === 'function') toggleEmployeeAgencyFields();
  if (typeof toggleEmployeeLifecycleDecisionFields === 'function') toggleEmployeeLifecycleDecisionFields();
  if (typeof onEmployeeIdModeChange === 'function') await onEmployeeIdModeChange();
  switchFormTab(draft.active_tab || 'personal');
  renderEmployeeDraftArchive();
  updateEmployeeDraftStatus(`Loaded draft: ${draft.title}`);
}

function deleteEmployeeDraft(draftId) {
  const drafts = readEmployeeDrafts();
  const draft = drafts.find(item => item.id === draftId);
  if (!draft) return;
  if (!confirm(`Delete draft "${draft.title}"?`)) return;
  writeEmployeeDrafts(drafts.filter(item => item.id !== draftId));
  if (ACTIVE_EMPLOYEE_DRAFT_ID === draftId) {
    ACTIVE_EMPLOYEE_DRAFT_ID = null;
    updateEmployeeDraftStatus('No draft loaded.');
  }
  renderEmployeeDraftArchive();
}

function clearEmployeeDraftArchive() {
  const drafts = readEmployeeDrafts();
  if (!drafts.length) return;
  if (!confirm('Clear all saved employee drafts?')) return;
  writeEmployeeDrafts([]);
  ACTIVE_EMPLOYEE_DRAFT_ID = null;
  renderEmployeeDraftArchive();
  updateEmployeeDraftStatus('Draft archive cleared.');
}

function removeActiveEmployeeDraftAfterSave() {
  if (!ACTIVE_EMPLOYEE_DRAFT_ID) return;
  writeEmployeeDrafts(readEmployeeDrafts().filter(draft => draft.id !== ACTIVE_EMPLOYEE_DRAFT_ID));
  ACTIVE_EMPLOYEE_DRAFT_ID = null;
  renderEmployeeDraftArchive();
  updateEmployeeDraftStatus('Draft converted to an employee record.');
}

function resetRegisterDraftSelection() {
  ACTIVE_EMPLOYEE_DRAFT_ID = null;
  updateEmployeeDraftStatus('No draft loaded.');
  renderEmployeeDraftArchive();
}

async function loadEmployeePositionOptions() {
  if (EMPLOYEE_POSITION_OPTIONS_PROMISE) return EMPLOYEE_POSITION_OPTIONS_PROMISE;
  EMPLOYEE_POSITION_OPTIONS_PROMISE = (async () => {
    try {
      const response = await apiFetch('/api/employee-setup/lookups');
      if (!response || !response.ok) throw new Error('Unable to load departments and positions.');
      const data = await response.json();
      EMPLOYEE_DEPARTMENTS = Array.isArray(data.departments) ? data.departments : [];
      EMPLOYEE_POSITION_ROUTES = Array.isArray(data.positions) ? data.positions : [];
    } catch (error) {
      console.warn('Using fallback department positions:', error.message);
      EMPLOYEE_DEPARTMENTS = Object.keys(DEFAULT_DEPARTMENT_POSITIONS).map((name, index) => ({ id: index + 1, name }));
      EMPLOYEE_POSITION_ROUTES = [];
    }
    renderEmployeeDepartmentOptions();
    return EMPLOYEE_POSITION_ROUTES;
  })();
  return EMPLOYEE_POSITION_OPTIONS_PROMISE;
}

function getEmployeeSetupElement(id) {
  if (id === 'emp-dept') return document.querySelector('#form-employment select#emp-dept');
  if (id === 'emp-position') return document.querySelector('#form-employment select#emp-position');
  return document.getElementById(id);
}

function renderEmployeeDepartmentOptions(selectedById = {}) {
  const targets = [
    ['emp-dept', 'Select department'],
    ['profile-edit-department', 'Select department'],
    ['edit-emp-dept', 'Select department'],
  ];

  targets.forEach(([id, placeholder]) => {
    const select = getEmployeeSetupElement(id);
    if (!select) return;
    const selected = selectedById[id] ?? select.value;
    select.innerHTML = `<option value="">${placeholder}</option>` + EMPLOYEE_DEPARTMENTS
      .map(department => `<option value="${employeeOptionEscape(department.name)}">${employeeOptionEscape(department.name)}</option>`)
      .join('');
    if (selected && EMPLOYEE_DEPARTMENTS.some(department => department.name === selected)) {
      select.value = selected;
    }
  });
}

function getEmployeePositionsForDepartment(departmentName, selectedValue = '') {
  const dept = String(departmentName || '').trim();
  const configured = EMPLOYEE_POSITION_ROUTES
    .filter(route => {
      const routeDepartment = String(route.department || '').trim();
      const positionName = route.name || route.position_name;
      return positionName && (!routeDepartment || routeDepartment === dept);
    })
    .map(route => route.name || route.position_name);

  const fallback = DEFAULT_DEPARTMENT_POSITIONS[dept] || [];
  const positions = [...new Set([...configured, ...fallback])].sort((a, b) => a.localeCompare(b));

  if (selectedValue && !positions.includes(selectedValue)) {
    positions.unshift(selectedValue);
  }

  return positions;
}

function renderEmployeePositionOptions(positionSelect, departmentName, selectedValue = '') {
  if (!positionSelect) return;
  const positions = getEmployeePositionsForDepartment(departmentName, selectedValue);
  const placeholder = departmentName ? 'Select position / job title' : 'Select department first';
  positionSelect.innerHTML = `<option value="">${placeholder}</option>` + positions
    .map(position => `<option value="${employeeOptionEscape(position)}">${employeeOptionEscape(position)}</option>`)
    .join('');
  positionSelect.value = selectedValue && positions.includes(selectedValue) ? selectedValue : '';
}

async function bindDepartmentPositionDropdown(departmentId, positionId, selectedPosition = '') {
  const departmentSelect = getEmployeeSetupElement(departmentId);
  const positionSelect = getEmployeeSetupElement(positionId);
  if (!departmentSelect || !positionSelect) return;

  await loadEmployeePositionOptions();

  const update = (nextSelected = '') => {
    renderEmployeePositionOptions(positionSelect, departmentSelect.value, nextSelected || positionSelect.value);
  };

  if (!departmentSelect.dataset.positionDropdownBound) {
    departmentSelect.dataset.positionDropdownBound = '1';
    departmentSelect.addEventListener('change', () => update(''));
  }

  update(selectedPosition || positionSelect.value);
}

function initializeEmployeePositionDropdowns() {
  bindDepartmentPositionDropdown('emp-dept', 'emp-position');
  bindDepartmentPositionDropdown('profile-edit-department', 'profile-edit-position');
  bindDepartmentPositionDropdown('edit-emp-dept', 'edit-emp-position');
}

function resetEmployeePositionOptions() {
  EMPLOYEE_POSITION_OPTIONS_PROMISE = null;
  EMPLOYEE_POSITION_ROUTES = [];
  EMPLOYEE_DEPARTMENTS = [];
}

const ADDRESS_FORM_CONFIGS = {
  emp: {
    home: { input: 'emp-address', line: 'emp-address-line' },
    current: { input: 'emp-current-address', line: 'emp-current-address-line', same: 'emp-current-same-home' },
    mailing: { input: 'emp-mailing-address', line: 'emp-mailing-address-line', same: 'emp-mailing-same-home' }
  },
  profile: {
    home: { input: 'profile-edit-address' },
    current: { input: 'profile-edit-current-address', same: 'profile-current-same-home' },
    mailing: { input: 'profile-edit-mailing-address', same: 'profile-mailing-same-home' }
  },
  onboarding: {
    home: { input: 'onb-home-address' },
    current: { input: 'onb-current-address', same: 'onb-current-same-home' },
    mailing: { input: 'onb-mailing-address', same: 'onb-mailing-same-home' }
  }
};

function addressEscapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function clearAddressSelection(input) {
  if (!input) return;
  delete input.dataset.addressSelected;
  delete input.dataset.latitude;
  delete input.dataset.longitude;
  delete input.dataset.placeId;
  delete input.dataset.region;
  delete input.dataset.province;
  delete input.dataset.cityMunicipality;
  delete input.dataset.barangay;
  delete input.dataset.streetAddress;
  delete input.dataset.locationAddress;
  delete input.dataset.fullAddress;
}

function setAddressSelection(input, address, latitude, longitude, placeId = '', details = {}) {
  if (!input) return;
  input.value = address || '';
  input.dataset.addressSelected = address && latitude !== undefined && longitude !== undefined ? '1' : '';
  input.dataset.latitude = latitude ?? '';
  input.dataset.longitude = longitude ?? '';
  input.dataset.placeId = placeId || '';
  input.dataset.region = details.region || '';
  input.dataset.province = details.province || '';
  input.dataset.cityMunicipality = details.city_municipality || '';
  input.dataset.barangay = details.barangay || '';
  input.dataset.streetAddress = details.street_address || '';
  input.dataset.locationAddress = details.location_address || details.full_address || address || '';
  input.dataset.fullAddress = details.full_address || address || '';
}

function getAddressLineInput(item) {
  return item?.line ? document.getElementById(item.line) : null;
}

function getAddressLineValue(item, input) {
  const lineInput = getAddressLineInput(item);
  return (lineInput?.value || input?.dataset.streetAddress || '').trim();
}

function getAddressLocationValue(input) {
  return (input?.dataset.fullAddress || input?.value || '').trim();
}

function getAddressLocationOnlyValue(item, input) {
  const line = getAddressLineValue(item, input);
  const selectedLocation = (input?.dataset.locationAddress || '').trim();
  if (selectedLocation) return selectedLocation;

  const rawValue = (input?.value || '').trim();
  const rawFullAddress = (input?.dataset.fullAddress || '').trim();
  const candidate = rawFullAddress || rawValue;
  if (!line || !candidate) return candidate;

  const normalizedLine = line.replace(/\s+/g, ' ').toLowerCase();
  const normalizedCandidate = candidate.replace(/\s+/g, ' ').toLowerCase();
  if (normalizedCandidate === normalizedLine) return '';

  const linePrefix = `${normalizedLine}, `;
  if (normalizedCandidate.startsWith(linePrefix)) {
    return candidate.slice(candidate.indexOf(',') + 1).trim();
  }

  return candidate;
}

function buildEmployeeFullAddress(line, location) {
  return [line, location].filter(Boolean).join(', ');
}

function syncAddressFullValue(item) {
  const input = document.getElementById(item.input);
  if (!input) return '';
  const line = getAddressLineValue(item, input);
  const location = item.line ? getAddressLocationOnlyValue(item, input) : getAddressLocationValue(input);
  const fullAddress = buildEmployeeFullAddress(line, location);
  input.dataset.streetAddress = line;
  if (item.line) input.dataset.locationAddress = location;
  input.dataset.fullAddress = fullAddress || location;
  return fullAddress || location || input.value || '';
}

function copyHomeAddress(config) {
  const home = document.getElementById(config.home.input);
  const homeLine = getAddressLineInput(config.home);
  ['current', 'mailing'].forEach(key => {
    const item = config[key];
    const same = document.getElementById(item.same);
    const input = document.getElementById(item.input);
    if (!same || !input || !same.checked) return;
    const lineInput = getAddressLineInput(item);
    if (lineInput) {
      lineInput.value = homeLine?.value || home?.dataset.streetAddress || '';
      lineInput.disabled = true;
    }
    // A same-as-home address is the same verified address, not merely the same
    // display text. Preserve its full selection metadata for payload generation.
    setAddressSelection(input, home?.value || '', home?.dataset.latitude, home?.dataset.longitude, home?.dataset.placeId, {
      region: home?.dataset.region,
      province: home?.dataset.province,
      city_municipality: home?.dataset.cityMunicipality,
      barangay: home?.dataset.barangay,
      street_address: homeLine?.value || home?.dataset.streetAddress,
      full_address: home?.dataset.fullAddress || home?.value || ''
    });
    if (window.copyPhilippineAddressSection) window.copyPhilippineAddressSection(config.home.input, item.input);
    input.disabled = true;
  });
}

function renderAddressSuggestions(input, results) {
  const box = document.getElementById(`${input.id}-suggestions`);
  if (!box) return;
  if (!results.length) {
    box.innerHTML = '<div class="address-suggestion">No address found.</div>';
    box.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
    return;
  }
  box.innerHTML = results.map((item, index) => `
    <button class="address-suggestion" type="button" data-index="${index}">
      ${addressEscapeHtml(item.full_address)}
      <span class="address-suggestion-meta">${
        item.latitude !== null && item.latitude !== undefined && item.longitude !== null && item.longitude !== undefined
          ? `${Number(item.latitude).toFixed(5)}, ${Number(item.longitude).toFixed(5)}`
          : item.provider === 'philippine_dataset' ? 'Philippine address dataset' : 'Google Places'
      }</span>
    </button>
  `).join('');
  box.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', async () => {
      let item = results[Number(button.dataset.index)];
      if (item.provider === 'google_places' && item.place_id) {
        const detailsResponse = await apiFetch(`/api/address/details?place_id=${encodeURIComponent(item.place_id)}`);
        if (detailsResponse && detailsResponse.ok) {
          item = await detailsResponse.json();
        }
      }
      if (item.provider !== 'philippine_dataset' && (item.latitude === null || item.latitude === undefined || item.longitude === null || item.longitude === undefined)) {
        alert('Could not get coordinates for the selected address. Please choose another suggestion.');
        return;
      }
      setAddressSelection(input, item.full_address, item.latitude, item.longitude, item.place_id || '', item);
      box.style.display = 'none';
      input.setAttribute('aria-expanded', 'false');
      Object.values(ADDRESS_FORM_CONFIGS).forEach(copyHomeAddress);
    });
  });
  box.style.display = 'block';
}

function setupAddressInput(inputId) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.addressReady === '1') return;
  input.dataset.addressReady = '1';
  const box = document.getElementById(`${input.id}-suggestions`);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  if (box) {
    box.setAttribute('role', 'listbox');
    input.setAttribute('aria-controls', box.id);
  }
  let timer = null;
  input.addEventListener('focus', () => {
    if (!box || input.value.trim().length >= 3) return;
    box.innerHTML = '<div class="address-suggestion address-suggestion-hint">Type at least 3 characters to search Philippine addresses.</div>';
    box.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
  });
  input.addEventListener('input', () => {
    clearAddressSelection(input);
    Object.values(ADDRESS_FORM_CONFIGS).forEach(copyHomeAddress);
    clearTimeout(timer);
    const query = input.value.trim();
    const box = document.getElementById(`${input.id}-suggestions`);
    if (query.length < 3) {
      if (box) {
        box.innerHTML = '<div class="address-suggestion address-suggestion-hint">Type at least 3 characters to search Philippine addresses.</div>';
        box.style.display = 'block';
        input.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    timer = setTimeout(async () => {
      try {
        const response = await apiFetch(`/api/address/search?q=${encodeURIComponent(query)}`);
        const results = response && response.ok ? await response.json() : [];
        renderAddressSuggestions(input, Array.isArray(results) ? results : []);
      } catch (error) {
        console.error('Address search failed:', error);
      }
    }, 300);
  });
}

function initializeEmployeeAddressAutocomplete(scope = document) {
  if (window.initializePhilippineAddressForms) {
    window.initializePhilippineAddressForms(scope);
  }
  Object.values(ADDRESS_FORM_CONFIGS).forEach(config => {
    if (!scope.querySelector?.(`#${config.home.input}`) && !document.getElementById(config.home.input)) return;
    setupAddressInput(config.home.input);
    setupAddressInput(config.current.input);
    setupAddressInput(config.mailing.input);
    ['home', 'current', 'mailing'].forEach(key => {
      const item = config[key];
      const lineInput = getAddressLineInput(item);
      if (!lineInput || lineInput.dataset.addressLineReady === '1') return;
      lineInput.dataset.addressLineReady = '1';
      lineInput.addEventListener('input', () => {
        syncAddressFullValue(item);
        Object.values(ADDRESS_FORM_CONFIGS).forEach(copyHomeAddress);
      });
    });

    ['current', 'mailing'].forEach(key => {
      const item = config[key];
      const same = document.getElementById(item.same);
      const input = document.getElementById(item.input);
      if (!same || !input || same.dataset.addressSameReady === '1') return;
      same.dataset.addressSameReady = '1';
      same.addEventListener('change', () => {
        const lineInput = getAddressLineInput(item);
        if (same.checked) {
          copyHomeAddress(config);
          input.disabled = true;
        } else {
          input.disabled = false;
          if (lineInput) {
            lineInput.disabled = false;
            lineInput.value = '';
          }
          input.value = '';
          clearAddressSelection(input);
        }
      });
    });
  });
  if (document.documentElement.dataset.addressDismissReady !== '1') {
    document.documentElement.dataset.addressDismissReady = '1';
    document.addEventListener('click', event => {
      if (event.target.closest('.address-autocomplete')) return;
      document.querySelectorAll('.address-suggestions').forEach(box => { box.style.display = 'none'; });
      document.querySelectorAll('.address-autocomplete input').forEach(input => input.setAttribute('aria-expanded', 'false'));
    });
  }
}

function collectEmployeeAddressPayload(mode = 'emp') {
  const config = ADDRESS_FORM_CONFIGS[mode];
  const get = key => document.getElementById(config[key].input);
  const home = get('home');
  const current = get('current');
  const mailing = get('mailing');
  const currentSame = config.current.same ? document.getElementById(config.current.same)?.checked : false;
  const mailingSame = config.mailing.same ? document.getElementById(config.mailing.same)?.checked : false;
  const errors = [];
  const homeLine = getAddressLineValue(config.home, home);
  const currentLine = currentSame ? homeLine : getAddressLineValue(config.current, current);
  const mailingLine = mailingSame ? homeLine : getAddressLineValue(config.mailing, mailing);
  const homeAddress = syncAddressFullValue(config.home);
  const currentAddress = currentSame ? homeAddress : syncAddressFullValue(config.current);
  const mailingAddress = mailingSame ? homeAddress : syncAddressFullValue(config.mailing);

  if (!homeLine) errors.push('Home Address exact address line is required.');
  if (!home?.value.trim()) errors.push('Home Address barangay / city / province is required.');
  if (!currentSame && !currentLine) errors.push('Current Address exact address line is required unless Same as Home Address is checked.');
  if (!currentSame && !current?.value.trim()) errors.push('Current Address barangay / city / province is required unless Same as Home Address is checked.');
  if (!mailingSame && !mailingLine) errors.push('Mailing Address exact address line is required unless Same as Home Address is checked.');
  if (!mailingSame && !mailing?.value.trim()) errors.push('Mailing Address barangay / city / province is required unless Same as Home Address is checked.');
  const phInputIds = [...new Set([config.home.input, currentSame ? config.home.input : config.current.input, mailingSame ? config.home.input : config.mailing.input])];
  const phAddress = window.collectPhilippineAddressPayload
    ? window.collectPhilippineAddressPayload(phInputIds)
    : { errors: [], payload: {} };
  errors.push(...phAddress.errors);
  const addressPayload = {
    ...phAddress.payload,
    residential_address_street_address: homeLine,
    residential_address_full_address: homeAddress,
    current_address_street_address: currentLine,
    current_address_full_address: currentAddress,
    mailing_address_street_address: mailingLine,
    mailing_address_full_address: mailingAddress
  };

  return {
    errors: [...new Set(errors)],
    payload: {
      residential_address: homeAddress || null,
      residential_address_lat: home?.dataset.latitude || null,
      residential_address_lng: home?.dataset.longitude || null,
      current_address: currentAddress || null,
      current_address_lat: currentSame ? home?.dataset.latitude || null : current?.dataset.latitude || null,
      current_address_lng: currentSame ? home?.dataset.longitude || null : current?.dataset.longitude || null,
      current_address_same_as_home: currentSame ? 1 : 0,
      mailing_address: mailingAddress || null,
      mailing_address_lat: mailingSame ? home?.dataset.latitude || null : mailing?.dataset.latitude || null,
      mailing_address_lng: mailingSame ? home?.dataset.longitude || null : mailing?.dataset.longitude || null,
      mailing_address_same_as_home: mailingSame ? 1 : 0,
      ...addressPayload
    }
  };
}

window.initializeEmployeePositionDropdowns = initializeEmployeePositionDropdowns;
window.bindDepartmentPositionDropdown = bindDepartmentPositionDropdown;
window.loadEmployeePositionOptions = loadEmployeePositionOptions;
window.resetEmployeePositionOptions = resetEmployeePositionOptions;
window.getEmployeeDepartments = () => EMPLOYEE_DEPARTMENTS;
window.getEmployeePositions = () => EMPLOYEE_POSITION_ROUTES;
window.initializeEmployeeAddressAutocomplete = initializeEmployeeAddressAutocomplete;
window.collectEmployeeAddressPayload = collectEmployeeAddressPayload;
window.setAddressSelection = setAddressSelection;

// Wage Configuration Data
let WAGE_CONFIG = {
  sawingTypes: [],
  logisticsRegions: [],
  selectedRates: { sewing: {}, logistics: {} }
};

// Fetch and populate wage types and rates
async function initializeWageConfig() {
  try {
    const [sewingRes, regionsRes] = await Promise.all([
      apiFetch('/api/payroll/sewing-types'),
      apiFetch('/api/payroll/logistics-regions')
    ]);
    
    const sewingData = await sewingRes.json();
    const regionsData = await regionsRes.json();
    
    WAGE_CONFIG.sawingTypes = sewingData;
    WAGE_CONFIG.logisticsRegions = regionsData;
    
    console.log('✅ Wage configuration loaded:', {
      sewingTypes: WAGE_CONFIG.sawingTypes.length,
      regions: WAGE_CONFIG.logisticsRegions.length
    });
  } catch (err) {
    console.error('Error loading wage configuration:', err);
  }
}

const REGISTER_PAYROLL_ONLY_FIELDS = [
  'wage_type_id', 'wage_type', 'base_rate', 'allowances',
  'payroll_schedule', 'tax_status', 'bank_name', 'bank_account'
];

function canManageRegisteredEmployeePayroll() {
  return ['hr_manager', 'hr_admin', 'payroll_officer', 'payroll_manager', 'admin', 'system_admin'].includes(getUser()?.role);
}

function removeUnauthorizedRegisterPayrollFields(payload) {
  if (canManageRegisteredEmployeePayroll()) return payload;
  REGISTER_PAYROLL_ONLY_FIELDS.forEach(field => delete payload[field]);
  return payload;
}

// Check user role and disable form fields for payroll officers
function applyRoleBasedAccess() {
  const userStr = sessionStorage.getItem('vp_user');
  const user = userStr ? JSON.parse(userStr) : null;
  const isPayrollOfficer = user?.role === 'payroll_officer' || user?.role === 'payroll_manager';
  
  if (isPayrollOfficer) {
    // Disable all form inputs for payroll officer (read-only mode)
    const allInputs = document.querySelectorAll('#register-form-view input, #register-form-view select, #register-form-view textarea');
    allInputs.forEach(input => {
      input.disabled = true;
      input.style.opacity = '0.6';
      input.style.cursor = 'not-allowed';
    });
    
    // Hide Save and Clear buttons
    const saveBtn = document.querySelector('button.btn-green');
    const clearBtn = document.querySelector('button.btn-outline');
    if (saveBtn) saveBtn.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    
    // Show read-only message
    const header = document.querySelector('.page-header-right');
    if (header) {
      const msg = document.createElement('div');
      msg.style.cssText = 'color: var(--yellow); font-weight: 600; font-size: 13px;';
      msg.textContent = '👁 View-Only Mode (Payroll Officer)';
      header.appendChild(msg);
    }
  }
}

// Get government contributions for payroll display
async function fetchGovernmentContributions(employeeId) {
  try {
    const response = await apiFetch(`/api/payroll/employees/${employeeId}/government-contributions`);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error('Error fetching government contributions:', err);
    return null;
  }
}

// Display government contributions in a modal for payroll officer
function displayGovernmentContributions(contributions) {
  if (!contributions) return;
  
  let html = `
    <div style="background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 16px 0;">
      <h4 style="font-weight: 600; margin-bottom: 12px; color: var(--text);">Government Contributions & Cost Deductions</h4>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
        <div>
          <label style="font-size: 11px; color: var(--muted); text-transform: uppercase;">SSS #</label>
          <div style="font-size: 13px; font-weight: 600; color: var(--text);">${contributions.government_ids.sss_number}</div>
        </div>
        <div>
          <label style="font-size: 11px; color: var(--muted); text-transform: uppercase;">PhilHealth #</label>
          <div style="font-size: 13px; font-weight: 600; color: var(--text);">${contributions.government_ids.philhealth_number}</div>
        </div>
        <div>
          <label style="font-size: 11px; color: var(--muted); text-transform: uppercase;">Pag-IBIG #</label>
          <div style="font-size: 13px; font-weight: 600; color: var(--text);">${contributions.government_ids.pagibig_number}</div>
        </div>
        <div>
          <label style="font-size: 11px; color: var(--muted); text-transform: uppercase;">TIN</label>
          <div style="font-size: 13px; font-weight: 600; color: var(--text);">${contributions.government_ids.tin}</div>
        </div>
      </div>
      ${contributions.deductions.length > 0 ? `
        <div>
          <h5 style="font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--text);">Active Deductions</h5>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${contributions.deductions.map(d => `
              <div style="display: flex; justify-content: space-between; padding: 8px; background: var(--bg); border-radius: 6px; border: 1px solid var(--border);">
                <span style="font-size: 12px; color: var(--text);">${d.deduction_type}</span>
                <span style="font-weight: 600; color: var(--accent);">₱${parseFloat(d.amount).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : '<div style="font-size: 12px; color: var(--muted);">No active deductions</div>'}
    </div>
  `;
  
  return html;
}

// Update wage type UI based on selection
function updateWageTypeUI() {
  const wageType = document.getElementById('emp-wage-type')?.value;
  
  // Hide all wage type UIs
  ['wage-base-salary', 'wage-hourly', 'wage-production', 'wage-logistics'].forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.style.display = 'none';
  });
  
  // Show selected wage type UI
  if (wageType === 'Base Salary') {
    const panel = document.getElementById('wage-base-salary');
    if (panel) panel.style.display = 'block';
  } else if (wageType === 'Hourly') {
    const panel = document.getElementById('wage-hourly');
    if (panel) panel.style.display = 'block';
  } else if (wageType === 'Per-Piece') {
    const panel = document.getElementById('wage-production');
    if (panel) panel.style.display = 'block';
    populateSewingTypeRates();
  } else if (wageType === 'Per-Trip') {
    const panel = document.getElementById('wage-logistics');
    if (panel) panel.style.display = 'block';
    populateLogisticsRegionRates();
  }
}

// Populate sewing type rates
function populateSewingTypeRates() {
  const container = document.getElementById('emp-sewing-rates');
  if (!container) return;
  
  container.innerHTML = WAGE_CONFIG.sawingTypes.map(sewing => `
    <div class="wage-rate-item">
      <label class="wage-rate-label">${sewing.name}</label>
      <input type="number" 
             class="wage-rate-input"
             id="sewing-${sewing.id}" 
             placeholder="₱ ${sewing.default_rate}" 
             min="0" step="0.01"
             value="${sewing.default_rate}" />
    </div>
  `).join('');
}

// Populate logistics region rates
function populateLogisticsRegionRates() {
  const container = document.getElementById('emp-logistics-rates');
  if (!container) return;
  
  container.innerHTML = WAGE_CONFIG.logisticsRegions.map(region => `
    <div class="wage-rate-item">
      <label class="wage-rate-label">${region.name} ${region.code ? `(${region.code})` : ''}</label>
      <input type="number" 
             class="wage-rate-input"
             id="logistics-${region.id}" 
             placeholder="₱ ${region.default_rate}" 
             min="0" step="0.01"
             value="${region.default_rate}" />
    </div>
  `).join('');
}

// Load employee data when editing
function loadEmployeeData() {
  // Check if we're in pending edit mode (set by employees.js)
  if (window.PENDING_EDIT_MODE) {
    EDIT_MODE = true;
    window.PENDING_EDIT_MODE = false;
  }
  
  const empDataStr = sessionStorage.getItem('editEmployee');
  if (!empDataStr) {
    console.log('No employee data in sessionStorage');
    return;
  }
  
  EDIT_MODE = true;
  const emp = JSON.parse(empDataStr);
  EDIT_EMPLOYEE_ID = emp.employee_code;
  EDIT_EMPLOYEE_NUMERIC_ID = emp.id;  // Store the numeric ID for API calls
  
  console.log('✅ loadEmployeeData called');
  console.log('Loading employee data for:', emp.employee_code, emp.first_name, emp.last_name);
  console.log('   Numeric ID:', emp.id);
  console.log('Employee from DB - Department:', emp.department, '| Position:', emp.position, '| Supervisor:', emp.supervisor);
  
  // Populate Personal Info
  const empCodeInput = document.getElementById('emp-id');
  if (empCodeInput) {
    empCodeInput.value = emp.employee_code || emp.id || '';
    empCodeInput.readOnly = true;
  }
  const empIdMode = document.getElementById('emp-id-mode');
  const empIdHint = document.getElementById('emp-id-hint');
  if (empIdMode) {
    empIdMode.value = 'manual';
    empIdMode.disabled = true;
  }
  if (empIdHint) {
    empIdHint.textContent = 'Employee ID is locked while editing an existing employee record.';
    empIdHint.classList.remove('error');
  }
  
  const firstNameInput = document.getElementById('emp-first-name');
  if (firstNameInput) firstNameInput.value = emp.first_name || '';
  
  const middleNameInput = document.getElementById('emp-middle-name');
  if (middleNameInput) middleNameInput.value = emp.middle_name || '';
  
  const lastNameInput = document.getElementById('emp-last-name');
  if (lastNameInput) lastNameInput.value = emp.last_name || '';
  
  const suffixInput = document.getElementById('emp-suffix');
  if (suffixInput) suffixInput.value = emp.suffix || 'None';
  
  const emailInput = document.getElementById('emp-email');
  if (emailInput) emailInput.value = emp.email || '';
  
  const contactInput = document.getElementById('emp-contact');
  if (contactInput) contactInput.value = emp.contact_number || '';

  const workEmailInput = document.getElementById('emp-work-email');
  if (workEmailInput) workEmailInput.value = emp.work_email || '';
  
  const nationalityInput = document.getElementById('emp-nationality');
  if (nationalityInput) nationalityInput.value = emp.nationality || 'Filipino';

  const placeOfBirthInput = document.getElementById('emp-place-of-birth');
  if (placeOfBirthInput) placeOfBirthInput.value = emp.place_of_birth || '';

  const bloodTypeInput = document.getElementById('emp-blood-type');
  if (bloodTypeInput) bloodTypeInput.value = emp.blood_type || '';

  const religionInput = document.getElementById('emp-religion');
  if (religionInput) religionInput.value = emp.religion || '';
  
  const genderInput = document.getElementById('emp-gender');
  if (genderInput) genderInput.value = emp.gender || 'Male';
  
  const dobInput = document.getElementById('emp-dob');
  if (dobInput) dobInput.value = emp.date_of_birth || '';
  
  const addressInput = document.getElementById('emp-address');
  if (addressInput) setAddressSelection(addressInput, emp.residential_address || '', emp.residential_address_lat, emp.residential_address_lng);
  if (window.setPhilippineAddressValues) window.setPhilippineAddressValues('emp-address', emp);

  const currentAddressInput = document.getElementById('emp-current-address');
  if (currentAddressInput) setAddressSelection(currentAddressInput, emp.current_address || '', emp.current_address_lat, emp.current_address_lng);
  if (window.setPhilippineAddressValues) window.setPhilippineAddressValues('emp-current-address', emp);

  const mailingAddressInput = document.getElementById('emp-mailing-address');
  if (mailingAddressInput) setAddressSelection(mailingAddressInput, emp.mailing_address || '', emp.mailing_address_lat, emp.mailing_address_lng);
  if (window.setPhilippineAddressValues) window.setPhilippineAddressValues('emp-mailing-address', emp);

  const currentSameInput = document.getElementById('emp-current-same-home');
  if (currentSameInput) currentSameInput.checked = Number(emp.current_address_same_as_home) === 1;

  const mailingSameInput = document.getElementById('emp-mailing-same-home');
  if (mailingSameInput) mailingSameInput.checked = Number(emp.mailing_address_same_as_home) === 1;

  initializeEmployeeAddressAutocomplete();
  currentSameInput?.dispatchEvent(new Event('change'));
  mailingSameInput?.dispatchEvent(new Event('change'));
  
  const emergNameInput = document.getElementById('emp-emerg-name');
  if (emergNameInput) emergNameInput.value = emp.emergency_contact_name || '';
  
  const emergPhoneInput = document.getElementById('emp-emerg-phone');
  if (emergPhoneInput) emergPhoneInput.value = emp.emergency_contact_num || '';

  const emergRelationshipInput = document.getElementById('emp-emerg-relationship');
  if (emergRelationshipInput) emergRelationshipInput.value = emp.emergency_contact_relationship || '';

  const emergSecondaryPhoneInput = document.getElementById('emp-emerg-secondary-phone');
  if (emergSecondaryPhoneInput) emergSecondaryPhoneInput.value = emp.emergency_contact_secondary_num || '';

  const emergEmailInput = document.getElementById('emp-emerg-email');
  if (emergEmailInput) emergEmailInput.value = emp.emergency_contact_email || '';

  const emergAddressInput = document.getElementById('emp-emerg-address');
  if (emergAddressInput) emergAddressInput.value = emp.emergency_contact_address || '';

  const maritalInput = document.getElementById('emp-marital-status');
  if (maritalInput) maritalInput.value = emp.marital_status || 'Single';
  
  // Populate Employment Details using specific selectors
  const typeInput = document.querySelector('#form-employment select#emp-type');
  if (typeInput) typeInput.value = emp.employment_type || 'Full-time';

  const hiringTypeInput = document.querySelector('#form-employment select#emp-hiring-type');
  if (hiringTypeInput) hiringTypeInput.value = emp.hiring_type || 'Direct Hire';

  const lifecycleActionInput = document.getElementById('emp-lifecycle-action');
  if (lifecycleActionInput) lifecycleActionInput.value = 'AUTO';

  const lifecycleNoteInput = document.getElementById('emp-lifecycle-note');
  if (lifecycleNoteInput) lifecycleNoteInput.value = '';

  const agencyNameInput = document.getElementById('emp-agency-name');
  if (agencyNameInput) agencyNameInput.value = emp.agency_name || '';

  const agencyContactPersonInput = document.getElementById('emp-agency-contact-person');
  if (agencyContactPersonInput) agencyContactPersonInput.value = emp.agency_contact_person || '';

  const agencyContactNumberInput = document.getElementById('emp-agency-contact-number');
  if (agencyContactNumberInput) agencyContactNumberInput.value = emp.agency_contact_number || '';

  const deploymentStatusInput = document.getElementById('emp-deployment-status');
  if (deploymentStatusInput) deploymentStatusInput.value = emp.deployment_status || 'Pending Deployment';

  const contractStartInput = document.getElementById('emp-contract-start-date');
  if (contractStartInput) contractStartInput.value = emp.contract_start_date || '';

  const contractEndInput = document.getElementById('emp-contract-end-date');
  if (contractEndInput) contractEndInput.value = emp.contract_end_date || '';

  toggleEmployeeAgencyFields();

  const statusInput = document.querySelector('#form-employment select#emp-status-field');
  if (statusInput) statusInput.value = emp.status || 'Active';
  
  const hiredDateInput = document.querySelector('#form-employment input#emp-hired-date');
  if (hiredDateInput) hiredDateInput.value = emp.date_hired || '';

  const endContractInput = document.querySelector('#form-employment input#emp-end-contract');
  if (endContractInput) endContractInput.value = emp.end_of_contract || '';
  
  const supervisorInput = document.querySelector('#form-employment input#emp-supervisor');
  if (supervisorInput) supervisorInput.value = emp.supervisor || '';
  
  const locationInput = document.querySelector('#form-employment input#emp-location');
  if (locationInput) locationInput.value = emp.work_location || '';

  const shiftInput = document.querySelector('#form-employment select#emp-shift-schedule');
  if (shiftInput) shiftInput.value = emp.shift_schedule || '';

  const levelInput = document.querySelector('#form-employment select#emp-level');
  if (levelInput) levelInput.value = emp.employee_level || '';

  const employmentHistoryInput = document.querySelector('#form-employment textarea#emp-employment-history');
  if (employmentHistoryInput) employmentHistoryInput.value = emp.employment_history || '';

  const sssInput = document.getElementById('emp-sss');
  if (sssInput) sssInput.value = emp.sss_number || '';

  const philhealthInput = document.getElementById('emp-philhealth');
  if (philhealthInput) philhealthInput.value = emp.philhealth_number || '';

  const pagibigInput = document.getElementById('emp-pagibig');
  if (pagibigInput) pagibigInput.value = emp.pagibig_number || '';

  const tinInput = document.getElementById('emp-tin');
  if (tinInput) tinInput.value = emp.tin || '';

  const taxStatusInput = document.getElementById('emp-tax-status');
  if (taxStatusInput) taxStatusInput.value = emp.tax_status || '';

  const allowancesInput = document.getElementById('emp-allowances');
  if (allowancesInput) allowancesInput.value = emp.allowances || '';

  const payrollScheduleInput = document.getElementById('emp-pay-freq');
  if (payrollScheduleInput) payrollScheduleInput.value = emp.payroll_schedule || 'Monthly';

  const bankInput = document.getElementById('emp-bank');
  if (bankInput) bankInput.value = emp.bank_name || '';

  const bankAccountInput = document.getElementById('emp-bank-account');
  if (bankAccountInput) bankAccountInput.value = emp.bank_account || '';
  applyBankAccountFormatHint();
  
  // Set department by name (not ID) - use specific selector to avoid filter dropdown
  const deptSelect = document.querySelector('#form-employment select#emp-dept');
  if (deptSelect && emp.department) {
    deptSelect.value = emp.department;
    console.log('✅ Set dept dropdown to:', emp.department);
  } else {
    console.warn('⚠️ Could not set department:');
    console.warn('  - deptSelect found:', !!deptSelect);
    console.warn('  - emp.department value:', emp.department);
  }

  bindDepartmentPositionDropdown('emp-dept', 'emp-position', emp.position || '');
  
  // Clear the temp storage
  sessionStorage.removeItem('editEmployee');
  
  // Set a global flag so switchRegisterView knows we're editing
  window.IS_EDITING = true;
  
  console.log('✅ Loaded all employee data. EDIT_MODE:', EDIT_MODE, 'EDIT_EMPLOYEE_ID:', EDIT_EMPLOYEE_ID);
  
  // Load existing documents if editing
  if (EDIT_EMPLOYEE_ID) {
    loadEmployeeDocuments(EDIT_EMPLOYEE_ID);
    // Also load wage configuration
    loadExistingWageConfiguration(EDIT_EMPLOYEE_ID);
  }

  if (window.LGSVValidation?.applyPhoneFieldHints) {
    window.LGSVValidation.applyPhoneFieldHints(document.getElementById('register-form-view') || document);
  }
}

// Auto-generate next employee ID
async function generateEmployeeID() {
  // Skip if in edit mode
  if (EDIT_MODE) {
    console.log('Skipping ID generation - in EDIT_MODE');
    return;
  }

  const mode = document.getElementById('emp-id-mode')?.value || 'auto';
  if (mode !== 'auto') {
    const empCodeInput = document.getElementById('emp-id');
    if (empCodeInput) {
      empCodeInput.readOnly = false;
      empCodeInput.disabled = false;
    }
    return null;
  }
  
  try {
    const empCodeInput = document.getElementById('emp-id');
    if (!empCodeInput) {
      console.error('emp-id input element not found!');
      return null;
    }
    
    // Show a placeholder while loading
    empCodeInput.value = 'Generating...';
    empCodeInput.disabled = true;
    
    console.log('Requesting next employee ID from server...');
    const nextCodeResponse = await apiFetch('/api/employees/next-code');
    if (nextCodeResponse?.ok) {
      const data = await nextCodeResponse.json();
      if (data.employee_code) {
        EMPLOYEE_ID_CONFIG = data.config || EMPLOYEE_ID_CONFIG;
        empCodeInput.value = data.employee_code;
        empCodeInput.readOnly = true;
        empCodeInput.disabled = false;
        console.log('Generated employee ID from server:', data.employee_code);
        return data.employee_code;
      }
    }

    const nextCodeError = await nextCodeResponse?.json?.().catch(() => ({}));
    if (nextCodeResponse?.status === 400 && nextCodeError?.error) {
      empCodeInput.value = '';
      empCodeInput.readOnly = true;
      empCodeInput.disabled = false;
      const hint = document.getElementById('emp-id-hint');
      if (hint) {
        hint.textContent = `${nextCodeError.error} Use existing employee ID mode.`;
        hint.classList.add('error');
      }
      return null;
    }

    console.warn('Server next-code endpoint unavailable; falling back to employee list scan.');
    const response = await apiFetch('/api/employees');
    if (!response || !response.ok) {
      console.error('Failed to fetch employees for ID generation');
      empCodeInput.value = '';
      empCodeInput.disabled = false;
      return null;
    }
    
    const employees = await response.json();
    console.log('Fetched', employees.length, 'employees');
    
    // Extract numeric IDs from employee codes (e.g., "EMP00001" -> 1)
    const ids = employees
      .map(e => {
        const code = String(e.employee_code || '').replace('EMP', '');
        const match = code.match(/\d+/);
        const numId = match ? parseInt(match[0]) : 0;
        if (numId > 0) {
          console.log('Found employee code:', e.employee_code, '-> numeric ID:', numId);
        }
        return numId;
      })
      .filter(id => id > 0);
    
    console.log('Extracted numeric IDs:', ids);
    
    // Find the next available ID
    const nextId = (ids.length > 0 ? Math.max(...ids) : 0) + 1;
    const newCode = 'EMP' + String(nextId).padStart(5, '0');
    
    console.log('Calculated next ID:', nextId, '-> Code:', newCode);
    
    // Set the employee code field
    if (empCodeInput) {
      empCodeInput.value = newCode;
      empCodeInput.readOnly = true;
      empCodeInput.disabled = false;
      console.log('✅ Generated new employee ID:', newCode);
    }
    
    return newCode;
  } catch (error) {
    console.error('❌ Error generating employee ID:', error);
    const empCodeInput = document.getElementById('emp-id');
    if (empCodeInput) {
      empCodeInput.value = '';
      empCodeInput.disabled = false;
    }
    return null;
  }
}

async function loadEmployeeIdConfig() {
  try {
    const response = await apiFetch('/api/employees/id-config');
    if (!response?.ok) return null;
    EMPLOYEE_ID_CONFIG = await response.json();
    return EMPLOYEE_ID_CONFIG;
  } catch (error) {
    console.warn('Unable to load employee ID config:', error.message);
    return null;
  }
}

async function onEmployeeIdModeChange() {
  const modeSelect = document.getElementById('emp-id-mode');
  const empCodeInput = document.getElementById('emp-id');
  const hint = document.getElementById('emp-id-hint');
  if (!modeSelect || !empCodeInput) return;

  if (!canOverrideEmployeeId()) {
    modeSelect.value = 'auto';
    modeSelect.disabled = true;
  }

  if (modeSelect.value === 'manual') {
    empCodeInput.value = '';
    empCodeInput.readOnly = false;
    empCodeInput.disabled = false;
    empCodeInput.placeholder = 'Existing company ID';
    if (hint) {
      hint.textContent = 'Allowed: letters, numbers, hyphens, and underscores. Employee ID must be unique.';
      hint.classList.remove('error');
    }
    empCodeInput.focus();
    return;
  }

  empCodeInput.placeholder = 'EMP000001';
  if (hint) {
    hint.textContent = 'The system will generate the next available employee ID.';
    hint.classList.remove('error');
  }
  await generateEmployeeID();
}

async function checkManualEmployeeCodeAvailability() {
  const modeSelect = document.getElementById('emp-id-mode');
  const empCodeInput = document.getElementById('emp-id');
  const hint = document.getElementById('emp-id-hint');
  if (!modeSelect || !empCodeInput || modeSelect.value !== 'manual') return true;

  const code = sanitizeEmployeeCode(empCodeInput.value);
  empCodeInput.value = code;

  if (!code) {
    if (hint) {
      hint.textContent = 'Employee ID is required when using an existing employee ID.';
      hint.classList.add('error');
    }
    return false;
  }

  if (!isValidManualEmployeeCode(code)) {
    if (hint) {
      hint.textContent = 'Employee ID can only contain letters, numbers, hyphens, and underscores.';
      hint.classList.add('error');
    }
    return false;
  }

  try {
    const response = await apiFetch(`/api/employees/code-available/${encodeURIComponent(code)}`);
    const data = await response.json();
    if (!response.ok || data.available === false) {
      if (hint) {
        hint.textContent = data.error || 'Employee ID already exists.';
        hint.classList.add('error');
      }
      return false;
    }
    if (hint) {
      hint.textContent = 'Employee ID is available.';
      hint.classList.remove('error');
    }
    return true;
  } catch (error) {
    if (hint) {
      hint.textContent = 'Employee ID will be checked when you save.';
      hint.classList.remove('error');
    }
    return true;
  }
}

function initializeEmployeeIdControls() {
  const modeSelect = document.getElementById('emp-id-mode');
  const empCodeInput = document.getElementById('emp-id');
  if (!modeSelect || !empCodeInput || modeSelect.dataset.ready === '1') return;
  modeSelect.dataset.ready = '1';

  if (!canOverrideEmployeeId()) {
    modeSelect.value = 'auto';
    modeSelect.disabled = true;
  }

  empCodeInput.addEventListener('input', () => {
    if (modeSelect.value !== 'manual') return;
    empCodeInput.value = sanitizeEmployeeCode(empCodeInput.value);
  });
  empCodeInput.addEventListener('blur', () => {
    checkManualEmployeeCodeAvailability();
  });

  loadEmployeeIdConfig().then(() => onEmployeeIdModeChange());
}

function getActiveFormTab() {
  const activeSection = document.querySelector('#register-form-view .form-tab.active')?.dataset?.formSection;
  if (FORM_SECTIONS.includes(activeSection)) return activeSection;

  const visibleSection = FORM_SECTIONS.find(sectionId => {
    const panel = document.getElementById(`form-${sectionId}`);
    if (!panel) return false;
    return window.getComputedStyle(panel).display !== 'none';
  });

  return visibleSection || 'personal';
}

function switchFormTab(tabOrEl) {
  const map = {
    'Personal Info': 'personal',
    'Contact Info': 'contact',
    'Employment Details': 'employment',
    'Employment Info': 'employment',
    'Bank/Tax Record': 'payroll',
    'Government/Tax': 'payroll',
    'Compensation': 'payroll',
    'Payroll & Compensation': 'payroll',
    'Documents': 'documents',
  };

  const sectionId = typeof tabOrEl === 'string'
    ? tabOrEl
    : (tabOrEl?.dataset?.formSection || map[tabOrEl?.textContent?.trim()]);

  if (!sectionId) return;

  // Update tab styles
  document.querySelectorAll('.form-tab').forEach(t => t.classList.remove('active'));
  const activeTab = document.querySelector(`.form-tab[data-form-section="${sectionId}"]`);
  if (activeTab) activeTab.classList.add('active');

  // Show/hide sections
  FORM_SECTIONS.forEach(s => {
    const panel = document.getElementById('form-' + s);
    if (panel) panel.style.display = (s === sectionId) ? 'block' : 'none';
  });
  if (employeeWizardStepIndex(sectionId) >= 0) {
    LAST_EMPLOYEE_WIZARD_REQUIRED_SECTION = sectionId;
  }
  
  // Initialize file uploads when Documents tab is shown
  if (sectionId === 'documents') {
    console.log('📄 Documents tab activated - initializing file uploads');
    setTimeout(() => {
      initializeFileUploads();
    }, 100);
  }
  if (sectionId === 'contact') {
    setTimeout(() => initializeEmployeeAddressAutocomplete(), 50);
  }
  updateEmployeeWizardActions(sectionId);
}

function employeeWizardStepIndex(sectionId) {
  return EMPLOYEE_WIZARD_REQUIRED_SECTIONS.indexOf(sectionId);
}

function updateEmployeeWizardActions(sectionId = getActiveFormTab()) {
  const backButton = document.getElementById('employee-wizard-back');
  const nextButton = document.getElementById('employee-wizard-next');
  const saveButton = document.getElementById('employee-wizard-save');
  if (!backButton || !nextButton || !saveButton) return;

  const stepIndex = employeeWizardStepIndex(sectionId);
  const isRequiredWizardStep = stepIndex >= 0;
  const isFirstStep = stepIndex === 0;
  const isFinalStep = sectionId === 'payroll';
  const isDocumentsStep = sectionId === 'documents';

  backButton.style.display = (!isFirstStep && (isRequiredWizardStep || isDocumentsStep)) ? 'inline-flex' : 'none';
  nextButton.style.display = isRequiredWizardStep && !isFinalStep ? 'inline-flex' : 'none';
  saveButton.style.display = isFinalStep ? 'inline-flex' : 'none';

  backButton.textContent = 'Back';
}

async function validateEmployeeWizardStep(sectionId) {
  const panel = document.getElementById(`form-${sectionId}`);
  if (panel && window.LGSVValidation && !window.LGSVValidation.validateScope(panel)) {
    return false;
  }

  if (sectionId === 'personal') {
    const employeeIdMode = document.getElementById('emp-id-mode')?.value || 'auto';
    const isEditing = EDIT_MODE || window.PENDING_EDIT_MODE || window.IS_EDITING || false;
    if (employeeIdMode === 'manual' && !isEditing && !(await checkManualEmployeeCodeAvailability())) {
      document.getElementById('emp-id')?.focus();
      return false;
    }
  }

  if (sectionId === 'contact') {
    const addressResult = collectEmployeeAddressPayload('emp');
    if (addressResult.errors.length) {
      alert(addressResult.errors.join('\n'));
      return false;
    }
  }

  if (sectionId === 'employment') {
    const position = document.querySelector('#form-employment select#emp-position')?.value || '';
    if (!position) {
      alert('Please select a position / job title so the system can route the employee lifecycle correctly.');
      document.querySelector('#form-employment select#emp-position')?.focus();
      return false;
    }

    const lifecycleAction = getLifecycleDecision();
    const lifecycleNote = document.getElementById('emp-lifecycle-note')?.value || '';
    if (lifecycleAction === 'ON_HOLD' && lifecycleNote.trim().length < 8) {
      alert('Please enter an HR note or reason of at least 8 characters when placing the record on hold.');
      document.getElementById('emp-lifecycle-note')?.focus();
      return false;
    }
  }

  return true;
}

async function goEmployeeWizardStep(targetSectionId) {
  if (!FORM_SECTIONS.includes(targetSectionId)) return;

  const currentSectionId = getActiveFormTab();
  const currentIndex = employeeWizardStepIndex(currentSectionId);
  const targetIndex = employeeWizardStepIndex(targetSectionId);

  if (targetIndex >= 0 && currentIndex >= 0 && targetIndex > currentIndex) {
    for (let index = currentIndex; index < targetIndex; index += 1) {
      const sectionId = EMPLOYEE_WIZARD_REQUIRED_SECTIONS[index];
      switchFormTab(sectionId);
      if (!(await validateEmployeeWizardStep(sectionId))) return;
    }
  }

  switchFormTab(targetSectionId);
}

async function goEmployeeWizardNext() {
  const currentSectionId = getActiveFormTab();
  const currentIndex = employeeWizardStepIndex(currentSectionId);
  if (currentIndex < 0 || currentIndex >= EMPLOYEE_WIZARD_REQUIRED_SECTIONS.length - 1) return;
  if (!(await validateEmployeeWizardStep(currentSectionId))) return;
  switchFormTab(EMPLOYEE_WIZARD_REQUIRED_SECTIONS[currentIndex + 1]);
}

function goEmployeeWizardBack() {
  const currentSectionId = getActiveFormTab();
  if (currentSectionId === 'documents') {
    switchFormTab(LAST_EMPLOYEE_WIZARD_REQUIRED_SECTION || 'personal');
    return;
  }
  const currentIndex = employeeWizardStepIndex(currentSectionId);
  if (currentIndex <= 0) return;
  switchFormTab(EMPLOYEE_WIZARD_REQUIRED_SECTIONS[currentIndex - 1]);
}

async function validateEmployeeWizardRequiredStepsBeforeSubmit() {
  for (const sectionId of EMPLOYEE_WIZARD_REQUIRED_SECTIONS) {
    switchFormTab(sectionId);
    if (!(await validateEmployeeWizardStep(sectionId))) return false;
  }
  switchFormTab('payroll');
  return true;
}

function toggleEmployeeAgencyFields() {
  const hiringType = document.getElementById('emp-hiring-type')?.value || 'Direct Hire';
  const agencyFields = document.getElementById('emp-agency-fields');
  if (!agencyFields) return;

  const isAgencyHired = hiringType === 'Agency-Hired';
  agencyFields.hidden = !isAgencyHired;
  agencyFields.querySelectorAll('input, select').forEach(field => {
    if (field.id === 'emp-deployment-status') return;
    field.required = isAgencyHired;
  });

  const typeInput = document.getElementById('emp-type');
  if (isAgencyHired && typeInput) typeInput.value = 'Contractual';
}

function getLifecycleDecision() {
  return document.getElementById('emp-lifecycle-action')?.value || 'AUTO';
}

function toggleEmployeeLifecycleDecisionFields() {
  const decision = getLifecycleDecision();
  const note = document.getElementById('emp-lifecycle-note');
  const help = document.getElementById('emp-lifecycle-help');
  const messages = {
    AUTO: 'Position defaults route production, operator, piece-rate, factory, and logistics helper roles to onboarding unless HR selects another action.',
    DIRECT_ACTIVE: 'This record will be created directly as an active employee in the Employee Directory.',
    SCREENING_REQUIRED: 'This record will go to Onboarding for screening and requirements checking before activation.',
    TRAINING_REQUIRED: 'This record will go to Onboarding and must complete training before HR approval.',
    ON_HOLD: 'This record will stay in Onboarding with an On Hold status until HR resumes the process.',
  };

  if (help) help.textContent = messages[decision] || messages.AUTO;
  if (note) {
    const showNote = decision === 'ON_HOLD' || decision === 'SCREENING_REQUIRED' || decision === 'TRAINING_REQUIRED';
    note.style.display = showNote ? 'block' : 'none';
    note.required = decision === 'ON_HOLD';
  }
}

function initializeEmployeeLifecycleControls() {
  const hiringType = document.getElementById('emp-hiring-type');
  if (hiringType) {
    hiringType.removeEventListener('change', toggleEmployeeAgencyFields);
    hiringType.addEventListener('change', toggleEmployeeAgencyFields);
  }

  const lifecycleAction = document.getElementById('emp-lifecycle-action');
  if (lifecycleAction) {
    lifecycleAction.removeEventListener('change', toggleEmployeeLifecycleDecisionFields);
    lifecycleAction.addEventListener('change', toggleEmployeeLifecycleDecisionFields);
  }

  toggleEmployeeAgencyFields();
  toggleEmployeeLifecycleDecisionFields();
}

async function showEmployeeRegistrationFeedback({ isEditing, routedToOnboarding, data, employeeCode }) {
  const savedCode = data?.employee_code || employeeCode || document.getElementById('emp-id')?.value || '';
  const title = routedToOnboarding
    ? 'Employee Routed to Onboarding'
    : isEditing
      ? 'Employee Updated'
      : 'Employee Registered';
  const fallbackMessage = routedToOnboarding
    ? 'Employee/applicant routed to onboarding.'
    : isEditing
      ? 'Employee record updated successfully.'
      : 'New employee account registered successfully.';
  const message = [
    data?.message || fallbackMessage,
    savedCode ? `Employee ID: ${savedCode}` : ''
  ].filter(Boolean).join('\n');

  if (typeof showAlert === 'function') {
    await showAlert(message, title, 'success');
  } else {
    alert(message);
  }
}

async function saveEmployee() {
  // Prevent double submission
  if (IS_SAVING) {
    console.warn('⚠️ Save already in progress - ignoring duplicate click');
    return;
  }
  IS_SAVING = true;

  // The form is assembled as a wizard. Validate only the required wizard
  // steps before final submit; Documents are optional during employee creation.
  if (!(await validateEmployeeWizardRequiredStepsBeforeSubmit())) {
    IS_SAVING = false;
    return;
  }
  
  // Collect form data from all sections using the new ID attributes
  const empIdInput = document.getElementById('emp-id');
  const employeeIdMode = document.getElementById('emp-id-mode')?.value || 'auto';
  let empId = sanitizeEmployeeCode(empIdInput?.value);
  
  // Check if we're editing by checking all relevant flags
  // EDIT_MODE is set during fresh loads
  // window.PENDING_EDIT_MODE is set before navigation
  // window.IS_EDITING is set in loadEmployeeData()
  const isEditing = EDIT_MODE || window.PENDING_EDIT_MODE || window.IS_EDITING || false;
  let savedEmployeeNumericId = EDIT_EMPLOYEE_NUMERIC_ID;
  let savedEmployeeCode = empId;
  let routedToOnboarding = false;
  let saveCompleted = false;
  
  // Debug log - VERY DETAILED
  console.log('====== saveEmployee DEBUG ======');
  console.log('empId:', empId);
  console.log('EDIT_MODE:', EDIT_MODE);
  console.log('window.PENDING_EDIT_MODE:', window.PENDING_EDIT_MODE);
  console.log('window.IS_EDITING:', window.IS_EDITING);
  console.log('isEditing (final):', isEditing);
  console.log('Method will be:', isEditing ? 'PUT (UPDATE)' : 'POST (INSERT)');
  console.log('================================');
  
  // Validation: Employee code is required when HR uses an existing company ID.
  if (employeeIdMode === 'manual' && (!empId || empId.trim() === '')) {
    IS_SAVING = false;  // Reset double-submit flag
    alert('Employee ID is required when using an existing employee ID.');
    console.error('Employee code is empty!');
    return;
  }

  if (employeeIdMode === 'manual' && !isValidManualEmployeeCode(empId)) {
    IS_SAVING = false;
    alert('Employee ID can only contain letters, numbers, hyphens, and underscores.');
    return;
  }

  if (employeeIdMode === 'manual' && !isEditing) {
    const isEmployeeCodeAvailable = await checkManualEmployeeCodeAvailability();
    if (!isEmployeeCodeAvailable) {
      IS_SAVING = false;
      alert('Employee ID already exists.');
      return;
    }
  }
  
  const departmentName = document.querySelector('#form-employment select#emp-dept')?.value || 'HR';
  const departmentId = getDepartmentId(departmentName);
  
  // DEBUG: Log what we're reading from the employment fields
  console.log('=== EMPLOYMENT FIELDS DEBUG ===');
  console.log('emp-dept value:', document.querySelector('#form-employment select#emp-dept')?.value);
  console.log('emp-position value:', document.querySelector('#form-employment select#emp-position')?.value);
  console.log('emp-hiring-type value:', document.querySelector('#form-employment select#emp-hiring-type')?.value);
  console.log('emp-type value:', document.querySelector('#form-employment select#emp-type')?.value);
  console.log('emp-status-field value:', document.querySelector('#form-employment select#emp-status-field')?.value);
  console.log('emp-hired-date value:', document.querySelector('#form-employment input#emp-hired-date')?.value);
  console.log('emp-end-contract value:', document.querySelector('#form-employment input#emp-end-contract')?.value);
  console.log('emp-supervisor value:', document.querySelector('#form-employment input#emp-supervisor')?.value);
  console.log('emp-location value:', document.querySelector('#form-employment input#emp-location')?.value);
  console.log('Department name:', departmentName, '-> ID:', departmentId);

  const addressResult = collectEmployeeAddressPayload('emp');
  if (addressResult.errors.length) {
    IS_SAVING = false;
    alert(addressResult.errors.join('\n'));
    switchFormTab('contact');
    return;
  }
  
  const formData = {
    // Personal Info
    employee_id_mode: employeeIdMode,
    employee_code: employeeIdMode === 'manual' ? empId : null,
    first_name: document.getElementById('emp-first-name')?.value || '',
    middle_name: document.getElementById('emp-middle-name')?.value || null,
    last_name: document.getElementById('emp-last-name')?.value || '',
    suffix: document.getElementById('emp-suffix')?.value === 'None' ? null : document.getElementById('emp-suffix')?.value || null,
    email: document.getElementById('emp-email')?.value || '',
    contact_number: document.getElementById('emp-contact')?.value || null,
    work_email: document.getElementById('emp-work-email')?.value || null,
    nationality: document.getElementById('emp-nationality')?.value || 'Filipino',
    marital_status: document.getElementById('emp-marital-status')?.value || null,
    date_of_birth: document.getElementById('emp-dob')?.value || null,
    place_of_birth: document.getElementById('emp-place-of-birth')?.value || null,
    gender: document.getElementById('emp-gender')?.value || null,
    blood_type: document.getElementById('emp-blood-type')?.value || null,
    religion: document.getElementById('emp-religion')?.value || null,
    ...addressResult.payload,
    emergency_contact_name: document.getElementById('emp-emerg-name')?.value || null,
    emergency_contact_num: document.getElementById('emp-emerg-phone')?.value || null,
    emergency_contact_relationship: document.getElementById('emp-emerg-relationship')?.value || null,
    emergency_contact_secondary_num: document.getElementById('emp-emerg-secondary-phone')?.value || null,
    emergency_contact_email: document.getElementById('emp-emerg-email')?.value || null,
    emergency_contact_address: document.getElementById('emp-emerg-address')?.value || null,
    
    // Employment Details
    department_id: departmentId,
    position: document.querySelector('#form-employment select#emp-position')?.value || null,
    employment_type: document.querySelector('#form-employment select#emp-type')?.value || 'Full-time',
    hiring_type: document.querySelector('#form-employment select#emp-hiring-type')?.value || 'Direct Hire',
    lifecycle_action: getLifecycleDecision(),
    lifecycle_note: document.getElementById('emp-lifecycle-note')?.value || null,
    requires_onboarding: ['SCREENING_REQUIRED', 'TRAINING_REQUIRED', 'ON_HOLD'].includes(getLifecycleDecision()) ? 1 : 0,
    requires_training: getLifecycleDecision() === 'TRAINING_REQUIRED' ? 1 : 0,
    agency_name: document.getElementById('emp-agency-name')?.value || null,
    agency_contact_person: document.getElementById('emp-agency-contact-person')?.value || null,
    agency_contact_number: document.getElementById('emp-agency-contact-number')?.value || null,
    deployment_status: document.getElementById('emp-deployment-status')?.value || null,
    contract_start_date: document.getElementById('emp-contract-start-date')?.value || null,
    contract_end_date: document.getElementById('emp-contract-end-date')?.value || null,
    date_hired: document.querySelector('#form-employment input#emp-hired-date')?.value || null,
    end_of_contract: document.querySelector('#form-employment input#emp-end-contract')?.value || null,
    supervisor: document.querySelector('#form-employment input#emp-supervisor')?.value || null,
    work_location: document.querySelector('#form-employment input#emp-location')?.value || null,
    shift_schedule: document.querySelector('#form-employment select#emp-shift-schedule')?.value || null,
    employee_level: document.querySelector('#form-employment select#emp-level')?.value || null,
    employment_history: document.querySelector('#form-employment textarea#emp-employment-history')?.value || null,
    status: document.querySelector('#form-employment select#emp-status-field')?.value || 'Active',
    
    // Payroll Info
    wage_type_id: getWageTypeId(document.getElementById('emp-wage-type')?.value),
    wage_type: document.getElementById('emp-wage-type')?.value || null,
    base_rate: document.getElementById('emp-salary')?.value || document.getElementById('emp-hourly-rate')?.value || document.getElementById('emp-prod-base-rate')?.value || null,
    allowances: document.getElementById('emp-allowances')?.value || null,
    payroll_schedule: document.getElementById('emp-pay-freq')?.value || null,
    sss_number: document.getElementById('emp-sss')?.value || null,
    philhealth_number: document.getElementById('emp-philhealth')?.value || null,
    pagibig_number: document.getElementById('emp-pagibig')?.value || null,
    tin: document.getElementById('emp-tin')?.value || null,
    tax_status: document.getElementById('emp-tax-status')?.value || null,
    bank_name: document.getElementById('emp-bank')?.value || null,
    bank_account: document.getElementById('emp-bank-account')?.value || null
  };
  removeUnauthorizedRegisterPayrollFields(formData);

  if (!formData.first_name || !formData.last_name || !formData.email) {
    IS_SAVING = false;  // Reset double-submit flag
    alert('First name, last name, and email are required.');
    console.error('Missing required fields:', { 
      first_name: formData.first_name, 
      last_name: formData.last_name, 
      email: formData.email 
    });
    return;
  }

  if (!formData.position) {
    IS_SAVING = false;
    alert('Please select a position / job title so the system can route the employee lifecycle correctly.');
    switchFormTab('employment');
    return;
  }

  if (formData.lifecycle_action === 'ON_HOLD' && String(formData.lifecycle_note || '').trim().length < 8) {
    IS_SAVING = false;
    alert('Please enter an HR note or reason of at least 8 characters when placing the record on hold.');
    switchFormTab('employment');
    return;
  }

  console.log('Saving employee:', formData);
  console.log('Is editing:', isEditing);
  console.log('Sending employment data to server:', {
    department_id: formData.department_id,
    position: formData.position,
    employment_type: formData.employment_type,
    date_hired: formData.date_hired,
    supervisor: formData.supervisor,
    work_location: formData.work_location
  });

  // Determine if this is a new employee or update
  const method = isEditing ? 'PUT' : 'POST';
  const endpoint = isEditing ? `/api/employees/${EDIT_EMPLOYEE_NUMERIC_ID || empId}` : '/api/employees';

  // Use apiFetch which auto-attaches token
  apiFetch(endpoint, {
    method: method,
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(formData)
  })
  .then(res => {
    console.log('Response status:', res.status);
    if (!res.ok) {
      console.error('HTTP error:', res.status);
      return res.json().then(data => {
        const error = new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
        error.payload = data;
        throw error;
      });
    }
    return res.json();
  })
  .then(async data => {
    console.log('Response data:', data);
    if (data.employee_code) {
      empId = data.employee_code;
      savedEmployeeCode = data.employee_code;
      if (empIdInput) empIdInput.value = data.employee_code;
    }
    routedToOnboarding = data.routed_to === 'onboarding';
    savedEmployeeNumericId = routedToOnboarding ? null : (data.id || savedEmployeeNumericId);
    await showEmployeeRegistrationFeedback({ isEditing, routedToOnboarding, data, employeeCode: savedEmployeeCode || empId });
    removeActiveEmployeeDraftAfterSave();
    IS_SAVING = false;  // Reset double-submit flag

    if (routedToOnboarding) return { routedToOnboarding: true };

    // Save wage configuration if set
    const wageTypeId = getWageTypeId(document.getElementById('emp-wage-type')?.value);
    if (canManageRegisteredEmployeePayroll() && wageTypeId) {
      // Use numeric ID for API calls, fall back to employee code for new employees
      const apiEmployeeId = savedEmployeeNumericId || empId;
      return saveWageConfiguration(apiEmployeeId, wageTypeId);
    }
    return null;
  })
  .then((wageResult) => {
    if (routedToOnboarding) return null;
    if (SELECTED_EMPLOYEE_PHOTO) {
      console.log('Uploading employee photo...');
      return uploadEmployeePhoto(savedEmployeeNumericId);
    }
    return null;
  })
  .then(() => {
    if (routedToOnboarding) return null;
    // Upload documents if any files were selected
    const hasFiles = Object.values(UPLOADED_FILES).some(files => Array.isArray(files) && files.length > 0);
    if (hasFiles) {
      console.log('Uploading documents...');
      return uploadEmployeeDocuments(savedEmployeeCode);
    }
    return null;
  })
  .then(() => {
    saveCompleted = true;
    if (routedToOnboarding) {
      clearUploadedFiles();
      setTimeout(() => {
        if (typeof navigate === 'function') navigate('onboarding', document.querySelector('[data-page="onboarding"]'));
      }, 500);
      return;
    }

    // Reload documents list after upload
    if (savedEmployeeCode) {
      loadEmployeeDocuments(savedEmployeeCode);
    }
    
    // Wait a moment for database to settle, then fetch fresh data and redirect
    setTimeout(async () => {
      console.log('Fetching fresh employee data...');
      if (typeof fetchEmployees === 'function') {
        try {
          const freshData = await fetchEmployees();
          console.log('✅ Fresh employee data loaded from API:', freshData?.length, 'employees');
          
          // Find the current employee in the fresh data
          const currentEmp = freshData?.find(e => e.id === empId);
          if (currentEmp) {
            console.log('✅ Current employee fresh data verified:', {
              name: currentEmp.name,
              email: currentEmp.email,
              phone: currentEmp.phone,
              city: currentEmp.city,
              dept: currentEmp.dept,
              position: currentEmp.position,
              supervisor: currentEmp.supervisor,
              status: currentEmp.status
            });
          } else {
            console.warn('⚠️ Could not find current employee in fresh data');
          }
          
          // Give DOM a moment to render the updated cards
          await new Promise(r => setTimeout(r, 200));
          
          if (typeof navigate === 'function') {
            console.log('✅ Redirecting to main Employees page with fresh data...');
            navigate('employees', null);
          } else {
            console.error('navigate is not available');
            alert('Error: Could not navigate to employees page');
          }
        } catch (err) {
          console.error('❌ Error fetching fresh data:', err);
          // Still navigate even if fetch fails
          if (typeof navigate === 'function') {
            navigate('employees', null);
          }
        }
      } else {
        console.warn('fetchEmployees not available, navigating with existing data');
        if (typeof navigate === 'function') {
          navigate('employees', null);
        }
      }
    }, 500); // Small delay to ensure database is updated
  })
  .catch(err => {
    IS_SAVING = false;  // Reset double-submit flag on error
    console.error('Save error:', err);
    if (err.payload?.duplicate?.field === 'employee_code' && err.payload?.next_employee_code) {
      const empIdInput = document.getElementById('emp-id');
      const mode = document.getElementById('emp-id-mode')?.value || 'auto';
      if (empIdInput && mode === 'auto') {
        empIdInput.value = err.payload.next_employee_code;
        empIdInput.readOnly = true;
      }
      alert(mode === 'auto'
        ? `${err.message}\n\nI generated a new available Employee ID: ${err.payload.next_employee_code}. Please review and save again.`
        : err.message);
      return;
    }
    alert('Failed to save employee: ' + err.message);
  })
  .finally(() => {
    if (saveCompleted && !routedToOnboarding) {
      EDIT_MODE = false;
      EDIT_EMPLOYEE_ID = null;
      EDIT_EMPLOYEE_NUMERIC_ID = null;
      window.IS_EDITING = false;
      window.PENDING_EDIT_MODE = false;
    }
  });
}

function getDepartmentId(deptName) {
  const department = EMPLOYEE_DEPARTMENTS.find(item => item.name === deptName);
  if (department) return department.id;
  const fallback = Object.keys(DEFAULT_DEPARTMENT_POSITIONS).indexOf(deptName);
  return fallback >= 0 ? fallback + 1 : null;
}

// Get wage type ID from name
function getWageTypeId(wageName) {
  const wageMap = {
    'Base Salary': 1,
    'Hourly': 2,
    'Per-Piece': 3,
    'Per-Trip': 4
  };
  return wageMap[wageName] || null;
}

// Load existing wage configuration for an employee (when editing)
async function loadExistingWageConfiguration(employeeCode) {
  try {
    console.log('📋 Loading existing wage configuration for:', employeeCode);
    
    const res = await apiFetch(`/api/payroll/employees/${employeeCode}/wage-config`);
    
    if (!res.ok) {
      console.log('ℹ️  No existing wage configuration found (new employee or wages not yet set)');
      return;
    }
    
    const config = await res.json();
    console.log('✅ Existing wage config found:', config);
    
    // Set the wage type dropdown
    const wageTypeDropdown = document.getElementById('emp-wage-type');
    if (wageTypeDropdown && config.wage_type) {
      wageTypeDropdown.value = config.wage_type;
      console.log('✅ Set wage type to:', config.wage_type);
      
      // Trigger change to show appropriate form sections
      wageTypeDropdown.dispatchEvent(new Event('change'));
    }
    
    // Populate the rates based on wage type
    if (config.rates && config.rates.length > 0) {
      if (config.wage_type === 'Base Salary') {
        const baseSalaryInput = document.getElementById('emp-salary');
        if (baseSalaryInput && config.rates[0]) {
          baseSalaryInput.value = config.rates[0].rate || config.rates[0].base_rate || '';
          console.log('✅ Loaded base salary:', baseSalaryInput.value);
        }
      } else if (config.wage_type === 'Hourly') {
        const hourlyInput = document.getElementById('emp-hourly-rate');
        const overtimeInput = document.getElementById('emp-overtime-rate');
        if (config.rates[0]) {
          if (hourlyInput) {
            hourlyInput.value = config.rates[0].hourly_rate || '';
            console.log('✅ Loaded hourly rate:', hourlyInput.value);
          }
          if (overtimeInput) {
            overtimeInput.value = config.rates[0].overtime_rate || '';
            console.log('✅ Loaded overtime rate:', overtimeInput.value);
          }
        }
      } else if (config.wage_type === 'Per-Piece') {
        // Load sewing type rates
        config.rates.forEach(rate => {
          if (rate.sewing_type_id) {
            const input = document.getElementById(`sewing-${rate.sewing_type_id}`);
            if (input) {
              input.value = rate.rate || '';
              console.log(`✅ Loaded sewing type ${rate.sewing_type_id} rate:`, input.value);
            }
          }
        });
      } else if (config.wage_type === 'Per-Trip') {
        // Load logistics region rates
        config.rates.forEach(rate => {
          if (rate.logistics_region_id) {
            const input = document.getElementById(`logistics-${rate.logistics_region_id}`);
            if (input) {
              input.value = rate.rate || '';
              console.log(`✅ Loaded logistics region ${rate.logistics_region_id} rate:`, input.value);
            }
          }
        });
      }
    }
    
    console.log('✅✅✅ Existing wage configuration loaded successfully');
  } catch (err) {
    console.error('❌ Error loading wage configuration:', err);
  }
}

// Save wage configuration for an employee
async function saveWageConfiguration(employeeCode, wageTypeId) {
  const wageType = document.getElementById('emp-wage-type')?.value;
  const rates = [];

  try {
    console.log('🔵 saveWageConfiguration called');
    console.log('   Wage Type:', wageType);
    console.log('   Employee Code:', employeeCode);
    console.log('   Wage Type ID:', wageTypeId);
    
    if (wageType === 'Base Salary') {
      // Collect base salary
      console.log('→ Collecting BASE SALARY rates');
      const salaryInput = document.getElementById('emp-salary');
      const salary = salaryInput ? parseFloat(salaryInput.value) : 0;
      
      if (salary > 0) {
        console.log('   ✅ Salary:', salary);
        rates.push({
          rate: salary,
          base_rate: salary,
          hourly_rate: null,
          overtime_rate: null,
          sewing_type_id: null,
          logistics_region_id: null
        });
      } else {
        console.log('   ⚠️ Salary is 0 or empty, skipping');
      }
    } else if (wageType === 'Hourly') {
      // Collect hourly rates
      console.log('→ Collecting HOURLY rates');
      const hourlyInput = document.getElementById('emp-hourly-rate');
      const overtimeInput = document.getElementById('emp-overtime-rate');
      const hourlyRate = hourlyInput ? parseFloat(hourlyInput.value) : 0;
      const overtimeRate = overtimeInput ? parseFloat(overtimeInput.value) : 0;
      
      if (hourlyRate > 0) {
        console.log('   ✅ Hourly Rate:', hourlyRate);
        console.log('   ✅ Overtime Rate:', overtimeRate);
        rates.push({
          rate: hourlyRate,
          base_rate: 0,
          hourly_rate: hourlyRate,
          overtime_rate: overtimeRate || 0,
          sewing_type_id: null,
          logistics_region_id: null
        });
      } else {
        console.log('   ⚠️ Hourly rate is 0 or empty, skipping');
      }
    } else if (wageType === 'Per-Piece') {
      // Collect sewing type rates
      console.log('→ Collecting PER-PIECE (Sewing) rates');
      for (const sewing of WAGE_CONFIG.sawingTypes) {
        const rateInput = document.getElementById(`sewing-${sewing.id}`);
        if (rateInput) {
          const rate = parseFloat(rateInput.value) || 0;
          if (rate > 0) {
            console.log(`   ✅ ${sewing.name}: ${rate}`);
            rates.push({
              rate: rate,
              base_rate: 0,
              hourly_rate: null,
              overtime_rate: null,
              sewing_type_id: sewing.id,
              logistics_region_id: null
            });
          } else {
            console.log(`   ⊘ ${sewing.name}: empty (skipped)`);
          }
        }
      }
    } else if (wageType === 'Per-Trip') {
      // Collect logistics region rates
      console.log('→ Collecting PER-TRIP (Logistics) rates');
      for (const region of WAGE_CONFIG.logisticsRegions) {
        const rateInput = document.getElementById(`logistics-${region.id}`);
        if (rateInput) {
          const rate = parseFloat(rateInput.value) || 0;
          if (rate > 0) {
            console.log(`   ✅ ${region.name}: ${rate}`);
            rates.push({
              rate: rate,
              base_rate: 0,
              hourly_rate: null,
              overtime_rate: null,
              sewing_type_id: null,
              logistics_region_id: region.id
            });
          } else {
            console.log(`   ⊘ ${region.name}: empty (skipped)`);
          }
        }
      }
    }

    console.log('📊 Total rates collected:', rates.length);
    
    if (rates.length > 0) {
      console.log('📤 SENDING WAGE CONFIG API REQUEST...');
      console.log('   Payload:', { wage_type_id: wageTypeId, rates: rates });
      
      const res = await apiFetch(`/api/payroll/employees/${employeeCode}/wage-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wage_type_id: wageTypeId, rates: rates })
      });
      
      console.log('📥 API Response Status:', res.status);
      
      if (res.ok) {
        const responseData = await res.json();
        console.log('✅✅✅ Wage configuration saved! Response:', responseData);
        return responseData;
      } else {
        const errorData = await res.json();
        console.error('❌ Failed to save wage configuration:', errorData);
        throw new Error(errorData.error || 'Failed to save wage configuration');
      }
    } else {
      console.log('⚠️ No rates to save (rates.length === 0)');
    }
  } catch (err) {
    console.error('❌ Error saving wage configuration:', err);
    throw err;
  }
  return null;
}

// Reset edit mode - exposed globally so employees.js can call it
window.resetEditMode = function() {
  EDIT_MODE = false;
  EDIT_EMPLOYEE_ID = null;
  EDIT_EMPLOYEE_NUMERIC_ID = null;
  window.IS_EDITING = false;
  window.PENDING_EDIT_MODE = false;
  console.log('All edit mode flags reset');
};

// Initialize form for ADDING a new employee (not editing)
window.initializeAddForm = function() {
  // Reset all edit flags
  EDIT_MODE = false;
  EDIT_EMPLOYEE_ID = null;
  window.IS_EDITING = false;
  window.PENDING_EDIT_MODE = false;
  
  // Clear form
  clearEmployeeForm();
  
  // Generate new ID
  setTimeout(() => {
    generateEmployeeID();
  }, 100);
  
  console.log('Form initialized for NEW employee. EDIT_MODE:', EDIT_MODE);
};

window.switchFormTab  = switchFormTab;
window.getActiveFormTab = getActiveFormTab;
window.goEmployeeWizardStep = goEmployeeWizardStep;
window.goEmployeeWizardNext = goEmployeeWizardNext;
window.goEmployeeWizardBack = goEmployeeWizardBack;
window.saveEmployee   = saveEmployee;
window.saveEmployeeDraft = saveEmployeeDraft;
window.loadEmployeeDraft = loadEmployeeDraft;
window.deleteEmployeeDraft = deleteEmployeeDraft;
window.clearEmployeeDraftArchive = clearEmployeeDraftArchive;
window.resetRegisterDraftSelection = resetRegisterDraftSelection;

// ===== FILE UPLOAD FUNCTIONS =====

// Initialize file upload listeners
function initializeFileUploads() {
  const docIds = ['resume', 'govid', 'nbi', 'other'];
  let successCount = 0;
  let failCount = 0;

  const photoInput = document.getElementById('emp-photo-input');
  if (photoInput) {
    photoInput.removeEventListener('change', handleEmployeePhotoSelect);
    photoInput.addEventListener('change', handleEmployeePhotoSelect);
  }
  
  docIds.forEach(docId => {
    const fileInput = document.getElementById(`doc-${docId}`);
    if (fileInput) {
      fileInput.addEventListener('change', (e) => handleFileSelect(e, docId));
      console.log(`✅ File upload listener initialized for: ${docId}`);
      successCount++;
    } else {
      console.warn(`⚠️ File input not found for: doc-${docId}`);
      failCount++;
    }
  });
  
  console.log(`📊 File upload initialization: ${successCount} initialized, ${failCount} missing`);
  
  // Initialize the preview area
  const previewEl = document.getElementById('selected-files-preview');
  if (previewEl) {
    console.log('✅ selected-files-preview element found');
    renderSelectedFilesChips();
  } else {
    console.warn('⚠️ selected-files-preview element not found');
  }
}

function handleEmployeePhotoSelect(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
  const maxSize = 5 * 1024 * 1024;

  if (!allowedTypes.includes(file.type)) {
    alert('Please select a JPG or PNG photo.');
    event.target.value = '';
    return;
  }

  if (file.size > maxSize) {
    alert(`Photo is too large. Maximum size is 5MB. Your file: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
    event.target.value = '';
    return;
  }

  SELECTED_EMPLOYEE_PHOTO = file;

  if (EMPLOYEE_PHOTO_PREVIEW_URL) {
    URL.revokeObjectURL(EMPLOYEE_PHOTO_PREVIEW_URL);
  }
  EMPLOYEE_PHOTO_PREVIEW_URL = URL.createObjectURL(file);

  const preview = document.getElementById('emp-photo-preview');
  const placeholder = document.getElementById('emp-photo-placeholder');
  const status = document.getElementById('emp-photo-status');

  if (preview) {
    preview.src = EMPLOYEE_PHOTO_PREVIEW_URL;
    preview.style.display = 'block';
  }
  if (placeholder) placeholder.style.display = 'none';
  if (status) status.textContent = file.name;
}

function clearEmployeePhotoSelection() {
  SELECTED_EMPLOYEE_PHOTO = null;

  if (EMPLOYEE_PHOTO_PREVIEW_URL) {
    URL.revokeObjectURL(EMPLOYEE_PHOTO_PREVIEW_URL);
    EMPLOYEE_PHOTO_PREVIEW_URL = null;
  }

  const input = document.getElementById('emp-photo-input');
  const preview = document.getElementById('emp-photo-preview');
  const placeholder = document.getElementById('emp-photo-placeholder');
  const status = document.getElementById('emp-photo-status');

  if (input) input.value = '';
  if (preview) {
    preview.removeAttribute('src');
    preview.style.display = 'none';
  }
  if (placeholder) placeholder.style.display = '';
  if (status) status.textContent = 'JPG or PNG, max 5MB';
}

async function uploadEmployeePhoto(employeeId) {
  if (!SELECTED_EMPLOYEE_PHOTO || !employeeId) return null;

  const formData = new FormData();
  formData.append('photo', SELECTED_EMPLOYEE_PHOTO);

  const response = await apiFetch(`/api/employees/${employeeId}/photo`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || error.details || 'Failed to upload employee photo');
  }

  clearEmployeePhotoSelection();
  return response.json();
}

// Handle file selection
function handleFileSelect(event, docType) {
  const file = event.target.files[0];
  if (!file) {
    console.log(`No file selected for ${docType}`);
    return;
  }

  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    alert(`File is too large. Maximum size is 5MB. Your file: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
    event.target.value = '';
    return;
  }

  if (!Array.isArray(UPLOADED_FILES[docType])) UPLOADED_FILES[docType] = [];
  UPLOADED_FILES[docType].push(file);
  event.target.value = '';

  const statusEl = document.getElementById(`${docType}-status`);
  if (statusEl) {
    const count = UPLOADED_FILES[docType].length;
    statusEl.textContent = count === 1 ? `Selected: ${file.name}` : `${count} files selected`;
    statusEl.style.color = '#28a745';
    statusEl.style.fontWeight = '600';
  }

  renderSelectedFilesChips();
}

// Render chips for all selected files
function renderSelectedFilesChips() {
  const previewEl = document.getElementById('selected-files-preview');
  if (!previewEl) return;

  previewEl.innerHTML = '';

  const docIds = ['resume', 'govid', 'nbi', 'other'];
  const docLabels = {
    resume: 'Resume',
    govid: 'Gov ID',
    nbi: 'NBI',
    other: 'Other'
  };

  let chipCount = 0;
  docIds.forEach(docId => {
    const files = Array.isArray(UPLOADED_FILES[docId]) ? UPLOADED_FILES[docId] : [];
    files.forEach((file, fileIndex) => {
      const chip = document.createElement('div');
      chip.id = `chip-${docId}-${fileIndex}`;
      chip.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: #4f7cff;
        border: 1px solid #7c9aff;
        border-radius: 20px;
        padding: 8px 12px;
        font-size: 13px;
        white-space: nowrap;
        color: #e8eaf6;
        animation: slideIn 0.2s ease-out;
      `;

      const displayName = file.name.length > 25 ? file.name.substring(0, 22) + '...' : file.name;
      chip.innerHTML = `
        <span style="font-weight:500;">${docLabels[docId]}</span>
        <span style="font-size:12px;opacity:0.9;">: ${employeeOptionEscape(displayName)}</span>
        <button type="button"
                style="background:none;border:none;color:#fff;cursor:pointer;font-weight:bold;padding:0;margin-left:6px;font-size:16px;opacity:0.8;transition:opacity 0.2s;"
                onmouseover="this.style.opacity='1'"
                onmouseout="this.style.opacity='0.8'"
                title="Remove ${docLabels[docId]}"
                onclick="removeUploadedFile('${docId}', ${fileIndex}, event)">x</button>
      `;
      previewEl.appendChild(chip);
      chipCount++;
    });
  });

  if (chipCount === 0) {
    previewEl.innerHTML = '<span style="color:var(--muted);font-size:13px;italic;">Select files to upload</span>';
  }
}

// Remove an uploaded file
function removeUploadedFile(docType, fileIndex, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (Array.isArray(UPLOADED_FILES[docType])) {
    UPLOADED_FILES[docType].splice(fileIndex, 1);
  } else {
    UPLOADED_FILES[docType] = [];
  }

  const fileInput = document.getElementById(`doc-${docType}`);
  if (fileInput) fileInput.value = '';

  const statusEl = document.getElementById(`${docType}-status`);
  if (statusEl) {
    const labels = {
      resume: 'Upload Resume / CV',
      govid: 'Upload Government ID',
      nbi: 'Upload NBI Clearance',
      other: 'Upload Other Documents'
    };
    const count = Array.isArray(UPLOADED_FILES[docType]) ? UPLOADED_FILES[docType].length : 0;
    statusEl.textContent = count ? `${count} file${count === 1 ? '' : 's'} selected` : labels[docType];
    statusEl.style.color = count ? '#28a745' : '';
    statusEl.style.fontWeight = count ? '600' : '';
  }

  renderSelectedFilesChips();
}

// Clear uploaded files
function clearUploadedFiles() {
  UPLOADED_FILES.resume = [];
  UPLOADED_FILES.govid = [];
  UPLOADED_FILES.nbi = [];
  UPLOADED_FILES.other = [];
  clearEmployeePhotoSelection();

  ['doc-resume', 'doc-govid', 'doc-nbi', 'doc-other'].forEach(id => {
    const field = document.getElementById(id);
    if (field) field.value = '';
  });

  const labels = {
    'resume-status': 'Upload Resume / CV',
    'govid-status': 'Upload Government ID',
    'nbi-status': 'Upload NBI Clearance',
    'other-status': 'Upload Other Documents'
  };
  Object.entries(labels).forEach(([id, label]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = label;
    el.style.color = '';
    el.style.fontWeight = '';
  });

  const previewEl = document.getElementById('selected-files-preview');
  if (previewEl) {
    previewEl.innerHTML = '<span style="color:var(--muted);font-size:13px;italic;">Select files to upload</span>';
  }

  if (!EDIT_MODE) {
    const listEl = document.getElementById('documents-list');
    if (listEl) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:13px;padding:16px;">No documents uploaded yet</div>';
    }
  }
}

// Upload files to server (called after employee is saved)
async function uploadEmployeeDocuments(employeeId) {
  const docIds = ['resume', 'govid', 'nbi', 'other'];
  let uploadCount = 0;
  const queuedCount = docIds.reduce((total, docId) => total + (Array.isArray(UPLOADED_FILES[docId]) ? UPLOADED_FILES[docId].length : 0), 0);

  for (const docId of docIds) {
    const files = Array.isArray(UPLOADED_FILES[docId]) ? UPLOADED_FILES[docId] : [];
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('docType', DOC_TYPES[docId]);

      try {
        const response = await apiFetch(`/api/employees/${employeeId}/documents`, {
          method: 'POST',
          body: formData
        });

        if (!response) continue;
        if (!response.ok) {
          const error = await response.text();
          alert(`Failed to upload ${DOC_TYPES[docId]}: ${error}`);
        } else {
          uploadCount++;
        }
      } catch (err) {
        alert(`Error uploading ${DOC_TYPES[docId]}: ${err.message}`);
      }
    }
  }

  console.log(`Upload complete: ${uploadCount}/${queuedCount} documents uploaded`);
  clearUploadedFiles();
  return new Promise(resolve => setTimeout(resolve, 500));
}

// Fetch and display existing documents for an employee
async function loadEmployeeDocuments(employeeId) {
  try {
    const response = await apiFetch(`/api/employees/${employeeId}/documents`);
    if (!response.ok) {
      console.warn('No documents found for employee');
      return;
    }
    
    const documents = await response.json();
    console.log('Loaded documents:', documents);
    displayDocuments(documents);
  } catch (err) {
    console.warn('Error loading documents:', err);
  }
}

// Display documents in the list
function displayDocuments(documents) {
  const listEl = document.getElementById('documents-list');
  
  if (!documents || documents.length === 0) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:13px;padding:16px;">No documents uploaded yet</div>';
    return;
  }
  
  listEl.innerHTML = documents.map(doc => {
    const docTypeLabel = doc.document_type.replace('_', ' ');
    const uploadedDate = new Date(doc.uploaded_date).toLocaleDateString();
    
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:white;border-radius:4px;border:1px solid #e9ecef;">
        <div style="display:flex;align-items:center;gap:12px;flex:1;">
          <div style="font-size:20px;">📄</div>
          <div style="flex:1;">
            <div style="font-weight:500;font-size:13px;">${docTypeLabel}</div>
            <div style="font-size:11px;color:var(--muted);">${doc.file_name} • ${uploadedDate}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <a href="${doc.file_path}" target="_blank" download style="color:#007bff;text-decoration:none;font-size:12px;padding:4px 8px;border-radius:4px;border:1px solid #007bff;cursor:pointer;">Download</a>
          <button onclick="deleteDocument(${doc.id})" style="color:#dc3545;background:#fff;border:1px solid #dc3545;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

// Delete a document
async function deleteDocument(docId) {
  if (!confirm('Are you sure you want to delete this document?')) return;
  
  try {
    const response = await apiFetch(`/api/employees/${EDIT_EMPLOYEE_ID}/documents/${docId}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      alert('Document deleted successfully');
      loadEmployeeDocuments(EDIT_EMPLOYEE_ID);
    } else {
      alert('Failed to delete document');
    }
  } catch (err) {
    console.error('Error deleting document:', err);
    alert('Error deleting document');
  }
}

let REGISTER_PAGE_INITIALIZED = false;

function initializeRegisterPage() {
  if (!document.getElementById('register-form-view')) return;
  if (!document.getElementById('page-register')?.classList.contains('active')) return;
  if (REGISTER_PAGE_INITIALIZED) return;
  REGISTER_PAGE_INITIALIZED = true;

  loadEmployeeData();
  initializeEmployeeIdControls();
  initializeFileUploads();
  initializeWageConfig();
  initializeEmployeeAddressAutocomplete();
  initializeEmployeeLifecycleControls();
  initializeEmployeePositionDropdowns();
  initializeBankAccountFormatControls();
  updateEmployeeWizardActions(getActiveFormTab());
  renderEmployeeDraftArchive();
  
  // Apply role-based access after a short delay to ensure DOM is ready
  setTimeout(() => {
    applyRoleBasedAccess();
  }, 100);
}

// Page partials are injected after DOMContentLoaded, so initialize once the
// register form actually exists.
document.addEventListener('DOMContentLoaded', initializeRegisterPage);
document.addEventListener('partialsLoaded', initializeRegisterPage);
window.initializeRegisterPage = initializeRegisterPage;
window.onEmployeeIdModeChange = onEmployeeIdModeChange;
