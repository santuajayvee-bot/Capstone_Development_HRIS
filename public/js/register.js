/* ============================================================
   REGISTER.JS — Register Employee form tab switching & save
   ============================================================ */

const FORM_SECTIONS = ['personal', 'employment', 'payroll', 'documents'];
let EDIT_MODE = false;
let EDIT_EMPLOYEE_ID = null;

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

// Update wage type UI based on selection
function updateWageTypeUI() {
  const wageType = document.getElementById('emp-wage-type')?.value;
  
  // Hide all wage type UIs
  document.getElementById('wage-base-salary').style.display = 'none';
  document.getElementById('wage-hourly').style.display = 'none';
  document.getElementById('wage-production').style.display = 'none';
  document.getElementById('wage-logistics').style.display = 'none';
  
  // Show selected wage type UI
  if (wageType === 'Base Salary') {
    document.getElementById('wage-base-salary').style.display = 'block';
  } else if (wageType === 'Hourly') {
    document.getElementById('wage-hourly').style.display = 'block';
  } else if (wageType === 'Per-Piece') {
    document.getElementById('wage-production').style.display = 'block';
    populateSewingTypeRates();
  } else if (wageType === 'Per-Trip') {
    document.getElementById('wage-logistics').style.display = 'block';
    populateLogisticsRegionRates();
  }
}

// Populate sewing type rates
function populateSewingTypeRates() {
  const container = document.getElementById('emp-sewing-rates');
  if (!container) return;
  
  container.innerHTML = WAGE_CONFIG.sawingTypes.map(sewing => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg);border-radius:4px;">
      <input type="number" 
             id="sewing-${sewing.id}" 
             placeholder="₱ ${sewing.default_rate}" 
             min="0" step="0.01"
             value="${sewing.default_rate}"
             style="flex:1;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);" />
      <label style="flex:2;margin:0;font-size:12px;">${sewing.name}</label>
    </div>
  `).join('');
}

// Populate logistics region rates
function populateLogisticsRegionRates() {
  const container = document.getElementById('emp-logistics-rates');
  if (!container) return;
  
  container.innerHTML = WAGE_CONFIG.logisticsRegions.map(region => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg);border-radius:4px;">
      <input type="number" 
             id="logistics-${region.id}" 
             placeholder="₱ ${region.default_rate}" 
             min="0" step="0.01"
             value="${region.default_rate}"
             style="flex:1;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);" />
      <label style="flex:2;margin:0;font-size:12px;">${region.name} ${region.code ? `(${region.code})` : ''}</label>
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
  
  console.log('✅ loadEmployeeData called');
  console.log('Loading employee data for:', emp.employee_code, emp.first_name, emp.last_name);
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
  
  const nationalityInput = document.getElementById('emp-nationality');
  if (nationalityInput) nationalityInput.value = emp.nationality || 'Filipino';
  
  const genderInput = document.getElementById('emp-gender');
  if (genderInput) genderInput.value = emp.gender || 'Male';
  
  const dobInput = document.getElementById('emp-dob');
  if (dobInput) dobInput.value = emp.date_of_birth || '';
  
  const addressInput = document.getElementById('emp-address');
  if (addressInput) addressInput.value = emp.residential_address || '';
  
  const emergNameInput = document.getElementById('emp-emerg-name');
  if (emergNameInput) emergNameInput.value = emp.emergency_contact_name || '';
  
  const emergPhoneInput = document.getElementById('emp-emerg-phone');
  if (emergPhoneInput) emergPhoneInput.value = emp.emergency_contact_num || '';
  
  // Populate Employment Details using specific selectors
  const positionInput = document.querySelector('#form-employment input#emp-position');
  if (positionInput) positionInput.value = emp.position || '';
  
  const typeInput = document.querySelector('#form-employment select#emp-type');
  if (typeInput) typeInput.value = emp.employment_type || 'Full-time';
  
  const hiredDateInput = document.querySelector('#form-employment input#emp-hired-date');
  if (hiredDateInput) hiredDateInput.value = emp.date_hired || '';
  
  const supervisorInput = document.querySelector('#form-employment input#emp-supervisor');
  if (supervisorInput) supervisorInput.value = emp.supervisor || '';
  
  const locationInput = document.querySelector('#form-employment input#emp-location');
  if (locationInput) locationInput.value = emp.work_location || '';
  
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

function switchFormTab(el) {
  // Map tab text to section id
  const map = {
    'Personal Info':          'personal',
    'Employment Details':     'employment',
    'Payroll & Compensation': 'payroll',
    'Documents':              'documents',
  };
  const key = el.textContent.trim();
  const sectionId = map[key];
  if (!sectionId) return;

  // Update tab styles
  document.querySelectorAll('.form-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');

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
}

function saveEmployee() {
  // Collect form data from all sections using the new ID attributes
  const empIdInput = document.getElementById('emp-id');
  const empId = empIdInput?.value;
  
  // Check if we're editing by checking all relevant flags
  // EDIT_MODE is set during fresh loads
  // window.PENDING_EDIT_MODE is set before navigation
  // window.IS_EDITING is set in loadEmployeeData()
  const isEditing = EDIT_MODE || window.PENDING_EDIT_MODE || window.IS_EDITING || false;
  
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
  console.log('emp-hired-date value:', document.querySelector('#form-employment input#emp-hired-date')?.value);
  console.log('emp-supervisor value:', document.querySelector('#form-employment input#emp-supervisor')?.value);
  console.log('emp-location value:', document.querySelector('#form-employment input#emp-location')?.value);
  console.log('Department name:', departmentName, '-> ID:', departmentId);

  
  const formData = {
    // Personal Info
    employee_code: empId || null,
    first_name: document.getElementById('emp-first-name')?.value || '',
    middle_name: document.getElementById('emp-middle-name')?.value || null,
    last_name: document.getElementById('emp-last-name')?.value || '',
    suffix: document.getElementById('emp-suffix')?.value === 'None' ? null : document.getElementById('emp-suffix')?.value || null,
    email: document.getElementById('emp-email')?.value || '',
    contact_number: document.getElementById('emp-contact')?.value || null,
    nationality: document.getElementById('emp-nationality')?.value || 'Filipino',
    date_of_birth: document.getElementById('emp-dob')?.value || null,
    gender: document.getElementById('emp-gender')?.value || null,
    residential_address: document.getElementById('emp-address')?.value || null,
    emergency_contact_name: document.getElementById('emp-emerg-name')?.value || null,
    emergency_contact_num: document.getElementById('emp-emerg-phone')?.value || null,
    
    // Employment Details
    department_id: departmentId,
    position: document.querySelector('#form-employment input#emp-position')?.value || null,
    employment_type: document.querySelector('#form-employment select#emp-type')?.value || 'Full-time',
    date_hired: document.querySelector('#form-employment input#emp-hired-date')?.value || null,
    supervisor: document.querySelector('#form-employment input#emp-supervisor')?.value || null,
    work_location: document.querySelector('#form-employment input#emp-location')?.value || null,
    status: 'Active',
    
    // Payroll Info
    wage_type_id: getWageTypeId(document.getElementById('emp-wage-type')?.value),
    sss_number: document.getElementById('emp-sss')?.value || null,
    philhealth_number: document.getElementById('emp-philhealth')?.value || null,
    pagibig_number: document.getElementById('emp-pagibig')?.value || null,
    tin: document.getElementById('emp-tin')?.value || null,
    bank_name: document.getElementById('emp-bank')?.value || null,
    bank_account: document.getElementById('emp-bank-account')?.value || null
  };

  if (!formData.first_name || !formData.last_name || !formData.email) {
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
  const endpoint = isEditing ? `/api/employees/${empId}` : '/api/employees';

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
    const message = isEditing ? 'Employee updated successfully!' : 'Employee added successfully!';
    alert(message);
    
    // Reset edit mode flags
    EDIT_MODE = false;
    EDIT_EMPLOYEE_ID = null;
    window.IS_EDITING = false;
    window.PENDING_EDIT_MODE = false;
    
    // Save wage configuration if set
    const wageTypeId = getWageTypeId(document.getElementById('emp-wage-type')?.value);
    if (wageTypeId) {
      return saveWageConfiguration(empId, wageTypeId);
    }
    return null;
  })
  .then((wageResult) => {
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
    setTimeout(() => {
      console.log('Fetching fresh employee data...');
      if (typeof fetchEmployees === 'function') {
        fetchEmployees()
          .then((freshData) => {
            console.log('✅ Fresh employee data loaded');
            // Find the current employee in the fresh data
            const currentEmp = freshData?.find(e => e.id === empId);
            if (currentEmp) {
              console.log('Current employee fresh data from API:', {
                name: currentEmp.name,
                dept: currentEmp.dept,
                position: currentEmp.position,
                supervisor: currentEmp.supervisor,
                status: currentEmp.status
              });
            }
            if (typeof navigate === 'function') {
              console.log('Redirecting to main Employees page...');
              navigate('employees', null);
            } else {
              console.error('navigate is not available');
              alert('Error: Could not navigate to employees page');
            }
          })
          .catch(err => {
            console.error('Error fetching fresh data:', err);
            // Still navigate even if fetch fails
            if (typeof navigate === 'function') {
              navigate('employees', null);
            }
          });
      } else {
        console.warn('fetchEmployees not available, navigating with existing data');
        if (typeof navigate === 'function') {
          navigate('employees', null);
        }
      }
    }, 500); // Small delay to ensure database is updated
  })
  .catch(err => {
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

// Save wage configuration for an employee
async function saveWageConfiguration(employeeCode, wageTypeId) {
  const wageType = document.getElementById('emp-wage-type')?.value;
  const rates = [];

  try {
    if (wageType === 'Per-Piece') {
      // Collect sewing type rates
      for (const sewing of WAGE_CONFIG.sawingTypes) {
        const rateInput = document.getElementById(`sewing-${sewing.id}`);
        if (rateInput) {
          rates.push({
            sewing_type_id: sewing.id,
            rate: parseFloat(rateInput.value) || sewing.default_rate
          });
        }
      }
    } else if (wageType === 'Per-Trip') {
      // Collect logistics region rates
      for (const region of WAGE_CONFIG.logisticsRegions) {
        const rateInput = document.getElementById(`logistics-${region.id}`);
        if (rateInput) {
          rates.push({
            logistics_region_id: region.id,
            rate: parseFloat(rateInput.value) || region.default_rate
          });
        }
      }
    }

    if (rates.length > 0) {
      const res = await apiFetch(`/api/payroll/employees/${employeeCode}/wage-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wage_type_id: wageTypeId, rates: rates })
      });
      
      if (res.ok) {
        console.log('✅ Wage configuration saved');
        return await res.json();
      } else {
        console.error('Failed to save wage configuration');
      }
    }
  } catch (err) {
    console.error('Error saving wage configuration:', err);
  }
  return null;
}

// Reset edit mode - exposed globally so employees.js can call it
window.resetEditMode = function() {
  EDIT_MODE = false;
  EDIT_EMPLOYEE_ID = null;
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

// Auto-generate employee ID on page load
document.addEventListener('DOMContentLoaded', () => {
  loadEmployeeData();
  generateEmployeeID();
  initializeFileUploads();
  initializeWageConfig();
});
