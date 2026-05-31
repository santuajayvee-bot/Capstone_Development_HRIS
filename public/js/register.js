/* ============================================================
   REGISTER.JS — Register Employee form tab switching & save
   ============================================================ */

const FORM_SECTIONS = ['personal', 'contact', 'employment', 'payroll', 'documents'];
let EDIT_MODE = false;
let EDIT_EMPLOYEE_ID = null;           // Stores the employee_code (e.g. "EMP00001")
let EDIT_EMPLOYEE_NUMERIC_ID = null;   // Stores the numeric database ID (for API calls)
let IS_SAVING = false;                 // Prevent double-submit
let SELECTED_EMPLOYEE_PHOTO = null;
let EMPLOYEE_PHOTO_PREVIEW_URL = null;

// Store uploaded files temporarily (in memory before save)
const UPLOADED_FILES = {
  resume: null,
  govid: null,
  nbi: null,
  other: null
};

// Document type mappings
const DOC_TYPES = {
  resume: 'Resume',
  govid: 'Government_ID',
  nbi: 'NBI_Clearance',
  other: 'Other'
};

const ADDRESS_FORM_CONFIGS = {
  emp: {
    home: { input: 'emp-address' },
    current: { input: 'emp-current-address', same: 'emp-current-same-home' },
    mailing: { input: 'emp-mailing-address', same: 'emp-mailing-same-home' }
  },
  profile: {
    home: { input: 'profile-edit-address' },
    current: { input: 'profile-edit-current-address', same: 'profile-current-same-home' },
    mailing: { input: 'profile-edit-mailing-address', same: 'profile-mailing-same-home' }
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
}

function setAddressSelection(input, address, latitude, longitude) {
  if (!input) return;
  input.value = address || '';
  input.dataset.addressSelected = address && latitude !== undefined && longitude !== undefined ? '1' : '';
  input.dataset.latitude = latitude ?? '';
  input.dataset.longitude = longitude ?? '';
}

function copyHomeAddress(config) {
  const home = document.getElementById(config.home.input);
  ['current', 'mailing'].forEach(key => {
    const item = config[key];
    const same = document.getElementById(item.same);
    const input = document.getElementById(item.input);
    if (!same || !input || !same.checked) return;
    setAddressSelection(input, home?.value || '', home?.dataset.latitude, home?.dataset.longitude);
    input.disabled = true;
  });
}

function renderAddressSuggestions(input, results) {
  const box = document.getElementById(`${input.id}-suggestions`);
  if (!box) return;
  if (!results.length) {
    box.innerHTML = '<div class="address-suggestion">No address found.</div>';
    box.style.display = 'block';
    return;
  }
  box.innerHTML = results.map((item, index) => `
    <button class="address-suggestion" type="button" data-index="${index}">
      ${addressEscapeHtml(item.full_address)}
      <span class="address-suggestion-meta">${
        item.latitude !== null && item.latitude !== undefined && item.longitude !== null && item.longitude !== undefined
          ? `${Number(item.latitude).toFixed(5)}, ${Number(item.longitude).toFixed(5)}`
          : 'Google Places'
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
      if (item.latitude === null || item.latitude === undefined || item.longitude === null || item.longitude === undefined) {
        alert('Could not get coordinates for the selected address. Please choose another suggestion.');
        return;
      }
      setAddressSelection(input, item.full_address, item.latitude, item.longitude);
      box.style.display = 'none';
      Object.values(ADDRESS_FORM_CONFIGS).forEach(copyHomeAddress);
    });
  });
  box.style.display = 'block';
}

function setupAddressInput(inputId) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.addressReady === '1') return;
  input.dataset.addressReady = '1';
  let timer = null;
  input.addEventListener('input', () => {
    clearAddressSelection(input);
    Object.values(ADDRESS_FORM_CONFIGS).forEach(copyHomeAddress);
    clearTimeout(timer);
    const query = input.value.trim();
    const box = document.getElementById(`${input.id}-suggestions`);
    if (query.length < 3) {
      if (box) box.style.display = 'none';
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
  Object.values(ADDRESS_FORM_CONFIGS).forEach(config => {
    if (!scope.querySelector?.(`#${config.home.input}`) && !document.getElementById(config.home.input)) return;
    setupAddressInput(config.home.input);
    setupAddressInput(config.current.input);
    setupAddressInput(config.mailing.input);

    ['current', 'mailing'].forEach(key => {
      const item = config[key];
      const same = document.getElementById(item.same);
      const input = document.getElementById(item.input);
      if (!same || !input || same.dataset.addressSameReady === '1') return;
      same.dataset.addressSameReady = '1';
      same.addEventListener('change', () => {
        if (same.checked) {
          copyHomeAddress(config);
          input.disabled = true;
        } else {
          input.disabled = false;
          input.value = '';
          clearAddressSelection(input);
        }
      });
    });
  });
  document.addEventListener('click', event => {
    if (event.target.closest('.address-autocomplete')) return;
    document.querySelectorAll('.address-suggestions').forEach(box => { box.style.display = 'none'; });
  }, { once: true });
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
  const selected = input => input?.dataset.addressSelected === '1';

  if (!home?.value.trim()) errors.push('Home Address is required.');
  if (!currentSame && !current?.value.trim()) errors.push('Current Address is required unless Same as Home Address is checked.');
  if (!mailingSame && !mailing?.value.trim()) errors.push('Mailing Address is required unless Same as Home Address is checked.');
  if (home?.value.trim() && !selected(home)) errors.push('Home Address must be selected from address suggestions.');
  if (current?.value.trim() && !selected(current)) errors.push('Current Address must be selected from address suggestions.');
  if (mailing?.value.trim() && !selected(mailing)) errors.push('Mailing Address must be selected from address suggestions.');

  return {
    errors,
    payload: {
      residential_address: home?.value || null,
      residential_address_lat: home?.dataset.latitude || null,
      residential_address_lng: home?.dataset.longitude || null,
      current_address: currentSame ? home?.value || null : current?.value || null,
      current_address_lat: currentSame ? home?.dataset.latitude || null : current?.dataset.latitude || null,
      current_address_lng: currentSame ? home?.dataset.longitude || null : current?.dataset.longitude || null,
      current_address_same_as_home: currentSame ? 1 : 0,
      mailing_address: mailingSame ? home?.value || null : mailing?.value || null,
      mailing_address_lat: mailingSame ? home?.dataset.latitude || null : mailing?.dataset.latitude || null,
      mailing_address_lng: mailingSame ? home?.dataset.longitude || null : mailing?.dataset.longitude || null,
      mailing_address_same_as_home: mailingSame ? 1 : 0
    }
  };
}

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

  const currentAddressInput = document.getElementById('emp-current-address');
  if (currentAddressInput) setAddressSelection(currentAddressInput, emp.current_address || '', emp.current_address_lat, emp.current_address_lng);

  const mailingAddressInput = document.getElementById('emp-mailing-address');
  if (mailingAddressInput) setAddressSelection(mailingAddressInput, emp.mailing_address || '', emp.mailing_address_lat, emp.mailing_address_lng);

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
  const positionInput = document.querySelector('#form-employment input#emp-position');
  if (positionInput) positionInput.value = emp.position || '';
  
  const typeInput = document.querySelector('#form-employment select#emp-type');
  if (typeInput) typeInput.value = emp.employment_type || 'Regular';

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
}

// Auto-generate next employee ID
async function generateEmployeeID() {
  // Skip if in edit mode
  if (EDIT_MODE) {
    console.log('Skipping ID generation - in EDIT_MODE');
    return;
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
    
    console.log('Fetching employees to generate next ID...');
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
}

function saveEmployee() {
  // Prevent double submission
  if (IS_SAVING) {
    console.warn('⚠️ Save already in progress - ignoring duplicate click');
    return;
  }
  IS_SAVING = true;
  
  // Collect form data from all sections using the new ID attributes
  const empIdInput = document.getElementById('emp-id');
  const empId = empIdInput?.value;
  
  // Check if we're editing by checking all relevant flags
  // EDIT_MODE is set during fresh loads
  // window.PENDING_EDIT_MODE is set before navigation
  // window.IS_EDITING is set in loadEmployeeData()
  const isEditing = EDIT_MODE || window.PENDING_EDIT_MODE || window.IS_EDITING || false;
  let savedEmployeeNumericId = EDIT_EMPLOYEE_NUMERIC_ID;
  
  // Debug log - VERY DETAILED
  console.log('====== saveEmployee DEBUG ======');
  console.log('empId:', empId);
  console.log('EDIT_MODE:', EDIT_MODE);
  console.log('window.PENDING_EDIT_MODE:', window.PENDING_EDIT_MODE);
  console.log('window.IS_EDITING:', window.IS_EDITING);
  console.log('isEditing (final):', isEditing);
  console.log('Method will be:', isEditing ? 'PUT (UPDATE)' : 'POST (INSERT)');
  console.log('================================');
  
  // Validation: Employee code is required
  if (!empId || empId.trim() === '') {
    IS_SAVING = false;  // Reset double-submit flag
    alert('Employee ID is missing. Please wait for the ID to generate or refresh the page.');
    console.error('Employee code is empty!');
    return;
  }
  
  const departmentName = document.querySelector('#form-employment select#emp-dept')?.value || 'HR';
  const departmentId = getDepartmentId(departmentName);
  
  // DEBUG: Log what we're reading from the employment fields
  console.log('=== EMPLOYMENT FIELDS DEBUG ===');
  console.log('emp-dept value:', document.querySelector('#form-employment select#emp-dept')?.value);
  console.log('emp-position value:', document.querySelector('#form-employment input#emp-position')?.value);
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
    employee_code: empId || null,
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
    position: document.querySelector('#form-employment input#emp-position')?.value || null,
    employment_type: document.querySelector('#form-employment select#emp-type')?.value || 'Regular',
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
        throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
      });
    }
    return res.json();
  })
  .then(data => {
    console.log('Response data:', data);
    savedEmployeeNumericId = data.id || savedEmployeeNumericId;
    const message = isEditing ? 'Employee updated successfully!' : 'Employee added successfully!';
    alert(message);
    IS_SAVING = false;  // Reset double-submit flag
    
    // Reset edit mode flags
    EDIT_MODE = false;
    EDIT_EMPLOYEE_ID = null;
    EDIT_EMPLOYEE_NUMERIC_ID = null;
    window.IS_EDITING = false;
    window.PENDING_EDIT_MODE = false;
    
    // Save wage configuration if set
    const wageTypeId = getWageTypeId(document.getElementById('emp-wage-type')?.value);
    if (wageTypeId) {
      // Use numeric ID for API calls, fall back to employee code for new employees
      const apiEmployeeId = savedEmployeeNumericId || empId;
      return saveWageConfiguration(apiEmployeeId, wageTypeId);
    }
    return null;
  })
  .then((wageResult) => {
    if (SELECTED_EMPLOYEE_PHOTO) {
      console.log('Uploading employee photo...');
      return uploadEmployeePhoto(savedEmployeeNumericId || EDIT_EMPLOYEE_NUMERIC_ID);
    }
    return null;
  })
  .then(() => {
    // Upload documents if any files were selected
    const hasFiles = Object.values(UPLOADED_FILES).some(f => f !== null);
    if (hasFiles) {
      console.log('Uploading documents...');
      return uploadEmployeeDocuments(empId);
    }
    return null;
  })
  .then(() => {
    // Reload documents list after upload
    if (EDIT_EMPLOYEE_ID) {
      loadEmployeeDocuments(EDIT_EMPLOYEE_ID);
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
    alert('Failed to save employee: ' + err.message);
  });
}

function getDepartmentId(deptName) {
  const deptMap = {
    'HR': 1,
    'Accounting': 2,
    'Production': 3,
    'Logistics': 4,
    'Personnel': 5
  };
  return deptMap[deptName] || null;
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
window.saveEmployee   = saveEmployee;

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
  
  console.log(`📁 File selected for ${docType}:`, file.name, `(${(file.size / 1024).toFixed(2)}KB)`);
  
  // Validate file size (max 5MB)
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    console.error(`❌ File too large: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
    alert(`File is too large. Maximum size is 5MB. Your file: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
    event.target.value = ''; // Clear the input
    return;
  }
  
  // Store file in memory
  UPLOADED_FILES[docType] = file;
  console.log(`✅ File stored in UPLOADED_FILES[${docType}]`);
  
  // Update status in upload box to indicate file selected
  const statusEl = document.getElementById(`${docType}-status`);
  if (statusEl) {
    statusEl.textContent = `✓ ${file.name}`;
    statusEl.style.color = '#28a745';
    statusEl.style.fontWeight = '600';
  }
  
  // Render chip in preview area
  renderSelectedFilesChips();
  
  console.log(`File selected for ${DOC_TYPES[docType]}:`, file.name);
}

// Render chips for all selected files
function renderSelectedFilesChips() {
  const previewEl = document.getElementById('selected-files-preview');
  if (!previewEl) {
    console.warn('⚠️ selected-files-preview element not found');
    return;
  }
  
  console.log('🎨 Rendering file chips...');
  
  // Clear existing chips
  previewEl.innerHTML = '';
  
  const docIds = ['resume', 'govid', 'nbi', 'other'];
  const docLabels = {
    resume: '📄 Resume',
    govid: '🆔 Gov ID',
    nbi: '✅ NBI',
    other: '📎 Other'
  };
  
  let chipCount = 0;
  
  // Add a chip for each selected file
  docIds.forEach(docId => {
    if (UPLOADED_FILES[docId]) {
      const file = UPLOADED_FILES[docId];
      const chip = document.createElement('div');
      chip.id = `chip-${docId}`;
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
      
      // Truncate long filenames
      let displayName = file.name;
      if (displayName.length > 25) {
        displayName = displayName.substring(0, 22) + '...';
      }
      
      chip.innerHTML = `
        <span style="font-weight:500;">${docLabels[docId]}</span>
        <span style="font-size:12px;opacity:0.9;">: ${displayName}</span>
        <button type="button" 
                style="background:none;border:none;color:#fff;cursor:pointer;font-weight:bold;padding:0;margin-left:6px;font-size:16px;opacity:0.8;transition:opacity 0.2s;"
                onmouseover="this.style.opacity='1'"
                onmouseout="this.style.opacity='0.8'"
                title="Remove ${docLabels[docId]}"
                onclick="removeUploadedFile('${docId}', event)">×</button>
      `;
      
      previewEl.appendChild(chip);
      chipCount++;
      console.log(`✅ Chip added for ${docId}: ${file.name}`);
    }
  });
  
  // If no files selected, show help message
  if (chipCount === 0) {
    previewEl.innerHTML = '<span style="color:var(--muted);font-size:13px;italic;">Select files to upload</span>';
    console.log('ℹ️ No files selected');
  }
}

// Remove an uploaded file
function removeUploadedFile(docType, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  
  console.log(`🗑️ Removing file: ${docType}`);
  
  // Clear from memory
  UPLOADED_FILES[docType] = null;
  
  // Clear file input
  const fileInput = document.getElementById(`doc-${docType}`);
  if (fileInput) fileInput.value = '';
  
  // Reset status text
  const statusEl = document.getElementById(`${docType}-status`);
  if (statusEl) {
    const labels = {
      resume: '⬆ Upload Resume / CV',
      govid: '⬆ Upload Government ID',
      nbi: '⬆ Upload NBI Clearance',
      other: '⬆ Upload Other Documents'
    };
    statusEl.textContent = labels[docType];
    statusEl.style.color = '';
    statusEl.style.fontWeight = '';
  }
  
  // Re-render chips
  renderSelectedFilesChips();
}

// Clear uploaded files
function clearUploadedFiles() {
  UPLOADED_FILES.resume = null;
  UPLOADED_FILES.govid = null;
  UPLOADED_FILES.nbi = null;
  UPLOADED_FILES.other = null;
  clearEmployeePhotoSelection();
  
  document.getElementById('doc-resume').value = '';
  document.getElementById('doc-govid').value = '';
  document.getElementById('doc-nbi').value = '';
  document.getElementById('doc-other').value = '';
  
  document.getElementById('resume-status').textContent = '⬆ Upload Resume / CV';
  document.getElementById('govid-status').textContent = '⬆ Upload Government ID';
  document.getElementById('nbi-status').textContent = '⬆ Upload NBI Clearance';
  document.getElementById('other-status').textContent = '⬆ Upload Other Documents';
  
  // Reset status colors
  const statusEls = document.querySelectorAll('[id$="-status"]');
  statusEls.forEach(el => {
    el.style.color = '';
    el.style.fontWeight = '';
  });
  
  // Clear chip preview
  const previewEl = document.getElementById('selected-files-preview');
  if (previewEl) {
    previewEl.innerHTML = '<span style="color:var(--muted);font-size:13px;italic;">Select files to upload</span>';
  }
  
  // Clear documents list when adding new employee
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
  
  console.log('📤 Starting document upload for employee:', employeeId);
  
  for (const docId of docIds) {
    const file = UPLOADED_FILES[docId];
    if (!file) {
      console.log(`⏭️  No ${docId} file to upload`);
      continue;
    }
    
    console.log(`📁 Uploading ${docId}:`, file.name);
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('docType', DOC_TYPES[docId]);
    
    console.log(`📤 FormData prepared for ${docId}. Sending to /api/employees/${employeeId}/documents`);
    
    try {
      const response = await apiFetch(`/api/employees/${employeeId}/documents`, {
        method: 'POST',
        body: formData
      });
      
      if (!response) {
        console.error(`❌ No response for ${docId} - auth might have failed`);
        continue;
      }
      
      console.log(`Response status for ${docId}:`, response.status, response.statusText);
      
      if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Failed to upload ${docId}:`, response.status, error);
        alert(`Failed to upload ${DOC_TYPES[docId]}: ${error}`);
      } else {
        const data = await response.json();
        console.log(`✅ Uploaded ${docId} successfully:`, data);
        uploadCount++;
      }
    } catch (err) {
      console.error(`❌ Error uploading ${docId}:`, err.message, err);
      alert(`Error uploading ${DOC_TYPES[docId]}: ${err.message}`);
    }
  }
  
  console.log(`✅ Upload complete: ${uploadCount}/${docIds.filter(d => UPLOADED_FILES[d]).length} documents uploaded`);
  
  // Clear files after upload
  clearUploadedFiles();
  
  // Small delay to ensure database writes are complete
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
  if (REGISTER_PAGE_INITIALIZED) return;
  REGISTER_PAGE_INITIALIZED = true;

  loadEmployeeData();
  generateEmployeeID();
  initializeFileUploads();
  initializeWageConfig();
  initializeEmployeeAddressAutocomplete();
  
  // Apply role-based access after a short delay to ensure DOM is ready
  setTimeout(() => {
    applyRoleBasedAccess();
  }, 100);
}

// Page partials are injected after DOMContentLoaded, so initialize once the
// register form actually exists.
document.addEventListener('DOMContentLoaded', initializeRegisterPage);
document.addEventListener('partialsLoaded', initializeRegisterPage);
